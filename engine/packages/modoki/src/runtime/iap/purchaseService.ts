/**
 * The purchase state machine — the crash-safe core of Modoki's IAP subsystem.
 *
 * Requirement it exists to satisfy (owner, #196):
 *
 *   > "make sure interrupted purchase e.g. force close during the transaction / crash, will be
 *   >  recovered in the next game session as long as the money is paid"
 *
 * ── The two invariants ─────────────────────────────────────────────────────────
 *  1. **Grant durably, THEN finish.** `finish()` is what stops the store re-delivering a
 *     transaction. Call it before the entitlement is durable and a crash in that window loses a
 *     purchase permanently. So it is always the last step, and it is skipped entirely if the
 *     durable write could not be confirmed — leaving the transaction for the next launch is always
 *     better than finishing one we failed to record.
 *  2. **Every grant is idempotent, keyed by transaction id.** Invariant 1 deliberately leaves a
 *     window where a purchase is granted but not finished, so the store WILL re-deliver it. Without
 *     idempotency that window would credit a coin pack again on every launch.
 *
 * Together they make every crash point safe:
 *
 *   | crash after…            | store         | us      | next launch                        |
 *   |-------------------------|---------------|---------|------------------------------------|
 *   | payment, before we hear | paid/unfinished | —     | re-delivered → grant → finish      |
 *   | hearing, before durable | paid/unfinished | —     | re-delivered → grant → finish      |
 *   | durable, before finish  | paid/unfinished | granted | re-delivered → NO-OP → finish      |
 *   | finish                  | paid/finished | granted | nothing to do                      |
 *
 * ── The structural decision that makes the table true ──────────────────────────
 * `purchase()` and `reconcile()` both funnel into ONE `settle()`. Recovery is not a second
 * implementation of the happy path — it *is* the happy path, entered from a different door. Had
 * they been separate, the crash tests would prove the recovery path correct while saying nothing
 * about whether it still agreed with normal purchasing, and the two would drift on the first
 * change. Resist any refactor that splits them.
 */

import { emit } from '../core/journal';
import { peekCurrentWorld } from '../core/ecs/worldRegistry';
import { NoopStoreBackend, type StoreBackend } from './storeBackend';
import { IapLedger, type IapLedgerStore } from './ledger';
import { LocalVerifier, type PurchaseVerifier } from './verifier';
import type { IapProduct, IapProductInfo, PurchaseResult, StoreTransaction } from './types';

/** Journal without requiring a world. `reconcile()` runs at boot, potentially before any scene has
 *  loaded, and a missing world must not turn recovery into a crash. */
