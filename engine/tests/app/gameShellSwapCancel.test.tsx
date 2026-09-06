/** Pins #516: `GameShell`'s per-game boot effect (`engine/app/App.tsx`) used to guard
 *  re-entrancy with `activeGameIdRef`, a ref written ONLY on the boot's success path. Swapping
 *  game A→B unregisters A's systems, then boots B; if the user swaps back to A while B is still
 *  in flight, B's effect cleanup sets `cancelled = true` and B's continuation returns at a
 *  cancellation check — but `activeGameIdRef` still said "A" the whole time (it was never
 *  nulled), so A's re-entry took the `activeGameIdRef.current === gameId` early return and
 *  re-registered nothing. Result: A on screen with its systems, projections and managers
 *  unregistered, nothing ever re-registering them, and the loading overlay dismissed over the
 *  top so nothing looked wrong.
 *
 *  The fix adds two refs: `teardownRef` (a teardown that has STARTED but whose destructive half
 *  — `clearAppServices()` + the tier-loop stop — has not finished, published BEFORE the first
 *  await so a mid-teardown game reads as "not loaded") and `registeredGameIdRef` (which game
 *  currently OWNS registered engine state, written immediately BEFORE the first registration
 *  rather than after the last, so a boot cancelled after `registerSystems()` is still known to
 *  own systems). This file exercises both halves directly. Mocking style, helpers and mount
 *  pattern follow `tests/app/gameShellLoadOnce.test.tsx` — read that file's header first. */

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

