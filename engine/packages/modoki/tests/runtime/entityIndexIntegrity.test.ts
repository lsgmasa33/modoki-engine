/** The entity index, driven the way PRODUCTION drives it — no mocks.
 *
 *  Why this file exists separately from entityUtils.test.ts: that suite `vi.mock`s
 *  `core/ecs/world`, so its "index" is a stand-in Map maintained by the mock factory. It proves
 *  deleteEntities CALLS unregister; it cannot prove the real index ends up clean, because the real
 *  index is never involved. That is the seam the spawn/destroy defects lived in — three game sites
 *  destroyed entities with no unregister at all, and no test could have seen it.
 *
 *  So: real world module, real entityUtils, real koota world. Spawn the way production spawns,
 *  delete the way the editor deletes, then ask the index what it thinks. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld, spawnEntity, findEntityById } from '../../src/runtime/core/ecs/world';
import { deleteEntity, deleteEntities } from '../../src/runtime/core/ecs/entityUtils';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';

let world: ReturnType<typeof createWorld>;

// `deleteEntities` discovers the subtree through `getAllEntities()`, which enumerates entities via
// the TRAIT REGISTRY — not via the world directly. Without this registration it finds nothing, so
// the parent/child case below passed vacuously in an earlier draft (it deleted the parent, walked
// an empty child index, and asserted on a child nothing had tried to delete).
registerTrait({
  name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
  fields: { name: { type: 'string' }, parentId: { type: 'number' }, guid: { type: 'string' } },
});

beforeEach(() => {
  world = createWorld();
  setCurrentWorld(world);
});

afterEach(() => {
  // The current world is process-global; leaving a destroyed one current leaks into the next file.
  setCurrentWorld(createWorld());
});

describe('entity index integrity, through the production path', () => {
  it('deleteEntity leaves no index entry behind', () => {
    const e = spawnEntity(world, EntityAttributes({ name: 'doomed', guid: 'g-doomed' }));
    const id = e.id();
    expect(findEntityById(id, world)).toBe(e);

    deleteEntity(id);

    expect(findEntityById(id, world)).toBeUndefined();
  });

  it('deleting a parent clears its CHILDREN from the index too, not just the parent', () => {
    // The subtree walk is the part most likely to drop an unregister: it deletes ids it discovered
    // rather than ids the caller passed, so a missed unregister there is invisible at the call site.
    const parent = spawnEntity(world, EntityAttributes({ name: 'parent', guid: 'g-parent' }));
    const parentId = parent.id();
    // `EntityAttributes.parentId` is the NUMERIC entity id at runtime, not the guid the scene FILE
    // carries — the loader remaps it on load. Authoring the guid here linked nothing and made this
    // test pass vacuously in its first draft.
    const child = spawnEntity(world, EntityAttributes({ name: 'child', guid: 'g-child', parentId }));
    const childId = child.id();

    deleteEntity(parentId);

    expect(findEntityById(parentId, world)).toBeUndefined();
    expect(findEntityById(childId, world)).toBeUndefined();
  });

  it('a bulk delete clears every id, and leaves untouched entities resolvable', () => {
    const a = spawnEntity(world, EntityAttributes({ name: 'a', guid: 'g-a' }));
    const b = spawnEntity(world, EntityAttributes({ name: 'b', guid: 'g-b' }));
    const survivor = spawnEntity(world, EntityAttributes({ name: 'keep', guid: 'g-keep' }));

    deleteEntities([a.id(), b.id()]);

    expect(findEntityById(a.id(), world)).toBeUndefined();
    expect(findEntityById(b.id(), world)).toBeUndefined();
    expect(findEntityById(survivor.id(), world)).toBe(survivor);
  });

  it('the index never resolves to a DESTROYED entity — the failure mode a stale entry causes', () => {
    // Stated as the symptom rather than the mechanism: whatever findEntityById returns must be
    // something you can still safely read. A stale entry is a silent index hit, so a test that only
    // asserted "unregister was called" would pass while this one fails.
    const e = spawnEntity(world, EntityAttributes({ name: 'gone', guid: 'g-gone' }));
    const id = e.id();

    deleteEntity(id);

    const resolved = findEntityById(id, world);
    expect(resolved).toBeUndefined();
    // And the world agrees it is gone — the index and koota can't disagree about existence.
    expect(world.entities.some((x) => x.id() === id)).toBe(false);
  });
});
