/**
 * Interstitial pacing (#932, promoted in #1312). Each game passes its own numbers; the game-side tests
 * cover what a game adds on top (Weaveling's daily board) and how it maps its config onto the policy.
 */
import { describe, it, expect } from 'vitest';
import { mayShowInterstitial, type InterstitialContext } from '../../../src/runtime/core/adPacing';

const POLICY = { unlockSolves: 20, minIntervalSec: 240 };
const T = 1_700_000_000_000;
/** Passes every gate, so each case can break exactly one thing. */
const base: InterstitialContext = { solvedCount: 20, lastShownMs: 0, nowMs: T, inTutorial: false, adsRemoved: false };

describe('mayShowInterstitial', () => {
  it('allows a player past the unlock who has never seen one', () => {
    expect(mayShowInterstitial(base, POLICY)).toEqual({ show: true });
  });

  it.each([
    ['ads-removed', { adsRemoved: true }],
    ['tutorial', { inTutorial: true }],
    ['below-unlock', { solvedCount: 19 }],
    ['too-soon', { lastShownMs: T - 239_999 }],
  ] as const)('withholds with the reason %s', (why, over) => {
    expect(mayShowInterstitial({ ...base, ...over }, POLICY)).toEqual({ show: false, why });
  });

  it('reports ads-removed before any other reason', () => {
    expect(mayShowInterstitial({ ...base, adsRemoved: true, inTutorial: true, solvedCount: 0, lastShownMs: T - 1 }, POLICY))
      .toEqual({ show: false, why: 'ads-removed' });
  });

  it('reports the tutorial before a cooldown or the unlock', () => {
    expect(mayShowInterstitial({ ...base, inTutorial: true, solvedCount: 0, lastShownMs: T - 1 }, POLICY))
      .toEqual({ show: false, why: 'tutorial' });
  });

  it('allows once the full interval has passed', () => {
    expect(mayShowInterstitial({ ...base, lastShownMs: T - 240_000 }, POLICY)).toEqual({ show: true });
  });

  it('fails OPEN on a clock that went backwards', () => {
    expect(mayShowInterstitial({ ...base, lastShownMs: T + 60_000 }, POLICY)).toEqual({ show: true });
  });

  it('treats a stamp of 0 as never shown, even with a clock starting at 0', () => {
    expect(mayShowInterstitial({ ...base, nowMs: 0, lastShownMs: 0 }, POLICY)).toEqual({ show: true });
  });

  it('honours the numbers it is given', () => {
    expect(mayShowInterstitial({ ...base, solvedCount: 3 }, { unlockSolves: 3, minIntervalSec: 1 })).toEqual({ show: true });
    expect(mayShowInterstitial({ ...base, lastShownMs: T - 2000 }, { unlockSolves: 0, minIntervalSec: 1 })).toEqual({ show: true });
  });
});
