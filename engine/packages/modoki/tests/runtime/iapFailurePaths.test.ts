/**
 * The failure branches of the purchase state machine.
 *
 * ── Why this is a separate file from the crash matrix ──────────────────────────
 * `iapCrashMatrix.test.ts` proves the ONE property the subsystem exists for: a purchase survives a
 * force-close. It does that with a fake store that always succeeds, because a crash is not a
 * failure — the store works fine, the *process* dies.
 *
 * That left every branch where the store or the app itself misbehaves completely uncovered, and the
 * gap was invisible precisely because the matrix looked thorough. Found in close-out review, by
 * asking what the fake is structurally incapable of doing: `FakeStore.purchase()` cannot return
 * `null` and cannot throw, so the player-cancelled path and every `catch` in `settle()` had never
 * once executed.
 *
 * Each test below states the shipped consequence of deleting the code it covers. They are cheap,
 * and all of them guard behaviour that is invisible in production: the write paths are
 * fire-and-forget (`void purchase(...)`), so a regression here surfaces as an unhandled rejection
 * or a silently wrong UI state, never as an error anyone sees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  configureIap, resetIap, purchase, reconcile, restorePurchases, refreshEntitlements,
  balanceOf, isEntitled, spend, productInfo,
  type StoreBackend, type StoreTransaction, type IapLedgerStore, type IapProduct, type IapProductInfo,
} from '../../src/runtime/iap';
import type { ConfigureIapOptions } from '../../src/runtime/iap/purchaseService';

const COINS: IapProduct = { id: 'coins.100', kind: 'consumable', grant: 100 };
const CATALOG = [COINS];

class MemStore implements IapLedgerStore {
  doc: unknown;
  /** Models the REAL PlayerPrefs failure: the value is in the cache (so it reads back fine) but the
   *  backend rejected the write and re-queued it. `flush()` still resolves. */
  backendAccepted = true;
  read(): unknown { return this.doc; }
  write(d: unknown): void { this.doc = JSON.parse(JSON.stringify(d)); }
  async flush(): Promise<void> { /* resolves even when the backend rejected — as PlayerPrefs does */ }
  durable(): boolean { return this.backendAccepted; }
}

/** A store whose every step can be made to fail — the thing the crash matrix's fake deliberately is not. */
class FlakyStore implements StoreBackend {
  readonly available = true;
  /** `null` = the player dismissed the sheet. */
  purchaseResult: StoreTransaction | null = { transactionId: 'tx-1', productId: COINS.id };
  purchaseThrows = false;
  acknowledgeThrows = false;
  finishThrows = false;
  unfinishedThrows = false;
  entitlementsThrows = false;
  finished: string[] = [];
  outstanding: StoreTransaction[] = [];

  async products(ids: readonly string[]): Promise<IapProductInfo[]> {
    return ids.map((id) => ({ id, displayPrice: '¥1', title: id, description: '' }));
  }
  async purchase(): Promise<StoreTransaction | null> {
    if (this.purchaseThrows) throw new Error('simulated store error');
    return this.purchaseResult;
  }
  async unfinished(): Promise<StoreTransaction[]> {
    if (this.unfinishedThrows) throw new Error('simulated query failure');
    return this.outstanding.filter((t) => !this.finished.includes(t.transactionId));
  }
  async entitlements(): Promise<StoreTransaction[]> {
    if (this.entitlementsThrows) throw new Error('simulated entitlement failure');
    return [];
  }
  async finish(tx: StoreTransaction): Promise<void> {
    if (this.finishThrows) throw new Error('simulated finish failure');
    this.finished.push(tx.transactionId);
  }
  async acknowledge(): Promise<void> {
    if (this.acknowledgeThrows) throw new Error('simulated acknowledge failure');
  }
}

let store: FlakyStore;
let disk: MemStore;

function launch(): void {
  resetIap();
  store = new FlakyStore();
  disk = new MemStore();
  configureIap({ backend: store, store: disk, products: CATALOG });
}

beforeEach(launch);
afterEach(resetIap);

