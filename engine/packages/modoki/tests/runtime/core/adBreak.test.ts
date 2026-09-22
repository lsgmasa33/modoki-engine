/**
 * The break before an ad (#1329/#1330). Pure rules only; each game's tests cover its cards, stamps
 * and timers through its real systems.
 */
import { describe, it, expect } from 'vitest';
import {
  adBreakCountdownLabel, mayOfferNoAds, midLevelBreakDue, planAdBreak, stepAdBreak,
  type AdBreakState, type MidLevelBreakContext, type NoAdsOfferContext,
} from '../../../src/runtime/core/adBreak';

const T = 1_700_000_000_000;
const OFFER = { offerCooldownSec: 3600 };
/** What both games actually ship since #1465: no cap, the offer before every ad. */
const NO_CAP = { offerCooldownSec: 0 };
/** Passes every check, so each case can break exactly one thing. */
const offerBase: NoAdsOfferContext = { lastOfferMs: 0, nowMs: T, offerable: true };

describe('mayOfferNoAds', () => {
  it('offers to a player who has never seen it', () => {
    expect(mayOfferNoAds(offerBase, OFFER)).toEqual({ offer: true });
  });

  it('withholds within the cooldown, and offers again once it has passed', () => {
    expect(mayOfferNoAds({ ...offerBase, lastOfferMs: T - 3_599_999 }, OFFER)).toEqual({ offer: false, why: 'cooldown' });
    expect(mayOfferNoAds({ ...offerBase, lastOfferMs: T - 3_600_000 }, OFFER)).toEqual({ offer: true });
  });

  it('withholds when there is nothing to sell, before the cooldown is even consulted', () => {
    expect(mayOfferNoAds({ ...offerBase, offerable: false }, OFFER)).toEqual({ offer: false, why: 'not-offerable' });
    expect(mayOfferNoAds({ ...offerBase, offerable: false, lastOfferMs: T - 1 }, OFFER))
      .toEqual({ offer: false, why: 'not-offerable' });
  });

  it('a clock that moved backwards fails OPEN, like the interstitial floor', () => {
    expect(mayOfferNoAds({ ...offerBase, lastOfferMs: T + 60_000 }, OFFER)).toEqual({ offer: true });
  });

  // #1465 — the shipped value. A cooldown of 0 is the one reading that could plausibly have gone the
  // other way ("no offers at all"), and both games now depend on it going this way.
  it('a cooldown of 0 offers EVERY time, including one millisecond after the last offer', () => {
    expect(mayOfferNoAds({ ...offerBase, lastOfferMs: T - 1 }, NO_CAP)).toEqual({ offer: true });
    expect(mayOfferNoAds({ ...offerBase, lastOfferMs: T }, NO_CAP)).toEqual({ offer: true });
  });

  it('a cooldown of 0 still withholds when there is nothing to sell', () => {
    expect(mayOfferNoAds({ ...offerBase, offerable: false }, NO_CAP)).toEqual({ offer: false, why: 'not-offerable' });
  });
});

describe('planAdBreak', () => {
  it('the offer comes first on either trigger', () => {
    expect(planAdBreak('level_end', { offer: true }, true)).toBe('offer');
    expect(planAdBreak('mid_level', { offer: true }, true)).toBe('offer');
  });

  it('without the offer, a mid-level ad counts down and a level-end ad plays at once', () => {
    expect(planAdBreak('mid_level', { offer: false, why: 'cooldown' }, true)).toBe('countdown');
    expect(planAdBreak('level_end', { offer: false, why: 'cooldown' }, true)).toBe('show');
  });

  it('with no ad loaded, neither card shows — not the offer, not the countdown', () => {
    expect(planAdBreak('level_end', { offer: true }, false)).toBe('show');
    expect(planAdBreak('mid_level', { offer: true }, false)).toBe('show');
    expect(planAdBreak('mid_level', { offer: false, why: 'cooldown' }, false)).toBe('show');
  });
});

