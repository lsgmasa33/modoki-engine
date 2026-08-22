import { WebPlugin } from '@capacitor/core';

import type { IapProductInfo, IapTransaction, ModokiIapPlugin } from './definitions';

/**
 * Web has no store, and this deliberately does NOT simulate one.
 *
 * A fake that pretends to sell things would let a game "work" in the browser and fail on a phone,
 * and would quietly let the engine's crash matrix pass against a fiction. Editor/browser
 * simulation is a separate, explicitly-named `MockStoreBackend` in the engine, chosen by an
 * authored flag that cannot be selected on a device.
 *
 * `isAvailable()` answering false is the honest signal, and the engine already handles it: nothing
 * is for sale.
 */
export class ModokiIapWeb extends WebPlugin implements ModokiIapPlugin {
  async isAvailable(): Promise<{ available: boolean }> {
    return { available: false };
  }
  async products(): Promise<{ products: IapProductInfo[] }> {
    return { products: [] };
  }
  async purchase(): Promise<{ transaction: IapTransaction | null }> {
    return { transaction: null };
  }
  async unfinished(): Promise<{ transactions: IapTransaction[] }> {
    return { transactions: [] };
  }
  async entitlements(): Promise<{ transactions: IapTransaction[] }> {
    return { transactions: [] };
  }
  async finish(): Promise<void> {
    /* nothing to finish */
  }
  async acknowledge(): Promise<void> {
    /* nothing to acknowledge */
  }
}