describe('a player who says no is not an error', () => {
  it('a dismissed sheet reports `cancelled`, grants nothing and finishes nothing', async () => {
    // `types.ts` is explicit that this is "never an error state, never a message". Relabel it
    // 'failed' and a player who simply closed the sheet is shown a purchase failure.
    store.purchaseResult = null;

    const r = await purchase(COINS.id);

    expect(r.outcome).toBe('cancelled');
    expect(r.error).toBeUndefined();
    expect(balanceOf(COINS.id)).toBe(0);
    expect(store.finished).toEqual([]);
  });
});

describe('the store misbehaving never becomes an unhandled rejection', () => {
  it('`purchase()` throwing is reported as a failed outcome, not thrown', async () => {
    // Callers use `void purchase(...)` — see the fire-and-forget note in iapControls.ts — so a
    // rethrow here is an unhandled rejection nobody sees, and the UI simply never updates.
    store.purchaseThrows = true;

    const r = await purchase(COINS.id);

    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/simulated store error/);
    expect(balanceOf(COINS.id)).toBe(0);
  });

  it('a failed acknowledge is non-fatal — the grant still happens', async () => {
    // Acknowledging is best-effort insurance against Google's 3-day auto-refund clock. Letting it
    // abort the settle would turn a transient Android hiccup into a purchase the player paid for
    // and did not receive — strictly worse than the risk it was guarding.
    store.acknowledgeThrows = true;
    store.purchaseResult = { transactionId: 'tx-ack', productId: COINS.id };

    const r = await purchase(COINS.id);

    expect(r.outcome).toBe('granted');
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished).toEqual(['tx-ack']);
  });

  it('`unfinished()` throwing leaves reconcile a no-op rather than a crash at boot', async () => {
    // reconcile() runs on every launch before the player can do anything. A throw here would take
    // the whole boot down over a transient store query.
    store.unfinishedThrows = true;
    await expect(reconcile()).resolves.toEqual([]);
  });

  it('`entitlements()` throwing KEEPS the previous set rather than revoking', async () => {
    // Briefly stale beats wrongly locking a paying player out of what they bought.
    store.outstanding = [];
    resetIap();
    const s = new FlakyStore();
    configureIap({
      backend: s, store: new MemStore(),
      products: [{ id: 'sub', kind: 'subscription' }],
    });
    s.entitlements = async () => [{ transactionId: 't', productId: 'sub' }];
    await refreshEntitlements();
    expect(isEntitled('sub')).toBe(true);

    s.entitlementsThrows = true;
    s.entitlements = async () => { throw new Error('simulated entitlement failure'); };
    await refreshEntitlements();

    expect(isEntitled('sub')).toBe(true);   // not revoked by a transient read failure
  });
});

describe('a verifier that throws fails CLOSED, and recoverably', () => {
  it('withholds the grant and leaves the transaction unfinished', async () => {
    // The `PurchaseVerifier` seam exists for a future server verifier, which can fail for network
    // reasons. Fail-closed protects revenue; leaving the transaction unfinished means a WRONG
    // refusal is undone by the next launch instead of costing the player their purchase.
    resetIap();
    const s = new FlakyStore();
    s.outstanding = [{ transactionId: 'tx-v', productId: COINS.id }];
    configureIap({
      backend: s, store: new MemStore(), products: CATALOG,
      verifier: { async verify() { throw new Error('verifier exploded'); } },
    });

    await reconcile();

    expect(balanceOf(COINS.id)).toBe(0);
    expect(s.finished).toEqual([]);
  });
});

describe('every public entry point is safe before configureIap has run', () => {
  // Boot is a race by construction: the catalog lives in the SCENE, so there are frames where the
  // buttons are on screen and IAP is not wired yet. Every one of these is reachable from a UI
  // binding, and the write paths are fire-and-forget — so a throw becomes an unhandled rejection
  // rather than anything a developer would see. Replace the guards with `cfg!` and a Buy tapped one
  // frame early is a TypeError instead of a no-op.
  beforeEach(() => resetIap());

  it('reads answer neutrally', () => {
    expect(balanceOf(COINS.id)).toBe(0);
    expect(isEntitled('anything')).toBe(false);
    expect(spend(COINS.id, 1)).toBe(false);
  });

  it('writes report failure instead of throwing', async () => {
    const r = await purchase(COINS.id);
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/not configured/);
  });

  it('the async reads resolve empty instead of rejecting', async () => {
    await expect(productInfo()).resolves.toEqual([]);
    await expect(reconcile()).resolves.toEqual([]);
    await expect(restorePurchases()).resolves.toEqual([]);
    await expect(refreshEntitlements()).resolves.toBeDefined();
  });
});

