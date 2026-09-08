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

/** A plain (non-gated) backend over a shared `Map` — for setting up an outgoing
 *  namespace's real, flushed data before a test races the swap that reads it. */
function plainBackend(store: Map<string, string>): PrefsBackend {
  return {
    getAll: async (prefix) => {
      const out: Record<string, string> = {};
      for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
      return out;
    },
    set: async (k, v) => { store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
}

describe('PlayerPrefs — write-during-swap window (#438)', () => {
  it('issue repro: a set() racing the swap lands in the OUTGOING namespace, not the incoming one', async () => {
    const store = new Map<string, string>();
    await PlayerPrefs.init({ namespace: 'g2', backend: plainBackend(store) });
    PlayerPrefs.set('save', 'G2-PROGRESS');
    await PlayerPrefs.flush();
    expect(store.get('mk:g2:save')).toBeDefined();

    const { backend: slow, entered, release } = gatedBackend(store);
    const p = PlayerPrefs.init({ namespace: 'g3', backend: slow });
    await entered(); // p is now genuinely parked mid-flight inside getAll()

    PlayerPrefs.set('save', 'G2-LATE-WRITE'); // races the swap — must land in g2, not g3
    await PlayerPrefs.flush();

    release();
    await p;

    expect(PlayerPrefs.namespace()).toBe('g3');
    expect(PlayerPrefs.get('save')).not.toBe('G2-LATE-WRITE');
    expect(store.get('mk:g3:save')).toBeUndefined(); // never wrote into the incoming namespace
  });

  it('during the window, namespace() still reports the outgoing namespace and isHydrated() is true', async () => {
    const store = new Map<string, string>();
    await PlayerPrefs.init({ namespace: 'g2', backend: plainBackend(store) });

    const { backend: slow, entered, release } = gatedBackend(store);
    const p = PlayerPrefs.init({ namespace: 'g3', backend: slow });
    await entered();

    expect(PlayerPrefs.namespace()).toBe('g2');
    expect(PlayerPrefs.isHydrated()).toBe(true);

    release();
    await p;
    expect(PlayerPrefs.namespace()).toBe('g3');
  });

  // GUARD, not a discriminator: this assertion holds against the pre-#438 code too (a rejecting
  // `getAll` always installed the incoming namespace empty and unhydrated) — kept because it's a
  // legitimate regression guard for that shape, not because it pins anything the raced-write split
  // changed.
  it('a rejecting getAll during a swap leaves isHydrated() false, namespace() reporting the INCOMING namespace, an empty cache, and rejects with the original error', async () => {
    await PlayerPrefs.init({ namespace: 'g2' });
    PlayerPrefs.set('leftover', 1);

    const boom = new Error('backend unavailable (simulated #438)');
    const throwing: PrefsBackend = {
      getAll: async () => { throw boom; },
      set: async () => {},
      remove: async () => {},
    };

    await expect(PlayerPrefs.init({ namespace: 'g3', backend: throwing })).rejects.toBe(boom);
    expect(PlayerPrefs.isHydrated()).toBe(false);
    expect(PlayerPrefs.namespace()).toBe('g3');
    expect(PlayerPrefs.keys()).toEqual([]);
  });

  // GUARD, not a discriminator: this holds against the pre-#438 code too (the old code already
  // cleared `cache` before repopulating from `getAll`) — kept as a legitimate regression guard,
  // not because the raced-write split changed anything about it.
  it('hydration does not layer on top of the outgoing cache — a key absent from the incoming getAll result does not survive', async () => {
    const store = new Map<string, string>();
    await PlayerPrefs.init({ namespace: 'g2', backend: plainBackend(store) });
    PlayerPrefs.set('onlyInG2', 'x');
    await PlayerPrefs.flush();

    // Incoming namespace g3 has nothing in the backend.
    await PlayerPrefs.init({ namespace: 'g3', backend: plainBackend(store) });

    expect(PlayerPrefs.get('onlyInG2')).toBeUndefined();
    expect(PlayerPrefs.keys()).toEqual([]);
  });

  // GUARD, not a discriminator: this holds against the pre-#438 code too (a plain pre-swap
  // rejection with no raced write was already reported and returned) — kept as a legitimate
  // regression guard, not because the raced-write split changed anything about it.
  it('regression guard: a normal swap with pending outgoing writes still reports discardedPending and logs', async () => {
    const rejecting: PrefsBackend = {
      getAll: async () => ({}),
      set: async () => { throw new Error('QuotaExceeded (simulated)'); },
      remove: async () => {},
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('a', 1); // never flushed successfully — discarded on swap

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await PlayerPrefs.init({ namespace: 'g2', backend: rejecting });
      expect(result.discardedPending).toEqual(['a']);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // DISCRIMINATOR — fails on the code that captured `discardedPending` only once, after the
  // `await`, because that code has nothing to tell a raced write apart from a pre-window one and
  // reports BOTH through the backend-rejection wording.
  it('a raced write is reported with the raced-write message, never the backend-rejection wording', async () => {
    const store = new Map<string, string>();
    await PlayerPrefs.init({ namespace: 'g2', backend: plainBackend(store) });
    // Nothing pending pre-window — the pre-swap flush loop has nothing to discard.

    const { backend: slow, entered, release } = gatedBackend(store);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g3', backend: slow });
      await entered(); // pre-swap flush loop already ran (nothing to flush); getAll now parked
      PlayerPrefs.set('late', 1); // written DURING the window — never offered to a flush
      release();
      const result = await p;

      expect(result.discardedPending).toEqual(['late']);
      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(messages.some((m) => m.includes("DURING the swap's backend read"))).toBe(true);
      expect(messages.some((m) => m.includes('did not accept during the pre-swap flush'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // DISCRIMINATOR — a single swap producing ONE key of each kind, asserting both land in
  // `discardedPending` together (sorted) even though they're reported through two different
  // console.error calls.
  it('discardedPending contains both a genuinely-rejected pre-window key and a raced key in one swap', async () => {
    const store = new Map<string, string>();
    const rejecting: PrefsBackend = {
      getAll: async () => ({}),
      set: async () => { throw new Error('QuotaExceeded (simulated)'); },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('rejected', 1); // attempted and rejected by the pre-swap flush loop

    const { backend: slow, entered, release } = gatedBackend(store);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g2', backend: slow });
      // Signals once `slow.getAll` is reached — i.e. AFTER the pre-swap flush loop (against
      // `rejecting`) has already run and converged.
      await entered();
      PlayerPrefs.set('raced', 2); // never offered to the pre-swap flush loop
      release();
      const result = await p;

      expect(result.discardedPending).toEqual(['raced', 'rejected']);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // DISCRIMINATOR — pins that the pre-window (`reportDiscarded`) path still fires on the
  // getAll-throws branch, not just the raced-write (`reportRaced`) path added alongside it.
  //
  // Also covers defect 4 (round 4, #438): a pre-window key that genuinely LANDS during the
  // window (drained successfully by a flush that runs after `preWindowPending` was captured but
  // before `getAll()` throws) must NOT appear in the discarded report — only keys still
  // genuinely pending at the moment of failure should. `landsLate`'s backend write fails while
  // `shouldSucceed` is false (so it ends up in `preWindowPending`, same as `rejected`), then
  // succeeds once flipped true and explicitly flushed DURING the window.
  it('reportDiscarded fires on the getAll-throws path too, and excludes a pre-window key that landed during the window', async () => {
    const store = new Map<string, string>();
    let shouldSucceed = false;
    const rejecting: PrefsBackend = {
      getAll: async () => ({}),
      set: async (k, v) => {
        if (k.endsWith(':landsLate') && shouldSucceed) { store.set(k, v); return; }
        throw new Error('QuotaExceeded (simulated)');
      },
      remove: async (k) => { store.delete(k); },
    };
    await PlayerPrefs.init({ namespace: 'g1', backend: rejecting });
    PlayerPrefs.set('rejected', 1); // attempted and rejected by the pre-swap flush loop, always
    PlayerPrefs.set('landsLate', 2); // rejected during the pre-swap flush loop too (shouldSucceed still false)

    let enteredThrow = false;
    let enteredThrowResolve: (() => void) | null = null;
    let releaseThrow: () => void = () => {};
    const throwGate = new Promise<void>((resolve) => { releaseThrow = resolve; });
    const boom = new Error('backend unavailable (simulated #438)');
    const throwing: PrefsBackend = {
      getAll: async () => {
        enteredThrow = true;
        enteredThrowResolve?.();
        await throwGate;
        throw boom;
      },
      set: async () => {},
      remove: async () => {},
    };
    const enteredThrowPromise = (): Promise<void> =>
      enteredThrow ? Promise.resolve() : new Promise<void>((resolve) => { enteredThrowResolve = resolve; });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g2', backend: throwing });
      await enteredThrowPromise(); // pre-swap flush loop already converged; getAll now parked

      // Land 'landsLate' DURING the window — after preWindowPending was captured, before getAll
      // throws.
      shouldSucceed = true;
      await PlayerPrefs.flush();
      expect(store.get('mk:g1:landsLate')).toBeDefined(); // genuinely durable now

      releaseThrow();
      await expect(p).rejects.toBe(boom);

      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      const discardedMsg = messages.find((m) => m.includes('did not accept during the pre-swap flush'));
      expect(discardedMsg).toBeDefined();
      expect(discardedMsg).toContain('rejected');
      expect(discardedMsg).not.toContain('landsLate'); // landed during the window — not lost
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('isSwapInFlight() is true during the window and false after both a successful swap and a rejected one', async () => {
    expect(PlayerPrefs.isSwapInFlight()).toBe(false);

    const store = new Map<string, string>();
    const { backend: slow, entered, release } = gatedBackend(store);
    const p = PlayerPrefs.init({ namespace: 'g2', backend: slow });
    await entered();
    expect(PlayerPrefs.isSwapInFlight()).toBe(true);
    release();
    await p;
    expect(PlayerPrefs.isSwapInFlight()).toBe(false);

    const boom = new Error('boom (simulated)');
    const throwing: PrefsBackend = {
      getAll: async () => { throw boom; },
      set: async () => {},
      remove: async () => {},
    };
    const p2 = PlayerPrefs.init({ namespace: 'g3', backend: throwing });
    await expect(p2).rejects.toBe(boom);
    expect(PlayerPrefs.isSwapInFlight()).toBe(false);
  });

  // #438 round 5 fixed a round-4 regression: folding a `drain()` batch that is genuinely IN
  // FLIGHT (already taken out of `dirty`, `backend.set()` not yet settled) into `doInit`'s
  // pending-key snapshots reported a write that goes on to SUCCEED as discarded — a false loss.
  // `doInit`'s snapshots are back to `dirty`-only (matching HEAD); a batch's eventual settlement
  // is `drain()`'s own concern (see its `batchNamespace`/`batchBackend` doc comment) —
  // round-4's cross-namespace-write fix for a LATE REJECTION (defect 2 there) is unaffected and
  // still covered below.
  //
  // Shared harness for both cases: an outgoing (g2) backend whose `set('k', ...)` PARKS on a
  // controllable gate instead of resolving immediately, so the write is still genuinely in
  // flight (out of `dirty`, not yet settled) at the exact moment the swap to g3 installs.
  function makeInFlightSwapHarness() {
    const setControl: { release: ((opts?: { reject?: boolean }) => void) | null } = { release: null };
    let setEntered = false;
    let setEnteredResolve: (() => void) | null = null;
    const outgoingStore = new Map<string, string>();
    const outgoing: PrefsBackend = {
      getAll: async (prefix) => {
        const out: Record<string, string> = {};
        for (const [k, v] of outgoingStore) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
      set: (k, v) => new Promise<void>((resolve, reject) => {
        setEntered = true;
        setEnteredResolve?.();
        setControl.release = (opts) => {
          if (opts?.reject) reject(new Error('rejected after swap install (simulated)'));
          else { outgoingStore.set(k, v); resolve(); }
        };
      }),
      remove: async (k) => { outgoingStore.delete(k); },
    };
    const setEnteredPromise = (): Promise<void> =>
      setEntered ? Promise.resolve() : new Promise<void>((resolve) => { setEnteredResolve = resolve; });

    // Incoming (g3) backend: gated getAll (so the test controls when install happens), and it
    // records every set/remove call it receives — defect 2's assertion is that it receives NONE
    // for 'k'.
    const incomingSetCalls: string[] = [];
    const incomingRemoveCalls: string[] = [];
    let releaseIncoming: () => void = () => {};
    const incomingGate = new Promise<void>((resolve) => { releaseIncoming = resolve; });
    let incomingEntered = false;
    let incomingEnteredResolve: (() => void) | null = null;
    const incoming: PrefsBackend = {
      getAll: async () => {
        incomingEntered = true;
        incomingEnteredResolve?.();
        await incomingGate;
        return {};
      },
      set: async (k) => { incomingSetCalls.push(k); },
      remove: async (k) => { incomingRemoveCalls.push(k); },
    };
    const incomingEnteredPromise = (): Promise<void> =>
      incomingEntered ? Promise.resolve() : new Promise<void>((resolve) => { incomingEnteredResolve = resolve; });

    return {
      outgoing, outgoingStore, setControl, setEnteredPromise,
      incoming, incomingSetCalls, incomingRemoveCalls, releaseIncoming, incomingEnteredPromise,
    };
  }

  // DISCRIMINATOR — fails on the round-4 code, which reported `['k']` here (it folded the
  // in-flight batch into `fullPending` via a since-reverted `inFlight` set) even though the write
  // goes on to durably succeed a moment later.
  it('a drain in flight at the moment of install that later SUCCEEDS is reported nowhere and lands durably in the outgoing store', async () => {
    const h = makeInFlightSwapHarness();
    await PlayerPrefs.init({ namespace: 'g2', backend: h.outgoing });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g3', backend: h.incoming });
      await h.incomingEnteredPromise(); // doInit parked in getAll — pre-swap loop already converged (nothing was pending)

      PlayerPrefs.set('k', 'v');
      const flushPromise = PlayerPrefs.flush(); // bypasses the debounce, starts the write against `outgoing` NOW
      await h.setEnteredPromise(); // the write is genuinely in flight: dirty is empty, backend.set() not yet settled

      h.releaseIncoming(); // let the swap's getAll resolve and install run while the write is still in flight
      const result = await p;

      expect(PlayerPrefs.namespace()).toBe('g3');
      // The in-flight write must NOT be reported as discarded — it has not failed, it is simply
      // still settling.
      expect(result.discardedPending).toEqual([]);

      // The write settles AFTER install — let it succeed, simulating the backend finally
      // answering once the swap has already moved on.
      h.setControl.release?.();
      await flushPromise; // resolves once the write's handler + drain() finish

      expect(h.outgoingStore.get('mk:g2:k')).toBe(JSON.stringify({ v: 1, d: 'v' })); // durably landed in the OUTGOING store
      expect(h.incomingSetCalls).toEqual([]); // never touched the incoming namespace/backend
      expect(h.incomingRemoveCalls).toEqual([]);
      expect(PlayerPrefs.get('k')).toBeUndefined(); // g3's cache never had it

      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      // Nothing about 'k' was ever lost — no discarded/raced/rejected message should name it.
      expect(messages.some((m) => m.includes('k'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Companion case: the in-flight write instead REJECTS after the swap. `discardedPending` still
  // does not name it (it was never visible to either `doInit` snapshot — matching HEAD, which also
  // only ever snapshotted `dirty`), but the loss is NOT silent: `drain()`'s own `batchNamespace`
  // guard (round 4, still in place) detects the swap and reports it directly, naming the OUTGOING
  // namespace, instead of re-queuing it against the now-installed incoming namespace/backend
  // (which would be a real cross-namespace write — the defect 2 that round 4 fixed and this round
  // does not touch).
  it('a drain in flight at the moment of install that later REJECTS is reported by drain() itself, and never touches the incoming namespace', async () => {
    const h = makeInFlightSwapHarness();
    await PlayerPrefs.init({ namespace: 'g2', backend: h.outgoing });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = PlayerPrefs.init({ namespace: 'g3', backend: h.incoming });
      await h.incomingEnteredPromise();

      PlayerPrefs.set('k', 'v');
      const flushPromise = PlayerPrefs.flush();
      await h.setEnteredPromise();

      h.releaseIncoming();
      const result = await p;

      expect(PlayerPrefs.namespace()).toBe('g3');
      // Matches HEAD: a write in flight at install time is invisible to the `dirty`-only
      // snapshot, so it is not (yet) in `discardedPending` — its fate is still unknown at this
      // point.
      expect(result.discardedPending).toEqual([]);

      // The write settles AFTER install — reject it, simulating the backend finally answering
      // once the store it was writing to is already gone.
      h.setControl.release?.({ reject: true });
      await flushPromise; // resolves once the rejected write's handler + drain() finish

      // DEFECT 2 (round 4, still fixed): the rejection must NOT be re-queued against the
      // INCOMING namespace/backend.
      expect(h.incomingSetCalls).toEqual([]);
      expect(h.incomingRemoveCalls).toEqual([]);
      expect(PlayerPrefs.get('k')).toBeUndefined(); // g3's cache never had it either

      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      // The loss IS reported — by drain()'s own "already swapped" console.error, naming the
      // OUTGOING namespace — never through `discardedPending`/`reportRaced` (the write was never
      // visible to either doInit snapshot).
      expect(messages.some((m) => m.includes('g2') && m.includes('k') && m.includes('already swapped'))).toBe(true);
      expect(messages.some((m) => m.includes("DURING the swap's backend read") && m.includes('k'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