function journal(type: string, payload?: unknown, level: 'info' | 'warn' | 'error' = 'info'): void {
  // Mirrored to the console as well as the journal. The journal is the right home for assertions,
  // but it is in-memory only — unreadable on a device without the debug bridge attached. Billing
  // failures happen on phones, so this trace needs to reach logcat/Xcode unaided. The native
  // plugin logs its own callbacks under `ModokiIap`; these are the JS half, and a disagreement
  // between the two is exactly the class of bug that is invisible from either side alone.
  const line = `[iap] ${type}${payload === undefined ? '' : ' ' + JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  const w = peekCurrentWorld();
  if (!w) return;
  emit(type, payload, w, level);
}

interface IapConfig {
  backend: StoreBackend;
  ledger: IapLedger;
  verifier: PurchaseVerifier;
  /** productId → catalog entry. Authored data, supplied by the game (see `types.ts`). */
  catalog: Map<string, IapProduct>;
}

let cfg: IapConfig | null = null;

/** Entitlements re-derived from the store — productIds currently owned or actively subscribed.
 *  Rebuilt wholesale by `refreshEntitlements()`; never persisted, because the store is the truth. */
let entitled = new Set<string>();

/**
 * Transactions currently being settled, keyed by transaction id.
 *
 * ⚠️ **`settle()` can be entered TWICE for the same purchase, concurrently.** A fresh purchase
 * arrives down two paths at once: the `purchase()` promise resolving, and the store's
 * `purchasesUpdated` event driving `reconcile()`. The ledger's idempotency check is synchronous,
 * so BOTH pass it before either has written — a check-then-act race that acknowledged the purchase
 * twice and consumed the same token twice. Measured on a device:
 *
 *     acknowledgePurchase: code=0
 *     acknowledgePurchase: code=2  Server error      (42ms later, same tx)
 *     consumeAsync:        code=0
 *     consumeAsync:        code=6  Server error      (2ms later, same token)
 *
 * Idempotency in the LEDGER is not enough because the destructive step is in the STORE. This set
 * is the missing mutual exclusion: one settle per transaction id at a time.
 */
const settling = new Set<string>();

export interface ConfigureIapOptions {
  /** Defaults to `NoopStoreBackend` — the editor, the browser and every headless test. */
  backend?: StoreBackend;
  /** Where the ledger persists. L3 wires PlayerPrefs in; tests pass a fake. */
  store: IapLedgerStore;
  /** The game's authored product catalog. */
  products: readonly IapProduct[];
  /** Defaults to `LocalVerifier` (the platform already verified — see `verifier.ts`). */
  verifier?: PurchaseVerifier;
}

/** Wire the subsystem up. Called once per game load by L3 composition. */
export function configureIap(opts: ConfigureIapOptions): void {
  cfg = {
    backend: opts.backend ?? new NoopStoreBackend(),
    ledger: new IapLedger(opts.store),
    verifier: opts.verifier ?? new LocalVerifier(),
    catalog: new Map(opts.products.map((p) => [p.id, p])),
  };
  entitled = new Set();
}

/** Drop all state — game swap and test teardown. */
export function resetIap(): void {
  // Let the backend release anything that outlives it (the native `purchasesUpdated` subscription).
  // Without this the listener survives every game swap and keeps driving `reconcile()` against a
  // torn-down session — see the `dispose` docs on `StoreBackend`.
  try {
    cfg?.backend.dispose?.();
  } catch (e) {
    // Teardown must not throw: it runs from `unregisterGameSystems()`, and a failure here would
    // abort the swap and leave the NEXT game half-registered.
    journal('iap.dispose-failed', { error: String(e) }, 'warn');
  }
  cfg = null;
  entitled = new Set();
}

/**
 * The wired-up config, or `null`.
 *
 * ⚠️ **Nothing in this module throws when IAP is unconfigured**, and that is deliberate. Boot is a
 * race by construction: the config lives in the scene, so there are frames during which the scene
 * has rendered — buttons and all — but `configureIap()` has not run. Every public entry point is
 * reachable from a UI binding, and the write paths are fire-and-forget (`void purchase(...)`), so a
 * throw there becomes an *unhandled rejection* rather than an error anyone sees.
 *
 * So reads return neutral values and writes return a failed result, each journaled once so the
 * cause is visible. A player tapping Buy a frame early gets nothing, not a crash — and no money
 * moves either way. Found by dispatching the action against a live editor, which is exactly the
 * class of bug a unit test misses by calling the API only the way the code already expects.
 */
function activeCfg(): IapConfig | null {
  if (!cfg) journal('iap.not-configured', undefined, 'warn');
  return cfg;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Is this non-consumable owned / this subscription active RIGHT NOW? Answered from the last
 *  `refreshEntitlements()`, which re-derives from the store rather than from anything we stored. */
export function isEntitled(productId: string): boolean {
  return entitled.has(productId);
}

/** Consumable units held. */
export function balanceOf(productId: string): number {
  return activeCfg()?.ledger.balanceOf(productId) ?? 0;
}

/** Spend consumable units. False (and nothing spent) if the balance is short. */
export function spend(productId: string, units: number): boolean {
  const c = activeCfg();
  if (!c) return false;
  const ok = c.ledger.spend(productId, units);
  journal('iap.spend', { productId, units, ok }, ok ? 'info' : 'warn');
  return ok;
}

/** Live localized pricing. Never cache the result across a launch — prices and currency change. */
export function productInfo(ids?: readonly string[]): Promise<IapProductInfo[]> {
  const c = activeCfg();
  if (!c) return Promise.resolve([]);
  return c.backend.products(ids ?? [...c.catalog.keys()]);
}

// ── The one settle path ──────────────────────────────────────────────────────

/**
 * Take one transaction from wherever it came — a fresh purchase or a re-delivery — and drive it to
 * a durable, finished state. **The only place a grant or a finish happens.**
 */
async function settle(tx: StoreTransaction, source: 'purchase' | 'recovery'): Promise<PurchaseResult> {
  const c = activeCfg();
  if (!c) return { outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId, error: 'iap not configured' };

  // One settle per transaction at a time — see `settling`. The loser reports 'already-owned'
  // rather than failing: the purchase IS being handled, just not by this caller.
  if (settling.has(tx.transactionId)) {
    journal('iap.settle-in-flight', { productId: tx.productId, transactionId: tx.transactionId, source });
    return { outcome: 'already-owned', productId: tx.productId, transactionId: tx.transactionId };
  }
  settling.add(tx.transactionId);
  try {
    return await settleInner(tx, source, c);
  } finally {
    settling.delete(tx.transactionId);
  }
}

/**
 * Is the config this settle STARTED with still the active one?
 *
 * ⚠️ A settle spans awaits that can last minutes — the platform sheet, Face ID, a parent approving
 * Ask-to-Buy. `resetIap()` can run in that window (a game swap: the editor's Open Project, or an
 * OTA sub-game module), and `settleInner` holds the OLD config in a closure. Its ledger store
 * closes over a PlayerPrefs KEY, not a namespace snapshot, and `PlayerPrefs.init()` re-namespaces a
 * module-level global for the incoming game — so a late write would land in the NEXT game's
 * namespace and clobber its ledger with this game's grant.
 *
 * Aborting is safe precisely because of invariant 1: nothing has been granted or finished at either
 * check, so the transaction stays unfinished and the next launch recovers it normally. Losing a
 * settle to a game swap costs one relaunch; writing into another game's save data does not undo.
 */
function stillActive(c: IapConfig): boolean {
  return cfg === c;
}

function tornDown(tx: StoreTransaction, source: string): PurchaseResult {
  journal('iap.session-torn-down', { productId: tx.productId, transactionId: tx.transactionId, source }, 'warn');
  return {
    outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId,
    error: 'iap session was torn down mid-settle; the transaction stays unfinished and recovers next launch',
  };
}

async function settleInner(
  tx: StoreTransaction,
  source: 'purchase' | 'recovery',
  c: IapConfig,
): Promise<PurchaseResult> {

  // Not a purchase yet — Ask-to-Buy, cash, carrier billing. Granting here would hand out goods for
  // money that may never arrive. Approval comes back later as a fresh re-delivery, which this same
  // function then handles correctly with no extra code.
  if (tx.pending) {
    journal('iap.pending', { productId: tx.productId, transactionId: tx.transactionId });
    return { outcome: 'pending', productId: tx.productId, transactionId: tx.transactionId };
  }

  // Refunded, or pulled by a family organiser. The money went BACK, so there is nothing to grant —
  // but unlike `pending` above this will never become valid, so leaving it unfinished would mean
  // re-deriving and re-refusing it on every launch forever. Finish it and be done.
  //
  // Checked BEFORE the catalog lookup on purpose: the "unknown product" branch below deliberately
  // refuses to finish, on the theory that a stale catalog is recoverable and a destroyed purchase is
  // not. That reasoning does not apply here — no catalog fix can make a revoked transaction
  // valuable. Finishing is safe on iOS, the only platform that reports this, because StoreKit
  // finishes by transaction id and never consults the product kind.
  if (tx.revoked) {
    journal('iap.revoked', { productId: tx.productId, transactionId: tx.transactionId, source }, 'warn');
    try {
      await c.backend.finish(tx);
      c.ledger.markFinished(tx.transactionId);
      void c.ledger.flush();
    } catch (e) {
      journal('iap.finish-failed', { transactionId: tx.transactionId, error: String(e) }, 'warn');
    }
    return { outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId, error: 'revoked' };
  }

  // Android's 3-day clock: an unacknowledged purchase is auto-refunded and revoked. Acknowledging
  // is non-destructive (it does NOT consume) and does not stop `unfinished()` re-reporting the
  // purchase, so doing it as early as possible costs nothing and protects the player if everything
  // below fails. No-op on iOS.
  //
  // ⚠️ **Before the catalog lookup, deliberately.** It used to sit after it, which meant the
  // unknown-product branch returned without ever acknowledging — and that branch exists precisely
  // because we believe the purchase is REAL and the shipped catalog is stale. Leaving it
  // unacknowledged hands Google three days to refund and revoke a purchase we were deliberately
  // preserving for recovery, so the guard destroyed the thing it was protecting.
  try {
    await c.backend.acknowledge(tx);
  } catch (e) {
    // Non-fatal: the grant is what matters, and the next launch re-delivers and retries this.
    journal('iap.acknowledge-failed', { transactionId: tx.transactionId, error: String(e) }, 'warn');
  }

  const product = c.catalog.get(tx.productId);
  if (!product) {
    // The store knows a product the game's catalog does not. Do NOT finish it: this is far more
    // likely a catalog that shipped stale than a purchase that should be discarded, and an
    // unfinished transaction is recoverable once the catalog is fixed. Finishing would destroy it.
    journal('iap.unknown-product', { productId: tx.productId, transactionId: tx.transactionId }, 'error');
    return { outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId, error: 'unknown product' };
  }

  const alreadyGranted = c.ledger.isProcessed(tx.transactionId);

  if (!alreadyGranted) {
    let verified: boolean;
    try {
      verified = await c.verifier.verify(tx);
    } catch (e) {
      journal('iap.verify-error', { transactionId: tx.transactionId, error: String(e) }, 'error');
      verified = false;
    }
    if (!verified) {
      // Withhold the grant AND leave the transaction unfinished, so a wrong refusal is undone by
      // the next launch instead of costing the player their purchase.
      journal('iap.verify-refused', { productId: tx.productId, transactionId: tx.transactionId }, 'error');
      return { outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId, error: 'verification refused' };
    }

    // Last point before we touch persistent storage — see `stillActive`.
    if (!stillActive(c)) return tornDown(tx, source);

    const units = product.kind === 'consumable' ? (product.grant ?? 1) : 0;
    c.ledger.recordGrant(tx.transactionId, tx.productId, units);
    await c.ledger.flush();

    // INVARIANT 1's guard. If the write did not survive the round trip, stop here — the transaction
    // stays unfinished and the store hands it back next launch. Finishing now is the one action
    // that could not be undone.
    if (!c.ledger.confirmDurable(tx.transactionId)) {
      journal('iap.durability-unconfirmed', { productId: tx.productId, transactionId: tx.transactionId }, 'error');
      return { outcome: 'failed', productId: tx.productId, transactionId: tx.transactionId, error: 'grant not durable' };
    }

    journal(source === 'recovery' ? 'iap.recovered' : 'iap.granted', {
      productId: tx.productId, transactionId: tx.transactionId, kind: product.kind, units,
    });
  } else {
    // The re-delivery case invariant 2 exists for: granted on an earlier run, crashed before the
    // finish landed. Credit nothing, but DO finish — that is the step that was missing.
    journal('iap.duplicate', { productId: tx.productId, transactionId: tx.transactionId, source });
  }

  // The destructive step, and the other side of `stillActive`: finishing against a torn-down
  // session would tell the store to stop re-delivering a purchase whose grant may have gone into
  // the wrong namespace. Leave it open instead.
  if (!stillActive(c)) return tornDown(tx, source);

  try {
    await c.backend.finish(tx);
    c.ledger.markFinished(tx.transactionId);
    // Best-effort: losing this flush only means one redundant re-delivery next launch, which the
    // idempotency check absorbs. Never worth failing a settled purchase over.
    void c.ledger.flush();
    journal('iap.finished', { productId: tx.productId, transactionId: tx.transactionId });
  } catch (e) {
    // Granted but not finished — the safe side of the window. Next launch re-delivers and retries.
    journal('iap.finish-failed', { transactionId: tx.transactionId, error: String(e) }, 'warn');
  }

  if (product.kind !== 'consumable') entitled.add(tx.productId);

  return {
    outcome: alreadyGranted ? 'already-owned' : 'granted',
    productId: tx.productId,
    transactionId: tx.transactionId,
  };
}

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Buy something. The player-initiated door into `settle()`.
 */
export async function purchase(productId: string): Promise<PurchaseResult> {
  const c = activeCfg();
  if (!c) return { outcome: 'failed', productId, error: 'iap not configured' };
  journal('iap.purchase.started', { productId });

  let tx: StoreTransaction | null;
  try {
    tx = await c.backend.purchase(productId);
  } catch (e) {
    journal('iap.purchase.failed', { productId, error: String(e) }, 'error');
    return { outcome: 'failed', productId, error: String(e) };
  }

  if (!tx) {
    // Dismissed the sheet. Not an error, and must never surface as one.
    journal('iap.purchase.cancelled', { productId });
    return { outcome: 'cancelled', productId };
  }

  return settle(tx, 'purchase');
}

/**
 * Re-derive what the player owns from the store. The source of truth for non-consumables and
 * subscriptions — including expiry, refund and revocation, all of which the platform applies for us.
 */
export async function refreshEntitlements(): Promise<ReadonlySet<string>> {
  const c = activeCfg();
  if (!c) return entitled;
  try {
    const active = await c.backend.entitlements();
    entitled = new Set(active.map((t) => t.productId));
    journal('iap.entitlements', { productIds: [...entitled] });
  } catch (e) {
    // Keep the previous set rather than revoking on a transient read failure — briefly stale beats
    // wrongly locking a paying player out of what they bought.
    journal('iap.entitlements-failed', { error: String(e) }, 'warn');
  }
  return entitled;
}

/**
 * **The recovery pass. Call this on every launch, before the player can buy anything.**
 *
 * This is what discharges the force-close requirement: it asks the store what it still considers
 * unfinished and drives each one through the same `settle()` a fresh purchase uses. A purchase
 * interrupted by a crash, a kill, or a battery death is picked up here on the next run.
 *
 * Safe to call repeatedly — every step it performs is idempotent.
 */
export async function reconcile(): Promise<PurchaseResult[]> {
  const c = activeCfg();
  if (!c) return [];
  await refreshEntitlements();

  let pending: StoreTransaction[];
  try {
    pending = await c.backend.unfinished();
  } catch (e) {
    journal('iap.reconcile-failed', { error: String(e) }, 'error');
    return [];
  }

  if (pending.length) journal('iap.reconcile', { count: pending.length });

  const results: PurchaseResult[] = [];
  // Sequential on purpose: two settles racing would interleave their ledger writes, and the last
  // `store.write()` would win with a document missing the other's grant. Purchases are rare and a
  // handful at most; there is nothing to gain by parallelising and a grant to lose.
  for (const tx of pending) results.push(await settle(tx, 'recovery'));
  return results;
}

/**
 * Player-facing "Restore Purchases" — **required by App Store review**, not optional.
 * Deliberately just the launch path run on demand: restoring is not a different operation from
 * recovering, and giving it its own implementation would give it its own bugs.
 */
export async function restorePurchases(): Promise<PurchaseResult[]> {
  journal('iap.restore.started');
  const results = await reconcile();
  journal('iap.restore.finished', { recovered: results.length, entitlements: [...entitled] });
  return results;
}
