/**
 * The crash matrix — the test that discharges the owner's requirement (#196):
 *
 *   > "make sure interrupted purchase e.g. force close during the transaction / crash, will be
 *   >  recovered in the next game session as long as the money is paid"
 *
 * ── How a "crash" is modelled, and why this way ────────────────────────────────
 * A real force-close is not an exception — execution simply stops. Interrupting a function
 * mid-flight is not something a unit test can do faithfully, and faking it with a throw would test
 * the catch blocks rather than the recovery.
 *
 * So the crash is modelled by its OBSERVABLE CONSEQUENCE, which is the only thing that survives a
 * process death anyway: the pair of (what the store recorded, what reached persistent storage) at
 * the instant of the kill. Each case below sets up that pair, throws the whole session away, and
 * boots a fresh one from the persisted bytes exactly as a relaunch would. Nothing is carried over
 * in memory — `resetIap()` plus a new `configureIap()` against the SAME stored bytes IS the
 * relaunch.
 *
 * The property under test is a money property, and it is two-sided: after recovery the player must
 * hold **exactly** what they paid for. Zero means we stole from them; double means we minted
 * currency. Both are asserted every time.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  configureIap, resetIap, purchase, reconcile, isEntitled, balanceOf,
  type StoreBackend, type StoreTransaction, type IapLedgerStore, type IapProduct,
} from '../../src/runtime/iap';

const COINS: IapProduct = { id: 'coins.100', kind: 'consumable', grant: 100 };
const NOADS: IapProduct = { id: 'noads', kind: 'non-consumable' };
const SUB: IapProduct = { id: 'com.modoki.subscription', kind: 'subscription' };
const CATALOG = [COINS, NOADS, SUB];

/** Persistent storage that OUTLIVES a simulated crash — the disk, in effect. A session writes into
 *  it; the next session reads whatever actually landed. */
class FakeDisk implements IapLedgerStore {
  bytes: string | undefined;
  /** Simulates a write that never reached the platform (quota, serialization refusal, a kill
   *  before writeback). Staged writes are silently dropped, which is precisely the condition
   *  `confirmDurable()` exists to detect. */
  dropWrites = false;
  reads = 0;

  read(): unknown {
    this.reads++;
    return this.bytes === undefined ? undefined : JSON.parse(this.bytes);
  }
  write(doc: unknown): void {
    if (this.dropWrites) return;
    this.bytes = JSON.stringify(doc);
  }
  async flush(): Promise<void> { /* the fake is synchronous; nothing is buffered */ }
}

/** A store that behaves like StoreKit / Play Billing in the one way that matters: it keeps handing
 *  back any transaction that was never finished. */
class FakeStore implements StoreBackend {
  readonly available = true;
  /** Everything the store believes was paid for. */
  paid: StoreTransaction[] = [];
  finished = new Set<string>();
  acknowledged = new Set<string>();
  /** Active subscriptions / owned non-consumables, as the platform would report them. */
  owned: StoreTransaction[] = [];
  /** Make `finish()` fail — the "died before the finish landed" leg. */
  failFinish = false;
  /** Call counts — the destructive step must happen exactly once per transaction. */
  finishCalls = 0;
  acknowledgeCalls = 0;

  async products() { return []; }

  async purchase(productId: string): Promise<StoreTransaction | null> {
    const tx: StoreTransaction = { transactionId: `tx-${this.paid.length + 1}`, productId };
    this.paid.push(tx);
    return tx;
  }

  async unfinished(): Promise<StoreTransaction[]> {
    return this.paid.filter((t) => !this.finished.has(t.transactionId));
  }

  async entitlements(): Promise<StoreTransaction[]> { return this.owned; }

  async finish(tx: StoreTransaction): Promise<void> {
    if (this.failFinish) throw new Error('simulated: process died before finish landed');
    this.finishCalls++;
    this.finished.add(tx.transactionId);
  }

  async acknowledge(tx: StoreTransaction): Promise<void> {
    this.acknowledgeCalls++;
    this.acknowledged.add(tx.transactionId);
  }
}

let disk: FakeDisk;
let store: FakeStore;

/** Boot a session against the CURRENT disk + store. Called once per simulated launch. */
function launch(): void {
  resetIap();
  configureIap({ backend: store, store: disk, products: CATALOG });
}

