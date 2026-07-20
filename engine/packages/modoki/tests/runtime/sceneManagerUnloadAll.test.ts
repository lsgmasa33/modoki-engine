/** SceneManager.unloadAll() teardown + preloaded-data aliasing.
 *
 *  F1 — unloadAll() must dispose the active scene/game managers (like a normal
 *  swap does) and reset the manager registry's active scope state. Before the
 *  fix it released resources + installed an empty world but skipped manager
 *  dispose entirely, leaking subscriptions/owned-actions and leaving a stale
 *  activeGameId so the NEXT loadScene mis-computes `gameChanged`.
 *
 *  F3 — loadScene() must treat `opts.preloaded` as caller-owned + read-only; it
 *  shallow-clones before rewriting `data.resources` / `data.version`, so a caller
 *  that holds onto the parsed object (dev hot-reload / agent validate-then-load)
 *  doesn't get it silently mutated.
 *
 *  Mirrors sceneManagerLifecycle.test.ts: drives the real sceneManager.loadScene
 *  via `preloaded` (no fetch / resource worlds), own module graph + fresh koota
 *  counter (koota caps live worlds at 16). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number' }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
  };
});

const sceneOf = (name: string) => ({
  version: 8, // current SCENE_FORMAT_VERSION → no in-place migration runs
  resources: [],
  entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name, parentId: 0 } } }],
});

beforeEach(async () => {
  vi.resetModules();
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;
});

async function setup() {
  const scene = await import('../../src/runtime/scene/SceneManager');
  scene.sceneManager.resetForTesting();
  const managers = await import('../../src/runtime/managers/managerRegistry');
  managers.__resetManagersForTesting();
  const world = await import('../../src/runtime/ecs/world');
  return { sceneManager: scene.sceneManager, managers, getCurrentWorld: world.getCurrentWorld };
}

describe('SceneManager.unloadAll — F1 manager dispose + scope reset', () => {
  it('disposes active scene + game managers and clears active scopes', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const sceneDispose = vi.fn();
    const gameDispose = vi.fn();
    managers.registerManager({
      name: 'sceneMgr', scenes: ['scene'], dispose: sceneDispose,
    });
    managers.registerManager({
      name: 'gameMgr', scope: 'game', games: ['space'], dispose: gameDispose,
    });

    // Load a scene in game 'space' → both managers activate.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    const worldA = getCurrentWorld();
    expect(managers.getActiveGameId()).toBe('space');

    await sceneManager.unloadAll();

    // F1: both active managers' dispose() ran (was skipped entirely before).
    expect(sceneDispose).toHaveBeenCalledTimes(1);
    expect(gameDispose).toHaveBeenCalledTimes(1);
    // Disposed against the world they were running on, not the fresh empty one.
    expect((sceneDispose.mock.calls[0][0] as { world: unknown }).world).toBe(worldA);
    expect((gameDispose.mock.calls[0][0] as { world: unknown }).world).toBe(worldA);

    // Active scope state reset: activeGameId is null again.
    expect(managers.getActiveGameId()).toBeNull();
  });

  it('after unloadAll, a fresh load re-computes gameChanged correctly (no stale activeGameId)', async () => {
    const { sceneManager, managers } = await setup();

    const init = vi.fn();
    managers.registerManager({ name: 'spaceMgr', scope: 'game', games: ['space'], init });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledTimes(1);

    await sceneManager.unloadAll();
    expect(managers.getActiveGameId()).toBeNull();

    // Re-loading 'space' AGAIN must re-init the game manager. If unloadAll had
    // left activeGameId='space' stale, gameChanged would be false and init would
    // NOT fire — the leak this guards against.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('leaves all managers inactive (no spurious re-activation of a no-filter scene manager)', async () => {
    const { sceneManager, managers } = await setup();

    const init = vi.fn();
    const dispose = vi.fn();
    // No `scenes` filter → matches any path, including the '' used during reset.
    managers.registerManager({ name: 'anyScene', init, dispose });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(init).toHaveBeenCalledTimes(1);

    await sceneManager.unloadAll();

    // Net: activated once on load, disposed during unloadAll. The reset routine
    // may momentarily re-activate a no-filter manager against '', but unloadAll
    // disposes it again, so it ends INACTIVE — init/dispose counts stay balanced
    // and equal.
    expect(dispose.mock.calls.length).toBe(init.mock.calls.length);

    // And a subsequent load re-activates it cleanly (proving it was left inactive).
    await sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never });
    expect(init).toHaveBeenCalledTimes(dispose.mock.calls.length + 1);
  });
});

describe('SceneManager.loadScene — F3 preloaded data is not mutated', () => {
  it('does not rewrite caller-owned preloaded.resources / .version in place', async () => {
    const { sceneManager } = await setup();

    const preloaded = sceneOf('A') as never as {
      version: number;
      resources: unknown[];
      entities: unknown[];
    };
    const originalResources = preloaded.resources;
    const originalVersion = preloaded.version;

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });

    // F3: loadScene shallow-clones before mutating, so the caller's object is
    // untouched. Before the fix, data.resources was reassigned to the full
    // transitive ref walk and data.version bumped — both observable here.
    expect(preloaded.resources).toBe(originalResources);
    expect(preloaded.resources).toEqual([]); // still the empty array we passed
    expect(preloaded.version).toBe(originalVersion);
    expect(preloaded.version).toBe(8);
  });

  it('reusing the same preloaded object across two loads sees identical input both times', async () => {
    const { sceneManager } = await setup();

    const preloaded = sceneOf('A') as never as { version: number; resources: unknown[] };

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });
    const afterFirst = { version: preloaded.version, resources: preloaded.resources };

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });

    // Second load must see the same untouched input the first one saw — proving
    // no aliasing rewrite leaked between calls.
    expect(preloaded.version).toBe(afterFirst.version);
    expect(preloaded.resources).toBe(afterFirst.resources);
    expect(preloaded.resources).toEqual([]);
  });
});