/** A promise this file can resolve from the outside, to park a `GameDefinition` hook mid-boot
 *  on demand — the whole point of these tests is to observe what happens while a swap is
 *  suspended, not just its start and end. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const baseConfig = {
  assetManifest: '/assets.manifest.json',
  scenePath: '/scene.json',
  disable3D: true,
} as never;

afterEach(() => {
  cleanup();
  __resetGameRegistryForTest();
  vi.clearAllMocks();
});

describe('GameShell A→B→A swap-back re-boots the game it returns to (#516)', () => {
  it('re-entering A while B is suspended mid-boot calls registerSystems a SECOND time for A, and A ends up active', async () => {
    const registerSystemsA = vi.fn(async () => {});
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    // B parks INSIDE `registerSystems` — before it has registered anything of its own.
    const bGate = deferred<void>();
    const registerSystemsB = vi.fn(() => bGate.promise);
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());
    expect(registerSystemsA).toHaveBeenCalledTimes(1);

    // A→B: parks inside B's `registerSystems`.
    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(registerSystemsB).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // B→A: swap back to A while B is still suspended. Before #516 this hit the
    // `activeGameIdRef.current === gameId` early return and re-registered nothing.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));

    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
    // A actually finished re-booting, not just re-entered `registerSystems`.
    expect(spies.loadScene).toHaveBeenCalledTimes(2);

    // Release B's suspended continuation so nothing is left dangling; it must be a no-op now
    // that its effect has been cancelled.
    bGate.resolve();
    await waitFor(() => expect(registerSystemsB).toHaveBeenCalledTimes(1));
  });
});

describe('GameShell A→B→A once-per-load contract (#516)', () => {
  it('unregisterSystems is called exactly once for A across the whole A→B→A sequence', async () => {
    // A's OWN teardown (triggered by A→B) is what gets suspended and re-joined here — the case
    // the fix's `teardownRef` exists for: the re-entry into A must JOIN this promise rather
    // than calling the hook a second time.
    const aTeardownGate = deferred<void>();
    const unregisterSystemsA = vi.fn(() => aTeardownGate.promise);
    const registerSystemsA = vi.fn(async () => {});
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    const registerSystemsB = vi.fn(async () => {});
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    // A→B: parks right after `await prevDef.unregisterSystems()` is called (before it resolves).
    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(unregisterSystemsA).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // B→A: the swap-back must JOIN the in-flight teardown, not call the hook again.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    // A second call would happen synchronously (before any await) if the fix regressed, so
    // asserting the count here (still 1, before the gate even opens) is meaningful.
    expect(unregisterSystemsA).toHaveBeenCalledTimes(1);

    aTeardownGate.resolve();

    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });

    expect(unregisterSystemsA).toHaveBeenCalledTimes(1);
  });

  it('clearAppServices (the destructive half) runs exactly once for A, and BEFORE A re-registers', async () => {
    const order: string[] = [];
    spies.clearAppServices.mockImplementation(() => { order.push('clearAppServices'); });

    const aTeardownGate = deferred<void>();
    const unregisterSystemsA = vi.fn(() => aTeardownGate.promise);
    const registerSystemsA = vi.fn(async () => { order.push('registerSystems:A'); });
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    const registerSystemsB = vi.fn(async () => {});
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());
    expect(order).toEqual(['registerSystems:A']);

    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(unregisterSystemsA).toHaveBeenCalledTimes(1), { timeout: 5000 });

    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    aTeardownGate.resolve();

    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });

    expect(spies.clearAppServices).toHaveBeenCalledTimes(1);
    // Ordering, not just counts: the destructive half ran BEFORE the re-registration it is
    // supposed to precede — post-#511 `clearAppServices` calls the outgoing game's own
    // `ads.cleanup()`, so running it AFTER re-registration would mean duplicate ad listeners.
    expect(order).toEqual(['registerSystems:A', 'clearAppServices', 'registerSystems:A']);
  });

  it('a boot cancelled AFTER registerSystems has run still gets torn down on the next swap (registeredGameIdRef)', async () => {
    const registerSystemsA = vi.fn(async () => {});
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    // B's `registerSystems` resolves normally (so B owns systems), but `loadConfig` parks — B
    // never reaches the success path that would have set `activeGameIdRef`.
    const registerSystemsB = vi.fn(async () => {});
    const unregisterSystemsB = vi.fn(async () => {});
    const bLoadConfigGate = deferred<never>();
    const loadConfigB = vi.fn(() => bLoadConfigGate.promise);
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      unregisterSystems: unregisterSystemsB,
      loadConfig: loadConfigB,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    // A→B: B's `registerSystems` runs to completion, then B parks inside `loadConfig` — never
    // reaching `activeGameIdRef.current = gameId`.
    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(loadConfigB).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(registerSystemsB).toHaveBeenCalledTimes(1);
    expect(unregisterSystemsB).not.toHaveBeenCalled();

    // B→A before B ever finishes booting. `registeredGameIdRef` — not `activeGameIdRef` — is
    // what has to tell the re-entry that B owns systems and owes a teardown.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));

    await waitFor(() => expect(unregisterSystemsB).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });

    // Let B's dead `loadConfig` continuation go so nothing is left dangling; it must be a no-op.
    bLoadConfigGate.resolve(baseConfig);
  });
});

describe('GameShell ordinary A→B swap (no regression)', () => {
  it('a plain A→B swap still tears down A once, then boots B once, in that order — and B ends up active', async () => {
    const order: string[] = [];
    const unregisterSystemsA = vi.fn(async () => { order.push('unregister:A'); });
    const registerSystemsA = vi.fn(async () => {});
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    const registerSystemsB = vi.fn(async () => { order.push('register:B'); });
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    expect(unregisterSystemsA).toHaveBeenCalledTimes(1);
    expect(registerSystemsB).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['unregister:A', 'register:B']);

    // B is genuinely active, not merely "not A": swapping back to A drives a real re-boot
    // rather than the `activeGameIdRef.current === gameId` no-op branch.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });
});

describe('GameShell teardown coverage gaps (adversarial review of #516)', () => {
  it('a REJECTED unregisterSystems is not memoized — the next swap retries the teardown instead of wedging every later boot', async () => {
    // Models a transient failure (the real `unregisterGameSystems` hook is a dynamic
    // `import('./runtime/setup')`, which rejects on a chunk 404 after a deploy or a flaky
    // network) that SUCCEEDS on retry — the case a real player actually hits: one swap fails,
    // the next one works.
    let unregisterCallCount = 0;
    const unregisterSystemsA = vi.fn(() => {
      unregisterCallCount += 1;
      return unregisterCallCount === 1
        ? Promise.reject(new Error('boom: chunk 404'))
        : Promise.resolve();
    });
    const registerSystemsA = vi.fn(async () => {});
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    const registerSystemsB = vi.fn(async () => {});
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const registerSystemsC = vi.fn(async () => {});
    const defC: GameDefinition = {
      id: 'game-c',
      name: 'game-c',
      registerSystems: registerSystemsC,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defC)) throw new Error('test setup: could not register game "game-c"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    // A→B: A's own teardown rejects. B's `registerSystems` is never reached — the boot fails
    // and surfaces as the error screen.
    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(unregisterSystemsA).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText('Error: boom: chunk 404')).toBeTruthy(), { timeout: 5000 });
    expect(registerSystemsB).not.toHaveBeenCalled();

    // B→C: `registeredGameIdRef` still names A (B's boot never claimed it), so this retries
    // A's teardown — NOT a re-await of the dead rejected promise. Before the fix, `teardownRef`
    // held that rejected promise forever and every later swap re-threw A's stale failure, so C
    // (and everything after it) never booted.
    rerender(React.createElement(GameShell, { gameId: 'game-c' }));
    await waitFor(() => expect(unregisterSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(registerSystemsC).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });

    // C genuinely finished booting (loadScene reached), not just re-entered registerSystems.
    // Only two loadScene calls: A's original boot and C's — B never got that far.
    expect(spies.loadScene).toHaveBeenCalledTimes(2);
  });

  it('A→B→C→A keeps the teardown/registration refs consistent across a full loop with every hop interrupted', async () => {
    const order: string[] = [];

    const unregisterSystemsA = vi.fn(async () => { order.push('unregister:A'); });
    const registerSystemsA = vi.fn(async () => { order.push('register:A'); });
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    // B and C never finish `registerSystems` on their first attempt — each hop is interrupted
    // before the game it lands on ever reaches `activeGameIdRef`, so the NEXT swap has to find
    // its owner through `registeredGameIdRef`, not `activeGameIdRef` (#516's other half).
    const bGate = deferred<void>();
    const unregisterSystemsB = vi.fn(async () => { order.push('unregister:B'); });
    const registerSystemsB = vi.fn(() => { order.push('register:B'); return bGate.promise; });
    const defB: GameDefinition = {
      id: 'game-b',
      name: 'game-b',
      registerSystems: registerSystemsB,
      unregisterSystems: unregisterSystemsB,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defB)) throw new Error('test setup: could not register game "game-b"');

    const cGate = deferred<void>();
    const unregisterSystemsC = vi.fn(async () => { order.push('unregister:C'); });
    const registerSystemsC = vi.fn(() => { order.push('register:C'); return cGate.promise; });
    const defC: GameDefinition = {
      id: 'game-c',
      name: 'game-c',
      registerSystems: registerSystemsC,
      unregisterSystems: unregisterSystemsC,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defC)) throw new Error('test setup: could not register game "game-c"');

    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(spies.loadScene).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull());

    // A→B: tears down A fully, then B's own boot parks before it can finish.
    rerender(React.createElement(GameShell, { gameId: 'game-b' }));
    await waitFor(() => expect(unregisterSystemsA).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(registerSystemsB).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // B→C: tears down B — which never reached `activeGameIdRef` but is still named by
    // `registeredGameIdRef` — then C's boot also parks.
    rerender(React.createElement(GameShell, { gameId: 'game-c' }));
    await waitFor(() => expect(unregisterSystemsB).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(registerSystemsC).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // C→A: tears down C, then boots A fresh — and this time A is allowed to finish.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(unregisterSystemsC).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });

    // Exactly one unregister per game that ever owned state — nothing torn down twice, nothing
    // skipped — and A ends up genuinely booted (loadScene reached a second time), not merely
    // "not torn down".
    expect(unregisterSystemsA).toHaveBeenCalledTimes(1);
    expect(unregisterSystemsB).toHaveBeenCalledTimes(1);
    expect(unregisterSystemsC).toHaveBeenCalledTimes(1);
    expect(registerSystemsA).toHaveBeenCalledTimes(2);
    expect(registerSystemsB).toHaveBeenCalledTimes(1);
    expect(registerSystemsC).toHaveBeenCalledTimes(1);
    expect(spies.loadScene).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'register:A',
      'unregister:A', 'register:B',
      'unregister:B', 'register:C',
      'unregister:C', 'register:A',
    ]);

    // Release B and C's dead continuations so nothing is left dangling; both must be no-ops now
    // that their effects were long since cancelled.
    bGate.resolve();
    cGate.resolve();
    await waitFor(() => expect(registerSystemsB).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(registerSystemsC).toHaveBeenCalledTimes(1));
  });

  it('a same-id re-entry into a game that owns registered state but never went active (no pending teardown) must not tear itself down', async () => {
    // Pins the `prevGameId !== gameId` half of the teardown guard's condition. Mutating that
    // condition to a bare `if (prevGameId)` passes the rest of this suite unchanged — every
    // OTHER case here reaches the block with `prevGameId` already different from the incoming
    // `gameId` (an ordinary swap) or with a `pendingTeardown` already in flight (the #516
    // swap-back), both of which the bare form still gets right. The one case it gets wrong is
    // this one: `prevGameId === gameId` with `pendingTeardown === null`.
    //
    // That state is reachable from ordinary prop changes alone, no React internals required: a
    // game's OWN first boot parks (claims `registeredGameIdRef` synchronously, before
    // `activeGameIdRef` is ever set), the player is routed through an UNKNOWN game id (which
    // returns before touching any of `activeGameIdRef`/`registeredGameIdRef`/`teardownRef` —
    // `findGame` fails first — but its mount still cancels the parked continuation via that
    // effect's own cleanup), then back to the same game. `activeGameIdRef` is still null (the
    // first attempt never finished), so this passes the top-level
    // `activeGameIdRef.current === gameId` early return; `registeredGameIdRef` is still this
    // game's id from the parked first attempt; `teardownRef` is null (nothing was ever torn
    // down). The mutated condition reads that as an ordinary swap-away-from-itself and calls
    // `unregisterSystems()` / `clearAppServices()` on the very game it is booting into.
    const aGate = deferred<void>();
    const unregisterSystemsA = vi.fn(async () => {});
    const registerSystemsA = vi.fn(() => aGate.promise);
    const defA: GameDefinition = {
      id: 'game-a',
      name: 'game-a',
      registerSystems: registerSystemsA,
      unregisterSystems: unregisterSystemsA,
      loadConfig: async () => baseConfig,
    };
    if (!registerDynamicGame(defA)) throw new Error('test setup: could not register game "game-a"');

    // First mount of 'A': parks inside `registerSystems`, before A ever reaches
    // `activeGameIdRef`. `registeredGameIdRef` claims 'game-a' synchronously before that await.
    const { rerender } = render(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Detour through an unknown game id — cancels A's parked continuation via cleanup, but
    // touches none of the refs itself.
    rerender(React.createElement(GameShell, { gameId: 'unregistered-game' }));
    await waitFor(() => expect(screen.getByText('Unknown game: "unregistered-game"')).toBeTruthy(), { timeout: 5000 });

    // Back to 'game-a' — a genuine new effect invocation, reached via a real gameId change on
    // both sides (game-a → unregistered-game → game-a), not a same-value re-render.
    rerender(React.createElement(GameShell, { gameId: 'game-a' }));
    await waitFor(() => expect(registerSystemsA).toHaveBeenCalledTimes(2), { timeout: 5000 });

    expect(unregisterSystemsA).not.toHaveBeenCalled();
    expect(spies.clearAppServices).not.toHaveBeenCalled();

    aGate.resolve();
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
    expect(registerSystemsA).toHaveBeenCalledTimes(2);
    expect(unregisterSystemsA).not.toHaveBeenCalled();
    expect(spies.clearAppServices).not.toHaveBeenCalled();
  });
});
