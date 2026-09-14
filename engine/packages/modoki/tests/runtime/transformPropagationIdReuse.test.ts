/** #868 Group C — `worldTransforms` / `deactivatedEntities` and koota's recycled entity index.
 *
 *  Both are filled by one propagation pass and read BY ID at later priorities and out of band
 *  (render callbacks, SceneView gizmos, MCP scene-state, reparenting). A destroy followed by a
 *  spawn that reclaims the index between that pass and the read hands the newcomer the dead
 *  entity's world pose / cascaded inactive flag. The fix deletes the entry synchronously inside
 *  `destroy()` (koota's `world.onRemove`) and forces the next pass past its "provably unchanged"
 *  short-circuit — without that, a same-pose respawn compares equal and its evicted entry is never
 *  rebuilt. The TRAP tests below pin that half; they are green before the fix and must stay green. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { Transform, EntityAttributes } from '../../src/runtime/traits';
import {
  transformPropagationSystem, worldTransforms, deactivatedEntities,
} from '../../src/runtime/core/ecs/transformPropagationSystem';
import { getWorldTransform2DInto } from '../../src/runtime/rendering/renderUtils';
import { setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';

const worlds: World[] = [];
function newWorld(): World { const w = createWorld(); worlds.push(w); return w; }
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
  worldTransforms.clear();
  deactivatedEntities.clear();
});

/** Destroy `a`, spawn a replacement, and prove the replacement reclaimed `a`'s index — so a pass
 *  that would have been fine for a fresh index cannot make these tests pass vacuously. */
function respawnOnSameIndex(world: World, a: ReturnType<World['spawn']>, ...traits: Parameters<World['spawn']>) {
  const aId = a.id(), aPacked = a.valueOf();
  a.destroy();
  const b = world.spawn(...traits);
  expect(b.id()).toBe(aId);
  expect(b.valueOf()).not.toBe(aPacked);
  return b;
}

const out = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };

describe('worldTransforms — recycled index', () => {
  it('a respawn read before the next pass gets its own local pose, not the dead entity\'s world pose', () => {
    const w = newWorld();
    const a = w.spawn(Transform({ x: 5 }), EntityAttributes({ name: 'A' }));
    transformPropagationSystem(w);
    expect(worldTransforms.get(a.id())?.x).toBe(5);

    const b = respawnOnSameIndex(w, a, Transform({ x: 9 }), EntityAttributes({ name: 'B' }));

    // The real reader: prefers the cache, falls back to the local transform when it has none.
    expect(getWorldTransform2DInto(out, b.id(), { x: 9, y: 0, rz: 0, sx: 1, sy: 1 }).x).toBe(9);
  });

  it('TRAP: a same-pose respawn still has an entry after the next pass', () => {
    const w = newWorld();
    const a = w.spawn(Transform({ x: 5 }), EntityAttributes({ name: 'A' }));
    transformPropagationSystem(w);

    const b = respawnOnSameIndex(w, a, Transform({ x: 5 }), EntityAttributes({ name: 'A' }));
    transformPropagationSystem(w);
    transformPropagationSystem(w);

    expect(worldTransforms.get(b.id())?.x).toBe(5);
  });

  it('a destroy in a world the cache no longer holds does not evict the current world\'s entry', () => {
    const w1 = newWorld();
    const w2 = newWorld();
    const a1 = w1.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'W1' }));
    const a2 = w2.spawn(Transform({ x: 2 }), EntityAttributes({ name: 'W2' }));
    expect(a2.id()).toBe(a1.id()); // the shared key is the point of the test

    transformPropagationSystem(w1);
    transformPropagationSystem(w2); // the cache now holds W2's data
    a1.destroy();

    expect(worldTransforms.get(a2.id())?.x).toBe(2);
  });
});

describe('deactivatedEntities — recycled index', () => {
  it('an active respawn does not read as deactivated before the next pass', () => {
    const w = newWorld();
    const a = w.spawn(Transform(), EntityAttributes({ name: 'A', isActive: false }));
    transformPropagationSystem(w);
    expect(deactivatedEntities.has(a.id())).toBe(true);

    const b = respawnOnSameIndex(w, a, Transform(), EntityAttributes({ name: 'B', isActive: true }));

    expect(deactivatedEntities.has(b.id())).toBe(false);
  });

  it('TRAP: an inactive respawn identical to the dead entity is deactivated after the next pass', () => {
    const w = newWorld();
    const a = w.spawn(Transform(), EntityAttributes({ name: 'A', isActive: false }));
    transformPropagationSystem(w);

    const b = respawnOnSameIndex(w, a, Transform(), EntityAttributes({ name: 'A', isActive: false }));
    transformPropagationSystem(w);

    expect(deactivatedEntities.has(b.id())).toBe(true);
  });

  it('TRAP: the same holds for an entity with no Transform (a UI row), which only the EntityAttributes eviction sees', () => {
    const w = newWorld();
    const a = w.spawn(EntityAttributes({ name: 'Row', isActive: false }));
    transformPropagationSystem(w);
    expect(deactivatedEntities.has(a.id())).toBe(true);

    const b = respawnOnSameIndex(w, a, EntityAttributes({ name: 'Row', isActive: false }));
    expect(deactivatedEntities.has(b.id())).toBe(false); // evicted at destroy
    transformPropagationSystem(w);

    expect(deactivatedEntities.has(b.id())).toBe(true);
  });
});

describe('world-swap wiring', () => {
  it('promoting a new world drops the old world\'s entries until a pass runs for the new one', () => {
    const w1 = newWorld();
    const w2 = newWorld();
    const a1 = w1.spawn(Transform({ x: 7 }), EntityAttributes({ name: 'Old', isActive: false }));
    const a2 = w2.spawn(Transform({ x: 3 }), EntityAttributes({ name: 'New' }));
    expect(a2.id()).toBe(a1.id());
    setCurrentWorld(w1);
    transformPropagationSystem(w1);

    setCurrentWorld(w2);

    // Before W2's first pass the new entity must not read W1's pose or inactive flag.
    expect(getWorldTransform2DInto(out, a2.id(), { x: 3, y: 0, rz: 0, sx: 1, sy: 1 }).x).toBe(3);
    expect(deactivatedEntities.has(a2.id())).toBe(false);

    transformPropagationSystem(w2);
    expect(worldTransforms.get(a2.id())?.x).toBe(3);
  });

  it('swapping away and back with no pass in between does not leave the caches empty', () => {
    const w1 = newWorld();
    const w2 = newWorld();
    const a1 = w1.spawn(Transform({ x: 7 }), EntityAttributes({ name: 'A', isActive: false }));
    w2.spawn(Transform({ x: 3 }), EntityAttributes({ name: 'B' }));
    setCurrentWorld(w1);
    transformPropagationSystem(w1);

    setCurrentWorld(w2); // clears the caches; no pass runs on W2
    setCurrentWorld(w1); // clears them again
    transformPropagationSystem(w1); // nothing changed in W1 since its last pass

    expect(worldTransforms.get(a1.id())?.x).toBe(7);
    expect(deactivatedEntities.has(a1.id())).toBe(true);
  });
});
