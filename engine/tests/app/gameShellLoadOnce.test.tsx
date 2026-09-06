/** Pins #267: `GameShell`'s per-game boot effect (`engine/app/App.tsx`) used to list
 *  `[gameId, initialized, configReady]` as its dependency array while its own body calls
 *  `setConfigReady(true)`/`setInitialized(true)` mid-effect — an effect that writes state it
 *  also depends on re-runs itself, so `registerSystems`, `registerAppServices`,
 *  `attribution.init()`, `PlayerPrefs.init`, and `sceneManager.loadScene` all fired TWICE for
 *  one game load. The fix pins the dependency array to `[gameId]` and mirrors the two flags
 *  into refs (`configReadyRef`/`initializedRef`) for the effect to read instead.
 *
 *  This is a React SCHEDULING property, so it can only be pinned by rendering the real
 *  component — there is no pure module to extract the guard into. Every import GameShell
 *  reaches is mocked at the leaf (engine barrel, capacitor, sibling app modules); GameShell
 *  itself and React's effect scheduling are real. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import React from 'react';

// ── Hoisted spies (referenced from vi.mock factories below — must be declared via
//    vi.hoisted so they exist before the mocks are hoisted above the imports). ──
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
  // App.tsx derives its two-frame ceiling from this (#682) — an explicit-list mock missing a newly
  // imported name fails at BINDING, so this file collects zero tests rather than failing a case.
  // Mirrors `runtime/rendering/scenePaintSignal.ts`; nothing here asserts on the value.
  SCENE_PAINT_MAX_WAIT_MS: 5000,
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

vi.mock('../../app/ecs/init', () => ({
  initWorldSync: vi.fn(),
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
import { GameShell } from '../../app/App';
import { registerDynamicGame, __resetGameRegistryForTest } from '../../app/gameRegistry';
import type { GameDefinition } from '@modoki/engine/runtime';

/** Builds a distinct, independently-spied `GameDefinition` per test so counts can't leak
 *  between games sharing one mock function. `findGame` (gameRegistry.ts) resolves through
 *  `virtual:modoki-games` (empty under vitest, per `tests/framework/gameRegistry.test.ts`)
 *  plus dynamically-registered games — so registering here is the real resolution path,
 *  not a stand-in for it. */
function makeGame(id: string) {
  const registerSystems = vi.fn(async () => {});
  const registerAppServices = vi.fn(async () => {});
  const def: GameDefinition = {
    id,
    name: id,
    registerSystems,
    registerAppServices,
    loadConfig: async () => ({
      assetManifest: '/assets.manifest.json',
      scenePath: '/scene.json',
      disable3D: true,
    } as never),
  };
  const ok = registerDynamicGame(def);
  if (!ok) throw new Error(`test setup: could not register game "${id}"`);
  return { def, registerSystems, registerAppServices };
}

afterEach(() => {
  cleanup();
  __resetGameRegistryForTest();
  vi.clearAllMocks();
});

