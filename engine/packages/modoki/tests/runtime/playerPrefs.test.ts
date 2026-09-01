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

  it('pendingKeys() reports a MID-DRAIN write as still pending — it used to under-report, which was a bug, not a documented quirk (#422 -> #559)', async () => {
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

    // ⚠️ **THIS EXPECTATION WAS INVERTED BY #559, and the old one was wrong — not merely
    // superseded.** The title this test used to carry, kept as the scar:
    //
    //     "pendingKeys() under-reports MID-DRAIN — pinning KNOWN behaviour the doc now qualifies,
    //      not a bug (#422)"
    //
    // A defect with a guard posted on it. It did not merely permit #532 F17 and #558 — both CITED
    // this test's framing as evidence the behaviour was intended, which is how a documented gap
    // becomes a licence. If you are here to relax this assertion, that is the history to beat. It used to assert `[]` here and called that "known behaviour the doc
    // qualifies". It was a defect with a test defending it: mid-drain the write is genuinely in
    // flight and about to be REJECTED, and reporting it as landed defeats the only signal these
    // accessors exist to give. `get()` re-reads the optimistic cache and cannot fail, so
    // `hasPendingWrite`/`pendingKeys` are the sole way to tell "stored" from "queued while the
    // cache lies" — the distinction #196 added them for, where it is real money.
    //
    // Documenting the gap did not shrink it: Court then hit it twice (#532 F17 — a gate credited
    // coins for a rejected write and logged nothing; #558 — the same shape in account deletion) and
    // built a flush-until-stable loop game-side that could not close it either, because under a
    // repeating concurrent flush BOTH of that loop's samples land mid-drain and agree. No caller
    // could fix this: "a drain is in flight" is private to the module.
    expect(
      PlayerPrefs.pendingKeys(),
      'a write still in flight has not been accepted, so it is still pending',
    ).toEqual(['k']);
    expect(PlayerPrefs.hasPendingWrite('k')).toBe(true);

    releaseGate();
    await flushPromise;

    // The blocked write has now resolved — and rejected — so it was re-queued into `dirty`. Since
    // #559 there is no longer a window in which it read as durable, so this is a continuation of
    // the state above rather than a recovery from a temporary lie.
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

describe('PlayerPrefs — swap-window residuals (#454)', () => {
  it('a backend swap under the SAME namespace re-queues the key — the RETRY follows the game, the value does not (#454 A)', async () => {
    // Pins drain()'s rejection-handler guard: `if (namespace === batchNamespace)` is
    // NAMESPACE-only, deliberately — a same-game reload that swaps only the BACKEND (like
    // App.tsx's `init({namespace: gameId, backend: selectDefaultBackend()})`) is NOT detected
    // by it, so the key re-queues and the retry is issued against the new backend.
    //
    // ⚠️ Read the `remove:` assertion at the bottom before believing the name: what follows the
    // game is the retry ATTEMPT, not the outgoing write's value. The install cleared `cache`
    // and repopulated it from the incoming backend long before this rejection settled, so the
    // retry is a no-op against that game's own store. That is the whole reason this branch is
    // harmless — not that anything was preserved. See drain()'s doc comment (#454 A).
    //
    // To exercise the guard for real (not just trivially, since the namespace value never
    // changes here) the write has to still be IN FLIGHT — inside drain()'s own
    // `Promise.all`, already claimed out of `dirty` — at the exact instant the swap installs
    // backend2. Only then does the eventual rejection settle with `backend` already pointing
    // at the new store while `namespace` reads the same as `batchNamespace`. Fake timers fire
    // the debounce directly (a SINGLE, un-retried drain() batch) rather than going through
    // `flush()`'s own built-in two-drain retry, which would otherwise consume the re-queue
    // against the new backend before this test gets a chance to observe it.
    vi.useFakeTimers();
    try {
      let releaseGetAll: () => void = () => {};
      const getAllGate = new Promise<void>((resolve) => { releaseGetAll = resolve; });
      let getAllStarted: () => void = () => {};
      const getAllStartedPromise = new Promise<void>((resolve) => { getAllStarted = resolve; });

      let releaseSet: () => void = () => {};
      const setGate = new Promise<void>((resolve) => { releaseSet = resolve; });
      let setStarted: () => void = () => {};
      const setStartedPromise = new Promise<void>((resolve) => { setStarted = resolve; });

      const backend1: PrefsBackend = {
        getAll: async () => ({}),
        // Blocks until released, then always rejects — the outgoing store's write is still
        // in flight when the swap installs backend2.
        set: async () => { setStarted(); await setGate; throw new Error('rejected — settles after the swap (simulated)'); },
        remove: async () => {},
      };

      const store2 = new Map<string, string>();
      const backend2Attempts: string[] = [];
      const backend2: PrefsBackend = {
        getAll: async (prefix) => {
          getAllStarted();
          await getAllGate;
          const out: Record<string, string> = {};
          for (const [k, v] of store2) if (k.startsWith(prefix)) out[k] = v;
          return out;
        },
        // `install`'s `cache.clear()` (in doInitBody) wipes 'k'\'s cached VALUE the instant it
        // runs, regardless of the write still being in flight against backend1 — `cache` and
        // `dirty` are cleared together by design (see the ⚠️ comment above the install block).
        // So the re-queue this test is pinning is a `dirty`-only signal: the retry that reaches
        // backend2 reads `cache.get('k')` as absent and calls `remove`, not `set` — which is
        // the correct, unsurprising behaviour for a key whose last known good value the process
        // no longer holds. What #454 A guarantees is that backend2 is asked about 'k' AT ALL,
        // rather than the write vanishing with nothing retried against the new store.
        set: async (k, v) => { backend2Attempts.push(`set:${k}`); store2.set(k, v); },
        remove: async (k) => { backend2Attempts.push(`remove:${k}`); store2.delete(k); },
      };

      await PlayerPrefs.init({ namespace: 'g1', backend: backend1 });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Same namespace, NEW backend — a reload, not a game swap.
      const initPromise = PlayerPrefs.init({ namespace: 'g1', backend: backend2 });
      await getAllStartedPromise; // doInitBody is parked awaiting backend2.getAll()

      PlayerPrefs.set('k', 1); // schedules the 150ms debounce (WRITE_DEBOUNCE_MS, private to the module)
      await vi.advanceTimersByTimeAsync(200); // fires ONE drain() against backend1
      await setStartedPromise; // backend1.set('k', …) is now in flight, blocked on setGate

      releaseGetAll(); // let the swap install run — 'k' is invisible to it (in-flight, not dirty)
      await initPromise;
      // Nothing was ever "discarded" by the swap itself — the write was in flight, not pending.
      expect(errorSpy).not.toHaveBeenCalled();

      releaseSet(); // now let the in-flight write settle — AFTER backend2 is already installed
      // Let drain()'s catch handler (namespace===batchNamespace re-queue) run its microtasks.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // The guard is namespace-only (#454 A): `namespace` is unchanged ('g1' → 'g1'), so the
      // rejection handler re-queues even though `backend` has moved on to backend2 — the key is
      // retried against the store the game now reads from, rather than the retry being dropped.
      expect(PlayerPrefs.pendingKeys()).toContain('k');
      expect(backend2Attempts).toEqual([]); // nothing has retried against the new backend yet

      // A subsequent flush() retries against the CURRENT backend, not the outgoing one.
      await PlayerPrefs.flush();
      // A `remove`, not a `set`: the value did not survive the install's `cache.clear()`. This
      // is the assertion that keeps the test name honest — the RETRY reached backend2, and it
      // carried nothing, which is exactly the no-op the doc comment describes.
      expect(backend2Attempts).toEqual(['remove:mk:g1:k']);
      expect(PlayerPrefs.pendingKeys()).not.toContain('k'); // and is no longer stuck retrying

      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pre-window key that LANDED during the window and was then RE-SET is reported as RACED, not discarded (#454 B)', async () => {
    // The defect this closes: `doInitBody` used to fold `preWindowPending ∩ fullPending`
    // straight into `reportDiscarded`, which is right for a key the backend never accepted —
    // but wrong for a key that landed durably during the window and was then overwritten
    // during the SAME window: that key is back in the pending set too, indistinguishable by
    // membership alone, yet the truth is "raced a re-write", not "the backend refused it".
    let setMode: 'reject' | 'succeed' = 'reject';
    let getAllCount = 0;
    let getAllStarted: () => void = () => {};
    const getAllStartedPromise = new Promise<void>((resolve) => { getAllStarted = resolve; });
    let releaseGetAll: () => void = () => {};
    const getAllGate = new Promise<void>((resolve) => { releaseGetAll = resolve; });
    const store = new Map<string, string>();
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        getAllCount++;
        // Only the SECOND call (the swap under test) parks on the gate — the FIRST call is
        // this test's own initial hydration and must complete immediately, or `await
        // getAllStartedPromise` below would resolve against the wrong call entirely.
        if (getAllCount === 2) {
          getAllStarted();
          await getAllGate;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => {
        if (k.endsWith(':k') && setMode === 'reject') throw new Error('rejected (simulated)');
        store.set(k, v);
      },
      remove: async (k) => { store.delete(k); },
    };

    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('k', 1);
    // Genuinely rejected and left pending — this is the state BEFORE the window opens.
    await PlayerPrefs.flush();
    expect(PlayerPrefs.pendingKeys()).toContain('k');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Re-init (same namespace is fine — the window mechanics don't care) triggers the
    // pre-swap convergence loop first: it retries 'k' against the still-rejecting backend,
    // converges (same rejected key both passes), and THEN opens the window right before
    // taking the pre-window pending snapshot — so 'k' is genuinely part of `preWindowPending`.
    const initPromise = PlayerPrefs.init({ namespace: 'g1', backend });
    await getAllStartedPromise; // doInitBody is parked awaiting getAll() — the window is open

    // Now, DURING the window: let 'k' land durably (a flush issued directly, not through
    // doInitBody), then immediately re-set it before the window closes.
    setMode = 'succeed';
    await PlayerPrefs.flush(); // lands 'k' — drain() records it into `windowLanded`
    PlayerPrefs.set('k', 2); // re-set during the SAME window, left dirty (not flushed again)

    releaseGetAll(); // let the swap install run
    const result = await initPromise;

    // `discardedPending` is UNCHANGED — still the install-time union.
    expect(result.discardedPending).toEqual(['k']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('k');
    // The attribution is RACED, not discarded — the backend never refused anything here.
    expect(message).not.toContain('did not accept');
    expect(message).toMatch(/written by the outgoing/);

    errorSpy.mockRestore();
  });

  it('a pre-window key that landed, was re-set, and was then REJECTED is discarded again — not raced (#454 B, review finding 1)', async () => {
    // The defect this closes: `windowLanded.add(k)` on a successful write was never undone, so
    // `windowLanded` meant "did this key EVER land in the window" rather than "did its MOST
    // RECENT attempt land". A key that landed, was re-set, and whose re-write was then genuinely
    // REJECTED by the backend was still in `landed` at install time and got routed to
    // `reportRaced` — whose message says "this is NOT a backend failure". It IS one here.
    let setMode: 'reject' | 'succeed' = 'reject';
    let getAllCount = 0;
    let getAllStarted: () => void = () => {};
    const getAllStartedPromise = new Promise<void>((resolve) => { getAllStarted = resolve; });
    let releaseGetAll: () => void = () => {};
    const getAllGate = new Promise<void>((resolve) => { releaseGetAll = resolve; });
    const store = new Map<string, string>();
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        getAllCount++;
        // Only the SECOND call (the swap under test) parks on the gate — the FIRST call is
        // this test's own initial hydration and must complete immediately.
        if (getAllCount === 2) {
          getAllStarted();
          await getAllGate;
        }
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => {
        if (k.endsWith(':k') && setMode === 'reject') throw new Error('rejected (simulated)');
        store.set(k, v);
      },
      remove: async (k) => { store.delete(k); },
    };

    await PlayerPrefs.init({ namespace: 'g1', backend });
    PlayerPrefs.set('k', 1);
    // Genuinely rejected and left pending — this is the state BEFORE the window opens.
    await PlayerPrefs.flush();
    expect(PlayerPrefs.pendingKeys()).toContain('k');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Re-init opens the window right before taking the pre-window pending snapshot, so 'k' is
    // genuinely part of `preWindowPending`.
    const initPromise = PlayerPrefs.init({ namespace: 'g1', backend });
    await getAllStartedPromise; // doInitBody is parked awaiting getAll() — the window is open

    // DURING the window: let 'k' land durably, re-set it, then flip the backend back to
    // rejecting and drive one more flush so the re-write is genuinely refused before the
    // window closes.
    setMode = 'succeed';
    await PlayerPrefs.flush(); // lands 'k' — drain() records it into `windowLanded`
    PlayerPrefs.set('k', 2); // re-set during the SAME window
    setMode = 'reject';
    await PlayerPrefs.flush(); // the re-write is rejected — `windowLanded.delete('k')` must fire

    releaseGetAll(); // let the swap install run
    const result = await initPromise;

    expect(result.discardedPending).toEqual(['k']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('k');
    // Discarded, not raced — the backend genuinely refused the re-write.
    expect(message).toContain('did not accept');
    expect(message).not.toMatch(/written by the outgoing/);

    errorSpy.mockRestore();
  });

  // Kept as the "plain case is unaffected" guard for #454 B: a pre-window key that NEVER
  // lands (the backend keeps rejecting it right through the window) must still be reported as
  // discarded, with the "did not accept" wording — this is the pre-existing #421 test above,
  // re-asserted here as the sibling of the RACED test just above it.
  it('a pre-window key that never lands is still reported as discarded, not raced (#454 B sibling)', async () => {
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
    const result = await PlayerPrefs.init({ namespace: 'g2' });

    expect(result.discardedPending).toEqual(['a']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('did not accept');
    expect(message).not.toMatch(/written by the outgoing/);
    errorSpy.mockRestore();
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

/**
 * #559 — `hasPendingWrite`/`pendingKeys` must not UNDER-REPORT a write that is still in flight.
 *
 * The defect: `drain()` does `const keys = [...dirty]; dirty.clear();` and only THEN awaits the
 * backend, and both accessors read `dirty` alone. So for the whole duration of a batch every write
 * in it reports as landed, even though none of them has been accepted yet — and if the backend then
 * REJECTS one, the caller has already been told it was durable.
 *
 * ⚠️ **Why this is a correctness bug and not a documentation nit.** `hasPendingWrite`'s entire
 * reason for existing is that `get()` re-reads the optimistic cache and so cannot fail — it is the
 * one signal that separates "stored" from "queued while the cache lies about it", and #196 built it
 * because the distinction is real money. A signal that reads `false` while the write is in flight
 * does not answer the question it was added to answer.
 *
 * Court hit this twice (#532 F17, #558) and worked around it game-side with a flush-until-stable
 * loop, which does not close the hole either: under a repeating concurrent flush BOTH of that
 * loop's samples can be mid-drain and agree. No game-side loop can fix it, because no game-side
 * code can observe "a drain is in flight" — that is this module's private state.
 */
describe('PlayerPrefs — an in-flight write is still pending (#559)', () => {
  /** Holds the drain's await open until released, so the test can observe mid-drain state. */
  class GatedBackend implements PrefsBackend {
    private readonly inner = new InMemoryBackend();
    readonly started: Promise<void>;
    private announceStarted!: () => void;
    private release!: () => void;
    private readonly gate: Promise<void>;
    constructor(private readonly suffix: string, private readonly reject: boolean) {
      this.started = new Promise((r) => { this.announceStarted = r as () => void; });
      this.gate = new Promise((r) => { this.release = r as () => void; });
    }
    releaseWrite(): void { this.release(); }
    getAll(prefix: string) { return this.inner.getAll(prefix); }
    async set(fullKey: string, value: string): Promise<void> {
      if (!fullKey.endsWith(this.suffix)) return this.inner.set(fullKey, value);
      this.announceStarted();
      await this.gate;
      if (this.reject) throw new Error('simulated: backend write rejected');
      return this.inner.set(fullKey, value);
    }
    async remove(fullKey: string): Promise<void> { return this.inner.remove(fullKey); }
  }

  it('reports a write as pending WHILE the backend call is outstanding', async () => {
    const be = new GatedBackend('money', false);
    await PlayerPrefs.init({ namespace: 'inflight-a', backend: be });
    PlayerPrefs.set('money', { coins: 100 });

    const flushed = PlayerPrefs.flush();
    await be.started;   // the drain has taken the key and is awaiting the backend

    expect(
      PlayerPrefs.hasPendingWrite('money'),
      'a write the backend has not accepted yet is still pending, not durable',
    ).toBe(true);
    expect(PlayerPrefs.pendingKeys()).toContain('money');

    be.releaseWrite();
    await flushed;
    expect(PlayerPrefs.hasPendingWrite('money')).toBe(false);
  });

  // Two sampled points, not "at any point" — an earlier title claimed the latter, which is neither
  // observable nor asserted. What this pins is that the write reads as pending BOTH while the
  // backend call is outstanding and after the rejection re-queues it, so there is no transition
  // between them at which it read as durable.
  it('a REJECTED in-flight write reads as pending both mid-flight and after the rejection', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const be = new GatedBackend('money', true);
      await PlayerPrefs.init({ namespace: 'inflight-b', backend: be });
      PlayerPrefs.set('money', { coins: 100 });

      const flushed = PlayerPrefs.flush();
      await be.started;
      expect(PlayerPrefs.hasPendingWrite('money')).toBe(true);

      be.releaseWrite();
      await flushed;
      // Re-queued by drain()'s catch, so it is still pending after the flush too. The point of the
      // test is that there was no WINDOW in between where it read as durable.
      expect(
        PlayerPrefs.hasPendingWrite('money'),
        'a rejected write must never report durable',
      ).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
