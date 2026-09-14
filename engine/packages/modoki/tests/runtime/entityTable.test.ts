/** #868 — `EntityTable` against a REAL koota world's recycled indices.
 *
 *  Every test that is about recycling asserts `b.id() === a.id()` AND `b.valueOf() !== a.valueOf()`
 *  before it asserts anything else, so a change in koota's free-list order fails loudly here rather
 *  than turning each test into one that passes whether or not the table checks the generation. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World, type Entity } from 'koota';
import { EntityTable, packedOf, isPackedAlive } from '../../src/runtime/core/ecs/entityTable';
import { setCurrentWorld } from '../../src/runtime/core/ecs/worldRegistry';

let world: World | undefined;
const tables: EntityTable<unknown>[] = [];
afterEach(() => {
  for (const t of tables.splice(0)) t.detach();
  world?.destroy();
  world = undefined;
});

function table<T>(worldSwap: 'clear' | 'owner-clears' = 'owner-clears') {
  const disposed: Array<[T, number]> = [];
  const t = new EntityTable<T>({ label: 'test', worldSwap, dispose: (v, id) => { disposed.push([v, id]); } });
  tables.push(t as EntityTable<unknown>);
  return { t, disposed };
}

/** Destroy `a` and spawn its successor on the same index — asserted, never assumed. */
function recycle(a: Entity): Entity {
  a.destroy();
  const b = world!.spawn();
  expect(b.id()).toBe(a.id());
  expect(b.valueOf()).not.toBe(a.valueOf());
  return b;
}

describe('EntityTable — recycled index', () => {
  it('get/has refuse a dead entity\'s entry, without disposing it', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.set(a, 'a-state');
    const b = recycle(a);

    expect(t.get(b)).toBeUndefined();
    expect(t.has(b)).toBe(false);
    expect(disposed).toEqual([]);
    // The read has no side effect: the index still holds the dead entry for the producer to evict.
    expect(t.peekId(b.id())).toBe('a-state');
  });

  it('getOrCreate disposes the dead entity\'s entry and builds for the newcomer', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.getOrCreate(a, () => 'a-state');
    const b = recycle(a);

    let built = 0;
    const got = t.getOrCreate(b, () => { built++; return 'b-state'; });
    expect(got).toBe('b-state');
    expect(built).toBe(1);
    expect(disposed).toEqual([['a-state', a.id()]]);
    expect(t.get(b)).toBe('b-state');
  });

  it('getOrCreate on the SAME entity is a hit: no rebuild, no dispose', () => {
    world = createWorld();
    const { t, disposed } = table<object>();
    const a = world.spawn();
    const first = t.getOrCreate(a, () => ({}));
    let built = 0;
    expect(t.getOrCreate(a, () => { built++; return {}; })).toBe(first);
    expect(built).toBe(0);
    expect(disposed).toEqual([]);
  });

  it('a create returning undefined stores nothing — and the dead entry is still gone', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.set(a, 'a-state');
    const b = recycle(a);
    expect(t.getOrCreate(b, () => undefined)).toBeUndefined();
    expect(t.hasId(b.id())).toBe(false);
    expect(disposed).toEqual([['a-state', a.id()]]);
  });

  it('set disposes what it replaces — this entity\'s previous value, or a dead entity\'s entry', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.set(a, 'a1');
    t.set(a, 'a1');                      // same value: nothing to release
    expect(disposed).toEqual([]);
    t.set(a, 'a2');
    expect(disposed).toEqual([['a1', a.id()]]);
    expect(t.get(a)).toBe('a2');
    disposed.length = 0;

    const b = recycle(a);
    t.set(b, 'b1');
    expect(disposed).toEqual([['a2', a.id()]]);
    expect(t.get(b)).toBe('b1');
  });

  it('touch evicts a dead entity\'s entry so the sweep cannot keep it alive for the newcomer', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    // The dead entry is written INSIDE the same pass the newcomer is touched in, so its pass stamp
    // is already current — only `touch`'s own eviction drops it. (Written in an earlier pass, the
    // sweep would drop it anyway and this test could not tell the two mechanisms apart.)
    t.beginPass();
    t.set(a, 'a-state');
    const b = recycle(a);
    t.touch(b);
    t.endPass();
    expect(disposed).toEqual([['a-state', a.id()]]);
    expect(t.size).toBe(0);
  });

  it('delete(entity) removes whatever the index holds, dead or live', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.set(a, 'a-state');
    const b = recycle(a);
    expect(t.delete(b)).toBe(true);
    expect(disposed).toEqual([['a-state', a.id()]]);
    expect(t.delete(b)).toBe(false);
  });
});

