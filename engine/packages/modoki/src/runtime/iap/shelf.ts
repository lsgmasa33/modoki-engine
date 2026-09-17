/**
 * The store SHELF — the product-agnostic decisions a game's store screen makes, as pure functions
 * (#925). Promoted from Court's `store.ts`/`storeUi.ts` for wordweave's store screen — the second
 * game with one, and the condition #659 set for reopening the extraction. What moved and what stayed per
 * game: `docs/cross-game-infrastructure.md` § "What is shared today".
 *
 * ⚠️ **No player-visible copy lives here, deliberately** — the same line the account contract draws
 * (#675). Every function answers a DECISION (is this row shown, what does this purchase pay, which
 * notice wins) and hands the words back to the game. A game's shelf reads in its own voice; a
 * sentence baked in here would be the one string neither game could retune.
 *
 * ⚠️ **The shelf is a DESCRIPTOR, not a type union.** Court's first cut named its six items in a
 * `StoreSlot` union and switched over it in three places, so every noun lived in code and no second
 * game could reuse the mechanism. An offer is data: its key, its authored product id, and what one
 * purchase pays. Order is display order.
 *
 * The four rules every function below serves, whatever the game:
 *  1. **No price, no row.** A price is the store's own localized string, never authored.
 *  2. **No verdict while the question is still open** — "not available" waits for the price fetch.
 *  3. **A cancel is not a failure the game caused.**
 *  4. **Hidden, not greyed.** A control with nothing honest to say is not on screen.
 */

import type { IapProduct, ProductKind } from './types';

/** One item on the shelf. Everything a purchase PAYS is authored here, so a retune moves the label,
 *  the grant and the analytics value together. */
export interface ShelfOffer {
  /** Stable identity inside the game (`'coins300'`), independent of the store's product id. */
  readonly key: string;
  /** The store product id. Blank means not for sale — skipped, never registered. */
  readonly productId: string;
  /** How the store treats it. A `non-consumable` is store-owned and comes back through restore. */
  readonly kind: ProductKind;
  /** Coins one purchase pays. 0 for an offer that pays none. */
  readonly coins: number;
  /** The ad removal this offer carries, if any. `'pass'` lasts `passHours`; `'forever'` does not end. */
  readonly noAds?: 'forever' | 'pass';
  /** Hours of ads-off one pass purchase adds. Read only when `noAds === 'pass'`. */
  readonly passHours?: number;
  /** US LIST price, for the purchase funnel's `value` — not what the player paid, not revenue. */
  readonly usd?: number;
  /**
   * The key of another offer whose product id must ALSO be authored before this one may be sold.
   *
   * Court's bundle needs it: the bundle's permanent-unlock half is recorded under the forever
   * offer's own product id, so selling the bundle while that id is blank would take the money and
   * drop the unlock with nowhere to write it. A game that records the unlock by EFFECT rather than
   * under a product id (wordweave's `StoredPurchases.noAdsForever`), or whose unlock is store-owned,
   * has no such dependency and leaves this unset.
   */
  readonly requires?: string;
}

/** What one settled transaction is worth. */
export interface ShelfEffect {
  coins: number;
  adsForever: boolean;
  passHours: number;
}

/** The authored product id for an offer, or `null` when it is blank (not for sale). */
export function shelfProductId(offer: ShelfOffer): string | null {
  const id = offer.productId.trim();
  return id === '' ? null : id;
}

function offerByKey(offers: readonly ShelfOffer[], key: string): ShelfOffer | undefined {
  return offers.find((o) => o.key === key);
}

/** Whether an offer's `requires` dependency is authored. An unknown key is unsatisfied. */
function requirementMet(offers: readonly ShelfOffer[], offer: ShelfOffer): boolean {
  if (offer.requires === undefined) return true;
  const dep = offerByKey(offers, offer.requires);
  return dep !== undefined && shelfProductId(dep) !== null;
}

/**
 * The offers the catalog CONTAINS, in shelf order — the one inclusion rule, so a catalog, a `k/N`
 * count and a visibility filter never restate it.
 *
 * `onUnsellable` is told about an offer skipped only because its `requires` is blank — the state a
 * designer is halfway through authoring. It is the caller's choice whether that is worth a warning:
 * the boot path wants to hear it once, a per-open counter never.
 */
export function sellableShelfOffers(
  offers: readonly ShelfOffer[],
  onUnsellable?: (offer: ShelfOffer) => void,
): ShelfOffer[] {
  const out: ShelfOffer[] = [];
  for (const offer of offers) {
    if (shelfProductId(offer) === null) continue;
    if (!requirementMet(offers, offer)) {
      onUnsellable?.(offer);
      continue;
    }
    out.push(offer);
  }
  return out;
}