beforeEach(() => {
  disk = new FakeDisk();
  store = new FakeStore();
  launch();
});

describe('crash matrix — a force-close never costs the player their purchase (#196)', () => {
  it('row 1: killed after payment, before the app ever heard about it', async () => {
    // The store took the money; our process died before `purchase()` returned. Nothing of ours ran.
    store.paid.push({ transactionId: 'tx-ghost', productId: COINS.id });

    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.has('tx-ghost')).toBe(true);
  });

  it('row 2: killed after hearing, before the grant was durable', async () => {
    // The grant was staged but never reached storage — modelled by dropping writes for that session.
    disk.dropWrites = true;
    const first = await purchase(COINS.id);

    // Invariant 1's guard fires: an unconfirmed write must NOT be followed by a finish.
    expect(first.outcome).toBe('failed');
    expect(store.finished.size).toBe(0);

    // Relaunch onto a disk that genuinely holds nothing.
    disk.dropWrites = false;
    expect(disk.bytes).toBeUndefined();
    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.size).toBe(1);
  });

  it('row 3: killed after the grant was durable, before the finish landed — the double-credit trap', async () => {
    store.failFinish = true;
    await purchase(COINS.id);

    // Granted and persisted, but the store still considers it unfinished — so it will be handed
    // back on every launch until we finish it. This is the window invariant 2 exists for.
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.size).toBe(0);
    expect(await store.unfinished()).toHaveLength(1);

    store.failFinish = false;
    launch();
    await reconcile();

    // Exactly once. Not zero, and — the whole point — not 200.
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.size).toBe(1);
  });

  it('row 3, repeated: many relaunches before the finish ever succeeds still credit once', async () => {
    store.failFinish = true;
    await purchase(COINS.id);

    for (let i = 0; i < 5; i++) { launch(); await reconcile(); }
    expect(balanceOf(COINS.id)).toBe(100);

    store.failFinish = false;
    launch();
    await reconcile();
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.size).toBe(1);
  });

  it('row 4: killed after the finish — a clean relaunch has nothing to do', async () => {
    await purchase(COINS.id);
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.size).toBe(1);

    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(100);
    expect(await store.unfinished()).toHaveLength(0);
  });
});

describe('what must NOT be granted', () => {
  it('a pending transaction is never granted and never finished', async () => {
    // Ask-to-Buy / cash payment: approved later, or never. Money has not moved.
    store.paid.push({ transactionId: 'tx-pending', productId: COINS.id, pending: true });

    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(0);
    expect(store.finished.size).toBe(0);
  });

  it('a pending transaction later approved is granted exactly once', async () => {
    store.paid.push({ transactionId: 'tx-later', productId: COINS.id, pending: true });
    launch();
    await reconcile();
    expect(balanceOf(COINS.id)).toBe(0);

    // The store re-delivers it, now paid — the same path handles it with no extra code.
    store.paid = [{ transactionId: 'tx-later', productId: COINS.id }];
    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.has('tx-later')).toBe(true);
  });

  it('a REVOKED transaction is never granted, and is finished so it stops coming back', async () => {
    // iOS surfaces a refunded transaction through `unfinished()` with a revocationDate. The money
    // went back, so granting would hand out goods for nothing. The plugin flagged these from the
    // start and the engine read the flag NOWHERE — the mechanism existed with no consumer, which is
    // this repo's most common defect shape.
    store.paid.push({ transactionId: 'tx-refunded', productId: COINS.id, revoked: true });

    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(0);
    // Finished — unlike `pending`, this can never become valid, so leaving it unfinished would mean
    // re-deriving and re-refusing it on every launch for the life of the install.
    expect(store.finished.has('tx-refunded')).toBe(true);
    expect(await store.unfinished()).toHaveLength(0);
  });

  it('a refund AFTER a grant does not claw the balance back', async () => {
    await purchase(COINS.id);
    expect(balanceOf(COINS.id)).toBe(100);

    // The player refunds. The store re-delivers the same transaction, now revoked.
    store.paid = [{ transactionId: 'tx-1', productId: COINS.id, revoked: true }];
    store.finished.clear();
    launch();
    await reconcile();

    // Deliberately NOT reversed. Clawing back spent currency is a product decision — it can drive a
    // balance negative, and the ledger has no concept of that. Pinned so a future change to the
    // revoked branch is a choice rather than an accident.
    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.has('tx-1')).toBe(true);
  });

  it('a product missing from the catalog is left UNFINISHED so a stale catalog is recoverable', async () => {
    store.paid.push({ transactionId: 'tx-unknown', productId: 'coins.500' });

    launch();
    await reconcile();

    // Finishing would destroy a real purchase over what is almost certainly a shipping mistake.
    expect(store.finished.size).toBe(0);
    expect(await store.unfinished()).toHaveLength(1);
  });

  it('a refused verification withholds the grant AND leaves the transaction recoverable', async () => {
    resetIap();
    configureIap({
      backend: store, store: disk, products: CATALOG,
      verifier: { async verify() { return false; } },
    });
    store.paid.push({ transactionId: 'tx-suspect', productId: COINS.id });
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(0);
    expect(store.finished.size).toBe(0);   // a wrong refusal must be undoable next launch
  });
});

