/** Pins #334: `GameShell` must not hide the `LoadingOverlay` — and so reveal the game's permanent
 *  HUD — until the renderer has actually PAINTED a frame of the scene that just swapped in.
 *
 *  The bug: the reveal was gated on a fixed two-`requestAnimationFrame` wait past the swap, while
 *  `liveCompileGate` holds `Scene3D`'s submit for however long the post-swap live compile takes.
 *  On a Galaxy A23 cold-booting `demos/forest-camp` that meant title text + D-pad controls sitting
 *  over a flat dark canvas with nothing 3D drawn, for most of a second.
 *
 *  Like `gameShellLoadOnce.test.tsx`, this can only be pinned by rendering the real component: the
 *  property is the ORDER of awaits inside a React effect. Everything GameShell imports is mocked at
 *  the leaf; GameShell and React's scheduling are real. `waitForScenePaint` is mocked to a deferred
 *  the test resolves by hand, standing in for the compile hold. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import React from 'react';

const spies = vi.hoisted(() => {
  /** Resolver for the pending `waitForScenePaint` call, so the test decides when the renderer
   *  "painted". Null until GameShell actually calls it — which is itself the assertion for the
   *  no-3D case. */
  let release: ((outcome: string) => void) | null = null;
  const waitForScenePaint = vi.fn((_opts?: unknown) => new Promise<string>((r) => { release = r; }));
  return {
    loadScene: vi.fn(async () => {}),
    checkAppOtaUpdate: vi.fn(async () => true),
    waitForScenePaint,
    releaseScenePaint: (outcome = 'painted') => { release?.(outcome); release = null; },
    isWaiting: () => release !== null,
  };
});

/** Set per test before rendering — GameShell reads it through the mocked `loadConfig`. */
const config = vi.hoisted(() => ({ disable3D: false as boolean, scenePath: '/scene.json' as string | undefined }));

vi.mock('@modoki/engine/runtime', () => ({
  useGameLoop: () => {},
  setGameConfig: vi.fn(),
  sceneManager: { loadScene: spies.loadScene },
  ensureManifestLoaded: vi.fn(async () => {}),
  resolveSceneByName: vi.fn(() => undefined),
  assetUrl: (p: string) => p,
  appServices: () => ({ attribution: { init: vi.fn() }, ads: { init: vi.fn(), cleanup: vi.fn() } }),
  clearAppServices: vi.fn(),
  getCurrentWorld: vi.fn(() => ({})),
  PlayerPrefs: { init: vi.fn(async () => ({ discardedPending: [] })), flush: vi.fn(async () => {}) },
  selectDefaultBackend: vi.fn(() => 'memory'),
  audioDispose: vi.fn(),
  audioResume: vi.fn(),
  VideoOverlay: () => null,
  onTierSwitchOverlay: vi.fn(() => () => {}),
  waitForScenePaint: spies.waitForScenePaint,
}));

