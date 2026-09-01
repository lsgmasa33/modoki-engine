/** The StrictMode teardown → re-register cycle closes, in the timing where it does NOT close by
 *  itself (#534).
 *
 *  THE RACE. `teardownAll()` runs from `App`'s unmount cleanup; the matching registration runs one
 *  component down, in `GameShell`'s `[gameId]` boot effect, behind an early return that asks only
 *  "is this game already loaded?". React StrictMode mounts → unmounts → remounts once on every dev
 *  boot, so that teardown fires on every dev boot. If the first boot COMPLETES before the remount,
 *  it sets `activeGameIdRef`, the cleanup then tears the app down, and the second pass hits the
 *  early return and registers nothing — leaving the app with no Managers: no input, no navigation,
 *  no audio, silently, for the rest of the session.
 *
 *  ⚠️ MEASURED: THAT ORDERING DOES NOT OCCUR TODAY, and the write-up matters more than the verdict
 *  because I got it wrong twice. It is not "the awaits are slow enough" (a race you happen to win),
 *  and it is not "act() drains microtasks so the boot finishes first" (my second theory, also
 *  wrong). React's StrictMode remount is SYNCHRONOUS within the commit, so a continuation parked on
 *  any await cannot run until the double-invoke has already completed. Instrumented: in the
 *  fast-boot case `PlayerPrefs.init` is reached exactly ONCE, by the second pass — the first pass
 *  was cancelled before its first await even settled.
 *
 *  So these tests do not reproduce a live bug. They pin an invariant of `GameShell` that
 *  `GameShell` nowhere states — THERE MUST BE AN AWAIT BEFORE `activeGameIdRef` IS WRITTEN — and,
 *  in the last case, the fact that the teardown trigger is not yet effective at all.
 *
 *  A React scheduling property, so it needs the real component under a real `StrictMode`. The
 *  wrapper below reproduces `App`'s `[]` cleanup rather than mounting `App` itself (which drags in
 *  routing and the lazy editor); that `App` really has that cleanup is a separate, source-level
 *  claim, pinned by `tests/architecture/appTeardownReachable.test.ts`. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import React from 'react';

// ── Hoisted spies (referenced from vi.mock factories below — must be declared via
//    vi.hoisted so they exist before the mocks are hoisted above the imports). ──
const latch = vi.hoisted(() => ({ registered: false, teardownSawRegistered: [] as boolean[] }));
const spies = vi.hoisted(() => ({
  attributionInit: vi.fn(),
  playerPrefsInit: vi.fn(async () => ({ discardedPending: [] })),
  loadScene: vi.fn(async () => {}),
  clearAppServices: vi.fn(),
  resolveTierForNo3DProject: vi.fn(async () => {}),
  resolveTierBeforeSceneLoad: vi.fn(async () => {}),
  stopTierCalibrationForNo3DProject: vi.fn(),
  checkAppOtaUpdate: vi.fn(async () => true),
}));

// ── `@modoki/engine/runtime` barrel — every named export App.tsx imports from it. ──
vi.mock('@modoki/engine/runtime', () => ({
  useGameLoop: () => {},
  setGameConfig: vi.fn(),
  sceneManager: { loadScene: spies.loadScene },
  ensureManifestLoaded: vi.fn(async () => {}),
  resolveSceneByName: vi.fn(() => undefined),
  assetUrl: (p: string) => p,
  appServices: () => ({
    attribution: { init: spies.attributionInit },
    ads: { init: vi.fn(), cleanup: vi.fn() },
  }),
  clearAppServices: spies.clearAppServices,
  getCurrentWorld: vi.fn(() => ({})),
  PlayerPrefs: { init: spies.playerPrefsInit, flush: vi.fn(async () => {}) },
  selectDefaultBackend: vi.fn(() => 'memory'),
  audioDispose: vi.fn(),
  audioResume: vi.fn(),
  VideoOverlay: () => null,
  onTierSwitchOverlay: vi.fn(() => () => {}),
  // Every game here is `disable3D: true`, so GameShell never actually awaits this (#334) — but
  // the barrel is fully mocked, and a named export App.tsx imports and this factory omits is a
  // module-init error, not a missing call.
  waitForScenePaint: vi.fn(async () => 'idle'),
}));

vi.mock('@modoki/engine/runtime/debug', () => ({
  DebugMenu: () => null,
}));

vi.mock('@modoki/engine/runtime/rendering/Game', () => ({
  default: () => null,
}));

vi.mock('@modoki/engine/runtime/rendering/Scene3D', () => ({
  default: () => null,
}));

vi.mock('@modoki/engine/runtime/rendering/tierBoot', () => ({
  resolveTierForNo3DProject: spies.resolveTierForNo3DProject,
  resolveTierBeforeSceneLoad: spies.resolveTierBeforeSceneLoad,
  stopTierCalibrationForNo3DProject: spies.stopTierCalibrationForNo3DProject,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

// The mocked `initWorldSync`/`register` pair models the REAL contract and nothing more:
// registration sets a latch, `teardownAll()` clears it, `isAppRegistered()` reads it. That is
// exactly `engine/app/ecs/register.ts`'s shape (verified against it), and the real latch's own
// behaviour — including the re-arm — is covered unmocked in `tests/ecs/appTeardownRearm.test.ts`.
// Faking it here keeps this file about SCHEDULING, which is the only thing it can prove, and
// avoids dragging `virtual:modoki-project-config` + a real game config into a React test.
vi.mock('../../app/ecs/init', () => ({
  initWorldSync: vi.fn(() => { latch.registered = true; }),
}));

vi.mock('../../app/ecs/register', () => ({
  teardownAll: vi.fn(() => { latch.teardownSawRegistered.push(latch.registered); latch.registered = false; }),
}));

vi.mock('../../app/ecs/pipeline', () => ({
  runPipeline: vi.fn(),
}));

vi.mock('../../app/ota', () => ({
  checkAppOtaUpdate: spies.checkAppOtaUpdate,
  subscribeOtaGate: vi.fn(() => () => {}),
}));

vi.mock('../../app/subgameLoader', () => ({
  loadStagedSubgames: vi.fn(async () => {}),
}));

vi.mock('../../app/useWebCanvasSizing', () => ({
  useWebCanvasSizing: () => ({ letterboxed: false, cssWidth: 0, cssHeight: 0 }),
}));

vi.mock('../../app/hooks/useKeyboardShift', () => ({
  useKeyboardShift: () => {},
}));

vi.mock('../../app/ui/DefaultGameUILayer', () => ({
  DefaultGameUILayer: () => null,
}));

vi.mock('../../app/ui/components/ErrorBoundary', () => ({
  setActiveResetPhase: vi.fn(),
  default: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../../app/ui/components/EditorBootBoundary', () => ({
  EditorBootBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

// Renders a queryable marker while `visible`, instead of always `null` — the boot effect's
// last two acts are `setInitialized(true)` then `setTransitioning(false)`, so the overlay
// going away IS "the effect finished" and gives tests a real completion signal to wait on
// instead of a fixed sleep.
vi.mock('../../app/ui/components/LoadingOverlay', () => ({
  default: ({ visible }: { visible?: boolean }) =>
    visible ? React.createElement('div', { 'data-testid': 'loading-overlay' }) : null,
}));

vi.mock('../../app/ui/components/OtaRestartGate', () => ({
  default: () => null,
}));

// Import AFTER the mocks above (vi.mock is hoisted regardless, but keep the read order honest).
import { StrictMode, useEffect } from 'react';
import { GameShell } from '../../app/App';
import { registerDynamicGame, __resetGameRegistryForTest } from '../../app/gameRegistry';
import { teardownAll } from '../../app/ecs/register';

/** Mirrors `App`'s app-scoped teardown effect (App.tsx) — a `[]`-deps cleanup calling
 *  `teardownAll()`, above `GameShell` in the tree. */
