/** PlayerPrefs — `init()` concurrency (#428).
 *
 *  `init()` used to be unserialized: `const prefix = keyPrefix()` was captured, then
 *  `await backend.getAll(prefix)` gave a SECOND `init()` a window to run to completion —
 *  setting its own `namespace`, clearing `cache`, hydrating — before the FIRST call's
 *  continuation resumed and poured its rows into the SECOND call's cache. Two games'
 *  stores could cross-contaminate. The fix serializes the whole body of `init()` on
 *  `initChain` (mirroring `writeChain`'s shape) so an overlapped call is QUEUED, not
 *  raced or superseded — see the doc comment on `doInit`/`init` in playerPrefs.ts. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  PlayerPrefs, InMemoryBackend, resetPlayerPrefsForTest, type PrefsBackend,
} from '../../src/runtime/storage';

afterEach(() => {
  resetPlayerPrefsForTest();
});

/** A backend whose `getAll` PARKS on a gate the test controls, and signals — via
 *  `entered` — the instant it is actually reached, so a test can deterministically wait
 *  until a call is genuinely mid-flight in `getAll` before starting a second one, rather
 *  than guessing at a number of microtask ticks. This is what makes the race in #428
 *  reproducible: without an explicit signal, releasing the gate "early enough" can let
 *  both calls' `getAll` resolve back-to-back without ever truly overlapping, which would
 *  pass on the buggy code too and prove nothing. */
