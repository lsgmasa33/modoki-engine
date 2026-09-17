/** #1219 — the mock store answers `entitlements()` from the CONSOLE's kinds (`storeKinds`), never
 *  from the kind the game declares in its catalog.
 *
 *  #1202 is the case these exist for: a game declared two consumable-backed products
 *  `non-consumable`, and because the mock believed the declaration, a relaunch test passed that a
 *  real sandbox then failed (`entitlements()` came back `[]` on an iPad). Each test below builds the
 *  two sources so they DISAGREE — a suite where catalog and table always match could not tell which
 *  one the mock reads. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockStoreBackend, shelfStoreKinds, type IapProduct, type ShelfOffer } from '../../src/runtime/iap';

class MemStore {
  doc: unknown;
  read(): unknown { return this.doc; }
  write(d: unknown): void { this.doc = JSON.parse(JSON.stringify(d)); }
  async flush(): Promise<void> { /* no-op */ }
}

/** What #1202's wordweave declared: a permanent unlock as `non-consumable`. */
const FOREVER_DECLARED_OWNED: IapProduct = { id: 'p.noads_forever', kind: 'non-consumable' };

afterEach(() => vi.restoreAllMocks());

describe('MockStoreBackend.entitlements() answers from storeKinds, not the catalog (#1219)', () => {
  it('the #1202 case: declared non-consumable, sold as a consumable → owns nothing after a relaunch', async () => {
    const store = new MemStore();
    const opts = {
      store, products: [FOREVER_DECLARED_OWNED],
      storeKinds: { 'p.noads_forever': 'consumable' } as const,
    };
    const tx = await new MockStoreBackend(opts).purchase('p.noads_forever');
    expect(tx).not.toBeNull();

    // A relaunch: a fresh backend over the same persisted document.
    const relaunched = new MockStoreBackend(opts);
    expect(await relaunched.entitlements()).toEqual([]);
  });

  it('the reverse disagreement: declared consumable, sold as a non-consumable → owned after a relaunch', async () => {
    const store = new MemStore();
    const opts = {
      store, products: [{ id: 'p.unlock', kind: 'consumable' } as IapProduct],
      storeKinds: { 'p.unlock': 'non-consumable' } as const,
    };
    await new MockStoreBackend(opts).purchase('p.unlock');
    const owned = await new MockStoreBackend(opts).entitlements();
    expect(owned.map((t) => t.productId)).toEqual(['p.unlock']);
  });

  it('a subscription recorded as one is an entitlement', async () => {
    const store = new MemStore();
    const opts = {
      store, products: [{ id: 'p.sub', kind: 'subscription' } as IapProduct],
      storeKinds: { 'p.sub': 'subscription' } as const,
    };
    await new MockStoreBackend(opts).purchase('p.sub');
    expect((await new MockStoreBackend(opts).entitlements()).length).toBe(1);
  });
});

describe('MockStoreBackend — storeKinds must cover every sellable product (#1219)', () => {
  it('throws, naming the id, when a catalog product has no store kind', () => {
    expect(() => new MockStoreBackend({
      store: new MemStore(),
      products: [FOREVER_DECLARED_OWNED, { id: 'p.coins', kind: 'consumable' }],
      storeKinds: { 'p.coins': 'consumable' },
    })).toThrow(/No store kind for "p\.noads_forever"/);
  });

  it('accepts a complete table, and a blank id needs no entry', () => {
    expect(() => new MockStoreBackend({
      store: new MemStore(),
      products: [FOREVER_DECLARED_OWNED, { id: '', kind: 'non-consumable' }],
      storeKinds: { 'p.noads_forever': 'consumable' },
    })).not.toThrow();
  });

  it('a prototype key is not an entry: an id named `constructor` still needs one', () => {
    expect(() => new MockStoreBackend({
      store: new MemStore(),
      products: [{ id: 'constructor', kind: 'consumable' }],
      storeKinds: {},
    })).toThrow(/No store kind for "constructor"/);
  });

  it('warns about an entry the catalog does not sell, without refusing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new MockStoreBackend({
      store: new MemStore(),
      products: [{ id: 'p.coins', kind: 'consumable' }],
      storeKinds: { 'p.coins': 'consumable', 'p.renamed_away': 'consumable' },
    });
    expect(warn.mock.calls.some(([m]) => String(m).includes('"p.renamed_away"'))).toBe(true);
    expect(warn.mock.calls.some(([m]) => String(m).includes('"p.coins"'))).toBe(false);
  });
});

describe('shelfStoreKinds — a slot-keyed table resolved to the authored product ids', () => {
  const offers: ShelfOffer[] = [
    { key: 'coins', productId: 'p.coins', kind: 'consumable', coins: 100 },
    { key: 'forever', productId: 'p.forever', kind: 'non-consumable', coins: 0, noAds: 'forever' },
    { key: 'blank', productId: '', kind: 'consumable', coins: 100 },
    { key: 'bundle', productId: 'p.bundle', kind: 'consumable', coins: 1, requires: 'blank' },
  ];

  it('maps each sellable offer by key, skipping blank and unsellable ones', () => {
    expect(shelfStoreKinds(offers, { coins: 'consumable', forever: 'consumable', blank: 'consumable', bundle: 'consumable' }))
      .toEqual({ 'p.coins': 'consumable', 'p.forever': 'consumable' });
  });

  it('leaves out an offer the table does not name, so the mock refuses to start over it', () => {
    const kinds = shelfStoreKinds(offers, { coins: 'consumable' });
    expect(kinds).toEqual({ 'p.coins': 'consumable' });
    expect(() => new MockStoreBackend({
      store: new MemStore(), products: [{ id: 'p.coins', kind: 'consumable' }, { id: 'p.forever', kind: 'non-consumable' }],
      storeKinds: kinds,
    })).toThrow(/"p\.forever"/);
  });

  it('warns when one id is authored in two slots recorded as different kinds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dup: ShelfOffer[] = [
      { key: 'a', productId: 'p.same', kind: 'consumable', coins: 1 },
      { key: 'b', productId: 'p.same', kind: 'consumable', coins: 2 },
    ];
    shelfStoreKinds(dup, { a: 'consumable', b: 'consumable' });
    expect(warn).not.toHaveBeenCalled();
    shelfStoreKinds(dup, { a: 'consumable', b: 'non-consumable' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('"p.same"'))).toBe(true);
  });

  it('does not resolve a prototype key as a table entry', () => {
    const proto: ShelfOffer[] = [{ key: 'toString', productId: 'p.x', kind: 'consumable', coins: 1 }];
    expect(shelfStoreKinds(proto, {})).toEqual({});
  });
});