describe('midLevelBreakDue', () => {
  const policy = { afterSec: 600, idleSec: 2 };
  const due: MidLevelBreakContext = { playSec: 600, idleSec: 2, moveInProgress: false, overlayOpen: false };

  it('is due at a pause once the play time is reached', () => {
    expect(midLevelBreakDue(due, policy)).toBe(true);
  });

  it.each([
    ['before the play time', { playSec: 599.9 }],
    ['before the idle period', { idleSec: 1.9 }],
    ['mid-move', { moveInProgress: true }],
    ['under an overlay', { overlayOpen: true }],
  ] as const)('is not due %s', (_why, over) => {
    expect(midLevelBreakDue({ ...due, ...over }, policy)).toBe(false);
  });

  it('0 (or less) turns breaks off, however long the play', () => {
    expect(midLevelBreakDue({ ...due, playSec: 1e9 }, { ...policy, afterSec: 0 })).toBe(false);
    expect(midLevelBreakDue({ ...due, playSec: 1e9 }, { ...policy, afterSec: -1 })).toBe(false);
  });
});

describe('stepAdBreak', () => {
  const idle: AdBreakState = { kind: 'idle' };
  const offer: AdBreakState = { kind: 'offer', trigger: 'mid_level', remainingSec: 3 };
  /** An offer that waits for a tap instead of leaving by itself (`countdownSec <= 0`). */
  const offerHeld: AdBreakState = { kind: 'offer', trigger: 'mid_level', remainingSec: null };

  it('start: offer shows the card and asks for the stamp; show plays at once; countdown waits', () => {
    expect(stepAdBreak(idle, { type: 'start', trigger: 'level_end', step: 'offer', countdownSec: 3 }))
      .toEqual({ state: { kind: 'offer', trigger: 'level_end', remainingSec: 3 }, effect: 'offer-shown' });
    expect(stepAdBreak(idle, { type: 'start', trigger: 'level_end', step: 'show', countdownSec: 3 }))
      .toEqual({ state: idle, effect: 'show-ad' });
    expect(stepAdBreak(idle, { type: 'start', trigger: 'mid_level', step: 'countdown', countdownSec: 3 }))
      .toEqual({ state: { kind: 'countdown', remainingSec: 3 }, effect: 'none' });
  });

  it('a countdown of 0 plays the ad with no card', () => {
    expect(stepAdBreak(idle, { type: 'start', trigger: 'mid_level', step: 'countdown', countdownSec: 0 }))
      .toEqual({ state: idle, effect: 'show-ad' });
  });

  // #1465 — the SAME number, read the opposite way on the offer: the card is the thing being offered,
  // so 0 cannot mean "skip it". It means the card waits for a tap, which is #1329's behaviour.
  it('an auto-dismiss of 0 still SHOWS the offer — it just never leaves by itself', () => {
    expect(stepAdBreak(idle, { type: 'start', trigger: 'level_end', step: 'offer', countdownSec: 0 }))
      .toEqual({ state: { kind: 'offer', trigger: 'level_end', remainingSec: null }, effect: 'offer-shown' });
    expect(stepAdBreak(idle, { type: 'start', trigger: 'level_end', step: 'offer', countdownSec: -1 }))
      .toEqual({ state: { kind: 'offer', trigger: 'level_end', remainingSec: null }, effect: 'offer-shown' });
  });

  it('a start while a break is running is ignored', () => {
    expect(stepAdBreak(offer, { type: 'start', trigger: 'level_end', step: 'show', countdownSec: 3 }))
      .toEqual({ state: offer, effect: 'none' });
  });

  it('No thanks plays the ad — straight away, never through a countdown', () => {
    expect(stepAdBreak(offer, { type: 'decline' })).toEqual({ state: idle, effect: 'show-ad' });
  });

  it('a purchase that lands skips the ad; one that does not plays it', () => {
    const buying = stepAdBreak(offer, { type: 'buy' });
    expect(buying).toEqual({ state: { kind: 'buying', trigger: 'mid_level' }, effect: 'none' });
    expect(stepAdBreak(buying.state, { type: 'purchase-settled', bought: true })).toEqual({ state: idle, effect: 'none' });
    expect(stepAdBreak(buying.state, { type: 'purchase-settled', bought: false })).toEqual({ state: idle, effect: 'show-ad' });
  });

  // #1465 — the offer auto-dismisses into the ad, and lands on the SAME transition `decline` makes.
  it('the offer runs down on ticks and plays the ad when it reaches 0, exactly as No thanks does', () => {
    let s: AdBreakState = offer;
    let t = stepAdBreak(s, { type: 'tick', dt: 2 });
    expect(t.effect).toBe('none');
    s = t.state;
    expect(s).toEqual({ kind: 'offer', trigger: 'mid_level', remainingSec: 1 });
    t = stepAdBreak(s, { type: 'tick', dt: 1 });
    expect(t).toEqual(stepAdBreak(offer, { type: 'decline' }));
    expect(t).toEqual({ state: idle, effect: 'show-ad' });
  });

  it('an offer with no auto-dismiss sits through any tick', () => {
    expect(stepAdBreak(offerHeld, { type: 'tick', dt: 1e6 })).toEqual({ state: offerHeld, effect: 'none' });
  });

  it('a negative tick does not wind the offer back', () => {
    expect(stepAdBreak(offer, { type: 'tick', dt: -5 }).state)
      .toEqual({ kind: 'offer', trigger: 'mid_level', remainingSec: 3 });
  });

  // #1465's own requirement: a tap on Buy must CANCEL the auto-dismiss, not race it. `buying` carries no
  // clock, so the tick has nothing to advance — the guarantee is the state shape, not a flag.
  it('a Buy stops the clock: the ad does not start under a purchase in flight', () => {
    const buying = stepAdBreak(offer, { type: 'buy' }).state;
    expect(stepAdBreak(buying, { type: 'tick', dt: 1e6 })).toEqual({ state: buying, effect: 'none' });
  });

  it('the countdown runs down on ticks and plays the ad when it reaches 0', () => {
    let s: AdBreakState = { kind: 'countdown', remainingSec: 1 };
    let t = stepAdBreak(s, { type: 'tick', dt: 0.6 });
    expect(t.effect).toBe('none');
    s = t.state;
    expect(s).toEqual({ kind: 'countdown', remainingSec: 0.4 });
    t = stepAdBreak(s, { type: 'tick', dt: 0.4 });
    expect(t).toEqual({ state: idle, effect: 'show-ad' });
  });

  it('a negative tick does not wind the countdown back', () => {
    expect(stepAdBreak({ kind: 'countdown', remainingSec: 1 }, { type: 'tick', dt: -5 }).state)
      .toEqual({ kind: 'countdown', remainingSec: 1 });
  });

  it('cancel ends any break with no ad', () => {
    expect(stepAdBreak(offer, { type: 'cancel' })).toEqual({ state: idle, effect: 'none' });
    expect(stepAdBreak({ kind: 'countdown', remainingSec: 2 }, { type: 'cancel' })).toEqual({ state: idle, effect: 'none' });
  });

  it.each([
    ['a decline with no offer up', idle, { type: 'decline' }],
    ['a buy during a countdown', { kind: 'countdown', remainingSec: 2 }, { type: 'buy' }],
    ['a stale purchase answer on the offer', offer, { type: 'purchase-settled', bought: false }],
  ] as const)('ignores %s — no second ad', (_why, state, event) => {
    expect(stepAdBreak(state as AdBreakState, event)).toEqual({ state, effect: 'none' });
  });
});

describe('adBreakCountdownLabel', () => {
  it('counts whole seconds up, and never shows 0', () => {
    expect(adBreakCountdownLabel(3)).toBe(3);
    expect(adBreakCountdownLabel(2.01)).toBe(3);
    expect(adBreakCountdownLabel(2)).toBe(2);
    expect(adBreakCountdownLabel(0.001)).toBe(1);
    expect(adBreakCountdownLabel(0)).toBe(1);
  });
});
