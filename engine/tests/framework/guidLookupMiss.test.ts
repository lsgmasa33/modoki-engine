/** A stale durable guid misses without rescanning the world every call (#1222).
 *
 *  `findEntityByGuid` self-heals a miss with a whole-world rescan, so a guid mint site that forgot
 *  `indexEntityGuid` still resolves. It used to rescan on EVERY miss, so a guid held across frames
 *  and polled after its entity was gone paid O(n) per call — measured 1.6 ms at 10k entities. The
 *  rescan now runs only when something that can put a guid on a live entity has happened since the
 *  last one.
 *
 *  Each case pins one half, and names the mutation that must turn it red:
 *  - the GATE: a repeat miss does not rescan (delete the `scannedAt === value` return);
 *  - the ACCEPT side, once per path a guid can appear by without announcing itself — an
 *    `entity.set` (drop the `onChange` subscription), and an `entity.add` or a spawn (drop `onAdd`:
 *    both cases go red), and after a `world.reset()`, which drops koota's subscriptions silently
 *    (drop the reset hook). Without these the gate would turn a forgotten mint site from slow into
 *    WRONG. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, findEntityByGuid, destroyEntity, spawnEntity,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { _guidIndexRescans, getGuidIndex } from '../../packages/modoki/src/runtime/core/ecs/world';

registerAllTraits();

const G_DEAD = 'd1222000-0000-4000-8000-000000000001';
const G_LATE = 'd1222000-0000-4000-8000-000000000002';

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; });

/** A world holding a destroyed durable-guid entity, already missed once (so the gate is armed). */
function worldWithAStaleGuid(): TestWorld {
  const t = createTestWorld({});
  for (let i = 0; i < 20; i++) t.spawn(Transform(), EntityAttributes({ name: `e${i}` }));
  const dead = t.spawn(Transform(), EntityAttributes({ name: 'Dead', guid: G_DEAD }));
  destroyEntity(dead);
  expect(findEntityByGuid(G_DEAD, t.world)).toBeUndefined();
  return t;
}

describe('findEntityByGuid — a stale durable guid (#1222)', () => {
  it('rescans on the first miss, and not on the repeats while nothing could add a guid', () => {
    tw = worldWithAStaleGuid();
    const after1 = _guidIndexRescans(tw.world);
    expect(after1).toBe(1);
    for (let i = 0; i < 50; i++) expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined();
    expect(_guidIndexRescans(tw.world)).toBe(after1);
  });

  it('still finds a guid WRITTEN onto a live entity with no indexEntityGuid call', () => {
    tw = worldWithAStaleGuid();
    const e = tw.spawn(Transform(), EntityAttributes({ name: 'Late' }));
    expect(findEntityByGuid(G_LATE, tw.world)).toBeUndefined(); // arms the gate AFTER the spawn's bump
    getGuidIndex(tw.world).delete(G_LATE); // (never indexed anyway — a forgotten mint site)
    e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), guid: G_LATE });
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(e);
  });

  it('still finds a guid on EntityAttributes ADDED to a live entity after the miss', () => {
    tw = worldWithAStaleGuid();
    const e = tw.spawn(Transform());
    e.remove(EntityAttributes); // every spawn carries it since #1248; removing it is the way to reach an ADD
    expect(findEntityByGuid(G_LATE, tw.world)).toBeUndefined();
    e.add(EntityAttributes({ name: 'Late', guid: G_LATE }));
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(e);
  });

  it('still finds a guid that arrived with a spawn the index was never told about', () => {
    tw = worldWithAStaleGuid();
    expect(findEntityByGuid(G_LATE, tw.world)).toBeUndefined();
    const e = tw.spawn(Transform(), EntityAttributes({ name: 'Late', guid: G_LATE }));
    getGuidIndex(tw.world).delete(G_LATE); // registerEntity indexed it; model a path that did not
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(e);
  });

  it('still finds a guid after world.reset() dropped the subscriptions the gate listens on', () => {
    // A bare koota world, so reset() cannot disturb the harness's own bookkeeping.
    const w: World = createWorld();
    try {
      const dead = spawnEntity(w, Transform(), EntityAttributes({ name: 'Dead', guid: G_DEAD }));
      destroyEntity(dead, w);
      expect(findEntityByGuid(G_DEAD, w)).toBeUndefined(); // arms the gate and subscribes
      w.reset();
      expect(findEntityByGuid(G_DEAD, w)).toBeUndefined(); // a lookup between the reset and the spawn
      const e = spawnEntity(w, Transform(), EntityAttributes({ name: 'Late', guid: G_LATE }));
      getGuidIndex(w).delete(G_LATE); // unannounced, as above
      expect(findEntityByGuid(G_LATE, w)).toBe(e);
    } finally {
      w.destroy();
    }
  });

  // Close-out review: a REMOVAL can strand a findable guid. Two live entities sharing one durable
  // guid (a hand-edited scene loads both) leave only one in the index; destroying that one used to
  // be healed by the rescan the gate now skips. Mutations: drop the duplicate bump in
  // `unregisterEntity` (the first case goes red); evict the key unconditionally again (the second).
  it('still finds the surviving holder of a duplicate guid after the indexed holder is destroyed', () => {
    tw = worldWithAStaleGuid();
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G_LATE }));
    const b = tw.spawn(Transform(), EntityAttributes({ name: 'B', guid: G_LATE }));
    expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined(); // re-arm after the spawns' bumps (its rescan indexes A: first wins)
    getGuidIndex(tw.world).set(G_LATE, b); // the registration order that leaves B indexed and A not
    destroyEntity(b); // evicts B's key: A is now reachable only by a rescan
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(a);
  });

  it('destroying the UNINDEXED holder of a duplicate guid leaves the indexed one in place', () => {
    tw = worldWithAStaleGuid();
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G_LATE }));
    const b = tw.spawn(Transform(), EntityAttributes({ name: 'B', guid: G_LATE }));
    expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined(); // its rescan indexes A (first wins), B is the other
    const before = _guidIndexRescans(tw.world);
    destroyEntity(b);
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(a);
    expect(_guidIndexRescans(tw.world)).toBe(before); // found through the index, not a rescan
  });

  // Scoped review: the duplicate is noticed by the RESCAN, and nothing else pinned that. A guid written
  // onto a second live entity by a site that forgot `indexEntityGuid` is only in the index's view
  // after a rescan; destroying the first holder must then reopen it. Mutation: drop the
  // `noteDuplicateGuid` call in `rebuildGuidIndexSync` (this case goes red).
  it('a duplicate a rescan found is rescanned for again once its indexed holder is destroyed', () => {
    tw = worldWithAStaleGuid();
    const a = tw.spawn(Transform(), EntityAttributes({ name: 'A', guid: G_LATE }));
    const b = tw.spawn(Transform(), EntityAttributes({ name: 'B' }));
    expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined(); // arm after the spawns
    b.set(EntityAttributes, { ...(b.get(EntityAttributes) as object), guid: G_LATE }); // unannounced
    expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined(); // the set reopened it: this rescan sees both
    const closed = _guidIndexRescans(tw.world);
    expect(findEntityByGuid(G_DEAD, tw.world)).toBeUndefined();
    expect(_guidIndexRescans(tw.world)).toBe(closed); // precondition: the gate is shut again
    destroyEntity(a);
    expect(findEntityByGuid(G_LATE, tw.world)).toBe(b);
  });
});
