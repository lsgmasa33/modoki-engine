/** #925 — the store shelf's decisions, promoted from Court to the engine. One test per rule, each
 *  written so that deleting the rule turns it red. */

import { describe, it, expect, vi } from 'vitest';
import {
  buildShelfCatalog, extendPassExpiry, isPassActive, noAdsActive, noAdsRemaining, quickBuyView,
  sellableShelfOffers, shelfEffectOf, shelfOfferForProduct, shelfProductId, shelfView, visibleShelfOffers,
  type ShelfInputs, type ShelfOffer, type ShelfState,
} from '../../src/runtime/iap/shelf';

const HOUR = 3_600_000;

function shelf(over: Partial<Record<string, Partial<ShelfOffer>>> = {}): ShelfOffer[] {
  const base: ShelfOffer[] = [
    { key: 'coins300', productId: 'p.coins300', kind: 'consumable', coins: 300 },
    { key: 'coins1000', productId: 'p.coins1000', kind: 'consumable', coins: 1000 },
    { key: 'pass', productId: 'p.pass', kind: 'consumable', coins: 0, noAds: 'pass', passHours: 72 },
    { key: 'forever', productId: 'p.forever', kind: 'non-consumable', coins: 0, noAds: 'forever' },
    { key: 'bundle', productId: 'p.bundle', kind: 'non-consumable', coins: 3000, noAds: 'forever' },
  ];
  return base.map((o) => ({ ...o, ...(over[o.key] ?? {}) }));
}

const WORDS: Pick<ShelfInputs, 'rowWords' | 'notice'> = {
  rowWords: (o) => ({ title: `T:${o.key}`, blurb: `B:${o.key}` }),
  notice: {
    loading: 'LOADING',
    unavailable: 'UNAVAILABLE',
    refusal: (r) => (r === 'already-in-flight' ? 'IN-FLIGHT' : ''),
  },
};

function allPrices(offers: readonly ShelfOffer[]): Map<string, string> {
  return new Map(offers.map((o) => [o.productId, '$1']));
}

function input(over: Partial<ShelfInputs> = {}): ShelfInputs {
  const offers = over.offers ?? shelf();
  return {
    offers, prices: allPrices(offers), owned: { foreverOwned: false }, pricesAnswered: true, refusal: null,
    ...WORDS, ...over,
  };
}

const SHELF: ShelfState = { kind: 'shelf' };

describe('the catalog', () => {
  it('skips a blank (or whitespace) product id rather than registering it', () => {
    const offers = shelf({ coins1000: { productId: '   ' } });
    expect(buildShelfCatalog(offers).map((p) => p.id)).toEqual(['p.coins300', 'p.pass', 'p.forever', 'p.bundle']);
    expect(shelfProductId(offers[1]!)).toBeNull();
  });

  it('carries each offer kind, and a pure coin pack registers its coin count as the grant', () => {
    const byId = new Map(buildShelfCatalog(shelf()).map((p) => [p.id, p]));
    expect(byId.get('p.coins300')).toEqual({ id: 'p.coins300', kind: 'consumable', grant: 300 });
    expect(byId.get('p.forever')).toEqual({ id: 'p.forever', kind: 'non-consumable', grant: 1 });
    // A bundle pays coins AND carries the unlock, so it is not a pure coin pack.
    expect(byId.get('p.bundle')!.grant).toBe(1);
  });

  it('withholds an offer whose `requires` is blank, and says so through the callback only', () => {
    const offers = shelf({ bundle: { requires: 'forever' }, forever: { productId: '' } });
    const told = vi.fn();
    expect(sellableShelfOffers(offers, told).map((o) => o.key)).toEqual(['coins300', 'coins1000', 'pass']);
    expect(told).toHaveBeenCalledTimes(1);
    expect(told.mock.calls[0]![0].key).toBe('bundle');
    // Authored dependency → sold.
    expect(sellableShelfOffers(shelf({ bundle: { requires: 'forever' } })).map((o) => o.key)).toContain('bundle');
  });
});

