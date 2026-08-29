/**
 * In-app purchase vocabulary — the types every other file in `runtime/iap/` speaks.
 *
 * Deliberately store-agnostic: nothing here names StoreKit or Play Billing. The platform words
 * ("finish", "acknowledge", "consume", "purchase token") are translated at the `StoreBackend`
 * boundary, so the state machine — the part that must be provably crash-safe — can be driven by a
 * fake in a headless test and by a real store on a phone through the same code path.
 *
 * See issue #196 for the design and the crash matrix this exists to satisfy.
 */

/**
 * What KIND of thing was bought. This is the single most load-bearing distinction in the whole
 * subsystem, because it decides **who owns the truth**:
 *
 *  - `non-consumable` / `subscription` — the STORE owns it. Both platforms will re-report an
 *    active entitlement on every launch forever (`Transaction.currentEntitlements` /
 *    `queryPurchasesAsync`), so we re-derive rather than remember. Survives reinstall and a new
 *    device for free, and no local corruption can lose it.
 *  - `consumable` — WE own it. The store forgets a consumable the moment it is consumed, so the
 *    grant exists only in our ledger. This is the only kind for which durability is our problem,
 *    and therefore the only kind the ledger is load-bearing for.
 *
 * Getting this wrong in either direction is a real bug, not a style choice: treating a
 * subscription as ours means a reinstall loses it; treating a consumable as the store's means the
 * balance vanishes on the first consume.
 */
export type ProductKind = 'consumable' | 'non-consumable' | 'subscription';

/**
 * A catalog entry — one purchasable thing, as AUTHORED by the game.
 *
 * ⚠️ These are **authored data, not code constants** (the repo's single-source-of-truth rule). A
 * product id is a string the two consoles also hold; duplicating it in TS means a rename has two
 * homes and one of them goes stale silently. The catalog is supplied at `configureIap()` time from
 * a config resource the game authors.
 */
export interface IapProduct {
  /** Store product id — must match App Store Connect / Play Console EXACTLY. */
  readonly id: string;
  readonly kind: ProductKind;
  /**
   * Units granted per purchase, for `consumable` only (coins, gems, lives). Ignored otherwise.
   * Defaults to 1 when omitted.
   */
  readonly grant?: number;
}

/**
 * What the game is being asked to apply, handed to `ConfigureIapOptions.onGrant`.
 *
 * ⚠️ **`transactionId` is the idempotency key, and the hook MUST use it.** The hook runs once per
 * settle pass until a `finish()` lands — on the fresh purchase AND on every re-delivery — so a hook
 * that credits unconditionally mints currency on exactly the crash the subsystem exists to survive.
 * It is the same key the ledger uses, which is what makes the two agree by construction rather than
 * by two people remembering the same rule.
 */
export interface IapGrant {
  /** Stable, store-assigned, unique per purchase. THE idempotency key. */
  readonly transactionId: string;
  readonly productId: string;
  /** The catalog entry as the game authored it. */
  readonly product: IapProduct;
  /** The authored `grant` quantity for a consumable (300 coins, 1 pass); 0 for everything else. */
  readonly units: number;
}

/** Live pricing/label pulled from the store at runtime. Never authored — the store is the only
 *  correct source for a localized, currency-correct price, and Apple rejects hardcoded prices. */
export interface IapProductInfo {
  readonly id: string;
  /** Localized, currency-formatted, ready to display verbatim (e.g. "¥600", "$4.99"). */
  readonly displayPrice: string;
  readonly title: string;
  readonly description: string;
}

/**
 * One purchase as the store reports it.
 *
 * `transactionId` is **the idempotency key** and the reason the crash matrix closes: it is stable
 * across re-deliveries, so a transaction that was granted but not yet finished is recognised as
 * already-processed on the next launch instead of being granted twice.
 */
export interface StoreTransaction {
  /** Stable, store-assigned, unique per purchase. iOS: `Transaction.id`. Android: `orderId`
   *  (falling back to the purchase token when an order id is absent, e.g. a test purchase). */
  readonly transactionId: string;
  readonly productId: string;
  /**
   * Android's `purchaseToken` — what `acknowledgePurchase`/`consumeAsync` are keyed by. Absent on
   * iOS, where `transactionId` is sufficient to finish.
   */
  readonly purchaseToken?: string;
  /**
   * True when the store says money has NOT changed hands yet — Android `PENDING` (cash / carrier
   * billing / parental approval), iOS Ask-to-Buy awaiting a guardian.
   *
   * ⚠️ **A pending transaction must never be granted.** It is not a purchase yet; it may be
   * approved hours later (arriving as a fresh re-delivery, which is exactly why the recovery path
   * handles it correctly for free) or simply abandoned.
   */
  readonly pending?: boolean;
  /**
   * The store has TAKEN THIS BACK — refunded, or removed by a family organiser. iOS only
   * (`Transaction.revocationDate`); Play simply stops reporting a refunded purchase.
   *
   * ⚠️ **Distinct from `pending` in the one way that matters: this transaction will never become
   * valid.** A pending purchase must be left unfinished, because it may be approved later. A
   * revoked one must be FINISHED without granting — leaving it unfinished means the store hands it
   * back on every launch forever, and granting it hands out goods for money that was returned.
   *
   * `entitlements()` is unaffected either way — `currentEntitlements` already excludes revoked
   * transactions, which is exactly why this flag is needed only on the `unfinished()` path.
   */
  readonly revoked?: boolean;
}

/** What a `purchase()` attempt did. Distinguishes the three outcomes a UI must render differently:
 *  something happened, nothing happened because the player said no, nothing happened because the
 *  store said no. */
export type PurchaseOutcome =
  /** Money taken, entitlement durably granted, transaction finished. */
  | 'granted'
  /** The store already considered this owned — a re-buy of a non-consumable, or a re-delivery we
   *  had already processed. Not an error; the UI should look identical to `granted`. */
  | 'already-owned'
  /** Awaiting external approval (Ask-to-Buy, cash payment). Grant nothing; it arrives later. */
  | 'pending'
  /** The player dismissed the sheet. Never an error state, never a message. */
  | 'cancelled'
  /** The store or verification refused. */
  | 'failed';

export interface PurchaseResult {
  readonly outcome: PurchaseOutcome;
  readonly productId: string;
  readonly transactionId?: string;
  /** Present only when `outcome === 'failed'` — for logs, never for display verbatim. */
  readonly error?: string;
}
