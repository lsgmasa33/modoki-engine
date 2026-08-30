/** PlayerPrefs — engine-owned atomic per-key JSON store.
 *
 *  Phase 1: the core service against the default in-memory backend. Covers the
 *  Unity-style sync surface, per-key atomicity, the JSON/POJO contract, envelope
 *  fail-soft, namespace isolation, debounced flush durability, and determinism
 *  (no wall-clock / randomness). Platform backends are exercised in Phase 2. */

import { describe, it, expect, afterEach, vi } from 'vitest';
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

  it('init() reports + discards a write the pre-swap convergence loop could not land (#421)', async () => {
    const store = new Map<string, string>();
    const rejecting: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async () => { throw new Error('QuotaExceeded (simulated)'); },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('a', 1);
    await PlayerPrefs.flush(); // attempted + rejected — 'a' is left in `dirty`
    expect(PlayerPrefs.pendingKeys()).toContain('a');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await PlayerPrefs.init({ namespace: 'g2' });

    expect(result.discardedPending).toEqual(['a']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('a');
    // Mirror guard (symmetric with the not-hydrated test's `not.toContain('rejected')` below): a
    // real swap must carry the non-acceptance wording and must NOT carry the write-before-init()
    // wording — deleting the `if (wasHydrated)` branch and reusing the not-hydrated message for
    // both (the shape #421's review reproduced) still passes every assertion that only checks
    // `toContain('a')`, since 'a' is the key and appears in both messages.
    expect(message).toContain('did not accept');
    expect(message).not.toContain('before init() was called');
    // The convergence loop CONVERGED here (the rejected set stopped changing), so this is the
    // "genuinely not accepted" case — the message must claim exactly that, not the "some may
    // never have been attempted" wording reserved for the non-converged case below.
    expect(message).not.toContain('may never have been attempted');
    errorSpy.mockRestore();
  });

  it('discardedPending is SORTED, not in the zeta-then-alpha dirty order (#421)', async () => {
    const store = new Map<string, string>();
    const rejecting: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async () => { throw new Error('QuotaExceeded (simulated)'); },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('zeta', 1);
    PlayerPrefs.set('alpha', 2);
    await PlayerPrefs.flush(); // both attempted + rejected, in insertion (zeta, alpha) order in `dirty`

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await PlayerPrefs.init({ namespace: 'g2' });
      expect(result.discardedPending).toEqual(['alpha', 'zeta']);
    } finally {
      // try/finally so a failing assertion here (e.g. under a mutation check) can't leak the
      // mocked console.error into later tests in this file.
      errorSpy.mockRestore();
    }
  });

  it('init() reports nothing on the ordinary path — no pending writes, no console.error', async () => {
    const backend = new InMemoryBackend();
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('a', 1);
    await PlayerPrefs.flush(); // lands cleanly — nothing left in `dirty`

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await PlayerPrefs.init({ namespace: 'g2', backend });

    expect(result.discardedPending).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a write before the FIRST init() is discarded as a caller bug, not reported as a rejection (#421)', async () => {
    // No flush() runs on this path at all — `hydrated` is false, so init() skips straight past
    // `if (hydrated) await flush()`. Anything in `dirty` here was set() before init() ever ran.
    PlayerPrefs.set('x', 1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await PlayerPrefs.init({ namespace: 'g1' });

    expect(result.discardedPending).toEqual(['x']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('x');
    // Over-claim guard: this case never went through a flush, so nothing was rejected by a
    // backend — the message must not say so.
    expect(message).not.toContain('rejected');
    errorSpy.mockRestore();
  });

  // Passes under the OLD (pre-#421-review-fixes) code too — it never touches the return value or
  // the message, only that the swap itself completes. Kept as a guard against a future "init()
  // throws/refuses instead of discarding" regression, not as coverage of this change's own fixes.
  it('a discarded pending write does not stop the swap from completing', async () => {
    const store = new Map<string, string>();
    const rejecting: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async () => { throw new Error('QuotaExceeded (simulated)'); },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('a', 1);
    await PlayerPrefs.flush();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await PlayerPrefs.init({ namespace: 'g2' });

    expect(PlayerPrefs.namespace()).toBe('g2');
    expect(PlayerPrefs.isHydrated()).toBe(true);
    errorSpy.mockRestore();
  });

  it('a write racing the SECOND drain of a single flush() call actually LANDS, not discarded as rejected (#421)', async () => {
    // Regression pin for the unsound half of #421's original fix: `flush()` drains AT MOST TWICE,
    // and `drain()` snapshots `dirty` into a local array BEFORE awaiting the backend, so a `set()`
    // landing during that second drain is never attempted by anyone — a plain `await flush()` (the
    // pre-fix `init()` body) returned with it still dirty, and the pre-fix code reported it as
    // "rejected by the backend" even though the backend never saw it and would have accepted it.
    //
    // To land IN the second drain deterministically: 'r' rejects on its first attempt (forcing
    // `flush()`'s own internal second drain to retry it), then blocks on its retry — the test
    // injects the racing `set('second', …)` exactly while that retry is in flight, after the
    // second drain's `dirty.clear()` has already run. This backend always eventually SUCCEEDS, so
    // any discard here is unambiguously the bug, not a real rejection.
    const store = new Map<string, string>();
    let rAttempts = 0;
    let secondAttemptStarted: () => void = () => {};
    const secondAttemptStartedPromise = new Promise<void>((resolve) => { secondAttemptStarted = resolve; });
    let releaseRGate: () => void = () => {};
    const rGate = new Promise<void>((resolve) => { releaseRGate = resolve; });
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => {
        if (k.endsWith(':r')) {
          rAttempts++;
          if (rAttempts === 1) throw new Error('rejected once (simulated)'); // re-queued by drain()
          secondAttemptStarted(); // signal: this drain's snapshot+clear has already run
          await rGate;
        }
        store.set(k, v);
      },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('r', 1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const initPromise = PlayerPrefs.init({ namespace: 'g2' }); // starts the pre-swap convergence loop

    await secondAttemptStartedPromise; // flush()'s internal second drain is blocked retrying 'r'
    PlayerPrefs.set('second', 2); // lands in the now-empty `dirty` — invisible to this drain
    releaseRGate();

    const result = await initPromise;

    expect(result.discardedPending).toEqual([]);
    expect(store.has('mk:g1:second')).toBe(true); // the racing write LANDED, not merely re-queued
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('init() names neither rejection nor never-attempted when the pending set never stops changing', async () => {
    // A backend that always ACCEPTS but is slow enough that a new write keeps landing every pass —
    // the convergence loop hits MAX_PRESWAP_FLUSHES with the pending set still changing. Neither
    // "rejected" nor "never attempted" is knowable for these keys, so the message must claim
    // neither as fact.
    const store = new Map<string, string>();
    let pass = 0;
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => {
        store.set(k, v);
        // Every accepted write spawns one more dirty key, so `dirty`'s CONTENTS keep changing on
        // every drain and the loop never converges within its cap.
        pass++;
        PlayerPrefs.set(`k${pass}`, pass);
      },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('k0', 0);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await PlayerPrefs.init({ namespace: 'g2' });

    expect(result.discardedPending.length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).not.toContain('did not accept');
    expect(message).toContain('may never have been attempted');
    errorSpy.mockRestore();
  });

  it('a getAll() rejection leaves hydrated FALSE, not stale-true from the previous namespace (#421)', async () => {
    await PlayerPrefs.init({ namespace: 'g1' }); // ordinary in-memory init — hydrated becomes true
    expect(PlayerPrefs.isHydrated()).toBe(true);

    const throwing: PrefsBackend = {
      getAll: async () => { throw new Error('backend unavailable (simulated)'); },
      set: async () => {},
      remove: async () => {},
    };
    await expect(PlayerPrefs.init({ namespace: 'g2', backend: throwing })).rejects.toThrow();
    expect(PlayerPrefs.isHydrated()).toBe(false);
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