describe('what a purchase pays', () => {
  it('maps a product id back to its offer, and never matches a blank offer with an empty id', () => {
    const offers = shelf({ coins1000: { productId: '' } });
    expect(shelfOfferForProduct(offers, 'p.pass')!.key).toBe('pass');
    expect(shelfOfferForProduct(offers, '')).toBeNull();
    expect(shelfOfferForProduct(offers, 'other')).toBeNull();
  });

  it('pays coins, the forever unlock and pass hours from the offer alone', () => {
    const offers = shelf();
    expect(shelfEffectOf(offers, 'p.coins300')).toEqual({ coins: 300, adsForever: false, passHours: 0 });
    expect(shelfEffectOf(offers, 'p.pass')).toEqual({ coins: 0, adsForever: false, passHours: 72 });
    expect(shelfEffectOf(offers, 'p.bundle')).toEqual({ coins: 3000, adsForever: true, passHours: 0 });
    expect(shelfEffectOf(offers, 'nope')).toBeNull();
  });

  it('a non-finite authored amount pays 0, for coins AND hours alike (#925 close-out review)', () => {
    const offers = shelf({ coins300: { coins: Number.NaN }, pass: { passHours: Number.NaN } });
    expect(shelfEffectOf(offers, 'p.coins300')).toEqual({ coins: 0, adsForever: false, passHours: 0 });
    expect(shelfEffectOf(offers, 'p.pass')).toEqual({ coins: 0, adsForever: false, passHours: 0 });
    expect(shelfEffectOf(shelf({ pass: { passHours: Number.POSITIVE_INFINITY } }), 'p.pass')!.passHours).toBe(0);
    expect(buildShelfCatalog(offers).find((p) => p.id === 'p.coins300')!.grant).toBe(1);
  });

  it('reads passHours only on a pass, and floors a fractional coin count', () => {
    const offers = shelf({ coins300: { passHours: 99, coins: 300.9 } });
    expect(shelfEffectOf(offers, 'p.coins300')).toEqual({ coins: 300, adsForever: false, passHours: 0 });
  });
});

describe('visibility', () => {
  it('drops every no-ads offer once forever is owned, and keeps the coin packs', () => {
    expect(visibleShelfOffers(shelf(), { foreverOwned: true }).map((o) => o.key)).toEqual(['coins300', 'coins1000']);
  });

  it('keeps the pass for a player who owns only a pass — passes stack', () => {
    expect(visibleShelfOffers(shelf(), { foreverOwned: false }).map((o) => o.key)).toContain('pass');
  });
});

describe('pass arithmetic', () => {
  it('extends a LIVE pass from its expiry, never from now', () => {
    const now = 1_000 * HOUR;
    expect(extendPassExpiry(now + 10 * HOUR, now, 72)).toBe(now + 82 * HOUR);
  });

  it('never writes a non-finite expiry over a live pass', () => {
    const now = 1_000 * HOUR;
    expect(extendPassExpiry(now + 10 * HOUR, now, Number.NaN)).toBe(now + 10 * HOUR);
  });

  it('starts a lapsed or malformed pass from now', () => {
    const now = 1_000 * HOUR;
    expect(extendPassExpiry(now - HOUR, now, 72)).toBe(now + 72 * HOUR);
    expect(extendPassExpiry(Number.NaN, now, 72)).toBe(now + 72 * HOUR);
    expect(extendPassExpiry(0, now, -5)).toBe(now);
  });

  it('answers ads-off for forever OR a live pass, and neither otherwise', () => {
    const now = 50 * HOUR;
    expect(noAdsActive({ foreverOwned: true, passExpiryMs: 0 }, now)).toBe(true);
    expect(noAdsActive({ foreverOwned: false, passExpiryMs: now + 1 }, now)).toBe(true);
    expect(noAdsActive({ foreverOwned: false, passExpiryMs: now }, now)).toBe(false);
    expect(isPassActive(Number.POSITIVE_INFINITY, now)).toBe(false);
  });

  it('reads a fresh three-day pass as 3 days, not 2 — the floor-twice defect (Court #462)', () => {
    const now = 10 * HOUR;
    expect(noAdsRemaining({ foreverOwned: false, passExpiryMs: now + 72 * HOUR }, now))
      .toEqual({ kind: 'left', parts: [{ n: 3, unit: 'day' }] });
    expect(noAdsRemaining({ foreverOwned: false, passExpiryMs: now + 72 * HOUR - 60_000 }, now))
      .toEqual({ kind: 'left', parts: [{ n: 2, unit: 'day' }, { n: 23, unit: 'hour' }] });
  });

  it('keeps the two most significant non-zero units, and names the edges', () => {
    const now = 0;
    expect(noAdsRemaining({ foreverOwned: false, passExpiryMs: HOUR + 5 * 60_000 }, now))
      .toEqual({ kind: 'left', parts: [{ n: 1, unit: 'hour' }, { n: 5, unit: 'minute' }] });
    expect(noAdsRemaining({ foreverOwned: false, passExpiryMs: 59_000 }, now)).toEqual({ kind: 'under-a-minute' });
    expect(noAdsRemaining({ foreverOwned: false, passExpiryMs: 0 }, now)).toEqual({ kind: 'off' });
    expect(noAdsRemaining({ foreverOwned: true, passExpiryMs: 0 }, now)).toEqual({ kind: 'forever' });
  });
});