describe('EntityTable — a DEAD handle cannot touch the newcomer\'s entry', () => {
  // A stale `Entity` captured before a despawn (an async load\'s .then, an ended listener, a
  // crossfade finishing) and used after the index was reclaimed. Every write must leave the live
  // newcomer\'s entry exactly as it was.
  function setup() {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.set(a, 'a-state');
    const b = recycle(a);
    t.set(b, 'b-state');
    disposed.length = 0;
    return { t, disposed, a, b };
  }
  const intact = (s: ReturnType<typeof setup>) => {
    expect(s.disposed).toEqual([]);
    expect(s.t.get(s.b)).toBe('b-state');
  };

  it('set', () => { const s = setup(); s.t.set(s.a, 'ghost'); intact(s); });
  it('replace', () => { const s = setup(); expect(s.t.replace(s.a, 'ghost')).toBeUndefined(); intact(s); });
  it('getOrCreate', () => {
    const s = setup();
    let built = 0;
    expect(s.t.getOrCreate(s.a, () => { built++; return 'ghost'; })).toBeUndefined();
    expect(built).toBe(0);
    intact(s);
  });
  it('delete', () => { const s = setup(); expect(s.t.delete(s.a)).toBe(false); intact(s); });
  it('touch', () => {
    const s = setup();
    s.t.beginPass();
    s.t.touch(s.a);
    s.t.touch(s.b);
    s.t.endPass();
    intact(s);
  });
});

describe('EntityTable — a DEAD handle over its OWN leftover entry', () => {
  // Despawned, index not yet reclaimed or swept: the slot still holds the entry stamped for it.
  it('cannot overwrite it, and cannot keep it alive through a sweep', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    t.beginPass();
    t.set(a, 'a-state');
    t.endPass();
    a.destroy();

    t.set(a, 'ghost');
    expect(t.replace(a, 'ghost')).toBeUndefined();
    expect(t.peekId(a.id())).toBe('a-state');
    expect(disposed).toEqual([]);
    let built = 0;
    expect(t.getOrCreate(a, () => { built++; return 'ghost'; })).toBe('a-state');
    expect(built).toBe(0);

    t.beginPass();
    t.touch(a);
    t.getOrCreate(a, () => 'ghost');
    t.endPass();
    expect(disposed).toEqual([['a-state', a.id()]]);   // swept: nothing live touched it
  });
});

describe('EntityTable — replace', () => {
  it('hands back this entity\'s previous value WITHOUT disposing it', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const a = world.spawn();
    expect(t.replace(a, 'a1')).toBeUndefined();
    expect(t.replace(a, 'a2')).toBe('a1');
    expect(disposed).toEqual([]);
    expect(t.get(a)).toBe('a2');

    const b = recycle(a);
    // A dead entity\'s entry is nobody\'s to hand back: disposed, and not returned.
    expect(t.replace(b, 'b1')).toBeUndefined();
    expect(disposed).toEqual([['a2', a.id()]]);
  });
});