/** A coin pack and nothing else — the only kind whose ledger `grant` carries its coin count. */
function isPureCoinOffer(offer: ShelfOffer): boolean {
  return offer.coins > 0 && offer.noAds === undefined;
}

/**
 * The catalog for `configureIap`.
 *
 * `grant` carries a pure coin pack's real coin count, so the engine's journal reads `{units: 300}`;
 * everything else registers 1. What a purchase actually DOES is `shelfEffectOf`, never the ledger's
 * units.
 */
export function buildShelfCatalog(
  offers: readonly ShelfOffer[],
  onUnsellable?: (offer: ShelfOffer) => void,
): IapProduct[] {
  return sellableShelfOffers(offers, onUnsellable).map((offer) => ({
    id: shelfProductId(offer)!,
    kind: offer.kind,
    grant: isPureCoinOffer(offer) ? Math.max(1, finiteAmount(offer.coins, true)) : 1,
  }));
}

/**
 * `MockStoreOptions.storeKinds` for a shelf, from a table keyed by offer KEY (#1219).
 *
 * Keyed by key, not product id, on purpose: the id is authored data (a scene/config field, see
 * `IapProduct`), so a table of ids in code would be a second home for every rename. The key is the
 * game's own stable name for the slot. Sellable offers only, same filter as `buildShelfCatalog`;
 * an offer missing from `kindsByKey` is left out, so the mock refuses to start and names its id.
 */
export function shelfStoreKinds(
  offers: readonly ShelfOffer[],
  kindsByKey: Readonly<Partial<Record<string, ProductKind>>>,
): Record<string, ProductKind> {
  const out: Record<string, ProductKind> = {};
  for (const offer of sellableShelfOffers(offers)) {
    const kind = Object.hasOwn(kindsByKey, offer.key) ? kindsByKey[offer.key] : undefined;
    if (kind === undefined) continue;
    const id = shelfProductId(offer)!;
    // Two slots authored with one id: the store has ONE product, so two kinds cannot both be true.
    if (Object.hasOwn(out, id) && out[id] !== kind) {
      console.warn(`[iap] "${id}" is authored in two slots recorded as different store kinds `
        + `(${out[id]} / ${kind}) — the store has one product; the later slot's kind is used.`);
    }
    out[id] = kind;
  }
  return out;
}

/** Which offer a store product id belongs to, or `null`. A `''` id cannot match a blank offer:
 *  `shelfProductId` answers `null` for one, never `''`. */
export function shelfOfferForProduct(offers: readonly ShelfOffer[], productId: string): ShelfOffer | null {
  return offers.find((o) => shelfProductId(o) === productId) ?? null;
}

/**
 * What one settled transaction pays, or `null` when the product is not on this shelf.
 *
 * No `units` parameter, on purpose: the engine's `IapGrant.units` is the authored `grant` copied
 * back, not a store-reported quantity, so multiplying by it would multiply by the same config twice.
 */
export function shelfEffectOf(offers: readonly ShelfOffer[], productId: string): ShelfEffect | null {
  const offer = shelfOfferForProduct(offers, productId);
  if (offer === null) return null;
  return {
    coins: finiteAmount(offer.coins, true),
    adsForever: offer.noAds === 'forever',
    passHours: offer.noAds === 'pass' ? finiteAmount(offer.passHours ?? 0, false) : 0,
  };
}

/**
 * An authored amount as something a purchase may pay: never negative, and a NON-FINITE value pays 0.
 *
 * ⚠️ One rule for every amount, because the two used to disagree: a NaN coin count paid 0 while NaN
 * pass hours flowed into `extendPassExpiry` and wrote a NaN expiry over a LIVE pass (#925 close-out
 * review). 0 is the side that cannot corrupt a stored document; the Inspector cannot author a
 * non-finite number, so this only ever meets corrupt data.
 */
function finiteAmount(n: number, floor: boolean): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, floor ? Math.floor(n) : n);
}

/**
 * Which offers to SHOW, given what the player owns.
 *
 * ⚠️ **Once ads are off forever, every no-ads offer leaves the shelf** — the forever unlock (never
 * sell it twice), the pass (worthless now, not merely redundant) and any bundle carrying the unlock
 * (for this player it is an overpriced coin pack). A pass stays up for a player who owns a PASS:
 * passes stack, so another is a real thing to want.
 */
