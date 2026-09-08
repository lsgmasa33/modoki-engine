/** #767, the mock store's half — the same `d.v !== 1 → emptyDoc()` collapse `ledger.ts` carried.
 *
 *  Lower stakes than the ledger (this is the editor/off-device mock; no real money moves through
 *  it) and it was fixed identically on purpose: the whole point of a shared classifier is that the
 *  same document question does not get two different answers depending on how important the
 *  document looked to whoever was passing.
 *
 *  These exist because the fix landed on both files and only `ledger.ts` had tests — a fix applied
 *  to a second site on the strength of "it's the same shape" is exactly the one that quietly
 *  isn't. See `iapLedgerSchema.test.ts` for the ledger half. */

import { describe, it, expect } from 'vitest';
import { MockStoreBackend, type IapProduct } from '../../src/runtime/iap';

const COINS: IapProduct = { id: 'coins.100', kind: 'consumable', grant: 100 };

class MemStore {
  doc: unknown;
  constructor(seed?: unknown) { this.doc = seed; }
  read(): unknown { return this.doc; }
  write(d: unknown): void { this.doc = JSON.parse(JSON.stringify(d)); }
  async flush(): Promise<void> { /* no-op */ }
}

/** The document as a hypothetical NEWER build would write it. */
const FROM_A_NEWER_BUILD = {
  v: 2,
  seq: 4,
  // Deliberately UNFINISHED: `unfinished()` then returns 1 with the fix and 0 without it (an
  // `emptyDoc()` has `paid: []`), which is what makes the assertion below discriminating. A
  // finished transaction would read 0 either way and prove nothing.
  paid: [{ transactionId: 'txn-1', productId: 'coins.100' }],
  finished: [],
  acknowledged: [],
  promoCodesRedeemed: ['SPRING24'], // the unknown field
};

const doc = (s: MemStore) => s.doc as Record<string, unknown>;

describe('MockStoreBackend — a document from a NEWER build is read, not discarded (#767)', () => {
  it('keeps the paid list rather than reading it as a fresh install', async () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    const backend = new MockStoreBackend({ store: store as never, products: [COINS] });
    // Before the fix `paid` was replaced by `[]`, so a v2 document looked like a fresh install
    // and this returned 0 — an unfinished purchase the app would never be handed back.
    expect(await backend.unfinished()).toHaveLength(1);
    // A consumable is never an entitlement, so this stays 0 either way — included as the control
    // that the assertion above is reading `paid` rather than just "any non-empty result".
    expect(await backend.entitlements()).toHaveLength(0);
  });

  it('carries an unknown field through a WRITE, and does not stamp the version down', async () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    const backend = new MockStoreBackend({ store: store as never, products: [COINS] });

    await backend.purchase('coins.100'); // forces a persist

    expect(doc(store).promoCodesRedeemed).toEqual(['SPRING24']);
    expect(doc(store).v).toBe(2);
  });

  it('never writes `unknownFields` as a literal key', async () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    await new MockStoreBackend({ store: store as never, products: [COINS] }).purchase('coins.100');
    expect(doc(store)).not.toHaveProperty('unknownFields');
  });
});

describe('MockStoreBackend — genuinely damaged documents still read as empty', () => {
  it('a non-integer version is unreadable, not preserved', async () => {
    const store = new MemStore({ ...structuredClone(FROM_A_NEWER_BUILD), v: '2' });
    const backend = new MockStoreBackend({ store: store as never, products: [COINS] });
    backend.reset();
    expect(doc(store).v).toBe(1); // normalized, not preserved
    expect(doc(store).promoCodesRedeemed).toBeUndefined();
  });

  it('a malformed paid list is refused even at a readable version', async () => {
    // Shape validation stays SEPARATE from the version verdict, as in the ledger.
    const store = new MemStore({ v: 1, seq: 0, paid: 'not-an-array', finished: [], acknowledged: [] });
    const backend = new MockStoreBackend({ store: store as never, products: [COINS] });
    expect(await backend.unfinished()).toEqual([]);
  });
});
