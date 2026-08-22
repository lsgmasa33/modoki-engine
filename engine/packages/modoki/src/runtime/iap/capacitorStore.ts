/**
 * `CapacitorStoreBackend` — the real store, adapting `capacitor-modoki-iap` onto `StoreBackend`.
 *
 * ── Why there is no runtime dependency on the plugin ───────────────────────────
 * The import of its types is `import type`, which ERASES at compile time, and the bridge is
 * obtained with Capacitor's `registerPlugin` — which resolves the native implementation by NAME.
 * So the engine never imports the plugin's JavaScript, and a game that does not depend on
 * `capacitor-modoki-iap` neither pays for it nor fails to build.
 *
 * That also makes the opt-in the right thing: **a Capacitor plugin's real cost is native, and
 * native inclusion is decided by the game's `package.json`.** A game that does not list the plugin
 * ships no StoreKit and no Play Billing, whatever the JS does. A `build.modules` flag would only
 * duplicate npm — and could not be auto-detected anyway, since `build.modules` resolves `'auto'`
 * by scanning scenes for ENGINE trait names, and "this game sells things" has no engine trait.
 *
 * When the native side is absent, `registerPlugin` still returns a proxy — every call rejects with
 * "not implemented". `probeAvailable()` turns that into an honest `false` once, at wiring time,
 * rather than letting it surface as a mystery rejection inside a purchase.
 */

import { registerPlugin } from '@capacitor/core';

import type { ModokiIapPlugin } from 'capacitor-modoki-iap';
import { reconcile } from './purchaseService';
import type { StoreBackend } from './storeBackend';
import type { IapProduct, IapProductInfo, StoreTransaction } from './types';

/**
 * Resolved on FIRST USE, never at module scope.
 *
 * A top-level `registerPlugin(...)` is an import-time side effect, and this module is reachable
 * from the runtime barrel — so merely importing the engine would touch Capacitor. That broke nine
 * unrelated tests whose `@capacitor/core` mock has no `registerPlugin`, which is the mild version
 * of the failure; the sharp version is a bundler or an early importer running it before Capacitor
 * is ready. Lazy costs one null check.
 */
let plugin: ModokiIapPlugin | null = null;
function iap(): ModokiIapPlugin {
  if (!plugin) plugin = registerPlugin<ModokiIapPlugin>('ModokiIap');
  return plugin;
}

/**
 * iOS reports an Ask-to-Buy purchase as `pending` with **no transaction at all** — the real one
 * arrives later as a re-delivery. The engine's `settle()` needs *a* transaction to report a
 * pending outcome, so we synthesise one.
 *
 * Safe because a pending transaction is never granted and never recorded: `settle()` returns
 * before touching the ledger, so this id cannot collide with, or pollute, the idempotency set.
 */
function syntheticPending(productId: string): StoreTransaction {
  return { transactionId: `pending:${productId}`, productId, pending: true };
}

export class CapacitorStoreBackend implements StoreBackend {
  readonly available = true;

  private readonly catalog: Map<string, IapProduct>;

  /** Undo for the `purchasesUpdated` subscription, so a game swap does not leave a listener
   *  driving a torn-down service. */
  private unsubscribe: (() => void) | null = null;

  constructor(products: readonly IapProduct[]) {
    // The catalog is needed on THIS side because the platform calls are kind-dependent: Android
    // queries one-time products and subscriptions separately, and "finish" means consume for a
    // consumable and acknowledge for everything else. The store cannot tell us which is which.
    this.catalog = new Map(products.map((p) => [p.id, p]));

    // ⚠️ **The store can hand us a purchase nobody asked for, and it is not an edge case.**
    //
    // A `pending` purchase — cash, carrier billing, parental approval, or Google's license-testing
    // "slow test card" — is approved MINUTES after `purchase()` has already resolved; a
    // subscription renews days later. Without this subscription the running app cannot notice, and
    // the purchase stays invisible until the next launch happens to run `reconcile()`. That was a
    // real observed failure: a paid-for coin pack that only appeared after a relaunch.
    //
    // `reconcile()` is the right response rather than settling the event's payload directly: it is
    // idempotent, it re-derives entitlements too, and it asks the STORE what is outstanding instead
    // of trusting a payload that may be partial.
    void iap()
      .addListener('purchasesUpdated', () => { void reconcile(); })
      .then((h) => { this.unsubscribe = () => { void h.remove(); }; })
      .catch(() => { /* no native plugin here — nothing to listen to */ });
  }

  /** Drop the listener. Called on teardown so a swapped-out game's backend goes quiet. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Is the native plugin actually present and billing usable? Called once at wiring time. */
  static async probeAvailable(): Promise<boolean> {
    try {
      const { available } = await iap().isAvailable();
      return available;
    } catch {
      // The plugin is not installed in this project, or billing is unavailable on this device.
      return false;
    }
  }

  private kindOf(productId: string): IapProduct['kind'] {
    return this.catalog.get(productId)?.kind ?? 'consumable';
  }

  async products(ids: readonly string[]): Promise<IapProductInfo[]> {
    const inapp: string[] = [];
    const subs: string[] = [];
    for (const id of ids) {
      (this.kindOf(id) === 'subscription' ? subs : inapp).push(id);
    }
    const { products } = await iap().products({ inapp, subs });
    return products;
  }

  async purchase(productId: string): Promise<StoreTransaction | null> {
    const { transaction, pending } = await iap().purchase({
      productId,
      kind: this.kindOf(productId),
    });
    if (transaction) return transaction;
    // Distinguish "waiting for a guardian" from "the player said no" — reporting a pending
    // purchase as cancelled would tell someone their purchase failed while it is still alive.
    return pending ? syntheticPending(productId) : null;
  }

  async unfinished(): Promise<StoreTransaction[]> {
    const { transactions } = await iap().unfinished();
    return transactions;
  }

  async entitlements(): Promise<StoreTransaction[]> {
    const { transactions } = await iap().entitlements();
    return transactions;
  }

  async finish(tx: StoreTransaction): Promise<void> {
    await iap().finish({
      transactionId: tx.transactionId,
      purchaseToken: tx.purchaseToken,
      kind: this.kindOf(tx.productId),
    });
  }

  async acknowledge(tx: StoreTransaction): Promise<void> {
    await iap().acknowledge({
      transactionId: tx.transactionId,
      purchaseToken: tx.purchaseToken,
    });
  }
}