vi.mock('@modoki/engine/runtime/debug', () => ({ DebugMenu: () => null }));
vi.mock('@modoki/engine/runtime/rendering/Game', () => ({ default: () => null }));
vi.mock('@modoki/engine/runtime/rendering/Scene3D', () => ({ default: () => null }));
vi.mock('@modoki/engine/runtime/rendering/tierBoot', () => ({
  resolveTierForNo3DProject: vi.fn(async () => {}),
  resolveTierBeforeSceneLoad: vi.fn(async () => {}),
  stopTierCalibrationForNo3DProject: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock('../../app/ecs/init', () => ({ initWorldSync: vi.fn() }));
vi.mock('../../app/ecs/pipeline', () => ({ runPipeline: vi.fn() }));
vi.mock('../../app/ota', () => ({
  checkAppOtaUpdate: spies.checkAppOtaUpdate,
  subscribeOtaGate: vi.fn(() => () => {}),
  isPluginUnimplemented: () => true,
}));
vi.mock('../../app/subgameLoader', () => ({ loadStagedSubgames: vi.fn(async () => {}) }));
vi.mock('../../app/useWebCanvasSizing', () => ({
  useWebCanvasSizing: () => ({ letterboxed: false, cssWidth: 0, cssHeight: 0 }),
}));
vi.mock('../../app/hooks/useKeyboardShift', () => ({ useKeyboardShift: () => {} }));
vi.mock('../../app/ui/DefaultGameUILayer', () => ({ DefaultGameUILayer: () => null }));
vi.mock('../../app/ui/components/ErrorBoundary', () => ({
  setActiveResetPhase: vi.fn(),
  default: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
vi.mock('../../app/ui/components/EditorBootBoundary', () => ({
  EditorBootBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
// The overlay's presence IS the thing under test — render a queryable marker for it.
vi.mock('../../app/ui/components/LoadingOverlay', () => ({
  default: ({ visible }: { visible?: boolean }) =>
    visible ? React.createElement('div', { 'data-testid': 'loading-overlay' }) : null,
}));
vi.mock('../../app/ui/components/OtaRestartGate', () => ({ default: () => null }));

import { GameShell } from '../../app/App';
import { registerDynamicGame, __resetGameRegistryForTest } from '../../app/gameRegistry';
import type { GameDefinition } from '@modoki/engine/runtime';

function makeGame(id: string): GameDefinition {
  const def: GameDefinition = {
    id,
    name: id,
    loadConfig: async () => ({
      assetManifest: '/assets.manifest.json',
      scenePath: config.scenePath,
      disable3D: config.disable3D,
    } as never),
  } as GameDefinition;
  if (!registerDynamicGame(def)) throw new Error(`test setup: could not register game "${id}"`);
  return def;
}

afterEach(() => {
  cleanup();
  __resetGameRegistryForTest();
  vi.clearAllMocks();
  config.disable3D = false;
  config.scenePath = '/scene.json';
  spies.releaseScenePaint(); // never leave a deferred parked for the next test
});

describe('GameShell first-paint gating (#334)', () => {
  it('keeps the loading overlay up until the renderer reports a painted frame', async () => {
    makeGame('paint-game');
    render(React.createElement(GameShell, { gameId: 'paint-game' }));

    // The boot sequence must reach the readiness wait…
    await waitFor(() => expect(spies.waitForScenePaint).toHaveBeenCalled(), { timeout: 5000 });

    // …and then STOP there. Give React and the rAF-based waits ample opportunity to run: the
    // pre-fix code would have hidden the overlay after two frames regardless.
    for (let i = 0; i < 10; i++) await new Promise<void>(r => requestAnimationFrame(() => r()));
    expect(screen.queryByTestId('loading-overlay')).not.toBeNull();

    // The compile settles and the renderer submits — now, and only now, the game is revealed.
    spies.releaseScenePaint('painted');
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
  });

  it('reveals the game anyway when the readiness wait times out — the overlay can never stick', async () => {
    makeGame('slow-game');
    render(React.createElement(GameShell, { gameId: 'slow-game' }));
    await waitFor(() => expect(spies.waitForScenePaint).toHaveBeenCalled(), { timeout: 5000 });
    expect(screen.queryByTestId('loading-overlay')).not.toBeNull();
    // The render layer's own 5 s ceiling has fired and it gave up; the DOM layer must follow it
    // rather than holding an overlay over a game that is now drawing (whatever it is drawing).
    spies.releaseScenePaint('timeout');
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
  });

  it('passes the boot effect\'s abort signal, so a cancelled load drops the waiter', async () => {
    makeGame('cancel-game');
    const { unmount } = render(React.createElement(GameShell, { gameId: 'cancel-game' }));
    await waitFor(() => expect(spies.waitForScenePaint).toHaveBeenCalled(), { timeout: 5000 });
    const arg = spies.waitForScenePaint.mock.calls[0][0] as { signal?: AbortSignal } | undefined;
    expect(arg?.signal).toBeInstanceOf(AbortSignal);
    expect(arg!.signal!.aborted).toBe(false);
    unmount();
    expect(arg!.signal!.aborted).toBe(true);
  });

  it('a NO-3D project never waits on a signal nothing will ever fire', async () => {
    // `disable3D` (and, equivalently, a build with `Scene3D` DCE'd) means no render surface exists
    // to arm or mark the paint signal. Awaiting it there would buy a 5 s stall on every boot.
    config.disable3D = true;
    makeGame('flat-game');
    render(React.createElement(GameShell, { gameId: 'flat-game' }));
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
    expect(spies.waitForScenePaint).not.toHaveBeenCalled();
  });

  it('a project with no boot scene never waits either — no swap means nothing armed', async () => {
    config.scenePath = undefined;
    makeGame('sceneless-game');
    render(React.createElement(GameShell, { gameId: 'sceneless-game' }));
    await waitFor(() => expect(screen.queryByTestId('loading-overlay')).toBeNull(), { timeout: 5000 });
    expect(spies.loadScene).not.toHaveBeenCalled();
    expect(spies.waitForScenePaint).not.toHaveBeenCalled();
  });
});
