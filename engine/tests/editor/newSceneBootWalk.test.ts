/** #1593 — Create Scene must not be overwritten by the editor's boot scene walk.
 *
 *  The walk (`createEditor`'s `sceneReady`) is a chain of awaits, and only the stretch INSIDE `loadScene` was
 *  visible to any guard. A `new_scene` landing in one of the walk's gaps answered ok, and the walk's own load then
 *  replaced its world ~80 ms later (reproduced live on demos/2d-physics-demo). The owner's ruling: WAIT for the walk,
 *  then run — the request somebody made is the newer intent and must land last. A `loadScene` somebody started is a
 *  competing intent that `newScene` cannot supersede, so that one is REFUSED.
 *
 *  The other half: a switch that is NOT gated (a user/agent `loadScene`, a prefab edit-open) landing in a gap is
 *  left standing — the walk's `load` yields to it instead of loading the next candidate over it.
 *
 *  `SceneManager` is mocked so `replaceWorldContent` and `loadScene` record their ORDER — the order of world
 *  replacements is the whole defect. `prefabEditWorld` is mocked to a flag (a real prefab-edit world needs a
 *  prefab file). `newScene`, `loadScene` and the walk are the real ones. */

import { describe, it, expect, vi, afterEach } from 'vitest';

const sm = vi.hoisted(() => ({
  order: [] as string[],
  holdLoad: null as Promise<void> | null,
  prefabEdit: false,
  current: null as { path: string } | null,
  /** Model SceneManager's cancel: a newer `loadScene` rejects the one in flight with an AbortError AT ITS START. */
  abortPrevious: false,
  abortInFlight: null as (() => void) | null,
}));
vi.mock('../../packages/modoki/src/editor/scene/prefabEditWorld', async (orig) => ({
  ...(await orig<object>()),
  isPrefabEditWorld: () => sm.prefabEdit,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async () => {
  const { getCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
  return {
    sceneManager: {
      getCurrent: () => sm.current,
      getNext: () => null,
      getCurrentBaseScene: () => undefined,
      getLoadedScenes: () => new Map(),
      loadScene: async (path: string) => {
        if (sm.abortPrevious) sm.abortInFlight?.();
        const aborted = new Promise<never>((_, reject) => {
          sm.abortInFlight = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
        aborted.catch(() => {});
        if (sm.holdLoad) await (sm.abortPrevious ? Promise.race([sm.holdLoad, aborted]) : sm.holdLoad);
        if (path.includes('missing')) throw new Error(`404 ${path}`);
        sm.order.push(`load ${path}`);
        sm.current = { path };
        return { keptBaseGuids: new Set<string>() };
      },
      replaceWorldContent: async (populate: (w: unknown) => void) => {
        populate(getCurrentWorld());
        sm.order.push('new-scene');
        sm.current = null; // replaceWorldContent clears loadedScenes
      },
    },
  };
});

import { createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  newScene, loadScene, beginBootSceneWalk, bootSceneWalkPending, NewSceneRefusedError, type BootSceneWalk,
  getCurrentScenePath, setCurrentScenePath,
} from '../../packages/modoki/src/editor/scene/serialize';
import { beginWorldSwitch } from '../../packages/modoki/src/editor/undo/undoManager';
import { loadFirstScene } from '../../packages/modoki/src/editor/createEditor';

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
registerAllTraits();

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
let game: TestWorld | undefined;
let walk: BootSceneWalk | null = null;
afterEach(async () => {
  walk?.release(); walk = null;
  sm.holdLoad = null; sm.prefabEdit = false; sm.current = null; sm.abortPrevious = false; sm.abortInFlight = null;
  await settle();
  sm.order.length = 0;
  setCurrentScenePath(null);
  game?.dispose(); game = undefined;
});

describe('newScene vs the boot scene walk (#1593)', () => {
  it('a newScene started inside the walk WAITS, and replaces the world AFTER the walk\'s own load', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();

    // The race as observed: Create Scene lands in a gap, BEFORE the walk's load has started.
    let done = false;
    const created = newScene().then(() => { done = true; });
    await settle();
    expect(done, 'newScene must not run while the boot walk is pending').toBe(false);
    expect(sm.order).toEqual([]);

    // The walk's load lands, then the walk ends.
    expect(await walk.load('/boot')).toBe('loaded');
    walk.release(); walk = null;
    await created;

    expect(sm.order).toEqual(['load /boot', 'new-scene']);
  });

  it('ACCEPT SIDE: with no walk pending, newScene runs straight away', async () => {
    game = createTestWorld({});
    expect(bootSceneWalkPending()).toBeNull();
    await newScene();
    expect(sm.order).toEqual(['new-scene']);
  });

  it('a newScene while a loadScene is in flight is REFUSED, and replaces nothing', async () => {
    game = createTestWorld({});
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });
    const loading = loadScene('/other');
    await settle();

    await expect(newScene()).rejects.toThrow(NewSceneRefusedError);
    await expect(newScene()).rejects.toThrow(/still loading/);
    unhold();
    expect(await loading).toBe('loaded');
    expect(sm.order).toEqual(['load /other']);
  });

  it('a refused newScene releases its latch — the next one runs', async () => {
    game = createTestWorld({});
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });
    const loading = loadScene('/other');
    await settle();
    await expect(newScene()).rejects.toThrow(NewSceneRefusedError);
    unhold(); await loading;

    await newScene();
    expect(sm.order).toEqual(['load /other', 'new-scene']);
  });

  it('a stale walk release does not open the gate under a newer walk', async () => {
    const first = beginBootSceneWalk();
    const second = beginBootSceneWalk();
    first.release();
    expect(bootSceneWalkPending()).not.toBeNull();
    second.release();
    expect(bootSceneWalkPending()).toBeNull();
  });

  it('a prefab edit-open that won while newScene waited on the walk → newScene is REFUSED after the wait', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    const created = newScene();
    await settle();
    sm.prefabEdit = true; // an edit-open landed in a walk gap; the walk yields to it
    sm.current = { path: '__prefab-edit__/p' };
    walk.release(); walk = null;
    await expect(created).rejects.toThrow(/while editing a prefab/);
    expect(sm.order).toEqual([]);
  });
});

