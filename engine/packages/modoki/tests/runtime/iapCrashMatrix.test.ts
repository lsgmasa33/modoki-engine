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
import type { ConfigureIapOptions } from '../../src/runtime/iap/purchaseService';

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
function launch(onGrant?: ConfigureIapOptions['onGrant']): void {
  resetIap();
  configureIap({ backend: store, store: disk, products: CATALOG, onGrant });
}

/**
 * A game whose truth lives OUTSIDE the ledger — a coin wallet, in effect (#371). Survives a
 * simulated crash exactly like `FakeDisk` does, which is what lets the rows below distinguish
 * "the engine granted" from "the player actually has the coins".
 */
class FakeGame {
  coins = 0;
  /** The hook's own idempotency key set — the contract `IapGrant.transactionId` demands. */
  applied = new Set<string>();
  /** Insertion order of `applied`, so a simulated relaunch can drop exactly the LAST mark — the
   *  one that raced the process death — not an arbitrary one. */
  private appliedOrder: string[] = [];
  /** Simulate the game failing to store its half (a full disk, a rejected write). */
  refuse = false;
  /** Simulate the hook throwing rather than returning false. */
  throws = false;
  /** Court's real ordering (finding 3/6): credit the coins and mark applied FIRST, and only then
   *  refuse — e.g. because a later durability confirm failed. Unlike `refuse`, the credit and the
   *  mark are already made before this returns false, which is what lets a row reproduce finding
   *  1/2's window instead of designing it out. */
  refuseAfterCredit = false;
  calls = 0;

  hook = (g: { transactionId: string; units: number }): boolean => {
    this.calls++;
    if (this.throws) throw new Error('simulated: the game could not write');
    if (this.refuse) return false;
    // Idempotent by transaction id — the hook sees repeats by design.
    if (!this.applied.has(g.transactionId)) {
      this.coins += g.units;
      this.applied.add(g.transactionId);
      this.appliedOrder.push(g.transactionId);
    }
    if (this.refuseAfterCredit) return false;
    return true;
  };

