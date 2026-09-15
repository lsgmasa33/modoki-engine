/** A prefab member removed by a scene's structural override leaves nothing behind (#1222 phase 4).
 *
 *  `applyStructureByLocalToEcs` (the runtime loader's re-expand of a saved instance) deleted removed
 *  members with a bare `entity.destroy()`, skipping `unregisterEntity`. The entity index kept the dead
 *  handle, so `findEntityById` returned a corpse (observed before the fix: the removed member's packed
 *  value) until a later spawn happened to reclaim that index.
 *
 *  In production the closure runs against SceneManager's STAGING world, never the current one, so these
 *  cases do too: a destroy aimed at the current world would drop the live world's same-numbered entries
 *  and still leave the corpse in staging. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, findEntityById, spawnEntity,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { applyStructureByLocalToEcs } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

registerAllTraits();

let tw: TestWorld | undefined;
let staging: World | undefined;
afterEach(() => { staging?.destroy(); staging = undefined; tw?.dispose(); tw = undefined; });

const ea = (name: string, parentId = 0) => EntityAttributes({ name, parentId });
const prefabOf = (...rows: Array<[number, string, number]>) => ({
  rootLocalId: 1,
  entities: rows.map(([localId, name, parentId]) => ({ localId, traits: { EntityAttributes: { name, parentId } } })),
});

/** The live (current) world, with entities on every low index a staging entity could share. */
function liveWorld(): { live: TestWorld; byId: Map<number, unknown> } {
  const live = createTestWorld({});
  const byId = new Map<number, unknown>();
  for (let i = 0; i < 8; i++) { const e = spawnEntity(live.world, Transform(), ea(`Live${i}`)); byId.set(e.id(), e); }
  return { live, byId };
}

describe('applyStructureByLocalToEcs — a removed member is unregistered (#1222)', () => {
  // Mutations: restore the bare destroy (the corpse stays indexed); `destroyEntity(e)` without the world
  // (the live world's same-numbered entries are dropped instead).
  it('the removed subtree leaves the STAGING world\'s index; the live world\'s same-numbered entities stay', () => {
    const { live, byId } = liveWorld(); tw = live;
    staging = createWorld();
    const s = staging;
    const root = spawnEntity(s, Transform(), ea('Root'));
    const branch = spawnEntity(s, Transform(), ea('Branch', root.id()));
    const leaf = spawnEntity(s, Transform(), ea('Leaf', branch.id()));
    const [branchId, leafId] = [branch.id(), leaf.id()];
    expect(byId.has(branchId) && byId.has(leafId), 'premise: the live world holds the same ids').toBe(true);

    applyStructureByLocalToEcs(s, new Map([[1, root.id()], [2, branchId], [3, leafId]]),
      prefabOf([1, 'Root', 0], [2, 'Branch', 1], [3, 'Leaf', 2]), { removed: [2] });

    expect(branch.isAlive() || leaf.isAlive(), 'premise: the subtree was destroyed').toBe(false);
    expect(findEntityById(branchId, s), 'no corpse by id').toBeUndefined();
    expect(findEntityById(leafId, s), 'no corpse by id (cascaded member)').toBeUndefined();
    expect(findEntityById(root.id(), s)).toBe(root);
    expect(findEntityById(branchId, live.world), 'the live world is untouched').toBe(byId.get(branchId));
    expect(findEntityById(leafId, live.world)).toBe(byId.get(leafId));
  });
});
