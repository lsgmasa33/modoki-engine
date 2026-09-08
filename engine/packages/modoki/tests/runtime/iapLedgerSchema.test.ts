/** #767 — the IAP ledger and the mock store must not DISCARD a document a newer build wrote.
 *
 *  Both `parse()` functions gated on `d.v !== 1` — exact equality — and returned `emptyDoc()` for
 *  anything else. On the ledger that means an **empty `processed` table**: the set of transaction
 *  ids already granted, described in `ledger.ts` as "the only thing standing between a re-delivered
 *  purchase and a duplicate credit". A `v: 2` document was therefore not merely stripped of the
 *  fields this build does not know — every already-granted transaction read as ungranted, and the
 *  next write put `{v: 1, …}` straight over it.
 *
 *  The disposition for these documents is PRESERVE (`docs/format-versioning.md` § 2b-bis), because they
 *  hold the player's own purchases: read the known fields, carry the unknown ones through, and keep
 *  the higher version on write-back.
 *
 *  ⚠️ The load-bearing assertions below are (a) `isProcessed` still true for a transaction recorded
 *  by the newer build, and (b) the unknown field surviving a WRITE — not merely a read. A read-only
 *  assertion passes without the write-back half of the fix. */

import { describe, it, expect } from 'vitest';
import { IapLedger, type IapLedgerStore } from '../../src/runtime/iap';

class MemStore implements IapLedgerStore {
  doc: unknown;
  constructor(seed?: unknown) { this.doc = seed; }
  read(): unknown { return this.doc; }
  write(d: unknown): void { this.doc = JSON.parse(JSON.stringify(d)); }
  async flush(): Promise<void> { /* no-op */ }
}

/** A ledger document as a hypothetical NEWER build would write it: version bumped, one already
 *  granted transaction, and a field this build has never heard of. */
const FROM_A_NEWER_BUILD = {
  v: 2,
  seq: 7,
  processed: { 'txn-abc': { productId: 'coins.100', seq: 7, finished: true } },
  consumables: { 'coins.100': 100 },
  refundedTransactions: ['txn-old'], // the unknown field
};

const doc = (s: MemStore) => s.doc as Record<string, unknown>;

describe('IapLedger — a document from a NEWER build is read, not discarded (#767)', () => {
  it('keeps the processed table, so an already-granted transaction is not re-credited', () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    const ledger = new IapLedger(store);

    // Before the fix this was `false` — the whole table had been replaced by `{}`, so the next
    // re-delivery of txn-abc would have credited 100 coins a second time.
    expect(ledger.isProcessed('txn-abc')).toBe(true);
  });

  it('keeps the consumable balance the newer build recorded', () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    expect(new IapLedger(store).balanceOf('coins.100')).toBe(100);
  });

  it('carries an unknown field through a WRITE, and does not stamp the version down', () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    const ledger = new IapLedger(store);

    // Any mutation forces a persist — this is the round trip that used to destroy the document.
    ledger.recordGrant('txn-new', 'coins.100', 0);

    expect(doc(store).refundedTransactions).toEqual(['txn-old']);
    // `Math.max(stored, current)` — writing `1` here would tell the newer build its document was
    // never stripped, which is exactly the signal a future migration needs (#735).
    expect(doc(store).v).toBe(2);
    // And the entry the newer build wrote is still there alongside the new one.
    expect(Object.keys(doc(store).processed as object).sort()).toEqual(['txn-abc', 'txn-new']);
  });

  it('never writes `unknownFields` as a literal key — it is a parse-time construct only', () => {
    const store = new MemStore(structuredClone(FROM_A_NEWER_BUILD));
    new IapLedger(store).recordGrant('txn-new', 'coins.100', 0);
    expect(doc(store)).not.toHaveProperty('unknownFields');
  });

  it('keeps arithmetic on a preserved document correct — the balance accumulates, not resets', () => {
    // The bag/known merge ORDER is not observable from here: `collectUnknownFields` excludes every
    // known key by construction, so a known key can never be IN the bag. That property is asserted
    // directly in `tests/runtime/formatVersion.test.ts`. What this pins instead is the thing a
    // caller sees: a grant applied to a too-new document adds to the balance that document carried,
    // rather than to the 0 an `emptyDoc()` would have handed back.
    const store = new MemStore({
      ...structuredClone(FROM_A_NEWER_BUILD),
      consumables: { 'coins.100': 5 },
    });
    new IapLedger(store).recordGrant('txn-new', 'coins.100', 3);
    expect((doc(store).consumables as Record<string, number>)['coins.100']).toBe(8);
  });
});

describe('IapLedger — genuinely damaged documents still read as empty', () => {
  it('a non-integer version is unreadable, not preserved', () => {
    const store = new MemStore({ ...structuredClone(FROM_A_NEWER_BUILD), v: '2' });
    expect(new IapLedger(store).isProcessed('txn-abc')).toBe(false);
  });

  it('a document below the readable floor is refused', () => {
    const store = new MemStore({ ...structuredClone(FROM_A_NEWER_BUILD), v: 0 });
    expect(new IapLedger(store).isProcessed('txn-abc')).toBe(false);
  });

  it('a malformed processed table is refused even at a readable version', () => {
    // Shape validation is kept SEPARATE from the version verdict — fusing them with `||` is what
    // made a version refusal and a corrupt payload indistinguishable to the caller.
    const store = new MemStore({ v: 1, seq: 0, processed: 'not-an-object', consumables: {} });
    expect(new IapLedger(store).isProcessed('txn-abc')).toBe(false);
  });

  it('reads a version-less document rather than emptying the money table', () => {
    // `absent` is readable per § 2a. The harm of wrongly emptying this table is minting currency,
    // so reading a shape-valid document with no `v` is the safer error.
    const { v: _v, ...noVersion } = structuredClone(FROM_A_NEWER_BUILD);
    expect(new IapLedger(new MemStore(noVersion)).isProcessed('txn-abc')).toBe(true);
  });
});