  /** Simulate a relaunch where the idempotency MARKER write was rejected while the coin write
   *  landed — the exact asymmetry finding 1 describes for `court.iap.applied`. Drops only the most
   *  recently added mark; `coins` is untouched, because this object IS the durable wallet and the
   *  credit already survived. */
  loseLastMark(): void {
    const last = this.appliedOrder.pop();
    if (last !== undefined) this.applied.delete(last);
  }
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

/**
 * The grant hook (#371) — invariant 1 extended to the GAME's own state.
 *
 * Every row here is about the same window: the engine's ledger is durable, but the game's wallet is
 * not yet. Without the hook the finish lands in that window and the purchase is gone, because a
 * finished transaction is never re-delivered. These prove it cannot.
 */
describe('the grant hook — the consume is LAST, after the GAME has written', () => {
  it('runs before the finish, and a refusal withholds it so the purchase survives', async () => {
    const game = new FakeGame();
    game.refuse = true;
    launch(game.hook);

    const r = await purchase('coins.100');
    expect(r.outcome).toBe('failed');
    // The destructive step never happened — this is the whole point.
    expect(store.finishCalls).toBe(0);
    expect(game.coins).toBe(0);

    // Next launch, with the game able to write again: the store re-delivers and the player is paid.
    game.refuse = false;
    launch(game.hook);
    await reconcile();
    expect(game.coins).toBe(100);
    expect(store.finishCalls).toBe(1);
  });

  it('a THROWING hook is treated as a refusal, never as a reason to finish anyway', async () => {
    const game = new FakeGame();
    game.throws = true;
    launch(game.hook);

    const r = await purchase('coins.100');
    expect(r.outcome).toBe('failed');
    expect(store.finishCalls).toBe(0);

    game.throws = false;
    launch(game.hook);
    await reconcile();
    expect(game.coins).toBe(100);
  });

  it('⚠️ runs on the ALREADY-GRANTED path — the crash between the ledger write and the game write', async () => {
    // THE row this hook exists for. The ledger records the grant, then the process dies before the
    // game stores its half. On relaunch the ledger says "processed", so without the hook running on
    // that path the settle would go straight to the finish and the coins would never arrive — with
    // no re-delivery left to repair it, because finishing is what stops re-delivery.
    const game = new FakeGame();
    game.refuse = true;                 // the game's write fails; the ledger's succeeds
    launch(game.hook);
    await purchase('coins.100');

    // The engine believes it granted — the ledger holds the units.
    expect(balanceOf('coins.100')).toBe(100);
    // The player does not have them, and the transaction is still open.
    expect(game.coins).toBe(0);
    expect(store.finishCalls).toBe(0);

    // Relaunch: the store re-delivers, the ledger no-ops, and the hook runs anyway.
    game.refuse = false;
    launch(game.hook);
    await reconcile();

    expect(game.coins).toBe(100);
    expect(store.finishCalls).toBe(1);
  });

  it('credits ONCE across many relaunches, because the hook keys on the transaction id', async () => {
    // The mirror of row 3 above: the hook seeing repeats is by design, so it must be the hook's own
    // idempotency that stops the double credit — not the engine skipping the call.
    const game = new FakeGame();
    store.failFinish = true;
    launch(game.hook);
    await purchase('coins.100');
    expect(game.coins).toBe(100);

    for (let i = 0; i < 5; i++) {
      launch(game.hook);
      await reconcile();
    }
    expect(game.coins).toBe(100);
    expect(game.calls).toBeGreaterThan(1);   // it really was re-offered

    store.failFinish = false;
    launch(game.hook);
    await reconcile();
    expect(game.coins).toBe(100);
    expect(store.finishCalls).toBe(1);
  });

  it('is OPTIONAL — omitting it leaves the subsystem exactly as it was', async () => {
    // `games/iap-test` and every other existing caller pass no hook. Their behaviour must not move.
    launch();
    const r = await purchase('coins.100');
    expect(r.outcome).toBe('granted');
    expect(balanceOf('coins.100')).toBe(100);
    expect(store.finishCalls).toBe(1);
  });

  it('no consume without a grant: refusing AFTER a durable credit still withholds the finish', async () => {
    // Court's real ordering (finding 6): the hook credits `coins` and marks applied BEFORE it can
    // refuse, e.g. because a later durability confirm failed. Unlike the plain `refuse` rows above,
    // the credit already landed — this row is the one that would catch a "finish on any return
    // value" regression that `refuse` (which never touches `coins`) cannot.
    const game = new FakeGame();
    game.refuseAfterCredit = true;
    launch(game.hook);

    const r = await purchase('coins.100');
    expect(r.outcome).toBe('failed');
    expect(game.coins).toBe(100);          // the durable credit landed
    expect(store.finishCalls).toBe(0);     // but it is NOT consumed — no finish without an affirmative grant

    // Re-delivered repeatedly while the hook keeps refusing: still never finished.
    for (let i = 0; i < 3; i++) {
      launch(game.hook);
      await reconcile();
      expect(store.finishCalls).toBe(0);
    }
  });

  it('no double credit: the engine never finishes without an affirmative grant, however many ' +
     'times a lost marker forces the hook to be re-invoked', async () => {
    // Models finding 1's failure mode end to end: the marker write ( `applied` ) races the process
    // death and is lost while the value write ( `coins` ) survives. `FakeGame.loseLastMark()`
    // simulates exactly that loss.
    //
    // A hook built like this — naive about a lost mark — WILL re-credit on the next delivery; that
    // is not something this engine can prevent, because it never sees the game's own idempotency
    // state. It is the failure `courtOnGrant` must be durability-safe against (write the mark and
    // the value as one durable unit, per plan §8's "how to fix these"), so this row does not assert
    // a final `coins` value either way — asserting a doubled balance as expected would codify the
    // bug finding 1 exists to prevent. What the ENGINE guarantees, and what is asserted below, is
    // narrower but load-bearing: it never finishes a transaction whose hook has not affirmatively
    // returned true, and it keeps re-invoking the hook on every re-delivery, so a durability-safe
    // hook gets the chance to recover.
    const game = new FakeGame();
    game.refuseAfterCredit = true;
    launch(game.hook);

    const first = await purchase('coins.100');
    expect(first.outcome).toBe('failed');
    expect(store.finishCalls).toBe(0);
    expect(game.calls).toBe(1);

    // The marker write is lost across the simulated relaunch; the credit is not.
    game.loseLastMark();

    launch(game.hook);
    await reconcile();

    // Re-invoked, and STILL never finished — the engine's guarantee holds regardless of what the
    // hook's own idempotency did or did not preserve.
    expect(game.calls).toBe(2);
    expect(store.finishCalls).toBe(0);
  });
});
