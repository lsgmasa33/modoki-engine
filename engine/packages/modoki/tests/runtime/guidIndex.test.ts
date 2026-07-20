/** guid→entity index unit tests — the maintained O(1) entity identity that makes
 *  GUID a first-class lookup (symmetric to the asset manifest's guid index).
 *
 *  Uses the REAL world module + the REAL EntityAttributes trait (no mocks) so the
 *  index maintenance in registerEntity/unregisterEntity/indexEntityGuid and the
 *  self-healing scan in findEntityByGuid are exercised end-to-end. Per-world WeakMap
 *  storage means a fresh createWorld() per test isolates state. */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import {
  setCurrentWorld, getCurrentWorld, registerEntity, unregisterEntity,
  findEntityByGuid, indexEntityGuid,
} from '../../src/runtime/ecs/world';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';

let world: ReturnType<typeof createWorld>;

beforeEach(() => {
  world = createWorld();
  setCurrentWorld(world);
});

describe('guid→entity index', () => {
  it('finds a loaded entity by guid after registerEntity (guid present at spawn)', () => {
    const e = world.spawn(EntityAttributes({ name: 'A', guid: 'g-a' }));
    registerEntity(e, world);
    expect(findEntityByGuid('g-a', world)?.id()).toBe(e.id());
  });

  it("returns undefined for '' / unknown guids", () => {
    expect(findEntityByGuid('', world)).toBeUndefined();
    expect(findEntityByGuid('nope', world)).toBeUndefined();
  });

  it('indexes a fresh ( \'\' → guid ) mint via indexEntityGuid', () => {
    const e = world.spawn(EntityAttributes({ name: 'B', guid: '' }));
    registerEntity(e, world); // empty guid → not indexed yet
    e.set(EntityAttributes, { ...e.get(EntityAttributes), guid: 'g-b' });
    indexEntityGuid(e, world);
    expect(findEntityByGuid('g-b', world)?.id()).toBe(e.id());
  });

  it('self-heals on a miss: finds an entity whose guid was never explicitly indexed', () => {
    // Spawn WITHOUT registerEntity → guid index never told about it.
    const e = world.spawn(EntityAttributes({ name: 'C', guid: 'g-c' }));
    // findEntityByGuid rescans the world on a miss and still finds it.
    expect(findEntityByGuid('g-c', world)?.id()).toBe(e.id());
  });

  it('stops finding a destroyed (unregistered) entity', () => {
    const e = world.spawn(EntityAttributes({ name: 'D', guid: 'g-d' }));
    registerEntity(e, world);
    expect(findEntityByGuid('g-d', world)?.id()).toBe(e.id());
    unregisterEntity(e, world);
    e.destroy();
    expect(findEntityByGuid('g-d', world)).toBeUndefined();
  });

  it('is per-world: a guid resolves only within the world that holds it', () => {
    const a = world.spawn(EntityAttributes({ name: 'E', guid: 'g-e' }));
    registerEntity(a, world);

    // Simulate a world swap (Play→Stop): a fresh world where a DIFFERENT id carries
    // the same guid. findEntityByGuid (no world arg) follows getCurrentWorld().
    const worldB = createWorld();
    worldB.spawn(EntityAttributes({ name: 'decoy', guid: 'decoy' })); // shift ids
    const b = worldB.spawn(EntityAttributes({ name: 'E', guid: 'g-e' }));
    registerEntity(b, worldB);
    setCurrentWorld(worldB);

    expect(getCurrentWorld()).toBe(worldB);
    expect(b.id()).not.toBe(a.id());
    expect(findEntityByGuid('g-e')?.id()).toBe(b.id()); // resolves in the NEW world
  });

  it('resolves to an entity carrying the guid even if two illegally share one', () => {
    const a = world.spawn(EntityAttributes({ name: 'F1', guid: 'dup' }));
    registerEntity(a, world);
    const b = world.spawn(EntityAttributes({ name: 'F2', guid: 'dup' }));
    registerEntity(b, world);
    // Duplicate guids are illegal; we only guarantee resolution returns one of them.
    const found = findEntityByGuid('dup', world);
    expect([a.id(), b.id()]).toContain(found?.id());
  });
});