export function visibleShelfOffers(
  offers: readonly ShelfOffer[],
  owned: { readonly foreverOwned: boolean },
): ShelfOffer[] {
  return sellableShelfOffers(offers).filter((offer) => !owned.foreverOwned || offer.noAds === undefined);
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Where a No-Ads pass expires after granting `hours` more of it.
 *
 * ⚠️ **EXTENDS from a live expiry, never resets to now** — a second pass bought while one is live
 * was paid for on top of the first. Only a lapsed or absent pass starts from `nowMs`.
 *
 * ⚠️ This cannot tell whether `nowMs` is trustworthy. A caller that WRITES the result should pass a
 * clock floored against the highest one it has seen, or a first purchase after the clock was wound
 * back is written into the past.
 */
export function extendPassExpiry(currentExpiryMs: number, nowMs: number, hours: number): number {
  const base = Number.isFinite(currentExpiryMs) && currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
  return base + finiteAmount(hours, false) * HOUR_MS;
}

/** Is a pass live right now? A missing or malformed expiry is simply "no pass". */
export function isPassActive(expiryMs: number, nowMs: number): boolean {
  return Number.isFinite(expiryMs) && expiryMs > nowMs;
}

/** The two sources of an ad removal. */
export interface NoAdsState {
  readonly foreverOwned: boolean;
  readonly passExpiryMs: number;
}

/**
 * **The one answer every ad site asks** — forever OR a live pass. One function, never two checks at
 * each call site: a site that remembered forever and forgot the pass would show ads to somebody
 * paying not to see them, silently.
 */
export function noAdsActive(state: NoAdsState, nowMs: number): boolean {
  return state.foreverOwned || isPassActive(state.passExpiryMs, nowMs);
}

/** The shape of the No-Ads status a game words for itself. */
export type NoAdsRemaining =
  | { readonly kind: 'forever' }
  | { readonly kind: 'off' }
  | { readonly kind: 'under-a-minute' }
  /** The two most significant non-zero units, largest first. */
  | { readonly kind: 'left'; readonly parts: ReadonlyArray<{ readonly n: number; readonly unit: 'day' | 'hour' | 'minute' }> };

/**
 * What is left of the player's ad removal.
 *
 * ⚠️ **FLOOR once, from total minutes** — never floor hours and then floor days from them. That
 * double floor told a player who had just bought three days that they had two (Court #462).
 */
export function noAdsRemaining(state: NoAdsState, nowMs: number): NoAdsRemaining {
  if (state.foreverOwned) return { kind: 'forever' };
  if (!isPassActive(state.passExpiryMs, nowMs)) return { kind: 'off' };
  const totalMinutes = Math.floor((state.passExpiryMs - nowMs) / MINUTE_MS);
  if (totalMinutes <= 0) return { kind: 'under-a-minute' };
  const all = [
    { n: Math.floor(totalMinutes / 1440), unit: 'day' as const },
    { n: Math.floor((totalMinutes % 1440) / 60), unit: 'hour' as const },
    { n: totalMinutes % 60, unit: 'minute' as const },
  ];
  return { kind: 'left', parts: all.filter((p) => p.n > 0).slice(0, 2) };
}

// ── The shelf's view-model ────────────────────────────────────────────────────────────────────

/** What the store screen is doing. */
export type ShelfState =
  /** Open, prices not back yet. Deliberately not a busy overlay — nothing the player started waits. */
  | { readonly kind: 'loading' }
  | { readonly kind: 'shelf' }
  /** A purchase is in flight. `stalled` means it has run long enough that the player deserves a way
   *  out — NOT that it failed; it may still settle. */
  | { readonly kind: 'buying'; readonly title: string; readonly productId: string; readonly stalled?: boolean }
  /** A settled failure worth an inline line. The game supplies the text. */
  | { readonly kind: 'error'; readonly text: string };

/** Why a buy was refused before it started. One vocabulary for the journal and the player's line. */
export type ShelfRefusal = 'already-in-flight' | 'mid-purchase' | 'not-on-shelf' | 'not-authored';

/** One shown row's words. */
export interface ShelfRowWords {
  readonly title: string;
  readonly blurb: string;
}

/** One row as the screen draws it. */
export interface ShelfRowView {
  readonly show: boolean;
  readonly title: string;
  readonly blurb: string;
  /** The store's own localized price. Never `''` on a shown row — that is rule 1. */
  readonly price: string;
}

/** The notice lines a game words for itself. `refusal` may return `''` for an arm with nothing to say. */
export interface ShelfNoticeWords {
  readonly loading: string;
  readonly unavailable: string;
  readonly refusal: (refusal: ShelfRefusal) => string;
}

export interface ShelfInputs {
  readonly offers: readonly ShelfOffer[];
  /** `IapProductInfo.displayPrice` by product id. Never cached across a launch. */
  readonly prices: ReadonlyMap<string, string>;
  readonly owned: { readonly foreverOwned: boolean };
  /**
   * Has a price fetch ANSWERED for this open (success or failure), or has the screen waited long
   * enough with nothing ever asked? Required, not defaulted: a caller must state which of "no prices
   * yet" and "no prices, full stop" it means, or the "not available" flash comes back (Court #463).
   */
  readonly pricesAnswered: boolean;
  /** The buy last refused, or `null`. Required for the same reason as `pricesAnswered` (Court #952). */
  readonly refusal: ShelfRefusal | null;
  readonly rowWords: (offer: ShelfOffer) => ShelfRowWords;
  readonly notice: ShelfNoticeWords;
}

const HIDDEN_ROW: ShelfRowView = { show: false, title: '', blurb: '', price: '' };

export interface ShelfView {
  /** Every offer key, always — `show: false` for the ones this player must not see. */
  readonly rows: Readonly<Record<string, ShelfRowView>>;
  /** How many rows are shown. */
  readonly shown: number;
  /** The one line above the shelf, or `''`. */
  readonly notice: string;
  /** False while a purchase is in flight — closing mid-purchase would strand it. */
  readonly showClose: boolean;
  /** The busy overlay's escape hatch: true only once an in-flight purchase has stalled. */
  readonly busyClose: boolean;
}

/**
 * The shelf as the screen draws it.
 *
 * Ownership (`visibleShelfOffers`) and availability (the price filter) are two separate questions,
 * deliberately not merged: a row hidden because it is owned is a decision, one hidden because the
 * store is silent is a symptom.
 */
export function shelfView(state: ShelfState, input: ShelfInputs): ShelfView {
  const rows: Record<string, ShelfRowView> = {};
  for (const offer of input.offers) rows[offer.key] = HIDDEN_ROW;
  let shown = 0;
  for (const offer of visibleShelfOffers(input.offers, input.owned)) {
    const price = (input.prices.get(shelfProductId(offer)!) ?? '').trim();
    if (price === '') continue; // Rule 1: no price, no row.
    const words = input.rowWords(offer);
    rows[offer.key] = { show: true, title: words.title, blurb: words.blurb, price };
    shown += 1;
  }
  return {
    rows,
    shown,
    notice: shelfNotice(state, shown, input),
    showClose: state.kind !== 'buying',
    busyClose: state.kind === 'buying' && state.stalled === true,
  };
}

/**
 * The line above the shelf, by precedence:
 *  1. a settled failure — the thing the player just did did not work;
 *  2. a refusal with something to say — they pressed something and nothing happened;
 *  3. loading — while the price question is still open, no verdict (rule 2);
 *  4. unavailable — only once it has answered and nothing survived the filter;
 *  5. nothing.
 */
function shelfNotice(
  state: ShelfState,
  shown: number,
  input: Pick<ShelfInputs, 'pricesAnswered' | 'refusal' | 'notice'>,
): string {
  if (state.kind === 'error') return state.text;
  const refusalLine = input.refusal === null ? '' : input.notice.refusal(input.refusal);
  if (refusalLine) return refusalLine;
  if (state.kind === 'loading' || !input.pricesAnswered) return input.notice.loading;
  if (shown === 0) return input.notice.unavailable;
  return '';
}

/** The quick-buy control on a coin-shortfall card. */
export interface QuickBuyView {
  readonly show: boolean;
  /** The store's price when shown, `''` otherwise. The game words the label around it. */
  readonly price: string;
}

/**
 * Whether a shortfall card may offer `offer` as a one-tap fix.
 *
 * ⚠️ **Hidden, not greyed, with no live price** (rule 4), and hidden while any purchase is in flight.
 *
 * ⚠️ **It must actually COVER the shortfall.** The offer's coins are an authored, live-editable
 * number; retuned below the gap, a quick buy would take the money and leave the player still short.
 * So coverage is checked on every call rather than assumed from which offer was picked.
 *
 * ⚠️ **Hidden while ITS product is in flight, not only while the screen says `buying`** (Court #1180).
 * A stalled purchase the player dismissed releases the screen and leaves the product in the store's
 * hands; a button still offering it would be refused as `already-in-flight`, and the card has nowhere
 * to say so. Required, not defaulted, so a caller cannot forget the released-purchase window.
 */
export function quickBuyView(
  offer: ShelfOffer | null,
  input: {
    readonly prices: ReadonlyMap<string, string>;
    readonly state: ShelfState;
    readonly shortfall: { readonly cost: number; readonly coins: number };
    /** `ShelfSession.isInFlight` — is this product still in the store's hands? */
    readonly isInFlight: (productId: string) => boolean;
  },
): QuickBuyView {
  const id = offer === null ? null : shelfProductId(offer);
  const price = id === null ? '' : (input.prices.get(id) ?? '').trim();
  const covers = offer !== null && offer.coins >= input.shortfall.cost - input.shortfall.coins;
  const show = input.state.kind !== 'buying' && price !== '' && covers && !input.isInFlight(id!);
  return show ? { show: true, price } : { show: false, price: '' };
}
