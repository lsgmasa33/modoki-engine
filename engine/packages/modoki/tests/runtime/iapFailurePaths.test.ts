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