describe('the shelf view', () => {
  it('rule 1 — a row with no price is not shown, and every key is still present', () => {
    const offers = shelf();
    const prices = new Map([['p.coins300', '$0.99'], ['p.pass', '  ']]);
    const view = shelfView(SHELF, input({ offers, prices }));
    expect(Object.keys(view.rows).sort()).toEqual(['bundle', 'coins1000', 'coins300', 'forever', 'pass']);
    expect(view.rows.coins300).toEqual({ show: true, title: 'T:coins300', blurb: 'B:coins300', price: '$0.99' });
    expect(view.rows.pass!.show).toBe(false);
    expect(view.shown).toBe(1);
  });

  it('ownership hides rows even when they are priced', () => {
    const view = shelfView(SHELF, input({ owned: { foreverOwned: true } }));
    expect(view.rows.forever!.show).toBe(false);
    expect(view.rows.bundle!.show).toBe(false);
    expect(view.rows.coins300!.show).toBe(true);
  });

  it('rule 2 — no "unavailable" verdict while the price question is open', () => {
    const empty = new Map<string, string>();
    expect(shelfView(SHELF, input({ prices: empty, pricesAnswered: false })).notice).toBe('LOADING');
    expect(shelfView({ kind: 'loading' }, input({ prices: empty, pricesAnswered: true })).notice).toBe('LOADING');
    expect(shelfView(SHELF, input({ prices: empty, pricesAnswered: true })).notice).toBe('UNAVAILABLE');
    expect(shelfView(SHELF, input()).notice).toBe('');
  });

  it('a settled error outranks a refusal, and a refusal with words outranks loading', () => {
    const empty = new Map<string, string>();
    expect(shelfView({ kind: 'error', text: 'ERR' }, input({ refusal: 'already-in-flight' })).notice).toBe('ERR');
    expect(shelfView({ kind: 'loading' }, input({ prices: empty, refusal: 'already-in-flight' })).notice).toBe('IN-FLIGHT');
    // A refusal arm the game words as '' does not mask the line beneath it.
    expect(shelfView({ kind: 'loading' }, input({ refusal: 'not-on-shelf' })).notice).toBe('LOADING');
  });

  it('closing is withheld while buying, and the escape hatch appears only once stalled', () => {
    const buying: ShelfState = { kind: 'buying', title: 'x', productId: 'p.pass' };
    expect(shelfView(buying, input())).toMatchObject({ showClose: false, busyClose: false });
    expect(shelfView({ ...buying, stalled: true }, input())).toMatchObject({ showClose: false, busyClose: true });
    expect(shelfView(SHELF, input())).toMatchObject({ showClose: true, busyClose: false });
  });
});

describe('the shortfall quick buy', () => {
  const offer = shelf()[0]!;
  const prices = new Map([['p.coins300', '$0.99']]);
  const NONE_IN_FLIGHT = (): boolean => false;

  it('shows the price when the offer is priced, idle and covers the gap', () => {
    expect(quickBuyView(offer, { prices, state: SHELF, shortfall: { cost: 30, coins: 5 }, isInFlight: NONE_IN_FLIGHT }))
      .toEqual({ show: true, price: '$0.99' });
  });

  it('rule 4 — hidden with no price, while buying, or with no offer', () => {
    const buying: ShelfState = { kind: 'buying', title: 'x', productId: 'p.coins300' };
    expect(quickBuyView(offer, { prices: new Map(), state: SHELF, shortfall: { cost: 30, coins: 5 }, isInFlight: NONE_IN_FLIGHT }).show).toBe(false);
    expect(quickBuyView(offer, { prices, state: buying, shortfall: { cost: 30, coins: 5 }, isInFlight: NONE_IN_FLIGHT }).show).toBe(false);
    expect(quickBuyView(null, { prices, state: SHELF, shortfall: { cost: 30, coins: 5 }, isInFlight: NONE_IN_FLIGHT }).show).toBe(false);
  });

  it('hidden when the offer does not cover the gap, shown when it exactly does', () => {
    expect(quickBuyView(offer, { prices, state: SHELF, shortfall: { cost: 400, coins: 99 }, isInFlight: NONE_IN_FLIGHT }).show).toBe(false);
    expect(quickBuyView(offer, { prices, state: SHELF, shortfall: { cost: 400, coins: 100 }, isInFlight: NONE_IN_FLIGHT }).show).toBe(true);
  });

  it('#1180 — hidden while ITS product is in flight on a released screen, shown while another one is', () => {
    const input = { prices, state: SHELF, shortfall: { cost: 30, coins: 5 } };
    expect(quickBuyView(offer, { ...input, isInFlight: (id) => id === 'p.coins300' })).toEqual({ show: false, price: '' });
    expect(quickBuyView(offer, { ...input, isInFlight: (id) => id === 'p.forever' }).show).toBe(true);
  });
});
