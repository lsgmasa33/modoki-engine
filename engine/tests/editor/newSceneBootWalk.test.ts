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
        if (sm.holdLoad) await sm.holdLoad;
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
} from '../../packages/modoki/src/editor/scene/serialize';

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
registerAllTraits();

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
let game: TestWorld | undefined;
let walk: BootSceneWalk | null = null;
afterEach(async () => {
  walk?.release(); walk = null;
  sm.holdLoad = null; sm.prefabEdit = false; sm.current = null;
  await settle();
  sm.order.length = 0;
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
