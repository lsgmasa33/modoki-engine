/**
 * `PurchaseVerifier` — the seam a server-side receipt check would drop into.
 *
 * **It ships empty on purpose.** The owner chose local, on-device verification with no backend
 * (#196, 2026-08-11), and the seam exists so that decision stays cheap to revisit rather than
 * because anything is planned behind it.
 *
 * ── Why "empty" is the honest default, not a stub ──────────────────────────────
 * On-device verification is genuinely performed — just not by us. StoreKit 2 hands the app only
 * transactions whose JWS signature the OS has already checked against Apple's certificates, and
 * Play Billing answers `queryPurchasesAsync` from Google's own record. By the time a
 * `StoreTransaction` reaches this layer it has been verified by the platform; re-checking it in JS
 * would add nothing, because any attacker able to forge what the plugin returns is already inside
 * the process and can forge a `true` here just as easily.
 *
 * So `LocalVerifier` accepting everything is not a TODO. It is the accurate statement that the
 * verification happened one layer down.
 *
 * ── What a real verifier would be for ──────────────────────────────────────────
 * Exactly one thing: moving the trust decision OFF the device, so a rooted Android phone cannot
 * hand the app a purchase that never happened. That requires a server holding store credentials —
 * declined here, with the trade-off recorded in #196. If it is ever built, it implements this
 * interface and `configureIap({ verifier })` picks it up; the state machine does not change.
 */

import type { StoreTransaction } from './types';

export interface PurchaseVerifier {
  /**
   * Decide whether this transaction is real. Returning `false` **withholds the grant and leaves the
   * transaction unfinished**, so a wrong `false` is recoverable (the store re-delivers next launch)
   * while a wrong `true` mints currency. Fail closed on uncertainty — but never fail closed on a
   * network blip, or an offline player loses a purchase they paid for.
   */
  verify(tx: StoreTransaction): Promise<boolean>;
}

/** Trusts the platform, because the platform already checked. See the header. */
export class LocalVerifier implements PurchaseVerifier {
  async verify(): Promise<boolean> { return true; }
}
