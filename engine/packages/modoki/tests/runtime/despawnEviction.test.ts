/** #868 — `createDespawnEviction`: an entry is deleted synchronously when its entity is destroyed
 *  or loses the population trait, and only for the world the cache was last bound to. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, trait, type World } from 'koota';
import { createDespawnEviction } from '../../src/runtime/core/ecs/despawnEviction';

const Tracked = trait({ v: 0 });
const Other = trait({ v: 0 });

const worlds: World[] = [];
function newWorld(): World { const w = createWorld(); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.destroy(); });

describe('createDespawnEviction', () => {
  it('evicts the destroyed entity\'s id before a spawn can reclaim the index', () => {
    const w = newWorld();
    const cache = new Map<number, string>();
    const ev = createDespawnEviction(Tracked, (id) => cache.delete(id));
    const a = w.spawn(Tracked());
    cache.set(a.id(), 'a');
    ev.bind(w);

    a.destroy();
    expect(cache.has(a.id())).toBe(false);
    const b = w.spawn(Tracked());
    expect(b.id()).toBe(a.id());
    expect(cache.get(b.id())).toBeUndefined();
  });

  it('evicts on a plain removal of the trait, and not on a destroy of an entity without it', () => {
    const w = newWorld();
    const evicted: number[] = [];
    const ev = createDespawnEviction(Tracked, (id) => evicted.push(id));
    ev.bind(w);
    const kept = w.spawn(Other());
    const stripped = w.spawn(Tracked());

    kept.destroy();
    expect(evicted).toEqual([]);
    stripped.remove(Tracked);
    expect(evicted).toEqual([stripped.id()]);
  });

  it('binding another world stops evictions from the first', () => {
    const w1 = newWorld();
    const w2 = newWorld();
    const evicted: string[] = [];
    const ev = createDespawnEviction(Tracked, () => evicted.push('x'));
    const e1 = w1.spawn(Tracked());
    const e2 = w2.spawn(Tracked());

    ev.bind(w1);
    ev.bind(w2);
    e1.destroy();
    expect(evicted).toEqual([]);
    e2.destroy();
    expect(evicted).toEqual(['x']);
  });

  it('unbind stops evictions', () => {
    const w = newWorld();
    let n = 0;
    const ev = createDespawnEviction(Tracked, () => { n++; });
    ev.bind(w);
    w.spawn(Tracked()).destroy();
    expect(n).toBe(1);

    ev.unbind();
    w.spawn(Tracked()).destroy();
    expect(n).toBe(1);
  });
});
