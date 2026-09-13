/**
 * The store screen's STATEFUL half (#925) — which prices came back, whether a purchase is in flight,
 * and the guards that keep a slow store from double-charging or wedging the screen. Promoted from
 * Court's `systems.ts`, where each field below was paid for by a device-found defect.
 *
 * It holds state and makes the transitions; it does NOT journal, track analytics or raise cards.
 * Every method returns what happened so the game can say it in its own vocabulary, and `onChange`
 * tells the game to redraw.
 *
 * ⚠️ **A released SCREEN is not a released PURCHASE.** The screen state (`state`) can go back to the
 * shelf while the store still holds a payment — the watchdog, a grant landing before `finish()`,
 * the player taking the escape hatch. `inFlight` is what refuses a second tap on the same product
 * until its promise settles, because a second `purchase()` for a consumable still in the payment
 * queue is a second charge. The two are deliberately separate fields.
 */

import { createSupersessionToken, createTeardownToken, type LivenessCheck } from '../core/liveness';
import type { IapProductInfo, PurchaseOutcome, PurchaseResult } from './types';
import type { ShelfRefusal, ShelfState } from './shelf';

/** How long a purchase may run before the busy overlay offers a way out. NOT a purchase timeout:
 *  nothing is cancelled or assumed failed. 90s covers an Ask-to-Buy prompt plus a password re-entry
 *  on a slow network. */
export const SHELF_WATCHDOG_MS = 90_000;

export interface ShelfTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ShelfTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ShelfSessionOptions<Where extends string> {
  purchase(productId: string): Promise<PurchaseResult>;
  productInfo(): Promise<readonly IapProductInfo[]>;
  /** Redraw — called after every transition that changes what the screen shows. */
  onChange?(): void;
  /** A price fetch threw. Fired for EVERY fetch, current or superseded, before the currency check. */
  onPricesFailed?(error: unknown, where: Where): void;
  /** The CURRENT price fetch answered (success or failure). `priced` counts products with
   *  a non-empty price. */
  onPricesAnswered?(answer: { where: Where; priced: number; failed: boolean }): void;
  /** The watchdog marked the in-flight purchase stalled. */
  onStalled?(buying: { title: string; productId: string }): void;
  watchdogMs?: number;
  timers?: ShelfTimers;
}

export type ShelfBegin =
  /** `stillCurrent` is this purchase attempt's liveness check — hand it back to `settle`, in the SAME
   *  tick: the product is marked in flight by `settle`, so anything awaited in between lets a second
   *  `begin` of the same product through. */
  | { readonly ok: true; readonly stillCurrent: LivenessCheck; readonly productId: string }
  | { readonly ok: false; readonly refusal: ShelfRefusal };

export type ShelfSettle = {
  /** False when a newer purchase began, or the session was reset — the caller must not speak for
   *  it. Opening the shelf or refetching prices does NOT make a settle stale. The in-flight marker is
   *  released either way. */
  readonly current: boolean;
  readonly outcome: PurchaseOutcome;
  readonly cancelReason?: string;
  readonly threw: boolean;
  readonly error?: unknown;
};

export class ShelfSession<Where extends string = string> {
  private readonly opts: ShelfSessionOptions<Where>;
  private readonly timers: ShelfTimers;

  private _state: ShelfState = { kind: 'shelf' };
  private _prices: ReadonlyMap<string, string> = new Map();
  /**
   * Has a price fetch for the current open answered? `'idle'` — nobody asked (the frames between a
   * scene binding raising the modal and the game's open running); `'pending'` — in the air;
   * `'answered'` — completed, success OR failure (an unreachable store is an answer).
   */
  private fetch: 'idle' | 'pending' | 'answered' = 'idle';
  private idleWaitMs = 0;
  private _refusal: ShelfRefusal | null = null;
  /**
   * Two supersession tokens (docs/async-lifetime.md), and keeping them SEPARATE is the point.
   *
   * `purchaseEpoch` moves when a new purchase begins (or on reset): an older purchase's settle then
   * stays quiet, which is the accepted cost Court's `ads.md` § #464 records for a second buy.
   * `fetchEpoch` moves when prices are re-asked: an older fetch must not answer for a newer open.
   *
   * ⚠️ **They were ONE counter in Court, and that silenced real outcomes** (#925 close-out review).
   * A purchase released from the screen (stalled and dismissed, or granted before `finish()`) is
   * still in the store's hands; re-opening the shelf or raising a shortfall card re-asked prices,
   * moved the shared epoch, and the purchase's later `cancelled`/`failed` settle said nothing — the
   * #580 silent-outcome symptom the owner ruled out on 2026-09-08, reached through a sixth door.
   */
  private readonly purchaseEpoch = createSupersessionToken();
  private readonly fetchEpoch = createSupersessionToken();
  private watchdog: unknown = null;
  private readonly inFlight = new Set<string>();
  /**
   * Which generation of `inFlight` a settle belongs to (a teardown token). Invalidated only by
   * `reset` (not by the purchase epoch, which moves for reasons that must not release a marker): `reset`
   * clears the set while a payment may still be queued, and without this the abandoned settle's
   * `finally` could release the marker a NEW purchase of the same product holds.
   */
  private readonly inFlightGen = createTeardownToken();

