/** NavigationManager — scene navigation + history. SceneManager.loadScene and
 *  the GUID resolver are mocked so we exercise the manager's routing, history
 *  stack, and built-in actions in isolation. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadScene = vi.fn();
let currentPath: string | null = null;

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    loadScene: (...args: unknown[]) => loadScene(...args),
    getCurrent: () => (currentPath ? { id: 1, path: currentPath, state: 'active' } : null),
  },
}));

vi.mock('../../src/runtime/loaders/assetManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/loaders/assetManifest')>();
  return {
    ...actual,
    resolveGuidToPath: (guid: string) =>
      guid === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' ? '/games/x/scenes/Other.json' : undefined,
  };
});

import { navigationManager } from '../../src/runtime/managers/NavigationManager';
import { registerManager, unregisterManager } from '../../src/runtime/managers/managerRegistry';
import { dispatchUIAction } from '../../src/runtime/ui/actionRegistry';
import { setPlayState } from '../../src/runtime/systems/playState';
import { getReadValue, __resetReadSourcesForTesting } from '../../src/runtime/ui/readSourceRegistry';

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('NavigationManager', () => {
  beforeEach(() => {
    setPlayState('playing');           // dispatchUIAction is gated on the sim running
    loadScene.mockClear();
    currentPath = null;
    __resetReadSourcesForTesting();
    registerManager(navigationManager); // activates → init() registers canGoBack, folds in actions
  });
  afterEach(() => {
    unregisterManager('engine.navigation'); // dispose() clears history
    setPlayState('playing');
  });

  it('loadScene routes a raw path through SceneManager; no history without a current scene', async () => {
    await navigationManager.loadScene('/scenes/Menu.json');
    expect(loadScene).toHaveBeenCalledWith('/scenes/Menu.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('resolves a GUID ref via the manifest', async () => {
    await navigationManager.loadScene(GUID);
    expect(loadScene).toHaveBeenCalledWith('/games/x/scenes/Other.json');
  });

  it('warns and does nothing on empty / unresolvable refs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await navigationManager.loadScene('   ');
    await navigationManager.loadScene('ffffffff-0000-0000-0000-000000000000');
    expect(loadScene).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('pushes the current scene onto history and back() returns to it', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json');
    expect(navigationManager.canGoBack).toBe(true);

    loadScene.mockClear();
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('back() at the root is inert', async () => {
    await navigationManager.back();
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('replace() navigates without recording history', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.replace('/scenes/B.json');
    expect(loadScene).toHaveBeenCalledWith('/scenes/B.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('does not push when navigating to the same scene', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('collapses A↔B oscillation so history does not grow unboundedly', async () => {
    currentPath = '/scenes/A.json';
    // 10 full A→B→A cycles. Each forward-nav to the scene we'd back() into pops
    // instead of pushing, so the stack nets zero growth per cycle.
    for (let i = 0; i < 10; i++) {
      await navigationManager.loadScene('/scenes/B.json');
      currentPath = '/scenes/B.json';
      await navigationManager.loadScene('/scenes/A.json');
      currentPath = '/scenes/A.json';
    }
    expect(navigationManager.canGoBack).toBe(false); // back at A with an empty stack

    // One forward nav leaves exactly one entry; a single back() exhausts it.
    await navigationManager.loadScene('/scenes/B.json');
    currentPath = '/scenes/B.json';
    loadScene.mockClear();
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('exposes built-in actions: engine.loadScene + engine.navigateBack', () => {
    dispatchUIAction('engine.loadScene', { payload: '/scenes/Menu.json' });
    expect(loadScene).toHaveBeenCalledWith('/scenes/Menu.json');

    loadScene.mockClear();
    expect(() => dispatchUIAction('engine.navigateBack')).not.toThrow(); // empty history → inert
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('exposes canGoBack as a UI read source', async () => {
    expect(getReadValue('canGoBack')).toBe(false);
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json');
    expect(getReadValue('canGoBack')).toBe(true);
  });
});
