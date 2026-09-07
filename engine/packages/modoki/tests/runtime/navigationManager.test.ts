/** NavigationManager — scene navigation + history.
 *
 *  ⚠️ The harness drives a REAL world swap, and that is load-bearing rather than
 *  realism for its own sake. History is recorded by `onSwap` (#808), so a mock that
 *  only resolves `sceneManager.loadScene` exercises nothing at all — the previous
 *  version of this file mocked exactly that and could not see the defect class that
 *  three successive repairs shipped. `commitSwap` is exposed so a test can put the
 *  swap and the promise resolution at DIFFERENT points, which is the post-swap-tail
 *  window where two successful navigations interleave.
 *
 *  `sceneManager` is mocked (routing + `getCurrent`); `worldRegistry` is NOT, so the
 *  swap the manager subscribes to is the real one. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';

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
import { setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';
import { SceneFormatRefusedError } from '../../src/runtime/loaders/loadSceneFile';

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Advance the world without pretending to arrive anywhere (test isolation only). */
function commitSwapNoop(): void {
  worldIdx ^= 1;
  setCurrentWorld(WORLDS[worldIdx]);
}

/** The scene becomes live: `getCurrent()` reports it and a real world swap fires.
 *  Mirrors SceneManager, which sets `loadedScenes`/`primaryId` BEFORE `setCurrentWorld`. */
// koota caps total worlds at 16, so alternate between two rather than minting one per
// swap — `setCurrentWorld` no-ops on identity, so toggling is what makes the swap fire.
const WORLDS = [createWorld(), createWorld()];
let worldIdx = 0;
function commitSwap(path: string): void {
  currentPath = path;
  worldIdx ^= 1;
  setCurrentWorld(WORLDS[worldIdx]);
}

/** Arrive at a scene by a route this manager did NOT drive (boot, hot-reload). It must
 *  advance the manager's `from` tracking without recording any history. */
function arriveAt(path: string): void {
  commitSwap(path);
}

/** The default: a load that swaps and then resolves, with no gap between them. */
function resolvingLoad() {
  return async (path: string) => { commitSwap(path); };
}

