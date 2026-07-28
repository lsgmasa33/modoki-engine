/** The core entity index (`runtime/core/ecs/entityIndex.ts`) — specifically the
 *  `isEntityActiveInHierarchy` predicate, tested DIRECTLY rather than only through its first
 *  consumer (timelineSystem's Director freeze).
 *
 *  It matters that this is core and independently covered: PHYSICS still ignores
 *  `EntityAttributes.isActive` entirely, and this predicate is the intended seam for fixing that
 *  (the timeline and zone subsystems already use it). The next consumer should be able to trust
 *  it without re-deriving the edge cases — a missing entity, an entity with no EntityAttributes, and a parentId CYCLE (which
 *  would otherwise recurse forever) all have defined answers here. */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Director } from '../../src/runtime/traits/Director';
import { buildEntityIndex, isEntityActiveInHierarchy } from '../../src/runtime/core/ecs/entityIndex';

describe('isEntityActiveInHierarchy', () => {
  it('reports a plain active root as active', () => {
    const w = createWorld();
    const e = w.spawn(EntityAttributes({ name: 'a' }));
    expect(isEntityActiveInHierarchy(buildEntityIndex(w), e.id())).toBe(true);
  });

  it('reports a self-deactivated entity as inactive', () => {
    const w = createWorld();
    const e = w.spawn(EntityAttributes({ name: 'a', isActive: false }));
    expect(isEntityActiveInHierarchy(buildEntityIndex(w), e.id())).toBe(false);
  });

  it('CASCADES — an active entity under an inactive ancestor is inactive', () => {
    const w = createWorld();
    const gp = w.spawn(EntityAttributes({ name: 'gp', isActive: false }));
    const p = w.spawn(EntityAttributes({ name: 'p', parentId: gp.id() }));
    const c = w.spawn(EntityAttributes({ name: 'c', parentId: p.id() }));
    const idx = buildEntityIndex(w);

    expect(isEntityActiveInHierarchy(idx, c.id())).toBe(false); // two levels up
    expect(isEntityActiveInHierarchy(idx, p.id())).toBe(false);
    expect(isEntityActiveInHierarchy(idx, gp.id())).toBe(false);
  });

  it('a deep ACTIVE chain stays active', () => {
    const w = createWorld();
    let parent = 0;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const e = w.spawn(EntityAttributes({ name: `n${i}`, parentId: parent }));
      parent = e.id();
      last = e.id();
    }
    expect(isEntityActiveInHierarchy(buildEntityIndex(w), last)).toBe(true);
  });

  it('treats an entity MISSING from the index as active (permissive default)', () => {
    // Matches what the renderers do with an id they don't know: don't hide it.
    const w = createWorld();
    expect(isEntityActiveInHierarchy(buildEntityIndex(w), 9999)).toBe(true);
  });

  it('treats a DANGLING parentId as active rather than throwing', () => {
    const w = createWorld();
    const e = w.spawn(EntityAttributes({ name: 'orphan', parentId: 4242 }));
    expect(isEntityActiveInHierarchy(buildEntityIndex(w), e.id())).toBe(true);
  });

  it('BREAKS a parentId cycle instead of recursing forever', () => {
    // A→B→A. Without the visiting guard this blows the stack; the propagation pass has the
    // same guard for the same reason. A cycle edge cannot deactivate, so it resolves active.
    const w = createWorld();
    const a = w.spawn(EntityAttributes({ name: 'a' }));
    const b = w.spawn(EntityAttributes({ name: 'b', parentId: a.id() }));
    a.set(EntityAttributes, { ...a.get(EntityAttributes)!, parentId: b.id() });
    const idx = buildEntityIndex(w);

    expect(() => isEntityActiveInHierarchy(idx, b.id())).not.toThrow();
    expect(isEntityActiveInHierarchy(idx, b.id())).toBe(true);
  });

  it('still finds an INACTIVE entity inside a cycle', () => {
    // The guard must break the walk without swallowing a real deactivation on the way.
    const w = createWorld();
    const a = w.spawn(EntityAttributes({ name: 'a', isActive: false }));
    const b = w.spawn(EntityAttributes({ name: 'b', parentId: a.id() }));
    a.set(EntityAttributes, { ...a.get(EntityAttributes)!, parentId: b.id() });

    expect(isEntityActiveInHierarchy(buildEntityIndex(w), b.id())).toBe(false);
  });

  it('does not mutate the caller-visible index (repeat calls agree)', () => {
    const w = createWorld();
    const p = w.spawn(EntityAttributes({ name: 'p', isActive: false }));
    const c = w.spawn(EntityAttributes({ name: 'c', parentId: p.id() }), Director({ timeline: 'x' }));
    const idx = buildEntityIndex(w);

    expect(isEntityActiveInHierarchy(idx, c.id())).toBe(false);
    expect(isEntityActiveInHierarchy(idx, c.id())).toBe(false); // the lazy `visiting` set is per-call
  });
});