function AppLike({ gameId }: { gameId: string }) {
  useEffect(() => () => { teardownAll(); }, []);
  return React.createElement(GameShell, { gameId });
}

/** `settle` decides which side of the race we are testing.
 *  - 'microtask' — every await resolves on a microtask, so `act()` drains the WHOLE boot before
 *    StrictMode's remount. The losing regime: the ref is set, then the app is torn down.
 *  - 'macrotask' — the boot is still parked when the remount lands. The regime that survives on
 *    its own, kept as a control so a fix that only works in one is not mistaken for a fix. */
function makeGame(id: string, settle: 'microtask' | 'macrotask') {
  const def = {
    id,
    name: id,
    registerSystems: vi.fn(async () => {}),
    registerAppServices: vi.fn(async () => {}),
    loadConfig: async () => {
      if (settle === 'macrotask') await new Promise((r) => setTimeout(r, 0));
      return { assetManifest: '/assets.manifest.json', scenePath: '/scene.json', disable3D: true };
    },
  } as unknown as Parameters<typeof registerDynamicGame>[0];
  if (!registerDynamicGame(def)) throw new Error(`test setup: could not register game "${id}"`);
}

afterEach(() => {
  cleanup();
  __resetGameRegistryForTest();
  vi.clearAllMocks();
  latch.registered = false;
  latch.teardownSawRegistered.length = 0;
});