describe('a write the BACKEND rejected must not read as durable', () => {
  it('does not finish when the store says the write was not accepted', async () => {
    // ⚠️ The most dangerous bug this subsystem has had, and the read-back check could not see it.
    // PlayerPrefs writes into an in-memory cache and queues the real write; a rejected backend
    // write (quota exceeded, native I/O error) is re-queued and warned about, `flush()` still
    // resolves, and `get()` keeps serving the cached value. So re-reading the document confirmed
    // itself, `settle()` concluded "durable", and called `finish()` — the irreversible step. The
    // next launch hydrates from the backend, the grant is absent, and the store will never
    // re-deliver it. Money gone, no recovery, which is precisely what invariant 1 exists to stop.
    disk.backendAccepted = false;
    store.purchaseResult = { transactionId: 'tx-quota', productId: COINS.id };

    const r = await purchase(COINS.id);

    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/durable/);
    // The one assertion that matters: the transaction stays open, so the next launch recovers it.
    expect(store.finished).toEqual([]);
  });

  it('finishes normally once the backend accepts', async () => {
    disk.backendAccepted = true;
    store.purchaseResult = { transactionId: 'tx-ok', productId: COINS.id };

    const r = await purchase(COINS.id);

    expect(r.outcome).toBe('granted');
    expect(store.finished).toEqual(['tx-ok']);
  });
});

describe('a product missing from the catalog is still ACKNOWLEDGED', () => {
  it('acknowledges before the catalog lookup, so a stale catalog cannot cost the player the purchase', async () => {
    // The unknown-product branch deliberately leaves the transaction unfinished, on the theory that
    // a stale shipped catalog is recoverable. Acknowledging used to happen AFTER that branch
    // returned — so Google got three days to auto-refund and revoke the very purchase the branch
    // was preserving. The guard destroyed what it was guarding.
    const acked: string[] = [];
    resetIap();
    const s = new FlakyStore();
    s.acknowledge = async () => { acked.push('yes'); };
    s.outstanding = [{ transactionId: 'tx-unknown', productId: 'coins.500' }];
    configureIap({ backend: s, store: new MemStore(), products: CATALOG });

    await reconcile();

    expect(acked).toHaveLength(1);          // protected from the refund clock
    expect(s.finished).toEqual([]);         // and still recoverable once the catalog is fixed
  });
});

