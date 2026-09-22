/**
 * What happens between "the pacing allows an interstitial" (`./adPacing.ts`) and the ad itself (#1329,
 * #1330). Pure: no ECS, no PlayerPrefs, no SDK, no clock. Each game owns the dialogs, the purchase, the
 * stamps and the timers, and asks this module what to do next.
 *
 * **The No Ads offer comes before EVERY ad** (owner, 2026-09-22, reversing the once-an-hour cap this
 * module shipped with in #1329). It auto-dismisses into the ad after `countdownSec`, which is the same
 * outcome as No thanks — the player is never held, and the card can earn where a bare countdown only
 * announced. The cap is still HERE, as `offerCooldownSec`; the games author it as 0, so it is a knob the
 * owner can take back rather than a rule that was deleted.
 *
 * The offer needs something to sell, so two triggers still reach a different step when it cannot show:
 * - **`level_end`**: the ad plays straight away.
 * - **`mid_level`**: the player has been on ONE level for a while (`midLevelBreakDue`), so a short
 *   "Ad break" countdown runs first — a mid-play ad must never cut in unannounced (#1330, kept
 *   deliberately by the owner on 2026-09-22 when the rest of the countdown path was retired).
 *
 * Owner rulings (2026-09-17): a purchase from the offer skips the ad; a cancelled or failed one is No
 * thanks, so the ad still plays. The offer shows both No Ads products. Every number is the game's config.
 *
 * ⚠️ **`nowMs` is passed IN** — the offer cooldown is wall-clock (an hour of the player's life, surviving
 * a relaunch), the same reason `adPacing.ts` gives. The two card clocks and the play timer are NOT
 * wall-clock: they advance by the frame delta the caller passes, so a backgrounded app does not run
 * them down.
 */

export type AdBreakTrigger = 'level_end' | 'mid_level';

export interface NoAdsOfferPolicy {
  /** Minimum wall-clock seconds between two offers. */
  offerCooldownSec: number;
}

export interface NoAdsOfferContext {
  /** Wall-clock ms of the last offer actually SHOWN on this device; 0 = never. */
  lastOfferMs: number;
  nowMs: number;
  /** Is there something to sell right now — a priced No Ads product the player does not own? */
  offerable: boolean;
}

export type NoAdsOfferWithheld = 'not-offerable' | 'cooldown';

export type NoAdsOfferVerdict = { offer: true } | { offer: false; why: NoAdsOfferWithheld };

/**
 * May the No Ads offer show before this ad? A reason, not a boolean, for the journal.
 *
 * ⚠️ `not-offerable` comes first and must NOT stamp: an offer skipped because prices had not loaded yet
 * would otherwise lock the offer out for an hour without the player ever seeing it.
 * A backwards clock fails OPEN (one extra offer), the same direction `mayShowInterstitial` takes.
 *
 * ⚠️ **`offerCooldownSec: 0` means EVERY time, not never** — the comparison is `<`, so a zero cooldown is
 * satisfied by any elapsed time including none. This is the value both games ship (owner, 2026-09-22), so
 * it is the live path rather than a degenerate one, and `adBreak.test.ts` pins it.
 */
export function mayOfferNoAds(ctx: NoAdsOfferContext, policy: NoAdsOfferPolicy): NoAdsOfferVerdict {
  if (!ctx.offerable) return { offer: false, why: 'not-offerable' };
  if (ctx.lastOfferMs === 0) return { offer: true };
  const elapsedSec = (ctx.nowMs - ctx.lastOfferMs) / 1000;
  if (elapsedSec < 0) return { offer: true };
  if (elapsedSec < policy.offerCooldownSec) return { offer: false, why: 'cooldown' };
  return { offer: true };
}

/** The first thing the player sees once an ad is allowed. */
export type AdBreakStep = 'offer' | 'countdown' | 'show';

/**
 * `adReady` is whether an interstitial is LOADED. Without one, neither card shows: an offer "before an
 * ad" that never comes, or a countdown to nothing, is worse than the invisible unfilled show (#1330
 * review — no fill is the common case on a new ad account, and always the case on the web). The caller
 * still attempts the show, which reports unfilled.
 */
export function planAdBreak(trigger: AdBreakTrigger, offer: NoAdsOfferVerdict, adReady: boolean): AdBreakStep {
  if (!adReady) return 'show';
  if (offer.offer) return 'offer';
  return trigger === 'mid_level' ? 'countdown' : 'show';
}

export interface MidLevelBreakPolicy {
  /** Play seconds on one level before a break is due. 0 or less turns mid-level breaks off. */
  afterSec: number;
  /** Seconds without a touch the player must have been idle for before the break may start. */
  idleSec: number;
}

export interface MidLevelBreakContext {
  /** Foreground play seconds on this level since it started or since the last break decision. */
  playSec: number;
  /** Seconds since the last touch. */
  idleSec: number;
  /** A finger is down, or a move is still animating. */
  moveInProgress: boolean;
  /** A dialog, the store or a menu owns the screen. */
  overlayOpen: boolean;
}

/**
 * Is a mid-level break due NOW? True only at a pause: never mid-drag, never over another dialog, and only
 * after the player has stopped touching the board for a moment (owner, 2026-09-17: "wait for a pause").
 */
export function midLevelBreakDue(ctx: MidLevelBreakContext, policy: MidLevelBreakPolicy): boolean {
  if (!(policy.afterSec > 0)) return false;
  if (ctx.playSec < policy.afterSec) return false;
  if (ctx.moveInProgress || ctx.overlayOpen) return false;
  return ctx.idleSec >= policy.idleSec;
}