function gatedBackend(store: Map<string, string>): {
  backend: PrefsBackend;
  entered: () => Promise<void>;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enterCount = 0;
  const enterSignals: Array<() => void> = [];
  const backend: PrefsBackend = {
    getAll: async (prefix) => {
      enterCount++;
      enterSignals.forEach((fn) => fn());
      await gate;
      const out: Record<string, string> = {};
      for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
      return out;
    },
    set: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
  /** Resolves once at least one `getAll` call has actually been reached. Call this
   *  BEFORE starting a call whose `getAll` you expect to observe, and await it before
   *  starting the next overlapping call. */
  const entered = (): Promise<void> => {
    if (enterCount > 0) return Promise.resolve();
    return new Promise<void>((resolve) => { enterSignals.push(resolve); });
  };
  return { backend, entered, release };
}

describe('PlayerPrefs — init() serialization (#428)', () => {
  it('an overlapped init() is queued, not raced — no cross-namespace contamination', async () => {
    const store = new Map<string, string>();
    store.set('mk:g2:fromG2', JSON.stringify({ v: 1, d: 'G2VALUE' }));
    store.set('mk:g3:fromG3', JSON.stringify({ v: 1, d: 'G3VALUE' }));

    const { backend: slow, entered, release } = gatedBackend(store);
    // First init hits the plain backend so it can hydrate immediately and leave
    // `hydrated === true` before the race — matching the issue's repro shape (a real
    // game/namespace swap, not the very-first-init path).
    await PlayerPrefs.init({ namespace: 'g1', backend: new InMemoryBackend() });

    const p1 = PlayerPrefs.init({ namespace: 'g2', backend: slow });
    await entered(); // p1 is now genuinely parked mid-flight inside getAll()
    const p2 = PlayerPrefs.init({ namespace: 'g3', backend: slow }); // overlaps p1

    release(); // let both proceed — under the fix, p2 hasn't even started its own body yet
    await Promise.all([p1, p2]);

    expect(PlayerPrefs.namespace()).toBe('g3');
    expect(PlayerPrefs.keys().sort()).toEqual(['fromG3']);
    expect(PlayerPrefs.get('fromG2')).toBeUndefined();
    expect(PlayerPrefs.get('fromG3')).toBe('G3VALUE');
  });

  // NOTE this is a liveness/smoke assertion, not race coverage: every assertion here holds
  // against the pre-#428 (unserialized) code too — an overlapped pair with empty stores and no
  // pending writes has nothing for the race to corrupt, so this only proves both calls settle
  // without throwing. The cross-contamination coverage is the first test above and the
  // "three overlapping inits" test below (which fails on the old code); keep this one for what
  // it actually checks — that overlapping callers each get their OWN resolved result, not one
  // hanging or rejecting the other.
  it('both overlapping calls resolve, each with its own honest result', async () => {
    const store = new Map<string, string>();
    const { backend: slow, entered, release } = gatedBackend(store);

    const p1 = PlayerPrefs.init({ namespace: 'g2', backend: slow });
    await entered();
    const p2 = PlayerPrefs.init({ namespace: 'g3', backend: slow });
    release();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.discardedPending).toEqual([]);
    expect(r2.discardedPending).toEqual([]);
    expect(PlayerPrefs.namespace()).toBe('g3'); // the later call's swap ran last
  });

  it('a rejecting init() rejects to its own caller, leaves hydrated false, and does not poison the chain', async () => {
    await PlayerPrefs.init({ namespace: 'g1' });
    expect(PlayerPrefs.isHydrated()).toBe(true);

    const throwing: PrefsBackend = {
      getAll: async () => { throw new Error('backend unavailable (simulated)'); },
      set: async () => {},
      remove: async () => {},
    };
    await expect(PlayerPrefs.init({ namespace: 'g2', backend: throwing })).rejects.toThrow();
    expect(PlayerPrefs.isHydrated()).toBe(false);

    // The chain must not be poisoned — a subsequent init() still succeeds.
    const result = await PlayerPrefs.init({ namespace: 'g3', backend: new InMemoryBackend() });
    expect(result.discardedPending).toEqual([]);
    expect(PlayerPrefs.namespace()).toBe('g3');
    expect(PlayerPrefs.isHydrated()).toBe(true);
  });

  it('three overlapping inits complete in call order and the last one\'s namespace wins', async () => {
    const store = new Map<string, string>();
    const order: string[] = [];
    // Gate ONLY the first call's (`a`) entry into `getAll` — released last, after `b` and `c`
    // would have long since run under unserialized code. This is the part that actually
    // discriminates: a plain (ungated, or gated-after-push) three-call race still enters
    // `getAll` in call order under EITHER implementation, because in the pre-#428 code
    // `namespace`/`cache` are mutated synchronously before the FIRST await when `hydrated` is
    // still `false` (the case here) — there's no yield point for a caller to jump ahead of.
    // Gating a's entry to `getAll` itself (not just its resolution) is what lets `b`/`c` run
    // to completion first on the old code: measured directly against `git show
    // HEAD:.../playerPrefs.ts` (pre-#428) this produces order `['mk:b:', 'mk:c:', 'mk:a:']`
    // (namespace still ends `'c'` either way — the ORDER is what breaks, not this particular
    // final value). Under the fix, `init()` queues on `initChain`, so `b`'s `doInit` cannot even
    // START until `a`'s finishes — `a`'s gate must release before `b`'s `getAll` can be called
    // at all, forcing `['mk:a:', 'mk:b:', 'mk:c:']` regardless of when the gate releases.
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const backend: PrefsBackend = {
      getAll: async (prefix) => {
        if (prefix === 'mk:a:') await gateA;
        order.push(prefix);
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    };

    const p1 = PlayerPrefs.init({ namespace: 'a', backend });
    const p2 = PlayerPrefs.init({ namespace: 'b', backend });
    const p3 = PlayerPrefs.init({ namespace: 'c', backend });
    // Give b/c every chance to run ahead under the old code before releasing a.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    releaseA();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(['mk:a:', 'mk:b:', 'mk:c:']); // each call's getAll ran in queued order
    expect(PlayerPrefs.namespace()).toBe('c');
  });

  it('discardedPending stays honest across an overlapped pair — reported by the call that actually discarded it', async () => {
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
    PlayerPrefs.set('a', 1); // never flushed — will be discarded when the swap runs

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p1 = PlayerPrefs.init({ namespace: 'g2', backend: rejecting }); // discards 'a'
      const p2 = PlayerPrefs.init({ namespace: 'g3', backend: rejecting }); // runs AFTER p1 — nothing pending
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.discardedPending).toEqual(['a']); // p1 actually discarded it
      expect(r2.discardedPending).toEqual([]); // p2 ran from p1's already-finished, clean state
      expect(PlayerPrefs.namespace()).toBe('g3');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // CONTRACT PIN — not a regression test for #428 itself, but for a behavior change #428's fix
  // introduced as a side effect. The OLD `init()` was declared `async`, so on a first-init call
  // it swapped `backend`/`namespace` and cleared `cache`/`dirty` SYNCHRONOUSLY, before returning
  // control to the caller — `PlayerPrefs.init({namespace:'g'}); PlayerPrefs.set('k', v);` in the
  // same tick landed `k` in g's cache. The NEW `init()` touches nothing until a microtask later
  // (`initChain.then(...)`), so the same two lines now run `set()` BEFORE `doInit` ever starts:
  // the write lands in the throwaway `'default'` cache, `doInit` reports it in
  // `discardedPending`, and it is lost. Both production callers (`App.tsx`, `editor/setup.ts`)
  // already `await init()` before writing, so this is latent today — but nothing else pins the
  // new ordering now that the signature no longer says `async`. A caller MUST await `init()`
  // before writing.
  it('CONTRACT: a set() issued in the same tick as init() (not awaited) is now DISCARDED, not applied', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g' });
      PlayerPrefs.set('k', 'v'); // fired before doInit has even started — see comment above
      const result = await p;

      expect(result.discardedPending).toEqual(['k']);
      expect(PlayerPrefs.get('k')).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled(); // "write(s) made before init() was called"
    } finally {
      errorSpy.mockRestore();
    }
  });
});