describe('teardown', () => {
  it('resetIap disposes the backend so its native listener does not outlive the game', async () => {
    // `dispose()` existed with a doc-comment claiming it was called on teardown, and nothing called
    // it — it was not even on the `StoreBackend` interface, so generic teardown code had no
    // type-safe way to reach it. Every game swap leaked a `purchasesUpdated` subscription.
    let disposed = 0;
    resetIap();
    const s = new FlakyStore() as FlakyStore & { dispose(): void };
    s.dispose = () => { disposed++; };
    configureIap({ backend: s, store: new MemStore(), products: CATALOG });

    resetIap();

    expect(disposed).toBe(1);
  });

  it('a settle that outlives its session writes nothing and finishes nothing', async () => {
    // A settle spans awaits that can last minutes (the platform sheet, Face ID, Ask-to-Buy). If the
    // game is swapped in that window, the closure still holds the OLD ledger — whose store closes
    // over a PlayerPrefs KEY, not a namespace — so a late write lands in the NEXT game's namespace
    // and clobbers its save data. Aborting is safe: nothing was granted or finished, so the store
    // re-delivers next launch.
    resetIap();
    const s = new FlakyStore();
    const d = new MemStore();
    let release!: (tx: StoreTransaction) => void;
    s.purchase = () => new Promise<StoreTransaction>((res) => { release = res; });
    configureIap({ backend: s, store: d, products: CATALOG });

    const pending = purchase(COINS.id);
    resetIap();                                    // the game swaps out mid-purchase
    release({ transactionId: 'tx-late', productId: COINS.id });

    const r = await pending;
    expect(r.outcome).toBe('failed');
    expect(s.finished).toEqual([]);
    expect(d.doc).toBeUndefined();                 // nothing reached the other game's storage
  });

  it('the ALREADY-GRANTED path never invokes onGrant once the session has torn down (finding 3)', async () => {
    // Court-store-plan §8 finding 3: unlike the fresh-purchase path (which has a `stillActive`
    // check right before it touches storage), the `alreadyGranted` path used to have NO check
    // between the catalog lookup and `c.onGrant` — so a game swap landing while `acknowledge()` is
    // still in flight let the hook write into the NEXT game's PlayerPrefs namespace. Silent: no
    // exception, no failed assertion anywhere else, just a write into the wrong save file.
    resetIap();
    const s = new FlakyStore();
    const d = new MemStore();
    const hookCalls: string[] = [];
    const hook: ConfigureIapOptions['onGrant'] = (g) => { hookCalls.push(g.transactionId); return true; };

    // Session 1: grant the transaction but never finish it (`finish()` throws), so the ledger
    // records it as processed while the store keeps re-delivering it — the crash matrix's row 3
    // window, needed here to reach `alreadyGranted` on the next session.
    s.finishThrows = true;
    configureIap({ backend: s, store: d, products: CATALOG, onGrant: hook });
    await purchase(COINS.id);
    expect(hookCalls).toEqual(['tx-1']);
    expect(s.finished).toEqual([]);

    // Session 2: the store re-delivers the same unfinished transaction via `reconcile()`, which
    // takes the ALREADY-GRANTED branch this finding is about. Pause the in-flight `acknowledge()`
    // (the await finding 3 names) and swap the game out from under it mid-settle — the same seam
    // the sibling "settle that outlives its session" test above uses for the fresh-purchase path.
    hookCalls.length = 0;
    s.finishThrows = false;
    s.outstanding = [{ transactionId: 'tx-1', productId: COINS.id }];
    let ackEntered = false;
    let release!: () => void;
    s.acknowledge = () => new Promise<void>((res) => { ackEntered = true; release = res; });
    configureIap({ backend: s, store: d, products: CATALOG, onGrant: hook });

    const pending = reconcile();
    // `reconcile()` awaits `refreshEntitlements()` and `unfinished()` before it ever reaches
    // `acknowledge()` — unlike the sibling test above, the pause is not the FIRST await, so spin
    // microtasks until execution has actually entered it before tearing the session down.
    while (!ackEntered) await Promise.resolve();
    resetIap();                 // the game swaps out mid-settle, before the hook ever runs
    release();

    const [r] = await pending;

    expect(hookCalls).toEqual([]);   // the hook must NEVER see a delivery from a torn-down session
    expect(s.finished).toEqual([]);  // and the transaction must not be finished either
    expect(r.outcome).toBe('failed');
  });

  it('a game swap during refreshEntitlements() does not overwrite the incoming game\'s entitlements (#434)', async () => {
    // `entitled` is REASSIGNED (not mutated) by `configureIap`/`resetIap`, so game A's stale
    // continuation must not be allowed to publish its own read over game B's live Set.
    resetIap();
    const sA = new FlakyStore();
    let entitlementsEntered = false;
    let release!: (txs: StoreTransaction[]) => void;
    sA.entitlements = () => new Promise<StoreTransaction[]>((res) => { entitlementsEntered = true; release = res; });
    configureIap({ backend: sA, store: new MemStore(), products: CATALOG });

    const pending = refreshEntitlements();
    while (!entitlementsEntered) await Promise.resolve();

    // The swap: game B configures and populates its OWN entitlements before A's read resolves.
    resetIap();
    const sB = new FlakyStore();
    sB.entitlements = async () => [{ transactionId: 'tx-b', productId: 'perk.b' }];
    configureIap({ backend: sB, store: new MemStore(), products: CATALOG });
    await refreshEntitlements();
    expect(isEntitled('perk.b')).toBe(true);

    // A's read finally lands, naming a product that belongs to A, not B.
    release([{ transactionId: 'tx-a', productId: 'coins.100' }]);
    await pending;

    // B's live entitlements must be untouched by A's late write.
    expect(isEntitled('perk.b')).toBe(true);
    expect(isEntitled('coins.100')).toBe(false);
  });

  it('a game swap during a refreshEntitlements() that THROWS does not hand the outgoing caller the incoming game\'s live set', async () => {
    // Mirror image of the success-path #434 test above: the catch branch used to `return entitled`
    // unconditionally, and `entitled` is REASSIGNED (not mutated) by `configureIap`/`resetIap` — so
    // by the time the catch ran, `entitled` could already be game B's live Set, handed to A's caller
    // by reference.
    resetIap();
    const sA = new FlakyStore();
    let entitlementsEntered = false;
    let reject!: (e: Error) => void;
    sA.entitlements = () => new Promise<StoreTransaction[]>((_res, rej) => { entitlementsEntered = true; reject = rej; });
    configureIap({ backend: sA, store: new MemStore(), products: CATALOG });

    const pending = refreshEntitlements();
    while (!entitlementsEntered) await Promise.resolve();

    // The swap: game B configures and populates its OWN entitlements before A's read rejects.
    resetIap();
    const sB = new FlakyStore();
    sB.entitlements = async () => [{ transactionId: 'tx-b', productId: 'perk.b' }];
    configureIap({ backend: sB, store: new MemStore(), products: CATALOG });
    await refreshEntitlements();
    expect(isEntitled('perk.b')).toBe(true);

    // A's read finally rejects, naming no product that belongs to B.
    reject(new Error('simulated entitlement failure'));
    const result = await pending;

    // A's caller must not receive B's live set, by value or by reference.
    expect(result.has('perk.b')).toBe(false);
    // B's live entitlements must be untouched by A's failed read.
    expect(isEntitled('perk.b')).toBe(true);
  });

  it('a game swap during the post-finish entitlement write does not leak into the incoming game (#434)', async () => {
    // Non-consumable only: the write under test is gated on `product.kind !== 'consumable'`, so a
    // consumable fixture would pass whether or not the guard exists.
    resetIap();
    const NOADS_A: IapProduct = { id: 'noads.a', kind: 'non-consumable' };
    const sA = new FlakyStore();
    sA.purchaseResult = { transactionId: 'tx-noads-a', productId: NOADS_A.id };
    let finishEntered = false;
    let release!: () => void;
    sA.finish = () => new Promise<void>((res) => { finishEntered = true; release = res; });
    configureIap({ backend: sA, store: new MemStore(), products: [NOADS_A] });

    const pending = purchase(NOADS_A.id);
    while (!finishEntered) await Promise.resolve();

    // The swap: game B configures and populates its OWN entitlements before A's finish() resolves.
    resetIap();
    const sB = new FlakyStore();
    sB.entitlements = async () => [{ transactionId: 'tx-b', productId: 'perk.b' }];
    configureIap({ backend: sB, store: new MemStore(), products: CATALOG });
    await refreshEntitlements();
    expect(isEntitled('perk.b')).toBe(true);

    // A's finish() finally lands — the finish genuinely happened for A, so A's caller is owed its
    // real result; only the entitlement CACHE write is what must be dropped.
    release();
    const r = await pending;

    expect(r.outcome).toBe('granted');
    expect(isEntitled('perk.b')).toBe(true);
    expect(isEntitled(NOADS_A.id)).toBe(false);
  });
});