  constructor(opts: ShelfSessionOptions<Where>) {
    this.opts = opts;
    this.timers = opts.timers ?? DEFAULT_TIMERS;
  }

  get state(): ShelfState { return this._state; }
  get prices(): ReadonlyMap<string, string> { return this._prices; }
  get refusal(): ShelfRefusal | null { return this._refusal; }
  /** How many purchases the store is still holding — a reload blocker's question. */
  get inFlightCount(): number { return this.inFlight.size; }
  isInFlight(productId: string): boolean { return this.inFlight.has(productId); }

  /**
   * Is the price question closed? `'answered'` always is. `'idle'` counts only once the screen has
   * sat there `waitMs` with nobody asking — the backstop for a modal raised with no open behind it.
   * ⚠️ Never applied to `'pending'`: a fixed delay on a live fetch only moves the flash later.
   */
  pricesAnswered(waitMs: number): boolean {
    return this.fetch === 'answered' || (this.fetch === 'idle' && this.idleWaitMs >= Math.max(0, waitMs));
  }

  /** Advance the idle backstop. Call only while the store screen is actually on screen. Ticking in
   *  any other fetch state is harmless: `pricesAnswered` reads the clock only while idle, and every
   *  fetch start zeroes it. */
  tickIdle(dtMs: number): void {
    this.idleWaitMs += Math.max(0, dtMs);
  }

  /**
   * Open the shelf: prices dropped and re-asked, `loading`, and any refusal from an earlier visit
   * forgotten. A purchase still in flight keeps its voice — see `purchaseEpoch`. Prices are never carried across an open — they are localized and the
   * store's to change.
   */
  open(where: Where): void {
    const stillCurrent = this.fetchEpoch.begin();
    this.clearWatchdog();
    this._state = { kind: 'loading' };
    this._refusal = null;
    this.startFetch(stillCurrent, where);
  }

  /**
   * Re-ask the store for prices without opening the shelf (a shortfall card's quick buy). Returns
   * false, doing nothing, while the screen is `buying`: a refetch drops every price, and the rows
   * behind a live buy overlay must not vanish under it. A purchase released from the screen but still
   * in flight is NOT a reason to refuse — the refetch no longer touches its settle.
   */
  refreshPrices(where: Where): boolean {
    if (this._state.kind === 'buying') return false;
    this.startFetch(this.fetchEpoch.begin(), where);
    return true;
  }

  /**
   * Try to start buying a row. The row is the one the player SAW (`show`/`title` from the view), so
   * "is this buyable" is never derived a second time.
   *
   * Refusals, in order: something is already buying; the row is not on the shelf; its product id is
   * blank; this product is still in the store's hands. Each is latched in `refusal` for the notice.
   * An accepted buy clears the refusal — here, after every refusing arm, so a repeated refused tap
   * does not flicker the line.
   */
  begin(row: { readonly show: boolean; readonly title: string }, productId: string | null): ShelfBegin {
    if (this._state.kind === 'buying') return this.refuse('mid-purchase');
    if (!row.show) return this.refuse('not-on-shelf');
    if (productId === null) return this.refuse('not-authored');
    if (this.inFlight.has(productId)) return this.refuse('already-in-flight');
    const stillCurrent = this.purchaseEpoch.begin();
    this._refusal = null;
    this._state = { kind: 'buying', title: row.title, productId };
    this.armWatchdog(stillCurrent);
    this.opts.onChange?.();
    return { ok: true, stillCurrent, productId };
  }

  /**
   * Run the purchase `begin` accepted and report how it came back.
   *
   * The in-flight marker is released when the promise settles — a fact about the store, not about
   * whether this screen still cares — unless `reset` has since dropped it. For the current attempt
   * the watchdog is cleared and the refusal forgotten (what it described is over); the SCREEN state
   * is left to the caller, which decides what each outcome shows.
   */
  async settle(stillCurrent: LivenessCheck, productId: string): Promise<ShelfSettle> {
    this.inFlight.add(productId);
    const markerStillOurs = this.inFlightGen.capture();
    let result: PurchaseResult | null = null;
    let threw = false;
    let error: unknown;
    try {
      result = await this.opts.purchase(productId);
    } catch (err) {
      threw = true;
      error = err;
    } finally {
      if (markerStillOurs()) this.inFlight.delete(productId);
    }
    const outcome: PurchaseOutcome = threw ? 'failed' : result?.outcome ?? 'failed';
    const cancelReason = result?.cancelReason;
    const base = cancelReason === undefined ? { outcome, threw } : { outcome, threw, cancelReason };
    const settled = threw ? { ...base, error } : base;
    if (!stillCurrent()) return { current: false, ...settled };
    this.clearWatchdog();
    this._refusal = null;
    return { current: true, ...settled };
  }

