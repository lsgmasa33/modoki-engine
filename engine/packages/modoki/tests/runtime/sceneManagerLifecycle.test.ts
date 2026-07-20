/** SceneManager ↔ Manager lifecycle integration.
 *
 *  Drives the real `sceneManager.loadScene` (via `preloaded` data, so no fetch /
 *  resource worlds) and asserts Managers init/dispose through the swap — in
 *  particular that `dispose` receives the OLD world it was operating against (not
 *  the freshly-promoted one), that scene-scoped Managers re-init each swap, and
 *  that game-scoped Managers survive an in-game swap but dispose on a game change.
 *
 *  Lives in its own file because koota caps live worlds at 16 and
 *  SceneManager.test.ts is already tuned to that budget; a separate file gets a
 *  fresh module graph (and a fresh koota counter). */

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
  version: 8,
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

describe('SceneManager ↔ scene-scoped manager lifecycle', () => {
  it('inits on load, then disposes on swap against the OLD world before re-init', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const order: string[] = [];
    const initWorlds: unknown[] = [];
    const disposeWorlds: unknown[] = [];
    managers.registerManager({
      name: 'lifecycle',
      scenes: ['scene'], // matches both paths below
      init: (ctx) => { order.push('init'); initWorlds.push(ctx.world); },
      dispose: (ctx) => { order.push('dispose'); disposeWorlds.push(ctx?.world); },
    });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(order).toEqual(['init']);
    const worldA = getCurrentWorld();
    expect(initWorlds[0]).toBe(worldA);

    await sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never });
    const worldB = getCurrentWorld();

    // dispose precedes re-init; dispose saw world A (the one it ran against),
    // NOT the freshly-promoted world B. This pins the dispose-ordering fix.
    expect(order).toEqual(['init', 'dispose', 'init']);
    expect(disposeWorlds[0]).toBe(worldA);
    expect(disposeWorlds[0]).not.toBe(worldB);
    expect(initWorlds[1]).toBe(worldB);
  });

  it('does not init a scene-scoped manager whose filter fails the loaded scene', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    managers.registerManager({ name: 'onlyWarp', scenes: ['Warp'], init });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(init).not.toHaveBeenCalled();
  });

  it('activates a game-scoped manager when its game loads, and it survives an in-game swap', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    const dispose = vi.fn();
    managers.registerManager({ name: 'spaceCtrl', scope: 'game', games: ['space'], init, dispose });

    // Game becomes active (explicit gameId on the switch) → init fires.
    await sceneManager.loadScene('/Station.json', { preloaded: sceneOf('Station') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledOnce();

    // In-game scene swap (no gameId → keep the active game) → manager persists,
    // not re-inited and not disposed.
    await sceneManager.loadScene('/Warp.json', { preloaded: sceneOf('Warp') as never });
    expect(dispose).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledOnce();
  });

  it('disposes a game-scoped manager (against the OLD world) when the active game changes', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();
    const disposeWorlds: unknown[] = [];
    managers.registerManager({
      name: 'spaceCtrl', scope: 'game', games: ['space'],
      dispose: (ctx) => { disposeWorlds.push(ctx?.world); },
    });

    await sceneManager.loadScene('/Station.json', { preloaded: sceneOf('Station') as never, gameId: 'space' });
    const worldSpace = getCurrentWorld();

    // Switch to a different game → dispose fires once, against the OLD (space)
    // world it was running on, not the freshly-promoted one.
    await sceneManager.loadScene('/chess.json', { preloaded: sceneOf('chess') as never, gameId: 'chess' });
    const worldChess = getCurrentWorld();

    expect(disposeWorlds).toHaveLength(1);
    expect(disposeWorlds[0]).toBe(worldSpace);
    expect(disposeWorlds[0]).not.toBe(worldChess);
  });

  it('does not activate a game-scoped manager whose games filter fails the active game', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    managers.registerManager({ name: 'onlySpace', scope: 'game', games: ['space'], init });

    await sceneManager.loadScene('/chess.json', { preloaded: sceneOf('chess') as never, gameId: 'chess' });
    expect(init).not.toHaveBeenCalled();
  });
});
