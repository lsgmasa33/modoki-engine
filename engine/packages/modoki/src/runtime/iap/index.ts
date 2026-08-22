/**
 * In-app purchases — crash-safe purchase handling for consumables, non-consumables and
 * subscriptions. Design, decisions and the crash matrix: issue #196.
 *
 * The two things a caller must know:
 *
 *  - **Call `reconcile()` once on every launch, before the player can buy anything.** That is the
 *    recovery pass; without it, a purchase interrupted by a force-close is never picked up.
 *  - **Entitlements are re-derived from the store, not remembered.** `isEntitled()` reflects the
 *    last `refreshEntitlements()`/`reconcile()`, which asks the platform — so expiry, refunds and
 *    revocation are handled without us tracking them.
 */

export type {
  ProductKind, IapProduct, IapProductInfo, StoreTransaction, PurchaseOutcome, PurchaseResult,
} from './types';
export { type StoreBackend, NoopStoreBackend } from './storeBackend';
export { IapLedger, type IapLedgerStore } from './ledger';
export { type PurchaseVerifier, LocalVerifier } from './verifier';
export {
  MockStoreBackend, pickStoreBackend,
  type MockStoreOptions, type MockStoreStore, type PickStoreBackendOptions,
} from './mockStore';
// `CapacitorStoreBackend` is deliberately NOT re-exported. It is reached only through
// `pickStoreBackend`'s dynamic import — re-exporting it statically would pull it, and Capacitor's
// plugin registration, into every consumer's import graph, which is exactly what the lazy import
// exists to avoid.
export {
  configureIap, resetIap, type ConfigureIapOptions,
  purchase, reconcile, restorePurchases, refreshEntitlements,
  isEntitled, balanceOf, spend, productInfo,
} from './purchaseService';