describe('the boot walk yields to a switch it did not make (#1593 siblings)', () => {
  it('a user loadScene in a walk gap: the walk\'s next candidate is NOT loaded over it', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    expect(await loadScene('/user')).toBe('loaded'); // lands between the walk's awaits
    expect(walk.overtaken()).toBe(true);
    expect(await walk.load('/boot')).toBe('superseded');
    expect(sm.order).toEqual(['load /user']);
  });

  it('a prefab edit-open in a walk gap: the walk loads nothing over it', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    sm.prefabEdit = true;
    sm.current = { path: '__prefab-edit__/p' };
    expect(walk.overtaken()).toBe(true);
    expect(await walk.load('/boot')).toBe('superseded');
    expect(sm.order).toEqual([]);
  });

  it('ACCEPT SIDE: the walk\'s OWN loads do not overtake it — a second candidate still loads', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    expect(await walk.load('/a')).toBe('loaded');
    expect(walk.overtaken()).toBe(false);
    expect(await walk.load('/b')).toBe('loaded');
    expect(sm.order).toEqual(['load /a', 'load /b']);
  });

  it('a user load that supersedes the walk\'s load MID-FLIGHT also overtakes it', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });
    const boot = walk.load('/boot');
    const user = loadScene('/user');
    unhold();
    expect(await boot).toBe('superseded');
    expect(await user).toBe('loaded');
    expect(walk.overtaken()).toBe(true);
  });

  it('a foreign load that FAILED in a gap does not overtake the walk — the next candidate still loads (no scene-less boot)', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    expect(await loadScene('/missing-typo')).toBe('failed');
    expect(walk.overtaken()).toBe(false);
    expect(await walk.load('/boot')).toBe('loaded');
    expect(sm.order).toEqual(['load /boot']);
  });

  it('a newScene that waited on a walk which yielded to a scene opened meanwhile is REFUSED — the open stands', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    const created = newScene();
    await settle();
    expect(await loadScene('/user')).toBe('loaded'); // the user opens X in a gap
    expect(await walk.load('/boot')).toBe('superseded');
    walk.release(); walk = null;
    await expect(created).rejects.toThrow(/opened while the editor was starting/);
    expect(sm.order).toEqual(['load /user']);
  });
});

/** #1598 — the walk's "did a foreign scene win" check could not see a switch still IN FLIGHT: it had installed
 *  nothing yet. So the walk waits for the registry of pending switches (`worldSwitchesSettled`) to drain, THEN asks
 *  the world. A switch registers at its top — a prefab edit-open before its fetch — which `beginWorldSwitch` stands in
 *  for here. */
describe('the boot walk waits for a switch still in flight, then decides (#1598)', () => {
  it('a foreign loadScene still in flight when the walk\'s next candidate starts: the walk waits, then yields', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });
    const user = loadScene('/user');
    await settle();

    let bootOutcome: string | undefined;
    const boot = walk.load('/boot').then((o) => { bootOutcome = o; return o; });
    await settle();
    expect(bootOutcome, 'the walk must not start its candidate over a load in flight').toBeUndefined();

    unhold();
    expect(await user).toBe('loaded');
    expect(await boot).toBe('superseded');
    expect(sm.order).toEqual(['load /user']);
  });

  it('a prefab edit-open mid-fetch that then LANDS: the walk waits, then loads nothing over it', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    const prefabOpen = beginWorldSwitch(); // `openPrefabForEditing`'s top, before its fetch
    const boot = walk.load('/boot');
    await settle();
    expect(sm.order).toEqual([]);

    sm.prefabEdit = true;
    sm.current = { path: '__prefab-edit__/p' }; // its direct `sceneManager.loadScene` swapped
    prefabOpen.release();
    expect(await boot).toBe('superseded');
    expect(sm.order).toEqual([]);
  });

  it('ACCEPT SIDE: a prefab edit-open that FAILS mid-fetch installs nothing — the walk then loads its candidate (no scene-less boot)', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    const prefabOpen = beginWorldSwitch();
    const boot = walk.load('/boot');
    await settle();
    expect(sm.order).toEqual([]);

    prefabOpen.release(); // the fetch failed: nothing swapped
    expect(await boot).toBe('loaded');
    expect(sm.order).toEqual(['load /boot']);
  });

  it('settle() before the persist/fallback: a foreign load that superseded the walk is waited for, then wins — no initWorld under it', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });
    const user = loadScene('/user'); // nothing is current yet: `overtaken()` alone answers false here

    let won: boolean | undefined;
    const settled = walk.settle().then((v) => { won = v; });
    await settle();
    expect(won, 'settle must wait for the load in flight').toBeUndefined();

    unhold();
    await user;
    await settled;
    expect(won).toBe(true);
  });

  it('ACCEPT SIDE: settle() with nothing in flight answers at once, from the world', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    expect(await walk.settle()).toBe(false);
    expect(await walk.load('/boot')).toBe('loaded');
    expect(await walk.settle()).toBe(false);
  });
});

