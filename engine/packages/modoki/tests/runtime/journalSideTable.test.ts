/** journal.ts ref→name side-table — the mechanism that lets Percept name an entity AFTER it
 *  despawns (recordRefName, driven by entityRef; read by resolveRefName). Covers the pieces the
 *  physics event tests can't isolate: the dual-key (guid entity resolvable by BOTH its GUID and its
 *  numeric id — the fix for the synthesized-exit path emitting a numeric id), the numeric-id
 *  despawn path, and the LRU cap + recency refresh that bound the table across a long session. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { entityRef, resolveRefName, MAX_NAMES } from '../../src/runtime/systems/journal';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { tw.dispose(); tw = undefined; } });

/** A minimal entity-like handle for driving entityRef without spawning a real entity — lets the LRU
 *  test cheaply create MAX_NAMES+ distinct refs. `alive` controls the has()/get() probe. */
function fakeHandle(id: number, opts: { guid?: string; name?: string } = {}) {
  return {
    id: () => id,
    has: (_t: unknown) => true,
    get: (_t: unknown) => ({ guid: opts.guid ?? '', name: opts.name ?? '' }),
  };
}

describe('side-table: dual-key + despawn resolution', () => {
  it('a guidable entity is resolvable by BOTH its GUID and its numeric id (dual-key)', () => {
    tw = createTestWorld();
    const e = tw.spawn(EntityAttributes({ guid: 'g-bolt', name: 'Bolt' }));
    entityRef(e); // seeds the side-table as a contact emit would, while alive
    expect(resolveRefName('g-bolt', tw.world)).toBe('Bolt');
    expect(resolveRefName(e.id(), tw.world)).toBe('Bolt'); // the numeric alias — the P0 fix
  });

  it('resolves a NAMED guid-LESS entity by its numeric id after it despawns', () => {
    tw = createTestWorld();
    const e = tw.spawn(EntityAttributes({ name: 'Spark' })); // no guid → recorded under numeric id only
    const id = e.id();
    entityRef(e);
    expect(resolveRefName(id, tw.world)).toBe('Spark');
    e.destroy();
    tw.step(1);
    expect(e.isAlive()).toBe(false);
    expect(resolveRefName(id, tw.world)).toBe('Spark'); // still nameable post-despawn (side-table)
  });

  it('does not record a nameless entity', () => {
    tw = createTestWorld();
    const e = tw.spawn(EntityAttributes({ guid: 'g-anon', name: '' }));
    entityRef(e);
    expect(resolveRefName('g-anon', tw.world)).toBeUndefined();
  });
});

describe('side-table: LRU cap + recency', () => {
  it('evicts the oldest past MAX_NAMES and a re-touched ref survives a later eviction', () => {
    tw = createTestWorld();
    // Guid-LESS handles so each records exactly ONE entry (numeric id) — keeps the cap arithmetic clean.
    // Insert MAX_NAMES + 5 (ids 1..MAX_NAMES+5): inserting id N>MAX_NAMES evicts id N-MAX_NAMES.
    const N = MAX_NAMES + 5;
    for (let i = 1; i <= N; i++) entityRef(fakeHandle(i, { name: `n${i}` }));
    // Oldest 5 (ids 1..5) evicted; newest present.
    expect(resolveRefName(1, tw.world)).toBeUndefined();
    expect(resolveRefName(5, tw.world)).toBeUndefined();
    expect(resolveRefName(6, tw.world)).toBe('n6');
    expect(resolveRefName(N, tw.world)).toBe(`n${N}`);

    // Recency: re-touch id 6 (moves it to newest), then insert one more new ref to force one eviction.
    // The evicted one must be the next-oldest (id 7), NOT the just-refreshed id 6.
    entityRef(fakeHandle(6, { name: 'n6' }));
    entityRef(fakeHandle(N + 1, { name: `n${N + 1}` }));
    expect(resolveRefName(7, tw.world)).toBeUndefined();  // next-oldest evicted
    expect(resolveRefName(6, tw.world)).toBe('n6');        // survived — recency refresh worked
    expect(resolveRefName(N + 1, tw.world)).toBe(`n${N + 1}`);
  });
});
