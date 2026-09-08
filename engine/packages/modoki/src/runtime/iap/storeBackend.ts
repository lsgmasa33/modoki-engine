/**
 * `StoreBackend` — the port between the crash-safe state machine and an actual store.
 *
 * The whole subsystem is designed so that this interface is the ONLY thing that differs between a
 * phone and a headless test. `purchaseService` never imports a Capacitor plugin; it drives this.
 * That is what makes the crash matrix (issue #196) testable at all — a fake backend can be told to
 * die between any two steps, which no real store will do on demand.
 *
 * ── The one rule a backend must not break ──────────────────────────────────────
 * **`finish()` is destructive and must be the LAST thing that happens.** On iOS it is
 * `Transaction.finish()`; on Android it is `consumeAsync` (consumables) or `acknowledgePurchase`
 * (everything else). After it, the store stops re-delivering the transaction — so calling it
 * before the entitlement is durable is the single way to lose a purchase the player paid for.
 * `purchaseService` owns that ordering; a backend must simply not finish anything on its own.
 *
 * ⚠️ This is not hypothetical. `@capgo/capacitor-native-purchases`' iOS `Transaction.updates`
 * listener calls `await transaction.finish()` *before* it tells JS the transaction exists —
 * fire-and-forget, no acknowledgement. A backend built on that plugin as-shipped cannot satisfy
 * the contract above, and closing that hole is Phase 3's job. See issue #196.
 */

import type { IapProductInfo, StoreTransaction } from './types';

/** A cancel the platform could NAME — see `PurchaseResult.cancelReason` for what the strings mean
 *  and why this is diagnostic-only. Distinguished from a `StoreTransaction` by the `cancelled` tag
 *  rather than by absence, so a caller cannot confuse it with a real transaction. */
export interface StoreCancelled {
  readonly cancelled: true;
  readonly reason: string;
  /** The platform's own error detail, when it had one. Log-only; shape is platform-specific. */
  readonly detail?: unknown;
}

/** Is this `purchase()` resolution a cancel rather than a transaction? */
export function isStoreCancelled(v: StoreTransaction | StoreCancelled | null): v is StoreCancelled {
  return v !== null && (v as StoreCancelled).cancelled === true;
}

export interface StoreBackend {
  /** Is there a real store here at all? False in the editor, the browser and every headless test. */
  readonly available: boolean;

  /** Live localized pricing for the given product ids. Ids the store doesn't know are omitted
   *  rather than throwing — a typo'd product should degrade to "not for sale", not a crash. */
  products(ids: readonly string[]): Promise<IapProductInfo[]>;

  /** Open the platform purchase sheet. Resolves with the transaction, `null` if the player
   *  dismissed it, or a `StoreCancelled` when the platform could say WHICH cancel it was.
   *  Rejects only on a genuine store error.
   *
   *  ⚠️ `null` and `StoreCancelled` are the SAME outcome — a backend that cannot name the reason
   *  keeps returning `null`, and every caller must treat the two identically apart from the
   *  diagnostic string (#946). The union exists so a reason can be carried, not so cancels can be
   *  sorted into two kinds. */
  purchase(productId: string): Promise<StoreTransaction | StoreCancelled | null>;

  /**
   * Every transaction the store still considers UNFINISHED — the recovery source, and the reason
   * a force-close mid-transaction is survivable.
   *
   * Must be answered from the store's own record (iOS `Transaction.unfinished` +
   * `Transaction.updates`; Android `queryPurchasesAsync`), never from anything we persisted. A
   * backend that answered from local state would make recovery circular and useless.
   */
  unfinished(): Promise<StoreTransaction[]>;

  /**
   * Currently-active entitlements, re-derived from the store: non-consumables ever bought, and
   * subscriptions active RIGHT NOW (expired, revoked and refunded ones excluded by the platform).
   *
   * This is what makes serverless verification correct rather than merely cheap — it is a fresh,
   * OS-verified answer, not a cache we hope is right.
   */
  entitlements(): Promise<StoreTransaction[]>;

  /**
   * Tell the store we have durably granted this. **Destructive — see the header.** Idempotent:
   * finishing an already-finished transaction must succeed silently, because the recovery path
   * will sometimes do exactly that.
   */
  finish(tx: StoreTransaction): Promise<void>;

  /**
   * Android only: acknowledge without consuming. Cheap, non-destructive, and it stops Google's
   * **3-day auto-refund clock** — an unacknowledged purchase is refunded and revoked automatically.
   * Called before the durable write so a slow grant can never cost the player their money.
   *
   * No-op on iOS, which has no acknowledgement step and no refund deadline for unfinished
   * transactions.
   */
  acknowledge(tx: StoreTransaction): Promise<void>;

  /**
   * Release anything the backend holds that outlives it — a native event subscription, a timer.
   * Called by `resetIap()` on game swap and test teardown. Optional: a backend with nothing to
   * release simply omits it.
   *
   * ⚠️ **This is on the INTERFACE for a reason.** `CapacitorStoreBackend` had a `dispose()` whose
   * own doc-comment said it was "called on teardown", and nothing anywhere called it — because
   * `cfg.backend` is typed as this interface, so generic teardown code had no type-safe way to
   * reach it even if someone had tried. The native `purchasesUpdated` subscription therefore
   * survived every game swap, and a second IAP game would have accumulated a listener per swap,
   * each one driving `reconcile()` on the wrong session. A method nobody can call is not a
   * teardown story.
   */
  dispose?(): void;
}

/**
 * The default everywhere that is not a device: the editor, the web build, the playable export and
 * every headless test.
 *
 * Deliberately reports `available: false` and sells nothing, rather than simulating a store. A fake
 * that pretends to sell things would let a game "work" in the editor and fail on a phone — and it
 * would quietly make the crash matrix pass against a fiction. Tests that need a store use the
 * purpose-built fake in the test suite, which is explicit about being one.
 */
export class NoopStoreBackend implements StoreBackend {
  readonly available = false;
  async products(): Promise<IapProductInfo[]> { return []; }
  async purchase(): Promise<StoreTransaction | null> { return null; }
  async unfinished(): Promise<StoreTransaction[]> { return []; }
  async entitlements(): Promise<StoreTransaction[]> { return []; }
  async finish(): Promise<void> { /* nothing to finish */ }
  async acknowledge(): Promise<void> { /* nothing to acknowledge */ }
}