describe('EntityTable — sweep', () => {
  it('endPass disposes exactly the entries not touched or written this pass', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const [x, y, z] = [world.spawn(), world.spawn(), world.spawn()];
    t.set(x, 'x'); t.set(y, 'y'); t.set(z, 'z');

    t.beginPass();
    t.touch(x);
    t.getOrCreate(y, () => 'unused');
    t.endPass();
    expect(disposed).toEqual([['z', z.id()]]);
    expect([...t.ids()].sort()).toEqual([x.id(), y.id()].sort());
  });

  it('refuses endPass without beginPass', () => {
    const { t } = table<string>();
    expect(() => t.endPass()).toThrow(/without beginPass/);
  });

  it('a pass abandoned by a throw does not wedge the next one — beginPass restarts, and so does clear', () => {
    world = createWorld();
    const { t, disposed } = table<string>();
    const [x, y] = [world.spawn(), world.spawn()];
    t.set(x, 'x'); t.set(y, 'y');
    t.beginPass();
    expect(() => t.getOrCreate(world!.spawn(), () => { throw new Error('malformed asset'); })).toThrow();
    // endPass never ran. The next frame must still be able to sweep.
    t.beginPass();
    t.touch(x);
    t.endPass();
    expect(disposed).toEqual([['y', y.id()]]);

    t.beginPass();
    t.clear();
    expect(() => t.endPass()).toThrow(/without beginPass/);
  });

  it('clear disposes every entry even when one dispose throws, then rethrows the first error', () => {
    world = createWorld();
    const released: string[] = [];
    const t = new EntityTable<string>({ label: 'throws', worldSwap: 'owner-clears', dispose: (v) => {
      released.push(v);
      if (v === 'bad') throw new Error('dispose failed');
    } });
    const [x, y, z] = [world.spawn(), world.spawn(), world.spawn()];
    t.set(x, 'bad'); t.set(y, 'ok1'); t.set(z, 'ok2');
    expect(() => t.clear()).toThrow(/dispose failed/);
    expect(released.sort()).toEqual(['bad', 'ok1', 'ok2']);
    expect(t.size).toBe(0);
  });

  it('retain and clear dispose what they drop', () => {
    world = createWorld();
    const { t, disposed } = table<number>();
    const [x, y] = [world.spawn(), world.spawn()];
    t.set(x, 1); t.set(y, 2);
    t.retain((v) => v === 1);
    expect(disposed).toEqual([[2, y.id()]]);
    t.clear();
    expect(disposed).toEqual([[2, y.id()], [1, x.id()]]);
    expect(t.size).toBe(0);
  });
});

describe('EntityTable — world swap', () => {
  it('worldSwap:"clear" disposes every entry on a swap; "owner-clears" keeps them', () => {
    world = createWorld();
    const cleared = table<string>('clear');
    const kept = table<string>('owner-clears');
    const a = world.spawn();
    cleared.t.set(a, 'a');
    kept.t.set(a, 'a');

    const next = createWorld();
    try {
      setCurrentWorld(next);
      expect(cleared.disposed).toEqual([['a', a.id()]]);
      expect(cleared.t.size).toBe(0);
      expect(kept.disposed).toEqual([]);
      expect(kept.t.size).toBe(1);
    } finally {
      next.destroy();
    }
  });

  it('detach stops the world-swap clear', () => {
    world = createWorld();
    const { t, disposed } = table<string>('clear');
    const control = table<string>('clear');   // proves the same swap DOES clear an attached table
    const e = world.spawn();
    t.set(e, 'a');
    control.t.set(e, 'a');
    t.detach();
    const next = createWorld();
    try {
      setCurrentWorld(next);
      expect(control.disposed).toEqual([['a', e.id()]]);
      expect(disposed).toEqual([]);
    } finally {
      next.destroy();
    }
  });
});

describe('isPackedAlive', () => {
  it('is true for the live entity, false for a recycled index\'s dead one, and false once the world is destroyed', () => {
    world = createWorld();
    const a = world.spawn();
    const pa = packedOf(a);
    expect(isPackedAlive(pa)).toBe(true);
    const b = recycle(a);
    expect(isPackedAlive(pa)).toBe(false);
    expect(isPackedAlive(packedOf(b))).toBe(true);
    const pb = packedOf(b);
    world.destroy();
    world = undefined;
    expect(isPackedAlive(pb)).toBe(false);
  });
});

describe('packedOf', () => {
  it('distinguishes a recycled index', () => {
    world = createWorld();
    const a = world.spawn();
    const pa = packedOf(a);
    const b = recycle(a);
    expect(packedOf(b)).not.toBe(pa);
  });
});