/**
 * The flow's state. `idle` is "no break in progress"; the ad itself is an EFFECT, not a state.
 *
 * ⚠️ **`offer.remainingSec` is `null` for "no auto-dismiss"**, not 0 — a ticking card reaches 0 on its
 * way to the ad, so 0 cannot also mean "never leaves". `buying` deliberately carries NO clock: that is
 * what makes a Buy cancel the auto-dismiss rather than race it (`tick` has nothing to advance), so the
 * race cannot be reintroduced by a later edit without first inventing a field to hold it.
 */
export type AdBreakState =
  | { kind: 'idle' }
  | { kind: 'offer'; trigger: AdBreakTrigger; remainingSec: number | null }
  | { kind: 'buying'; trigger: AdBreakTrigger }
  | { kind: 'countdown'; remainingSec: number };

export type AdBreakEvent =
  /**
   * An ad is allowed; `step` is `planAdBreak`'s answer. `countdownSec` is how long the card that step
   * raises sits before the ad starts by itself — the countdown's length, or the offer's auto-dismiss.
   * ⚠️ Its `<= 0` case reads OPPOSITELY on the two steps, by design: no countdown card at all, versus an
   * offer card that waits for a tap. Both are tested.
   */
  | { type: 'start'; trigger: AdBreakTrigger; step: AdBreakStep; countdownSec: number }
  /** No thanks on the offer. */
  | { type: 'decline' }
  /** Buy on the offer — the purchase has been STARTED. */
  | { type: 'buy' }
  /** The purchase started from the offer settled. */
  | { type: 'purchase-settled'; bought: boolean }
  /** A frame passed, in seconds. The countdown and the auto-dismissing offer use it. */
  | { type: 'tick'; dt: number }
  /** The break is abandoned without an ad (a level swap, a teardown). */
  | { type: 'cancel' };

/**
 * What the caller must DO as a result of a transition:
 * - `offer-shown`: the offer card is now visible — stamp the offer cooldown;
 * - `show-ad`: play the interstitial now;
 * - `none`.
 */
export type AdBreakEffect = 'none' | 'offer-shown' | 'show-ad';

export interface AdBreakTransition {
  state: AdBreakState;
  effect: AdBreakEffect;
}

const IDLE: AdBreakState = { kind: 'idle' };

/**
 * The flow as a reducer. An event that does not apply to the current state is ignored (state unchanged,
 * no effect) — a double tap on No thanks, or a stale purchase settling after a cancel, must not play a
 * second ad.
 */
export function stepAdBreak(state: AdBreakState, event: AdBreakEvent): AdBreakTransition {
  const stay = { state, effect: 'none' as const };
  switch (event.type) {
    case 'start':
      if (state.kind !== 'idle') return stay;
      if (event.step === 'offer') {
        // ⚠️ `<= 0` is "no auto-dismiss", NOT "no card" — the opposite of the countdown's reading below.
        // A card that offers a purchase and vanishes in the same frame would be a flicker, and the
        // player would have been shown nothing; one that waits for a tap is #1329's behaviour intact.
        const remainingSec = event.countdownSec > 0 ? event.countdownSec : null;
        return { state: { kind: 'offer', trigger: event.trigger, remainingSec }, effect: 'offer-shown' };
      }
      // A countdown of 0 or less is "no countdown": straight to the ad, rather than a card that flashes.
      if (event.step === 'countdown' && event.countdownSec > 0) {
        return { state: { kind: 'countdown', remainingSec: event.countdownSec }, effect: 'none' };
      }
      return { state: IDLE, effect: 'show-ad' };
    case 'decline':
      return state.kind === 'offer' ? { state: IDLE, effect: 'show-ad' } : stay;
    case 'buy':
      return state.kind === 'offer' ? { state: { kind: 'buying', trigger: state.trigger }, effect: 'none' } : stay;
    case 'purchase-settled':
      if (state.kind !== 'buying') return stay;
      // Owner, 2026-09-17: a cancelled or failed purchase is No thanks — the ad still plays.
      return { state: IDLE, effect: event.bought ? 'none' : 'show-ad' };
    case 'tick': {
      // The offer expires to the SAME transition `decline` makes: waiting the card out and tapping No
      // thanks are one outcome, not two, so nothing downstream has to tell them apart.
      if (state.kind === 'offer') {
        if (state.remainingSec === null) return stay;
        const remainingSec = state.remainingSec - Math.max(0, event.dt);
        if (remainingSec <= 0) return { state: IDLE, effect: 'show-ad' };
        return { state: { ...state, remainingSec }, effect: 'none' };
      }
      if (state.kind !== 'countdown') return stay;
      const remainingSec = state.remainingSec - Math.max(0, event.dt);
      if (remainingSec <= 0) return { state: IDLE, effect: 'show-ad' };
      return { state: { kind: 'countdown', remainingSec }, effect: 'none' };
    }
    case 'cancel':
      return state.kind === 'idle' ? stay : { state: IDLE, effect: 'none' };
  }
}

/**
 * The whole number a pre-ad card shows: 3, 2, 1 — never 0, which would read as "now" and linger. Both
 * cards use it: the Ad break countdown, and the offer's own line (owner, 2026-09-22 — the offer tells the
 * player what happens if they do nothing, rather than vanishing unannounced).
 */
export function adBreakCountdownLabel(remainingSec: number): number {
  return Math.max(1, Math.ceil(remainingSec));
}
