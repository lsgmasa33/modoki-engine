/**
 * When a game may show an interstitial. Pure: no ECS, no PlayerPrefs, no SDK. The caller owns the side
 * effects, and this answers the question.
 *
 * The ad-pacing half of Court's `runtime/adPolicy.ts`. Weaveling copied it for #932, and #1312 promoted it
 * once both games paced interstitials the same way (#661's promotion condition). Court's other half, the
 * coin economy, stays in Court: its field set is Court's own.
 *
 * The owner's rules (Court 2026-08-26, Weaveling 2026-09-17): only between levels after a solve, never in
 * a tutorial lesson, not before N solves, at least M seconds apart, and never for a player who removed
 * ads. The NUMBERS are each game's config resource; nothing here has a default.
 *
 * ⚠️ **`nowMs` is passed IN, never read here.** The floor is genuinely wall-clock (four minutes of the
 * player's life, surviving a relaunch), and a module that read the clock could not be tested.
 *
 * ⚠️ **A backwards clock fails OPEN**: one extra ad, against every ad locked out until the skew ends.
 * The login bonus (`./loginBonus.ts`) fails CLOSED on purpose; do not "make the two consistent".
 */

export interface InterstitialPolicy {
  /** Levels the player must have SOLVED before any interstitial. */
  unlockSolves: number;
  /** Floor between two interstitials, in seconds. */
  minIntervalSec: number;
}

export interface InterstitialContext {
  /** Distinct levels solved, tutorial lessons excluded. */
  solvedCount: number;
  /** Wall-clock ms of the last interstitial SHOWN on this device; 0 = never. */
  lastShownMs: number;
  nowMs: number;
  /** Is the level being left a tutorial lesson? */
  inTutorial: boolean;
  /** Has the player removed ads (a purchase, a pass, or bonus minutes)? */
  adsRemoved: boolean;
}

export type InterstitialWithheld = 'ads-removed' | 'tutorial' | 'below-unlock' | 'too-soon';

/** A reason, not a boolean: "no ad" has several causes, and the journal must say which. */
export type InterstitialVerdict = { show: true } | { show: false; why: InterstitialWithheld };

export function mayShowInterstitial(ctx: InterstitialContext, policy: InterstitialPolicy): InterstitialVerdict {
  if (ctx.adsRemoved) return { show: false, why: 'ads-removed' };
  // Before the pacing checks, so a lesson never reports "too-soon" and sends someone hunting a cooldown
  // bug. A lesson is reachable from a menu at any solve count, so this is not redundant with the unlock.
  if (ctx.inTutorial) return { show: false, why: 'tutorial' };
  if (ctx.solvedCount < policy.unlockSolves) return { show: false, why: 'below-unlock' };
  // 0 is "never shown" and must PASS. Stated explicitly so a fake clock starting at 0 cannot break it.
  if (ctx.lastShownMs === 0) return { show: true };
  const elapsedSec = (ctx.nowMs - ctx.lastShownMs) / 1000;
  if (elapsedSec < 0) return { show: true };
  if (elapsedSec < policy.minIntervalSec) return { show: false, why: 'too-soon' };
  return { show: true };
}