describe('NavigationManager', () => {
  beforeEach(() => {
    setPlayState('playing');           // dispatchUIAction is gated on the sim running
    loadScene.mockReset();
    loadScene.mockImplementation(resolvingLoad());
    currentPath = null;
    commitSwapNoop(); // settle onto a known world before each test
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
    arriveAt('/scenes/A.json');
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
    arriveAt('/scenes/A.json');
    await navigationManager.replace('/scenes/B.json');
    expect(loadScene).toHaveBeenCalledWith('/scenes/B.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('does not push when navigating to the same scene', async () => {
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('collapses A↔B oscillation so history does not grow unboundedly', async () => {
    arriveAt('/scenes/A.json');
    // 10 full A→B→A cycles. Each forward-nav to the scene we'd back() into pops
    // instead of pushing, so the stack nets zero growth per cycle.
    for (let i = 0; i < 10; i++) {
      await navigationManager.loadScene('/scenes/B.json');
      arriveAt('/scenes/B.json');
      await navigationManager.loadScene('/scenes/A.json');
      arriveAt('/scenes/A.json');
    }
    expect(navigationManager.canGoBack).toBe(false); // back at A with an empty stack

    // One forward nav leaves exactly one entry; a single back() exhausts it.
    await navigationManager.loadScene('/scenes/B.json');
    arriveAt('/scenes/B.json');
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
    arriveAt('/scenes/A.json');
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
    arriveAt('/scenes/A.json');
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

  // ── two navigations that BOTH succeed (#808) ────────────────────────────────
  // The class three successive repairs shipped, and the one nothing could see while
  // this file mocked `loadScene` without a swap. `SceneManager` releases the input
  // lock AT THE SWAP and only throws for a teardown, so a load superseded by a newer
  // LOAD still resolves — its continuation runs after the winner's. Recording at the
  // swap instead of in that continuation is what makes these correct.

  /** Walk the whole stack, returning what `back()` loaded, deepest last. */
  async function drainHistory(): Promise<unknown[]> {
    loadScene.mockClear();
    loadScene.mockImplementation(resolvingLoad());
    const seen: unknown[] = [];
    // Bounded on purpose: a mutation that stops `back()` popping turns an unbounded
    // `while (canGoBack)` into a hang, which reads as an inconclusive run rather than
    // a caught defect. Fail loudly instead. MAX_HISTORY is 50.
    while (navigationManager.canGoBack) {
      if (seen.length > 60) throw new Error(`drainHistory did not terminate — back() is not popping (drained ${seen.length})`);
      await navigationManager.back();
      seen.push(loadScene.mock.calls[loadScene.mock.calls.length - 1][0]);
    }
    return seen;
  }

  it('records BOTH transitions when the first navigation resolves last', async () => {
    arriveAt('/scenes/A.json');
    let finishB!: () => void;
    loadScene.mockImplementationOnce((p: string) => {
      commitSwap(p);                                          // B is live and on screen…
      return new Promise<void>((res) => { finishB = res; });  // …its post-swap tail runs on
    });
    const navB = navigationManager.loadScene('/scenes/B.json');

    // The lock lifted at B's swap, so the player taps on to C, which completes fully.
    await navigationManager.loadScene('/scenes/C.json');
    finishB();
    await navB;

    // The player walked A→B→C. Repair 3 popped here and left the stack EMPTY.
    expect(await drainHistory()).toEqual(['/scenes/B.json', '/scenes/A.json']);
  });

  it('a back() and a forward navigation that both succeed do not corrupt the stack', async () => {
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // ['A']
    await navigationManager.loadScene('/scenes/C.json'); // ['A','B']

    let finishBack!: () => void;
    loadScene.mockImplementationOnce((p: string) => {
      commitSwap(p);
      return new Promise<void>((res) => { finishBack = res; });
    });
    const backP = navigationManager.back();              // swaps to B, tail pending
    await navigationManager.loadScene('/scenes/D.json'); // player taps on to D
    finishBack();
    await backP;

    // Repair 3 popped B here on the late continuation, so Back from D skipped B.
    expect(await drainHistory()).toEqual(['/scenes/B.json', '/scenes/A.json']);
  });

  it('a scene loaded OUTSIDE this manager records nothing but still moves the from-scene', async () => {
    arriveAt('/scenes/A.json');
    arriveAt('/scenes/B.json');   // boot / hot-reload — swaps, but not ours to record
    expect(navigationManager.canGoBack).toBe(false);

    await navigationManager.loadScene('/scenes/C.json');
    // Must push where we ACTUALLY were ('B'), not the stale 'A'.
    expect(await drainHistory()).toEqual(['/scenes/B.json']);
  });

  it('replace() does not record even when a loadScene for the SAME path is in flight', async () => {
    // The previous version of this test had a body identical to the plain replace()
    // test above — no concurrency at all — while its name claimed the property that
    // was actually broken. `replace()` must consume its own swap and record nothing.
    arriveAt('/scenes/A.json');
    loadScene.mockImplementationOnce(() => new Promise<void>(() => {})); // never settles
    const pending = navigationManager.loadScene('/scenes/B.json');       // claims B
    void pending;

    await navigationManager.replace('/scenes/B.json');                   // wins the swap
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('a loadScene that COMMITS records, even with an earlier replace() to the same path pending', async () => {
    // The mirror of the test above, and the direction a "suppress always wins" rule got
    // wrong: a replace() that was itself superseded, whose finally has not run, must not
    // disarm the navigation that actually committed. Tie-break is most-recent-intent.
    arriveAt('/scenes/A.json');
    loadScene.mockImplementationOnce(() => new Promise<void>(() => {})); // replace: never settles
    const stuck = navigationManager.replace('/scenes/B.json');
    void stuck;

    await navigationManager.loadScene('/scenes/B.json'); // starts later, and commits
    expect(navigationManager.canGoBack).toBe(true);
    expect(await drainHistory()).toEqual(['/scenes/A.json']);
  });

  it('a suppressed swap still moves the from-scene', async () => {
    // `lastPath` is updated before the claim is even looked at. If a replace() left it
    // stale, the NEXT navigation would push where we used to be instead of where we are.
    arriveAt('/scenes/A.json');
    await navigationManager.replace('/scenes/B.json');   // records nothing…
    await navigationManager.loadScene('/scenes/C.json'); // …but we left B, not A
    expect(await drainHistory()).toEqual(['/scenes/B.json']);
  });

  it('does not stack the same scene twice when an external load lands on the history top', async () => {
    // pushHistory's consecutive-repeat dedupe. Without it the player needs TWO Back
    // presses to leave one scene, and nothing else in this file measures it.
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // ['A'], on B
    arriveAt('/scenes/A.json');                          // agent load / Play-stop restore
    await navigationManager.loadScene('/scenes/C.json'); // leaving A again

    expect(await drainHistory()).toEqual(['/scenes/A.json']); // one entry, not two
  });

  it('back() into the scene we are ALREADY on consumes its entry', async () => {
    // Reached whenever something outside this manager lands us on the history top —
    // Play-stop restore, prefab undo, an agent load_scene. The swap is then A→A, and
    // guarding on `from === to` before the pop left the entry forever unconsumed, so
    // every later Back reloaded the scene the player was already standing on.
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // ['A'], on B
    await navigationManager.replace('/scenes/A.json');   // back on A, history untouched
    expect(navigationManager.canGoBack).toBe(true);

    await navigationManager.back();
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('two navigations to the SAME path do not share one claim', async () => {
    // A Set keyed by path collapsed these into one entry: the loser's `finally`
    // released it before the winner swapped, so the winner recorded nothing. A
    // superseded load rejects BEFORE its swap (AbortError), so the loser really does
    // settle first — that ordering is the whole defect.
    arriveAt('/scenes/A.json');
    let rejectFirst!: (e: unknown) => void;
    let swapSecond!: () => void;
    loadScene.mockImplementationOnce(() => new Promise<void>((_r, rej) => { rejectFirst = rej; }));
    loadScene.mockImplementationOnce((path: string) => new Promise<void>((res) => {
      swapSecond = () => { commitSwap(path); res(); };
    }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});
    const second = navigationManager.loadScene('/scenes/B.json'); // same path, own claim

    // Ordering IS the defect: the superseded load rejects BEFORE the winner swaps.
    rejectFirst(new SceneFormatRefusedError('superseded', 'too-new'));
    await expect(first).rejects.toBeInstanceOf(SceneFormatRefusedError);
    swapSecond();
    await second;

    // The winner swapped, so leaving A must be recorded.
    expect(navigationManager.canGoBack).toBe(true);
    expect(await drainHistory()).toEqual(['/scenes/A.json']);
  });

  it('two back() presses to the same entry still consume it exactly once', async () => {
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // ['A'], on B

    let rejectFirst!: (e: unknown) => void;
    let swapSecond!: () => void;
    loadScene.mockImplementationOnce(() => new Promise<void>((_r, rej) => { rejectFirst = rej; }));
    loadScene.mockImplementationOnce((path: string) => new Promise<void>((res) => {
      swapSecond = () => { commitSwap(path); res(); };
    }));
    const back1 = navigationManager.back();
    back1.catch(() => {});
    const back2 = navigationManager.back();              // second press, same entry
    rejectFirst(new SceneFormatRefusedError('superseded', 'too-new'));
    await expect(back1).rejects.toBeInstanceOf(SceneFormatRefusedError);
    swapSecond();
    await back2;

    expect(navigationManager.canGoBack).toBe(false);
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
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // pushes A
    expect(navigationManager.canGoBack).toBe(true);

    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.back()).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockImplementationOnce(resolvingLoad());
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);
  });

  it('loadScene() leaves the stack unchanged when its load rejects, and rethrows', async () => {
    arriveAt('/scenes/A.json');
    expect(navigationManager.canGoBack).toBe(false);

    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/B.json')).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(false);
  });

  it('loadScene() does not collapse the oscillation when its load rejects', async () => {
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // pushes A; history = [A]
    arriveAt('/scenes/B.json');

    // Forward-navigating back to A would collapse (pop A) — but only on success.
    const err = new SceneFormatRefusedError('too new', 'too-new');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/A.json')).rejects.toBe(err);

    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockImplementationOnce(resolvingLoad());
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
  });

  // ── supersession, the cases the two earlier repairs got wrong ────────────────

  it('a superseded navigation does not clobber the winner\'s history', async () => {
    arriveAt('/scenes/A.json');
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    loadScene.mockImplementationOnce(resolvingLoad());
    await navigationManager.loadScene('/scenes/C.json'); // wins; pushes A

    const err = new SceneFormatRefusedError('superseded', 'too-new');
    rejectFirst(err);
    await expect(first).rejects.toBe(err);

    // An unconditional restore emptied the stack here, leaving a dead Back button.
    expect(navigationManager.canGoBack).toBe(true);
    loadScene.mockClear();
    loadScene.mockImplementation(resolvingLoad());
    await navigationManager.back();
    expect(loadScene).toHaveBeenCalledWith('/scenes/A.json');
  });

  it('a superseding navigation that mutates NOTHING does not leak the loser\'s push', async () => {
    // The epoch repair's blind spot: navigating to the scene you are already on
    // makes no history mutation, but still claimed the epoch — so the superseded
    // call's push was never undone and Back reloaded the scene you were on.
    arriveAt('/scenes/A.json');
    let rejectFirst: (e: unknown) => void = () => {};
    loadScene.mockImplementationOnce(() => new Promise((_res, rej) => { rejectFirst = rej; }));
    const first = navigationManager.loadScene('/scenes/B.json');
    first.catch(() => {});

    loadScene.mockImplementationOnce(resolvingLoad());
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
    arriveAt('/scenes/A.json');
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
    arriveAt('/scenes/A.json');
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
    arriveAt('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json'); // ['A']
    arriveAt('/scenes/B.json');

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
      loadScene.mockImplementation(resolvingLoad());
      for (let i = 0; i <= n; i++) {
        arriveAt(`/scenes/s${i}.json`);
        await navigationManager.loadScene(`/scenes/s${i + 1}.json`);
      }
    };
    const drain = async () => {
      loadScene.mockClear();
      loadScene.mockImplementation(resolvingLoad());
      const seen: unknown[] = [];
      while (navigationManager.canGoBack) {
        // Bounded — see drainHistory: an unbounded drain turns a non-popping
        // regression into a hung worker instead of a failed assertion.
        if (seen.length > 60) throw new Error(`drain did not terminate — back() is not popping (drained ${seen.length})`);
        await navigationManager.back();
        seen.push(loadScene.mock.calls[loadScene.mock.calls.length - 1][0]);
      }
      return seen;
    };

    // Baseline: overflow the cap with no failure, and record the whole stack.
    await fill(60);
    const baseline = await drain();
    // The fill must actually have hit the cap, or this test proves nothing. BOTH
    // bounds: `< 61` alone is satisfied by an EMPTY stack, so gutting the recorder
    // left this green while 10 other tests reddened.
    expect(baseline.length).toBeLessThan(61);
    expect(baseline.length).toBeGreaterThan(40);

    // Same fill, then a navigation whose push overflows the cap and REJECTS.
    unregisterManager('engine.navigation');
    registerManager(navigationManager);
    await fill(60);
    const err = new SceneFormatRefusedError('too new', 'too-new');
    arriveAt('/scenes/s61.json');
    loadScene.mockRejectedValueOnce(err);
    await expect(navigationManager.loadScene('/scenes/s62.json')).rejects.toBe(err);

    // A failed navigation must leave the stack exactly as it found it.
    expect(await drain()).toEqual(baseline);
  });
});
