/**
 * `capacitor-modoki-iap` — the native store bridge for Modoki's in-app purchases (#196).
 *
 * ── Why this exists rather than an off-the-shelf plugin ────────────────────────
 * The engine's purchase state machine rests on one ordering rule: **grant durably, THEN finish**.
 * `finish()` is what stops a store re-delivering a transaction, so calling it before the
 * entitlement is durable is the single way to lose a purchase the player paid for — and
 * re-delivery is exactly what makes a force-close survivable.
 *
 * `@capgo/capacitor-native-purchases`, the obvious choice, **cannot honour that rule**. Its iOS
 * `Transaction.updates` listener calls `await transaction.finish()` unconditionally — no flag
 * reaches it — and only then emits a JS event, fire-and-forget. On the launch after a crash the
 * plugin destroys the re-delivered transaction before any JS has subscribed. Its
 * `restorePurchases()` additionally blanket-finishes everything in `SKPaymentQueue`. Both were
 * read from source, not inferred.
 *
 * So this plugin's entire reason to exist is a promise the alternative structurally cannot make:
 *
 *   ⚠️ **NOTHING HERE EVER FINISHES A TRANSACTION ON ITS OWN.**
 *   `finish()` happens only when JS calls `finish()`. There is no auto-finish, no listener that
 *   finishes, no "tidy up on launch" pass. If you are implementing a native method and reach for
 *   `transaction.finish()` / `consumeAsync` / `acknowledgePurchase` anywhere except the explicit
 *   method for it, stop — that is the defect this package was created to avoid.
 *
 * Deliberately SMALL. It implements exactly the six operations the engine's `StoreBackend` needs
 * and nothing else — no offer codes, commitment plans, storefronts or app transactions. That is
 * most of why a first-party plugin is tractable at all.
 */

/** Which kind of product, because it decides what "finish" MEANS on Android: a consumable is
 *  consumed (destructive — the store forgets it), everything else is merely acknowledged. */
export type IapProductKind = 'consumable' | 'non-consumable' | 'subscription';

/** One purchase, normalized across the two platforms. Mirrors the engine's `StoreTransaction`. */
export interface IapTransaction {
  /** Stable and unique per purchase; the engine's idempotency key. iOS: `Transaction.id`.
   *  Android: `orderId`, falling back to the purchase token when absent (test purchases). */
  transactionId: string;
  productId: string;
  /** Android only — what `consumeAsync`/`acknowledgePurchase` are keyed by. Absent on iOS. */
  purchaseToken?: string;
  /** Money has NOT changed hands yet: Android `PENDING` (cash/carrier/parental approval), iOS
   *  Ask-to-Buy awaiting a guardian. The engine refuses to grant these. */
  pending?: boolean;
  /** Android only — already acknowledged, so Google's 3-day auto-refund clock is stopped. */
  acknowledged?: boolean;
  /** iOS only (`Transaction.revocationDate`) — refunded, or removed by a family organiser. It will
   *  never become valid, so the engine finishes it WITHOUT granting. Play has no equivalent: a
   *  refunded purchase simply stops being reported. */
  revoked?: boolean;
}

export interface IapProductInfo {
  id: string;
  /** Localized and currency-formatted, ready to display verbatim. Apple rejects hardcoded prices. */
  displayPrice: string;
  title: string;
  description: string;
}

/** Payload of the `purchasesUpdated` event. */
export interface PurchasesUpdatedEvent {
  transactions: IapTransaction[];
}

export interface ModokiIapPlugin {
  /**
   * Fires when the store delivers a purchase that **no `purchase()` call is waiting for**.
   *
   * This is not an optional nicety. A `pending` purchase — cash, carrier billing, parental
   * approval, or Google's license-testing "slow test card" — is approved MINUTES later, and a
   * subscription renews days later. This event is the only in-process signal that it happened;
   * without it the app cannot notice until its next launch, leaving a purchase the player has paid
   * for invisible in the meantime.
   *
   * The listener does NOT finish anything. It reports; the engine decides.
   */
  addListener(
    eventName: 'purchasesUpdated',
    listener: (event: PurchasesUpdatedEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;

  /** Is a real store reachable here? False on web, and on a device where billing is unavailable
   *  (no Play Store, a blocked/managed device). */
  isAvailable(): Promise<{ available: boolean }>;

  /**
   * Live localized pricing.
   *
   * Split by kind because Android must query one-time products and subscriptions as SEPARATE
   * `queryProductDetailsAsync` calls with different product types — a single flat list cannot be
   * asked for. iOS does not care, and merges them.
   *
   * Unknown ids are omitted rather than erroring: a typo'd product should degrade to "not for
   * sale", not take down the store screen.
   */
  products(options: { inapp: string[]; subs: string[] }): Promise<{ products: IapProductInfo[] }>;

  /**
   * Open the platform purchase sheet.
   *
   * Resolves `{ transaction: null }` when the player dismisses it — a cancel is a normal outcome,
   * never an error, and must not reject.
   *
   * ⚠️ `pending` is a THIRD outcome and must be distinguished from a cancel. StoreKit's
   * `.pending` (Ask-to-Buy awaiting a guardian) carries **no transaction at all** — the purchase
   * arrives later, as a re-delivery, which `unfinished()` then reports. Reporting that as a cancel
   * would tell the player their purchase failed when it is merely waiting for a parent.
   */
  purchase(options: {
    productId: string;
    kind: IapProductKind;
    /** Android subscriptions only: which base plan / offer to buy. */
    planId?: string;
  }): Promise<{ transaction: IapTransaction | null; pending?: boolean }>;

  /**
   * Every transaction the store still considers UNFINISHED. **The recovery source** — this is what
   * makes a purchase interrupted by a force-close survivable.
   *
   * iOS: `Transaction.unfinished`. Android: `queryPurchasesAsync` (which by construction returns
   * only purchases not yet consumed/acknowledged).
   *
   * Must be answered from the STORE's record, never from anything the app persisted — answering
   * from local state would make recovery circular and useless.
   */
  unfinished(): Promise<{ transactions: IapTransaction[] }>;

  /**
   * Currently-active entitlements re-derived from the store: non-consumables ever bought, and
   * subscriptions active RIGHT NOW. Expired, revoked and refunded ones are excluded BY THE
   * PLATFORM — which is what lets the engine verify entitlement with no server of its own.
   *
   * iOS: `Transaction.currentEntitlements`. Android: `queryPurchasesAsync` minus consumables.
   */
  entitlements(): Promise<{ transactions: IapTransaction[] }>;

  /**
   * **Destructive. The store stops re-delivering this transaction afterwards.**
   *
   * Call ONLY after the entitlement is durably recorded. Must be idempotent — the engine's
   * recovery path will sometimes finish something already finished.
   *
   * iOS: `Transaction.finish()`. Android: `consumeAsync` when `kind` is consumable (the store then
   * forgets it entirely), otherwise `acknowledgePurchase`.
   */
  finish(options: {
    transactionId: string;
    purchaseToken?: string;
    kind: IapProductKind;
  }): Promise<void>;

  /**
   * Android only, and non-destructive: acknowledge without consuming.
   *
   * Exists because Google **auto-refunds and revokes** a purchase that is not acknowledged within
   * three days. The engine calls it BEFORE the durable write, so a player is protected even when
   * everything after it fails. Acknowledging does not stop `unfinished()` returning the purchase,
   * so it cannot break recovery.
   *
   * A no-op on iOS, which has neither an acknowledgement step nor a refund deadline for unfinished
   * transactions.
   */
  acknowledge(options: { transactionId: string; purchaseToken?: string }): Promise<void>;
}