describe('entitlements are re-derived from the store, not remembered', () => {
  it('a subscription active at the store is entitled after reconcile', async () => {
    store.owned = [{ transactionId: 'tx-sub', productId: SUB.id }];

    launch();
    await reconcile();

    expect(isEntitled(SUB.id)).toBe(true);
  });

  it('a lapsed subscription is NOT entitled, even though the ledger still records the purchase', async () => {
    store.owned = [{ transactionId: 'tx-sub', productId: SUB.id }];
    await purchase(SUB.id);
    launch();
    await reconcile();
    expect(isEntitled(SUB.id)).toBe(true);

    // It expires. The platform stops reporting it; we must follow, not consult our own ledger.
    store.owned = [];
    launch();
    await reconcile();

    expect(isEntitled(SUB.id)).toBe(false);
  });

  it('a non-consumable survives a wiped ledger, because the store still reports it', async () => {
    store.owned = [{ transactionId: 'tx-noads', productId: NOADS.id }];
    await purchase(NOADS.id);

    // Reinstall: local storage is gone, the store's record is not.
    disk.bytes = undefined;
    launch();
    await reconcile();

    expect(isEntitled(NOADS.id)).toBe(true);
  });
});

describe('acknowledgement beats Google\'s 3-day auto-refund clock', () => {
  it('acknowledges before the durable write, so a failed grant still protects the player', async () => {
    disk.dropWrites = true;
    store.paid.push({ transactionId: 'tx-ack', productId: COINS.id });

    launch();
    await reconcile();

    // Acknowledged even though everything after it failed — so Google will not auto-refund and
    // revoke the purchase before the next launch gets another chance at the grant.
    expect(store.acknowledged.has('tx-ack')).toBe(true);
    // Not finished: the transaction must survive to be re-delivered.
    expect(store.finished.size).toBe(0);
    // Nothing reached storage.
    expect(disk.bytes).toBeUndefined();

    // The balance IS credited in memory for the rest of this session, and that is deliberate:
    // the player paid, so showing them an empty wallet because our WRITE failed would punish them
    // for our problem. The invariant that matters — don't finish — is what protects the money.
    expect(balanceOf(COINS.id)).toBe(100);

    // And the round trip proves the optimism is free: the next launch re-grants from the still
    // unfinished transaction, exactly once rather than twice.
    disk.dropWrites = false;
    launch();
    await reconcile();

    expect(balanceOf(COINS.id)).toBe(100);
    expect(store.finished.has('tx-ack')).toBe(true);
  });
});

describe('concurrent settle — the store is destructive, so the ledger alone is not enough', () => {
  it('two settles of the SAME purchase finish it once, not twice', async () => {
    // Reproduces a measured device failure. A fresh purchase arrives down two paths at once — the
    // `purchase()` promise resolving, and the store's purchasesUpdated event driving reconcile() —
    // and both passed the ledger's synchronous idempotency check before either had written. On the
    // A23 that acknowledged the purchase twice and consumed the same token twice, the second of
    // each returning a Play "Server error".
    store.paid.push({ transactionId: 'tx-race', productId: COINS.id });
    launch();

    await Promise.all([reconcile(), reconcile()]);

    expect(balanceOf(COINS.id)).toBe(100);        // credited once
    expect(store.finishCalls).toBe(1);            // and finished once — the destructive step
    expect(store.acknowledgeCalls).toBe(1);
  });
});
