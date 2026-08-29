/** PlayerPrefs — engine-owned atomic per-key JSON store.
 *
 *  Phase 1: the core service against the default in-memory backend. Covers the
 *  Unity-style sync surface, per-key atomicity, the JSON/POJO contract, envelope
 *  fail-soft, namespace isolation, debounced flush durability, and determinism
 *  (no wall-clock / randomness). Platform backends are exercised in Phase 2. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest, type PrefsBackend,
} from '../../src/runtime/storage';

afterEach(() => {
  resetPlayerPrefsForTest();
});

describe('PlayerPrefs — core get/set', () => {
  it('round-trips a POJO document by key', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('progress', { level: 5, coins: 100, unlocked: ['a', 'b'] });
    expect(PlayerPrefs.get('progress')).toEqual({ level: 5, coins: 100, unlocked: ['a', 'b'] });
  });

  it('supports bare primitives at the top level', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('coins', 42);
    PlayerPrefs.set('name', 'Ada');
    PlayerPrefs.set('muted', true);
    PlayerPrefs.set('nothing', null);
    expect(PlayerPrefs.get('coins')).toBe(42);
    expect(PlayerPrefs.get('name')).toBe('Ada');
    expect(PlayerPrefs.get('muted')).toBe(true);
    expect(PlayerPrefs.get('nothing')).toBeNull();
  });

  it('returns undefined for an unknown key', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    expect(PlayerPrefs.get('missing')).toBeUndefined();
    expect(PlayerPrefs.has('missing')).toBe(false);
  });

  it('overwrites an existing key wholesale', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('s', { a: 1 });
    PlayerPrefs.set('s', { b: 2 });
    expect(PlayerPrefs.get('s')).toEqual({ b: 2 });
  });
});

describe('PlayerPrefs — delete semantics', () => {
  it('set(key, undefined) deletes the key', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('x', 1);
    PlayerPrefs.set('x', undefined);
    expect(PlayerPrefs.get('x')).toBeUndefined();
    expect(PlayerPrefs.has('x')).toBe(false);
  });

  it('delete() removes the key and clear() empties the namespace', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('a', 1);
    PlayerPrefs.set('b', 2);
    PlayerPrefs.delete('a');
    expect(PlayerPrefs.keys().sort()).toEqual(['b']);
    PlayerPrefs.clear();
    expect(PlayerPrefs.keys()).toEqual([]);
  });

  it('clear() is durable — the backend is emptied and stays empty across reload', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('a', 1);
    PlayerPrefs.set('b', 2);
    await PlayerPrefs.flush();

    PlayerPrefs.clear();
    await PlayerPrefs.flush();
    expect(Object.keys(await backend.getAll('mk:g1:'))).toEqual([]);

    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    expect(PlayerPrefs.keys()).toEqual([]); // no stale entries re-hydrated
  });
});

describe('PlayerPrefs — immutability & JSON contract', () => {
  it('hands back a fresh copy — mutating a read never affects the store', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    PlayerPrefs.set('doc', { nested: { n: 1 } });
    const read = PlayerPrefs.get<{ nested: { n: number } }>('doc')!;
    read.nested.n = 999;
    expect(PlayerPrefs.get('doc')).toEqual({ nested: { n: 1 } });
  });

  it('mutating the object passed to set() after the call never affects the store', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    const obj = { n: 1 };
    PlayerPrefs.set('doc', obj);
    obj.n = 2;
    expect(PlayerPrefs.get('doc')).toEqual({ n: 1 });
  });

  it('skips (warns, does not throw) a non-serializable value with a cycle', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Cast through unknown — the type system would reject this; we assert runtime safety.
    expect(() => PlayerPrefs.set('bad', cyclic as never)).not.toThrow();
    expect(PlayerPrefs.get('bad')).toBeUndefined();
  });

  it('skips a top-level function/symbol value (would serialize to a d-less envelope)', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    expect(() => PlayerPrefs.set('fn', (() => 1) as never)).not.toThrow();
    // Not stored — no phantom has()===true / get()===undefined split, no vanish-on-reload.
    expect(PlayerPrefs.has('fn')).toBe(false);
    expect(PlayerPrefs.get('fn')).toBeUndefined();
  });
});

describe('PlayerPrefs — namespace isolation', () => {
  it('keeps two namespaces separate against the same backend', async () => {
    const shared = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'gameA', backend: shared });
    PlayerPrefs.set('score', 10);
    await PlayerPrefs.flush();

    await PlayerPrefs.init({ namespace: 'gameB', backend: shared });
    expect(PlayerPrefs.get('score')).toBeUndefined(); // gameB can't see gameA's key
    PlayerPrefs.set('score', 20);
    await PlayerPrefs.flush();

    await PlayerPrefs.init({ namespace: 'gameA', backend: shared });
    expect(PlayerPrefs.get('score')).toBe(10); // gameA's value survived intact
  });
});

describe('PlayerPrefs — hydration & durability', () => {
  it('hydrates prior values from the backend on init (simulated reload)', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('save', { hp: 3 });
    await PlayerPrefs.flush();

    // Simulate a fresh launch: reset the module, re-init against the same backend.
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    expect(PlayerPrefs.get('save')).toEqual({ hp: 3 });
    expect(PlayerPrefs.isHydrated()).toBe(true);
  });

  it('flush() resolves after pending debounced writes are durable', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('a', 1);
    PlayerPrefs.set('b', 2);
    await PlayerPrefs.flush();
    const raw = await backend.getAll('mk:g1:');
    expect(Object.keys(raw).sort()).toEqual(['mk:g1:a', 'mk:g1:b']);
  });

  it('a game swap flushes the previous namespace even without an explicit flush', async () => {
    // Pins init()'s leading "if (hydrated) await flush()": a debounced write for the
    // outgoing game must be persisted before the cache is cleared for the new game.
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'a', backend });
    PlayerPrefs.set('k', 1); // deliberately NOT flushed
    await PlayerPrefs.init({ namespace: 'b', backend }); // swap — must flush 'a' first
    await PlayerPrefs.init({ namespace: 'a', backend }); // return to 'a'
    expect(PlayerPrefs.get('k')).toBe(1);
  });

  it('a corrupt backend entry fails soft to undefined on hydrate', async () => {
    const backend = new InMemoryBackend();
    await backend.set('mk:g1:broken', '{not valid json');
    await backend.set('mk:g1:ok', JSON.stringify({ v: 1, d: 7 }));
    await PlayerPrefs.init({ namespace: 'g1', backend });
    expect(PlayerPrefs.get('broken')).toBeUndefined();
    expect(PlayerPrefs.get('ok')).toBe(7);
  });
});

describe('PlayerPrefs — per-key atomicity', () => {
  it('a write to one key leaves other keys intact (no cross-key coupling)', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('a', { big: 'x'.repeat(1000) });
    PlayerPrefs.set('b', { small: 1 });
    await PlayerPrefs.flush();

    PlayerPrefs.set('a', { big: 'y'.repeat(1000) });
    await PlayerPrefs.flush();

    // b is byte-identical to its original single-key write.
    const raw = await backend.getAll('mk:g1:');
    expect(raw['mk:g1:b']).toBe(JSON.stringify({ v: 1, d: { small: 1 } }));
    expect(PlayerPrefs.get('a')).toEqual({ big: 'y'.repeat(1000) });
  });

  it('each set() is an independent atomic backend write', async () => {
    const writes: string[] = [];
    const spy: PrefsBackend = {
      getAll: async () => ({}),
      set: async (k) => { writes.push(k); },
      remove: async (k) => { writes.push(`-${k}`); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: spy });
    PlayerPrefs.set('a', 1);
    PlayerPrefs.set('b', 2);
    PlayerPrefs.delete('a');
    await PlayerPrefs.flush();
    // Latest state coalesced per key: b written, a removed (order within a drain may vary).
    expect(writes).toContain('mk:g1:b');
    expect(writes).toContain('-mk:g1:a');
  });

  it('calls backend.flush() once per drained batch, after the writes it covers (#335)', async () => {
    const events: string[] = [];
    const spy: PrefsBackend = {
      getAll: async () => ({}),
      set: async (k) => { events.push(`set:${k}`); },
      remove: async () => {},
      flush: async () => { events.push('flush'); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: spy });
    PlayerPrefs.set('a', 1);
    PlayerPrefs.set('b', 2);
    await PlayerPrefs.flush();
    expect(events).toEqual(['set:mk:g1:a', 'set:mk:g1:b', 'flush']); // one flush, after both sets

    events.length = 0;
    PlayerPrefs.set('c', 3);
    await PlayerPrefs.flush();
    expect(events).toEqual(['set:mk:g1:c', 'flush']); // a later, separate batch — flush() again

    events.length = 0;
    await PlayerPrefs.flush(); // nothing dirty — drain() short-circuits, no flush() call
    expect(events).toEqual([]);
  });

  it('a backend with no flush() (e.g. InMemory/Preferences) drains without error', async () => {
    const backend = new InMemoryBackend(); // has no `flush` method at all
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('a', 1);
    await expect(PlayerPrefs.flush()).resolves.toBeUndefined();
  });

  it('a rejecting backend.flush() never poisons writeChain — later writes still land (#335 review)', async () => {
    const store = new Map<string, string>();
    let failFlushOnce = true;
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      flush: async () => {
        if (failFlushOnce) { failFlushOnce = false; throw new Error('flushStorageData IPC gone'); }
      },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend });

    PlayerPrefs.set('a', 1); // this batch's flush() throws
    await PlayerPrefs.flush(); // must resolve anyway — the throw is caught, not propagated
    expect(store.get('mk:g1:a')).toBe(JSON.stringify({ v: 1, d: 1 })); // the SET itself still landed

    PlayerPrefs.set('b', 2); // a later, independent batch
    await PlayerPrefs.flush(); // must not be wedged by the earlier rejection
    expect(store.get('mk:g1:b')).toBe(JSON.stringify({ v: 1, d: 2 }));
  });
});

describe('PlayerPrefs — determinism', () => {
  it('the source uses no wall-clock or randomness', async () => {
    // Guard mirror: the module must not read Date.now()/performance.now()/Math.random()
    // (enforced repo-wide by determinismGuard.test.ts). Sanity-assert behavior is
    // stable across two identical runs.
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('k', { seq: [1, 2, 3] });
    await PlayerPrefs.flush();
    const first = (await backend.getAll('mk:g1:'))['mk:g1:k'];

    resetPlayerPrefsForTest();
    const backend2 = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend: backend2 });
    PlayerPrefs.set('k', { seq: [1, 2, 3] });
    await PlayerPrefs.flush();
    const second = (await backend2.getAll('mk:g1:'))['mk:g1:k'];

    expect(first).toBe(second); // identical bytes — no timestamp/nonce in the envelope
  });
});

describe('PlayerPrefs — backend-failure resilience', () => {
  it('a rejecting backend write never poisons the pipeline; a later write still lands', async () => {
    let failNext = true;
    const store = new Map<string, string>();
    const flaky: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => {
        if (failNext) { failNext = false; throw new Error('QuotaExceeded (simulated)'); }
        store.set(k, v);
      },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: flaky });

    PlayerPrefs.set('a', 1); // this write's backend.set rejects once
    await PlayerPrefs.flush();

    PlayerPrefs.set('b', 2); // pipeline must NOT be wedged — this must persist
    await PlayerPrefs.flush();
    expect(store.get('mk:g1:b')).toBe(JSON.stringify({ v: 1, d: 2 }));

    // 'a' was re-queued after its failure; a subsequent flush retries and lands it.
    await PlayerPrefs.flush();
    expect(store.get('mk:g1:a')).toBe(JSON.stringify({ v: 1, d: 1 }));
  });

  it('pendingKeys() sees a rejected DELETE that keys() structurally cannot (#422)', async () => {
    // A delete removes the key from `cache` immediately, so `keys()` never has it — but it's
    // still `dirty` if the backend rejected the remove. `keys().filter(hasPendingWrite)` can
    // never reconstruct that; `pendingKeys()` reads `dirty` directly and does.
    const store = new Map<string, string>();
    store.set('mk:g1:k', JSON.stringify({ v: 1, d: 1 }));
    const flaky: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => { store.set(k, v); },
      // Always rejects — the test asserts the state right after flush(), which drains twice
      // internally; a reject-once backend would let the second internal drain quietly succeed.
      remove: async () => { throw new Error('I/O error (simulated)'); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: flaky });
    expect(PlayerPrefs.get('k')).toBe(1); // hydrated

    PlayerPrefs.delete('k');
    await PlayerPrefs.flush(); // the backend.remove() call rejects once, re-queuing 'k' into dirty

    expect(PlayerPrefs.keys()).not.toContain('k'); // blind spot: gone from the cache-derived view
    expect(PlayerPrefs.pendingKeys()).toContain('k'); // authoritative: still pending
  });

  it('pendingKeys() under-reports MID-DRAIN — pinning KNOWN behaviour the doc now qualifies, not a bug (#422)', async () => {
    // `drain()` does `const keys = [...dirty]; dirty.clear();` and only THEN awaits the backend
    // calls, so `dirty` — and so `pendingKeys()` — is empty for the entire duration of a batch,
    // even though every one of those writes is genuinely still in flight. This mechanic is
    // pre-existing and correct (drain() must own the keys it's about to attempt so a write
    // dirtied mid-batch isn't silently swallowed); the #422 follow-up fixed only that the doc
    // comments called `pendingKeys()` unconditionally "authoritative" with no timing qualifier.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const store = new Map<string, string>();
    const gated: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      // Blocks on `gate`, then always rejects — simulates a slow backend whose write is
      // in flight and about to be rejected (quota, native I/O).
      set: async () => { await gate; throw new Error('rejected after delay (simulated)'); },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: gated });

    PlayerPrefs.set('k', 1);
    const flushPromise = PlayerPrefs.flush(); // drain() starts; its set() call is now blocked on `gate`

    // Let the microtask queue advance far enough for drain()'s synchronous
    // `dirty.clear()` to run (it happens before the gated `await` inside the per-key write).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Mid-drain: the write is genuinely in flight (blocked on `gate`), but `dirty` has already
    // been emptied — this is the under-report the doc comments now describe.
    expect(PlayerPrefs.pendingKeys()).toEqual([]);

    releaseGate();
    await flushPromise;

    // The blocked write has now resolved — and rejected — so it was re-queued into `dirty`.
    // `pendingKeys()` is authoritative again now that we're at a stable point (post-flush).
    expect(PlayerPrefs.pendingKeys()).toContain('k');
  });
});

describe('PlayerPrefs — namespace edge cases', () => {
  it('an empty-string namespace resets to the default (not the prior namespace)', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'realGame', backend });
    PlayerPrefs.set('score', 99);
    await PlayerPrefs.flush();

    await PlayerPrefs.init({ namespace: '', backend });
    PlayerPrefs.set('x', 1);
    await PlayerPrefs.flush();
    // The empty namespace maps to 'default', not 'realGame'.
    expect(Object.keys(await backend.getAll('mk:default:'))).toEqual(['mk:default:x']);
    expect(PlayerPrefs.get('score')).toBeUndefined();
  });
});