describe('spending', () => {
  it('refuses a short balance rather than spending part of it', async () => {
    await purchase(COINS.id);
    expect(balanceOf(COINS.id)).toBe(100);

    // A partial spend is a silent loss of the player's money.
    expect(spend(COINS.id, 150)).toBe(false);
    expect(balanceOf(COINS.id)).toBe(100);

    expect(spend(COINS.id, 100)).toBe(true);
    expect(balanceOf(COINS.id)).toBe(0);
  });
});

describe('a failure must name the RIGHT cause, not merely fail (#487, #499)', () => {
  /** Capture the `[iap] …` trace. It is the only place the structured payload is observable, and
   *  the payload IS the fix in #499 — asserting the outcome alone would pass on the old code. */
  function captureIapLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const grab = (fn: (...a: unknown[]) => void) => (...a: unknown[]) => {
      if (typeof a[0] === 'string' && a[0].startsWith('[iap] ')) lines.push(a[0]);
      else fn(...a);
    };
    console.log = grab(original.log as never);
    console.warn = grab(original.warn as never);
    console.error = grab(original.error as never);
    return {
      lines,
      restore: () => { console.log = original.log; console.warn = original.warn; console.error = original.error; },
    };
  }

  /**
   * An error shaped the way Capacitor ACTUALLY hands a `call.reject(msg, code, err, data)` to JS.
   *
   * ⚠️ **`data` is NOT flattened onto the Error, and a fixture that pretends otherwise is worse
   * than no test.** iOS wraps it as `["data": data]` (`PluginCallResult.swift`,
   * `init(message:code:error:data:)`); Android does `errorResult.put("data", data)`
   * (`PluginCall.java`, the 4-arg `reject`); `native-bridge.js` then copies only that payload's
   * TOP-LEVEL keys onto the Error. So `code` is an own property and the plugin's `storeError` sits
   * one level down, under `data`.
   *
   * This helper exists because the first version of these tests asserted the flattened shape, and
   * `describeStoreError` read the same flattened shape — so both were wrong together, the
   * assertions were green, and deleting the fix still broke them "correctly". A fake that models
   * behaviour the real dependency does not have makes the guard defend the bug. Verified against
   * the vendored Capacitor sources, not from memory.
   */
  function capacitorRejection(message: string, code: string, storeError: unknown): Error {
    return Object.assign(new Error(message), { errorMessage: message, code, data: { storeError } });
  }

  /** The payload of the one `[iap] <type> {…}` line, parsed back out of the trace. */
  function payloadOf(lines: string[], type: string): Record<string, unknown> {
    const line = lines.find((l) => l.startsWith(`[iap] ${type} `));
    if (!line) throw new Error(`no journal line for ${type}; saw:\n${lines.join('\n')}`);
    return JSON.parse(line.slice(`[iap] ${type} `.length)) as Record<string, unknown>;
  }

  it('a game swap inside ledger.flush() reports a TORN-DOWN session, not a storage fault (#487 item 3)', async () => {
    // Both arms decline to finish, so the money outcome is identical and an outcome-only assertion
    // cannot tell them apart — the whole defect is the ATTRIBUTION. Without the check,
    // `confirmDurable` reads back through PlayerPrefs, which is namespaced to whatever game is live
    // NOW, misses a write the backend actually took, and journals `iap.durability-unconfirmed` at
    // ERROR level, blaming storage quota or native I/O for a swap.
    resetIap();
    const s = new FlakyStore();
    const d = new MemStore();
    let flushEntered = false;
    let release!: () => void;
    d.flush = () => new Promise<void>((res) => { flushEntered = true; release = res; });
    configureIap({ backend: s, store: d, products: CATALOG });

    const pending = purchase(COINS.id);
    while (!flushEntered) await Promise.resolve();

    resetIap();                       // the game swaps out while the ledger write is in flight
    // ⚠️ Model the actual consequence of the swap, not just its timing. `confirmDurable` reads back
    // through PlayerPrefs, which the incoming game has RE-NAMESPACED — so the read-back misses a
    // write the backend genuinely took. Without this the test is green either way: a LATER
    // `stillActive` (the grant-hook one) also reports "torn down", so the assertion below cannot
    // tell whether the post-flush check exists. Verified by deleting the check: this fails, and
    // without this line it does not.
    d.backendAccepted = false;
    release();
    const r = await pending;

    expect(r.outcome).toBe('failed');
    // The distinguishing observation: the torn-down wording, NOT 'grant not durable'.
    expect(r.error).toContain('torn down');
    expect(r.error).not.toContain('durable');
    expect(s.finished).toEqual([]);   // and still nothing finished, which is what keeps it safe
  });

  it('restorePurchases never names another game\'s entitlements, and reports the REFRESHED ones with no swap (#487 item 4)', async () => {
    // `entitled` is REASSIGNED by configureIap/resetIap, so the post-await read can name the
    // INCOMING game's purchases as this restore's result. Journal-only — and the journal is the one
    // record anyone consults when a player says a restore did not return what they own.
    resetIap();
    const sA = new FlakyStore();
    let unfinishedEntered = false;
    let release!: (txs: StoreTransaction[]) => void;
    sA.entitlements = async () => [{ transactionId: 'tx-a', productId: 'perk.a' }];
    sA.unfinished = () => new Promise<StoreTransaction[]>((res) => { unfinishedEntered = true; release = res; });
    configureIap({ backend: sA, store: new MemStore(), products: CATALOG });

    const cap = captureIapLog();
    try {
      const pending = restorePurchases();
      while (!unfinishedEntered) await Promise.resolve();

      // The swap: game B configures and owns something entirely different.
      resetIap();
      const sB = new FlakyStore();
      sB.entitlements = async () => [{ transactionId: 'tx-b', productId: 'perk.b' }];
      configureIap({ backend: sB, store: new MemStore(), products: CATALOG });
      await refreshEntitlements();

      release([]);
      await pending;

      // Never B's, and never a set at all: by now A's own refreshed Set has been dropped on the
      // floor by the swap, so there is no truthful list left to name — say the session was torn
      // down instead. A restore reporting nothing BECAUSE IT WAS TORN DOWN is a different event
      // from one reporting nothing because the player owns nothing, and this line is what a
      // "restore did not return what I own" report gets read against.
      const swapped = payloadOf(cap.lines, 'iap.restore.finished');
      expect(swapped.tornDown).toBe(true);
      expect(swapped.entitlements).toBeUndefined();
      expect(JSON.stringify(swapped)).not.toContain('perk.b');

      // ── The other half, and the reason a plain capture-before is NOT the fix here ──
      // `reconcile()` calls `refreshEntitlements()`, which REPLACES `entitled` on its happy path.
      // With no swap, the trace must report the set the restore just refreshed TO.
      //
      // ⚠️ The store must now report something `entitled` does NOT already hold, or this assertion
      // passes under both hypotheses: with B's set left at `perk.b`, a capture-before at the top of
      // `restorePurchases` would snapshot `perk.b` and read identically. Re-pointing it to `perk.c`
      // is what makes the observation distinguishing — a pre-await snapshot answers `['perk.b']`.
      sB.entitlements = async () => [{ transactionId: 'tx-c', productId: 'perk.c' }];
      cap.lines.length = 0;
      await restorePurchases();
      expect(payloadOf(cap.lines, 'iap.restore.finished').entitlements).toEqual(['perk.c']);
    } finally {
      cap.restore();
    }
  });

  it('a rejected purchase journals the store\'s structured classification, not just its prose (#499)', async () => {
    // `localizedDescription` alone reads identically for a user cancel, an ASD/AMS account fault
    // and a network failure — which is why the owner-reported failure could not be named without a
    // device session. The native plugins now carry domain/code/underlying through Capacitor's
    // reject payload, which the bridge copies onto the Error as own properties.
    const bridgeError = capacitorRejection('purchase failed: Request Canceled', 'storekit.systemError', {
      domain: 'StoreKit.StoreKitError', code: 3, description: 'Request Canceled',
      underlying: { domain: 'ASDErrorDomain', code: 509, description: 'No account' },
    });
    store.purchase = async () => { throw bridgeError; };

    const cap = captureIapLog();
    let r;
    try {
      r = await purchase(COINS.id);
      const p = payloadOf(cap.lines, 'iap.purchase.failed');
      expect(p.code).toBe('storekit.systemError');
      expect(p.detail).toMatchObject({ domain: 'StoreKit.StoreKitError', underlying: { domain: 'ASDErrorDomain', code: 509 } });
    } finally {
      cap.restore();
    }
    // `PurchaseResult.error` is the only channel that reaches a caller, so the classification has
    // to survive into it too — otherwise a game's own failure reporting is back to bare prose.
    expect(r.error).toContain('storekit.systemError');
  });

  it('reads the ANDROID payload shape too, not just the iOS one (#499)', async () => {
    // The two producers put different things in `storeError`: iOS a string domain with a nested
    // `underlying` chain, Android `{domain:'BillingResponseCode', code:<int>, description}` with no
    // nesting, and a numeric code where iOS has a symbolic one. `describeStoreError` is the single
    // reader for both, so a shape-specific assumption in it would leave one platform silently
    // undiagnosable — and Android is the platform whose per-device iteration costs a Play upload.
    store.purchase = async () => {
      throw capacitorRejection('purchase failed: Item already owned (code 7)', 'billing.7', {
        domain: 'BillingResponseCode', code: 7, description: 'Item already owned',
      });
    };

    const cap = captureIapLog();
    try {
      const r = await purchase(COINS.id);
      const p = payloadOf(cap.lines, 'iap.purchase.failed');
      expect(p.code).toBe('billing.7');
      expect(p.detail).toEqual({ domain: 'BillingResponseCode', code: 7, description: 'Item already owned' });
      expect(r.error).toContain('billing.7');
    } finally {
      cap.restore();
    }
  });

  it('a restore with IAP unconfigured is journalled as unconfigured, NOT as torn down (#487 item 4)', async () => {
    // Three outcomes share "reported no entitlements" and they are not the same event: the player
    // owns nothing, the session was torn down mid-restore, and IAP was never configured. The last
    // is the boot-race path, and collapsing it into `tornDown` would send a reader hunting a game
    // swap that never happened. Guarding on `cfg` directly rather than through `activeCfg()` is
    // what keeps them distinct — that accessor journals as a side effect, and a `c && …` guard
    // built from it silently switches itself off in exactly this case.
    resetIap();

    const cap = captureIapLog();
    try {
      const results = await restorePurchases();
      expect(results).toEqual([]);
      const p = payloadOf(cap.lines, 'iap.restore.finished');
      expect(p.notConfigured).toBe(true);
      expect(p.tornDown).toBeUndefined();
      expect(p.entitlements).toBeUndefined();
      // And the side-effecting accessor is not consulted twice for the one restore.
      expect(cap.lines.filter((l) => l.startsWith('[iap] iap.not-configured')).length).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('the FINISH path carries the classification too, not just purchase (#499)', async () => {
    // The close-out sweep taught the Android plugin to classify `consume`/`acknowledge` failures,
    // and these journal sites went on printing `String(e)` — so `billing.6` arrived and was thrown
    // away one line short of the log. A producer with no consumer is this repo's most-repeated
    // defect, and adding the field is not the same as wiring it.
    //
    // These are `warn`-level and deliberately non-fatal (the grant is what matters; the next launch
    // re-delivers and retries), which is exactly why they are easy to leave unwired: nothing fails.
    store.outstanding = [{ transactionId: 'tx-fin', productId: COINS.id }];
    store.finish = async () => {
      throw capacitorRejection('consume failed: Server error (code 6)', 'billing.6', {
        domain: 'BillingResponseCode', code: 6, description: 'Server error',
      });
    };

    const cap = captureIapLog();
    try {
      await reconcile();
      const p = payloadOf(cap.lines, 'iap.finish-failed');
      expect(p.code).toBe('billing.6');
      expect(p.detail).toMatchObject({ domain: 'BillingResponseCode', code: 6 });
    } finally {
      cap.restore();
    }
    // Non-fatal is preserved: the grant landed even though the finish did not.
    expect(balanceOf(COINS.id)).toBe(COINS.grant);
  });

  it('an error with no structured payload still journals cleanly (#499)', async () => {
    // The web stub, a native binary predating #499, and any throw from outside the bridge carry
    // neither field. `describeStoreError` must degrade, not emit `code: undefined` noise or throw.
    store.purchaseThrows = true;

    const cap = captureIapLog();
    try {
      const r = await purchase(COINS.id);
      const p = payloadOf(cap.lines, 'iap.purchase.failed');
      expect(p.error).toContain('simulated store error');
      expect('code' in p).toBe(false);
      expect('detail' in p).toBe(false);
      expect(r.error).toBe('Error: simulated store error');   // unchanged, no trailing `[undefined]`
    } finally {
      cap.restore();
    }
  });
});