describe('GameShell load-once contract (#267)', () => {
  it('drives every boot side effect exactly once for a single mount', async () => {
    const { registerSystems, registerAppServices } = makeGame('test-game');

    render(React.createElement(GameShell, { gameId: 'test-game' }));

    await waitFor(() => expect(spies.loadScene).toHaveBeenCalled(), { timeout: 5000 });
    // Settle before counting. `loadScene` is not the end of the effect (onSceneReady, two
    // rAFs and `setInitialized` follow it), and a re-entrant second pass would be racing
    // this assertion. A fixed sleep can't retry — on a loaded machine a late second call
    // would land AFTER the sleep and pass the count check anyway, so wait on the overlay
    // (the effect's actual last act) instead of guessing a duration.
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    // Guard against a vacuous pass (the component errored out and rendered nothing):
    // assert each spy fired AT LEAST once before asserting the exact count.
    expect(registerSystems.mock.calls.length).toBeGreaterThan(0);
    expect(registerAppServices.mock.calls.length).toBeGreaterThan(0);
    expect(spies.attributionInit.mock.calls.length).toBeGreaterThan(0);
    expect(spies.playerPrefsInit.mock.calls.length).toBeGreaterThan(0);
    expect(spies.loadScene.mock.calls.length).toBeGreaterThan(0);

    expect(registerSystems).toHaveBeenCalledTimes(1);
    expect(registerAppServices).toHaveBeenCalledTimes(1);
    expect(spies.attributionInit).toHaveBeenCalledTimes(1);
    expect(spies.playerPrefsInit).toHaveBeenCalledTimes(1);
    expect(spies.loadScene).toHaveBeenCalledTimes(1);
  });

  // ⚠️ Weaker than it looks, and worth saying so: `GameShell` is `React.memo`'d, so a
  // rerender with an identical `gameId` prop is skipped by React before the component runs
  // at all. What this pins is the OUTER contract (a parent re-rendering must not re-boot the
  // game); the re-entry #267 was actually about came from state INSIDE the component, and
  // that is what the first test covers.
  it('re-rendering with the SAME gameId adds no further calls', async () => {
    const { registerSystems, registerAppServices } = makeGame('test-game');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'test-game' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalled(), { timeout: 5000 });

    expect(registerSystems).toHaveBeenCalledTimes(1);
    expect(registerAppServices).toHaveBeenCalledTimes(1);
    expect(spies.attributionInit).toHaveBeenCalledTimes(1);
    expect(spies.playerPrefsInit).toHaveBeenCalledTimes(1);
    expect(spies.loadScene).toHaveBeenCalledTimes(1);

    rerender(React.createElement(GameShell, { gameId: 'test-game' }));
    // Give any (incorrect) re-entrant effect a chance to fire before asserting it didn't —
    // via the overlay's real completion signal, not a fixed sleep a slow re-entrant pass
    // could outrun.
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    expect(registerSystems).toHaveBeenCalledTimes(1);
    expect(registerAppServices).toHaveBeenCalledTimes(1);
    expect(spies.attributionInit).toHaveBeenCalledTimes(1);
    expect(spies.playerPrefsInit).toHaveBeenCalledTimes(1);
    expect(spies.loadScene).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT gameId after the first settles drives the second game\'s boot (control: proves the fix does not simply freeze the effect)', async () => {
    const game1 = makeGame('test-game-1');
    const game2 = makeGame('test-game-2');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'test-game-1' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(game1.registerSystems).toHaveBeenCalledTimes(1);
    expect(game1.registerAppServices).toHaveBeenCalledTimes(1);
    expect(game2.registerSystems).not.toHaveBeenCalled();
    expect(game2.registerAppServices).not.toHaveBeenCalled();

    rerender(React.createElement(GameShell, { gameId: 'test-game-2' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // Game 1's boot spies must stay at 1 — only game 2's fired for the switch.
    expect(game1.registerSystems).toHaveBeenCalledTimes(1);
    expect(game1.registerAppServices).toHaveBeenCalledTimes(1);
    expect(game2.registerSystems).toHaveBeenCalledTimes(1);
    expect(game2.registerAppServices).toHaveBeenCalledTimes(1);
  });
});

describe('GameShell recovery paths', () => {
  it('a stale error screen does not outlive its game (pins the setError(null) fix)', async () => {
    makeGame('test-game');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'unregistered-game' }));
    await waitFor(() => expect(screen.getByText('Unknown game: "unregistered-game"')).toBeTruthy());

    // Before the fix, `error` had no path back to `null` anywhere in App.tsx, so this error
    // page stayed on screen forever — even once a properly-registered game loaded behind it.
    rerender(React.createElement(GameShell, { gameId: 'test-game' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalled(), { timeout: 5000 });
    // `LoadingOverlay` only mounts once `configReady`, so wait for the boot to actually
    // START (loadScene called) before waiting for it to finish (overlay gone) — otherwise
    // the still-loading "Loading..." screen (no overlay element at all) reads as "done".
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    expect(screen.queryByText('Unknown game: "unregistered-game"')).toBeNull();
    expect(spies.loadScene).toHaveBeenCalled();
  });

  it('returning to the loaded game after a cancelled swap clears the transition overlay (pins the setTransitioning(false) fix)', async () => {
    makeGame('game-a');

    // Game B's config load never resolves, parking its swap in flight indefinitely — so
    // `activeGameIdRef.current` never advances to 'game-b' and a later rerender back to
    // 'game-a' hits the `activeGameIdRef.current === gameId` early-return branch.
    const registerSystemsB = vi.fn(async () => {});
    const registerAppServicesB = vi.fn(async () => {});
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      registerAppServices: registerAppServicesB,
      loadConfig: () => new Promise(() => {}) as never,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    // `LoadingOverlay` only mounts once `configReady`, so wait for the boot to actually
    // START (loadScene called) before waiting for it to finish (overlay gone) — otherwise
    // the still-loading "Loading..." screen (no overlay element at all) reads as "done".
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(screen.getByTestId('loading-overlay')).toBeTruthy());

    // Before the fix, the early-return branch never called `setTransitioning(false)`, so the
    // overlay stayed up for the rest of the session, covering game A which was running fine.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());
  });
});

describe('a cancelled swap does not tear down the game that is live again (#511 continuation)', () => {
  // The A→B→A-while-suspended case that used to live here ('A→B→A while B is suspended on
  // unregisterSystems must NOT call clearAppServices') is DELETED, not rewritten in place.
  //
  // Under the pre-#516 code that expectation was the real #511 invariant. Under the #516 fix
  // it is no longer true ON PURPOSE: the swap-back JOINS the interrupted teardown and performs
  // the destructive half itself before re-registering A, so `clearAppServices` legitimately
  // DOES fire once on this path — the old "torn down and never rebuilt" bug this repo used to
  // ship is exactly what made "no clearAppServices" look like the invariant, when the actual
  // bug was that A was left torn down with nothing left to call it. The test only kept passing
  // after #516 landed because its two `setTimeout(0)` ticks happened to land before the
  // re-entrant continuation's own `await import('tierBoot')` resolved — a timing accident, not
  // a passing assertion (50×5ms ticks report `clearAppServices` called once and fail).
  //
  // What the design now guarantees on this exact path — B's dead continuation does not call
  // `clearAppServices` (the real #511 invariant, which survives), `clearAppServices` fires
  // EXACTLY ONCE for A across the whole sequence, and it lands BEFORE A's re-registration — is
  // already pinned, word for word, by `gameShellSwapCancel.test.tsx`'s
  // "clearAppServices (the destructive half) runs exactly once for A, and BEFORE A
  // re-registers" (under 'GameShell A→B→A once-per-load contract (#516)'), which uses the same
  // A-tears-itself-down-then-rejoins shape and asserts both the count and the exact
  // `['registerSystems:A', 'clearAppServices', 'registerSystems:A']` ordering. Keeping a second,
  // differently-named case here for the same scenario would just be two names for one
  // assertion, so it isn't rewritten — it's removed.

  it('an UNCANCELLED A→B swap DOES call clearAppServices exactly once (control)', async () => {
    makeGame('game-a');
    makeGame('game-b');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    expect(spies.clearAppServices).toHaveBeenCalledTimes(1);
  });
});