  /** Release a `buying` screen back to the shelf (after a settle, or when a grant lands before
   *  `finish()`), and stop the watchdog. Does not move the purchase epoch, so a settle still to come
   *  keeps its voice. Any other screen state is left alone: a late settle arriving after the player
   *  re-opened the shelf must not skip that open's `loading`. */
  showShelf(): void {
    this.clearWatchdog();
    if (this._state.kind !== 'buying') return;
    this._state = { kind: 'shelf' };
    this.opts.onChange?.();
  }

  /**
   * The player taking the escape hatch on a STALLED purchase. Releases the screen only — the product
   * stays in flight and the settle still speaks. Returns the product id it released, or `null` when
   * nothing is stalled (a stale tap must not strip the overlay off a healthy purchase).
   */
  dismissBusy(): string | null {
    const s = this._state;
    if (s.kind !== 'buying' || s.stalled !== true) return null;
    this._state = { kind: 'shelf' };
    this.opts.onChange?.();
    return s.productId;
  }

  /** Teardown: every field back to a fresh screen, and any in-flight marker orphaned. */
  reset(): void {
    this.clearWatchdog();
    this.purchaseEpoch.begin();
    this.fetchEpoch.begin();
    this._prices = new Map();
    this.fetch = 'idle';
    this.idleWaitMs = 0;
    this.inFlight.clear();
    this.inFlightGen.invalidateAll();
    this._refusal = null;
    this._state = { kind: 'shelf' };
  }

  /** Test seam: force a screen state without driving a purchase. */
  setStateForTest(next: ShelfState): void { this._state = next; }
  /** Test seam: arm or disarm an in-flight marker directly. */
  setInFlightForTest(productId: string, inFlight: boolean): void {
    if (inFlight) this.inFlight.add(productId); else this.inFlight.delete(productId);
  }

  private refuse(refusal: ShelfRefusal): ShelfBegin {
    this._refusal = refusal;
    this.opts.onChange?.();
    return { ok: false, refusal };
  }

  /** The three fetch fields always move together — prices dropped, `pending`, the idle clock zeroed.
   *  A writer that cleared prices but left `'answered'` flashed "not available" (Court #463). */
  private startFetch(stillCurrent: LivenessCheck, where: Where): void {
    this._prices = new Map();
    this.fetch = 'pending';
    this.idleWaitMs = 0;
    this.opts.onChange?.();
    void this.fetchPrices(stillCurrent, where);
  }

  private async fetchPrices(stillCurrent: LivenessCheck, where: Where): Promise<void> {
    let priced = new Map<string, string>();
    let failed = false;
    try {
      for (const info of await this.opts.productInfo()) {
        const price = (info.displayPrice ?? '').trim();
        if (price !== '') priced.set(info.id, price);
      }
    } catch (err) {
      failed = true;
      priced = new Map();
      this.opts.onPricesFailed?.(err, where);
    }
    // Only the current attempt may answer; a superseded fetch must not close a newer open's question.
    if (!stillCurrent()) return;
    this.fetch = 'answered';
    this._prices = priced;
    // Only the state this fetch owns: an answer never knocks a buy overlay off the screen. A buy
    // needs a priced row, and a refetch refuses under `buying`, so in practice the fetch has already
    // answered — this states which state the answer owns rather than relying on that.
    if (this._state.kind === 'loading') this._state = { kind: 'shelf' };
    this.opts.onPricesAnswered?.({ where, priced: priced.size, failed });
    this.opts.onChange?.();
  }

  private armWatchdog(stillCurrent: LivenessCheck): void {
    this.clearWatchdog();
    this.watchdog = this.timers.set(() => {
      this.watchdog = null;
      const s = this._state;
      if (!stillCurrent() || s.kind !== 'buying') return;
      // ⚠️ Marks it stalled — does NOT drop to the shelf and does NOT move the epoch. Dropping tore
      // the "Buying…" overlay off a purchase still running; moving the epoch muted a settle that came
      // back afterwards, so a cancel after a long password entry said nothing (Court #580).
      this._state = { ...s, stalled: true };
      this.opts.onStalled?.({ title: s.title, productId: s.productId });
      this.opts.onChange?.();
    }, this.opts.watchdogMs ?? SHELF_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      this.timers.clear(this.watchdog);
      this.watchdog = null;
    }
  }
}