/** #1598 close-out review — the seam production drives: `loadFirstScene` over `walk.load`, where a foreign load
 *  CANCELS the walk's own (SceneManager aborts it at the newer call's start) while nothing is current yet. */
describe('loadFirstScene over the walk: a cancelled candidate settles before it answers (#1598 review)', () => {
  const walkDeps = (w: BootSceneWalk) => ({
    canonicalize: async (p: string) => p,
    load: (p: string) => w.load(p),
    settle: () => w.settle(),
  });

  it('a foreign open of the SAME scene cancels the walk\'s load: the answer is that scene, not null (no initWorld into it)', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    sm.abortPrevious = true;
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });

    const booted = loadFirstScene(['/x'], walkDeps(walk));
    await settle();
    const user = loadScene('/x'); // the same scene, opened by hand — cancels the walk's load
    await settle();
    unhold();

    expect(await user).toBe('loaded');
    expect(await booted, 'null here makes createEditor run initWorld into the loaded scene').toBe('/x');
    expect(sm.order).toEqual(['load /x']);
  });

  it('a foreign load that cancels the walk\'s load and then FAILS: the walk retries its candidate (no fallback over a loadable scene)', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    sm.abortPrevious = true;
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });

    const booted = loadFirstScene(['/a'], walkDeps(walk));
    await settle();
    const user = loadScene('/missing-typo'); // cancels the walk's load, then 404s
    await settle();
    sm.abortPrevious = false; // the retry below is not cancelled by anything
    unhold();

    expect(await user).toBe('failed');
    expect(await booted).toBe('/a');
    expect(sm.order).toEqual(['load /a']);
  });

  it('a foreign load of ANOTHER scene that cancels the walk\'s load: the answer is that scene, and the walk is overtaken', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    sm.abortPrevious = true;
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });

    const booted = loadFirstScene(['/boot'], walkDeps(walk));
    await settle();
    const user = loadScene('/user');
    await settle();
    unhold();

    expect(await user).toBe('loaded');
    expect(await booted).toBe('/user');
    expect(await walk.settle()).toBe(true);
    expect(sm.order).toEqual(['load /user']);
  });

  it('superseded in its POST-SWAP tail by a foreign load that then fails: the swapped-but-unadopted candidate is re-loaded, not reported as loaded', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    let unhold!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold = r; });

    const booted = loadFirstScene(['/a'], walkDeps(walk));
    await settle();
    const user = loadScene('/missing-typo'); // nothing aborts: the walk's swap lands, then its tail sees the newer epoch
    await settle();
    sm.holdLoad = null;
    unhold();

    expect(await user).toBe('failed');
    expect(await booted).toBe('/a');
    expect(getCurrentScenePath(), 'the editor must have ADOPTED the scene it reports as loaded').toBe('/a');
    expect(sm.order).toEqual(['load /a', 'load /a']);
  });

  it('a retry cancelled AGAIN by a second failing load: the walk moves on to the next candidate, not the fallback', async () => {
    game = createTestWorld({});
    walk = beginBootSceneWalk();
    sm.abortPrevious = true;
    let unhold1!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold1 = r; });

    const booted = loadFirstScene(['/a', '/b'], walkDeps(walk));
    await settle();
    const user1 = loadScene('/missing-1'); // cancels '/a', then fails
    await settle();
    let unhold2!: () => void;
    sm.holdLoad = new Promise<void>((r) => { unhold2 = r; });
    unhold1();
    expect(await user1).toBe('failed');
    await settle(); // the retry of '/a' is now in flight, held
    const user2 = loadScene('/missing-2'); // cancels the retry, then fails
    await settle();
    sm.abortPrevious = false;
    sm.holdLoad = null;
    unhold2();

    expect(await user2).toBe('failed');
    expect(await booted).toBe('/b');
    expect(sm.order).toEqual(['load /b']);
  });
});
