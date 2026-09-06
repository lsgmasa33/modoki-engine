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
import { dispatchUIAction } from '../../src/runtime/core/actionRegistry';
import { setPlayState } from '../../src/runtime/core/playState';
import { getReadValue, __resetReadSourcesForTesting } from '../../src/runtime/core/readSourceRegistry';
import { SceneFormatRefusedError } from '../../src/runtime/loaders/loadSceneFile';

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

  it('engine.loadScene / engine.navigateBack return a thenable (#466: applyBindings\' trackLockPromise tracks it)', () => {
    // `applyBindings` holds the global input lock open until a 'call' handler's RETURNED
    // promise settles. These two built-ins used to `void` the promise instead of returning it,
    // so the lock lifted on the 300ms floor alone and a double-tap could fire loadScene twice
    // (#435/#468). Assert the action registry actually gets a thenable back, not just that the
    // underlying navigation happened.
    const loadResult = dispatchUIAction('engine.loadScene', { payload: '/scenes/Menu.json' });
    expect(loadResult).toBeInstanceOf(Promise);

    const backResult = dispatchUIAction('engine.navigateBack');
    expect(backResult).toBeInstanceOf(Promise);
  });

  it('exposes canGoBack as a UI read source', async () => {
    expect(getReadValue('canGoBack')).toBe(false);
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json');
    expect(getReadValue('canGoBack')).toBe(true);
  });

  // ── lifecycle, called directly ──────────────────────────────────────────────
  // Every test above drives the manager through registerManager/unregisterManager,
  // so init()/dispose() were only ever exercised transitively — nothing asserted what
  // they do. These call them directly, which is also the no-arg form the interface now
  // declares (#37); before that they inherited ManagerDef's init(ctx: ManagerContext)
  // and a direct call had to fabricate a context the manager never reads.

  it('dispose() clears history and drops the canGoBack read source', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json');
    expect(navigationManager.canGoBack).toBe(true);

    navigationManager.dispose();

    expect(navigationManager.canGoBack).toBe(false);   // history cleared
    expect(getReadValue('canGoBack')).toBeUndefined(); // read source gone
  });

  it('init() re-registers the canGoBack read source after a dispose', () => {
    navigationManager.dispose();
    expect(getReadValue('canGoBack')).toBeUndefined();

    navigationManager.init();

    expect(getReadValue('canGoBack')).toBe(false);
  });

  // ── rejection handling (#808) ────────────────────────────────────────────────
  // sceneManager.loadScene can reject (teardown-race AbortError, HTTP-not-ok,
  // parseAssetJson throw, abort checkpoints, SceneFormatRefusedError) and — most
  // often — because a NEWER navigation superseded it. History is therefore mutated
  // only AFTER the load commits, so a failed navigation leaves no trace to undo.
  // Every case below is about that ordering; each one failed against at least one
  // of the two repair attempts that preceded it (an unconditional restore in a
  // catch, then that restore gated on a supersession epoch).

  it('back() leaves its entry on the stack when the load rejects, and rethrows', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json'); // pushes A
    expect(navigationManager.canGoBack).toBe(true);

    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.back()).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockResolvedValueOnce(undefined);
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('loadScene() leaves the stack unchanged when its load rejects, and rethrows', async () => {
    currentPath = '/scenes/A.json';
    expect(navigationManager.canGoBack).toBe(false);

    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/B.json')).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(false);
  });

  it('loadScene() does not collapse the oscillation when its load rejects', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json'); // pushes A; history = [A]
    currentPath = '/scenes/B.json';

    // Forward-navigating back to A would collapse (pop A) — but only on success.
    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/A.json')).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockResolvedValueOnce(undefined);
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
  });

  // ── supersession, the cases the two earlier repairs got wrong ────────────────

  it('a superseded navigation does not clobber the winner\'s history', async () => {
    currentPath = '/scenes/A.json';
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    loadScene.mockResolvedValueOnce(undefined);
    await navigationManager.loadScene('/scenes/C.json'); // wins; pushes A

    const err = new SceneFormatRefusedError('superseded', 'too-new');
    rejectFirst(err);
    await expect(first).rejects.toBe(err);

    // An unconditional restore emptied the stack here, leaving a dead Back button.
    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockResolvedValue(undefined);
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
  });

  it('a superseding navigation that mutates NOTHING does not leak the loser\'s push', async () => {
    // The epoch repair's blind spot: navigating to the scene you are already on
    // makes no history mutation, but still claimed the epoch — so the superseded
    // call's push was never undone and Back reloaded the scene you were on.
    currentPath = '/scenes/A.json';
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    loadScene.mockResolvedValueOnce(undefined);
    await navigationManager.loadScene('/scenes/A.json'); // current === path: no mutation

    const err = new SceneFormatRefusedError('superseded', 'too-new');
    rejectFirst(err);
    await expect(first).rejects.toBe(err);

    // Nothing ever swapped away from A, so nothing belongs on the stack.
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('two overlapping navigations that BOTH reject leave the stack empty', async () => {
    // The epoch repair's second blind spot: the later call rejected first, so its
    // own restore wrote back a snapshot that still contained the earlier push, and
    // the earlier call's restore was then suppressed as stale.
    currentPath = '/scenes/A.json';
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    const errC = new SceneFormatRefusedError('gone', 'unreadable');
    loadScene.mockRejectedValueOnce(errC);
    await expect(navigationManager.loadScene('/scenes/C.json')).rejects.toBe(errC);

    const errB = new SceneFormatRefusedError('superseded', 'too-new');
    rejectFirst(errB);
    await expect(first).rejects.toBe(errB);

    expect(navigationManager.canGoBack).toBe(false);
  });

  it('an inert back() during an in-flight navigation does not suppress anything', async () => {
    // The epoch repair bumped the counter before back()'s own empty-stack guard, so
    // a no-op back() burned an epoch and suppressed a restore that was owed.
    currentPath = '/scenes/A.json';
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    loadScene.mockClear();
    await navigationManager.back();                 // stack empty → inert
    expect(loadScene).not.toHaveBeenCalled();

    const err = new SceneFormatRefusedError('nope', 'unreadable');
    rejectFirst(err);
    await expect(first).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(false);
  });

  it('a navigation still in flight across dispose() cannot resurrect the stack', async () => {
    currentPath = '/scenes/A.json';
    await navigationManager.loadScene('/scenes/B.json'); // ['A']
    currentPath = '/scenes/B.json';

    let rejectPending: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectPending = rej; }));
    const pending = navigationManager.loadScene('/scenes/C.json');
    pending.catch(() => {});

    navigationManager.dispose();
    expect(navigationManager.canGoBack).toBe(false);

    const err = new SceneFormatRefusedError('nope', 'unreadable');
    rejectPending(err);
    await expect(pending).rejects.toBe(err);

    // The epoch repair restored the PRE-dispose stack here: dispose() clears
    // history without bumping the counter, so the last nav's capture still matched.
    expect(navigationManager.canGoBack).toBe(false);
    navigationManager.init(); // leave the read source registered for afterEach
  });

  it('a rejected navigation at the depth cap leaves the stack exactly as it was', async () => {
    // pushHistory bounds depth by SHIFTING the oldest entry off, so any repair that
    // undid a failed push with a bare pop() restored the wrong end. Asserted
    // DIFFERENTIALLY against a clean fill, so it carries no copy of MAX_HISTORY.
    const fill = async (n: number) => {
      loadScene.mockResolvedValue(undefined);
      for (let i = 0; i <= n; i++) {
        currentPath = `/scenes/s${i}.json`;
        await navigationManager.loadScene(`/scenes/s${i + 1}.json`);
      }
    };
    const drain = async () => {
      loadScene.mockClear();
      loadScene.mockResolvedValue(undefined);
      const seen: unknown[] = [];
      while (navigationManager.canGoBack) {
        await navigationManager.back();
        seen.push(loadScene.mock.calls[loadScene.mock.calls.length - 1][0]);
      }
      return seen;
    };

    // Baseline: overflow the cap with no failure, and record the whole stack.
    await fill(60);
    const baseline = await drain();
    // The fill must actually have hit the cap, or this test proves nothing.
    expect(baseline.length).toBeLessThan(61);

    // Same fill, then a navigation whose push overflows the cap and REJECTS.
    unregisterManager('engine.navigation');
    registerManager(navigationManager);
    await fill(60);
    const err = new SceneFormatRefusedError('too new', 'too-new');
    currentPath = '/scenes/s61.json';
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/s62.json')).rejects.toBe(err);

    // A failed navigation must leave the stack exactly as it found it.
    expect(await drain()).toEqual(baseline);
  });
});