async function settleBoot() {
  await waitFor(() => expect(spies.loadScene).toHaveBeenCalled(), { timeout: 5000 });
  await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());
}

describe('the app-scoped registration survives a StrictMode remount (#534)', () => {
  it('ends REGISTERED when the first boot completes before the remount (the losing regime)', async () => {
    makeGame('fast-game', 'microtask');
    render(React.createElement(StrictMode, null, React.createElement(AppLike, { gameId: 'fast-game' })));
    await settleBoot();

    // Guard against a vacuous pass: the teardown must actually have fired, or this proves nothing
    // about surviving it.
    expect(teardownAll).toHaveBeenCalled();
    expect(latch.registered).toBe(true);
  });

  it('ends REGISTERED when the boot is still in flight at the remount (the control)', async () => {
    makeGame('slow-game', 'macrotask');
    render(React.createElement(StrictMode, null, React.createElement(AppLike, { gameId: 'slow-game' })));
    await settleBoot();

    expect(teardownAll).toHaveBeenCalled();
    expect(latch.registered).toBe(true);
  });

  it('a plain mount without StrictMode is registered and never torn down', async () => {
    makeGame('plain-game', 'microtask');
    render(React.createElement(AppLike, { gameId: 'plain-game' }));
    await settleBoot();

    expect(teardownAll).not.toHaveBeenCalled();
    expect(latch.registered).toBe(true);
  });

  /** ⚠️ THIS TEST PINS A GAP, NOT A GUARANTEE — read it before deleting it.
   *
   *  #534 built the teardown path and wired `teardownAll()` to `App`'s unmount. That entry point is
   *  correct and re-arms properly. But the ONLY thing that unmounts `App` is StrictMode's
   *  synchronous mount → unmount → remount, and BOTH `registerAll()` call sites (`ecs/init.ts` via
   *  GameShell's boot effect, `editor/setup.ts` via a React.lazy factory) are downstream of awaits.
   *  So the teardown always runs before anything is registered, and tears down nothing — every
   *  time, in both routes.
   *
   *  That means the six teardown halves #534 set out to make reachable are reachable ON PAPER and
   *  still inert in practice, and it is why `APP_LIFETIME_BY_DESIGN` in
   *  `tests/architecture/appManagerDisposeReachable.test.ts` still carries its three entries.
   *
   *  WHEN THIS TEST FAILS, THAT IS GOOD NEWS: a trigger that fires while the app is registered has
   *  landed (the candidates are #516's A→B→A game swap and an error boundary raised above
   *  `GameShell`). Do not "fix" it by loosening the assertion — invert it to expect `true`, delete
   *  that allowlist, and check `disposeAudioContext` now actually runs. */
  it('records that the teardown currently fires with NOTHING registered (#534 residual)', async () => {
    makeGame('gap-game', 'microtask');
    render(React.createElement(StrictMode, null, React.createElement(AppLike, { gameId: 'gap-game' })));
    await settleBoot();

    expect(teardownAll).toHaveBeenCalledTimes(1);
    expect(latch.teardownSawRegistered).toEqual([false]);
  });
});
