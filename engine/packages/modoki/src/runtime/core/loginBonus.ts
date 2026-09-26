/**
 * The once-a-day login bonus wheel's DECISIONS — which slice a spin lands on, what it pays, and
 * whether a spin is owed at all. Pure TS; its one import is `dateKeyOf`.
 *
 * Promoted out of `games/court/runtime/loginBonus.ts` (#372) when wordweave became the second game
 * with the same wheel (#926). The availability gate is the part that must not fork: it has already
 * been an unbounded coin faucet twice in Court — a wound-back device clock, then a time-zone
 * switch — and a second copy is a second place for the next fix to miss
 * (docs/cross-game-infrastructure.md).
 *
 * ⚠️ **What stays in the GAME:** the numbers (weights, payouts, the substitute — a game's economy, so
 * a game's `*_DEFAULTS` and its authored config), the art-bound constants (wedge count, label
 * radius), every player-visible word, and every side effect: the clock read, the RNG roll, the
 * durable write of the grant and the claim stamp, and whatever syncs.
 *
 * ⚠️ **NAMING — this is NOT the Daily Challenge.** `dailyCalendar.ts` next door is a per-day PUZZLE;
 * this is a retention faucet that pays currency. The word "daily" is deliberately absent from every
 * symbol here so the two cannot be confused at a call site — the ONE thing borrowed is `dateKeyOf`,
 * and borrowing it is the point: "once a day" must mean the same instant for both, or a player sees
 * one reset and not the other.
 *
 * ── Takes no clock and no RNG ──────────────────────────────────────────────────────────────────
 * `nowMs` and `roll` are parameters. The bonus is genuinely wall-clock (a day of the player's life,
 * surviving backgrounding and relaunch) and genuinely random, but a module that reads either itself
 * cannot be tested, and untestable weights are weights nobody checks before they ship.
 */

import { dateKeyOf, type DateKey } from './dailyCalendar';

/** Which slice of the wheel a spin landed on: up to four coin tiers plus the ad-free slice.
 *  ⚠️ Four is a CAP, not a count — `loginBonusSegments` ignores a fifth authored tier rather than
 *  minting an id nobody's art or save format knows. */
export type LoginBonusSegmentId =
  | 'coins-1' | 'coins-2' | 'coins-3' | 'coins-4' | 'no-ads';

/** One slice, after a game's flat config fields have been composed into a wheel. */
export interface LoginBonusSegment {
  id: LoginBonusSegmentId;
  /** RELATIVE weight, not a percentage — the draw normalizes by the sum, so retuning one slice does
   *  not force a rebalance of the others. */
  weight: number;
  /** Coins this slice pays. 0 on `no-ads` — its substitution is decided by `resolveLoginBonusPayout` —
   *  except under `noAdsPaysCoins`, where `no-ads` IS a coin slice. */
  coins: number;
  /** Minutes of ad-free play this slice pays. 0 on every coin slice. */
  noAdsMinutes: number;
}

/**
 * The live policy. Plain fields, NOT `typeof SOME_DEFAULTS` — deriving the type from an `as const`
 * default narrows every field to the literal it happens to default to, and an authored value from
 * the Inspector then fails to assign.
 */
export interface LoginBonusPolicy {
  /** Master switch. Off = no spin is ever owed (the game hides its entry point). */
  enabled: boolean;
  /** The coin slices, in ladder order. At most four are read. */
  tiers: readonly { coins: number; weight: number }[];
  /** Minutes of ad-free play the `no-ads` slice pays. */
  noAdsMinutes: number;
  /** Relative weight of the `no-ads` slice. */
  noAdsWeight: number;
  /**
   * Coins paid INSTEAD of ad-free minutes when the minutes cannot be granted (see
   * `resolveLoginBonusPayout`). Without a substitution the slice lands on nothing for exactly the
   * players who already paid, and the feature reads as broken.
   */
  noAdsSubstituteCoins: number;
  /**
   * `true` on a build that shows no ads at all (a game's published web build, #1585). The `no-ads`
   * slot then becomes a COIN slice paying `noAdsSubstituteCoins` — at the same weight, under the
   * same id — rather than a prize that does nothing where it is won.
   *
   * ⚠️ Decided HERE, when the wheel is composed, not in `resolveLoginBonusPayout`. A payout-time
   * swap pays coins under a wedge that still shows the ad-free label and icon, because every game
   * draws the wedge from the segment; composing a coin slice makes the label, the icon, the result
   * line, the reveal card and a game's welcome-back lookup (`noAdsMinutes > 0`) all agree without a
   * second check in each. Not an authored knob — a game derives it from its platform.
   */
  noAdsPaysCoins?: boolean;
}

/** The ids of the coin tiers, in ladder order — index `i` of `LoginBonusPolicy.tiers`. */
const TIER_IDS: readonly LoginBonusSegmentId[] = ['coins-1', 'coins-2', 'coins-3', 'coins-4'];

/**
 * Compose the authored policy into the wheel a spin is actually drawn from.
 *
 * ⚠️ **A slice with a non-positive or non-finite weight is DROPPED, not clamped to zero.** Both end
 * up unreachable in the draw, but dropping it means the wheel the player SEES has the same slices the
 * draw can return — a rendered slice that can never be landed on is the near-miss dark pattern
 * arriving by accident. An owner who zeroes a weight has removed that prize.
 *
 * A slice paying nothing at all (`coins <= 0` on a tier) is dropped for the same reason: it is a
 * blank on the wheel.
 */
export function loginBonusSegments(policy: LoginBonusPolicy): LoginBonusSegment[] {
  const out: LoginBonusSegment[] = [];
  policy.tiers.forEach((tier, i) => {
    if (i >= TIER_IDS.length) return;   // an over-long authored ladder cannot mint unnamed ids
    if (!(tier.weight > 0) || !Number.isFinite(tier.weight)) return;
    if (!(tier.coins > 0) || !Number.isFinite(tier.coins)) return;
    out.push({ id: TIER_IDS[i], weight: tier.weight, coins: Math.floor(tier.coins), noAdsMinutes: 0 });
  });
  const minutes = Math.floor(policy.noAdsMinutes);
  if (policy.noAdsWeight > 0 && Number.isFinite(policy.noAdsWeight) && minutes > 0) {
    if (policy.noAdsPaysCoins) {
      // The coin-slice rule above applies to the substitute too: a slice paying nothing is a blank.
      const coins = Math.floor(policy.noAdsSubstituteCoins);
      if (coins > 0 && Number.isFinite(coins)) out.push({ id: 'no-ads', weight: policy.noAdsWeight, coins, noAdsMinutes: 0 });
    } else {
      out.push({ id: 'no-ads', weight: policy.noAdsWeight, coins: 0, noAdsMinutes: minutes });
    }
  }
  return out;
}

/**
 * Draw a slice. `roll` is a float in `[0, 1)` — the seeded RNG at the game's call site.
 *
 * ⚠️ **No near-miss engineering, ever.** The pointer lands where the draw actually fell; a wheel
 * tuned to stop just past the jackpot is the standard dark pattern. The presentation layer's ONLY
 * job is to animate to the slice this function already chose. (A game's single declared rigged
 * outcome — Court's welcome-back gift — bypasses the draw at the call site, in the open.)
 *
 * Returns `null` when there is no wheel to draw from (every slice dropped by `loginBonusSegments`),
 * rather than a fabricated slice — the caller must treat that as "no bonus", not as a zero payout.
 */
export function drawLoginBonusSegment(
  segments: readonly LoginBonusSegment[], roll: number,
): LoginBonusSegment | null {
  if (segments.length === 0) return null;
  const total = segments.reduce((sum, s) => sum + s.weight, 0);
  if (!(total > 0)) return null;
  // Clamped rather than trusted: a `roll` of exactly 1 (or a NaN from a future caller) would
  // otherwise fall off the end of the loop and silently make the LAST slice the fallback for a
  // broken input.
  const r = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999) : 0;
  let cursor = r * total;
  for (const segment of segments) {
    cursor -= segment.weight;
    if (cursor < 0) return segment;
  }
  // Unreachable while `r < 1` and `total > 0` — floating-point residue only.
  return segments[segments.length - 1];
}

/** Why a `no-ads` win was paid as coins instead. `''` = it was not substituted. */
export type LoginBonusSubstitution = '' | 'forever-owned' | 'no-pass-product';

/** What a claim actually pays, once entitlements and store configuration are taken into account. */
export interface LoginBonusPayout {
  /** Coins to credit. */
  coins: number;
  /** Minutes of ad-free play to add. 0 when nothing was won or the win was substituted. */
  noAdsMinutes: number;
  /** Why coins were paid in place of ad-free minutes, for the journal and the analytics event. */
  substituted: LoginBonusSubstitution;
}

/**
 * What `segment` pays THIS player.
 *
 * Two independent reasons a `no-ads` win becomes coins, and the caller needs to tell them apart
 * because only one of them is about the player:
 *
 * 1. ⚠️ **`forever-owned` keys on the FOREVER entitlement alone, never on "ads are currently off".**
 *    A player inside a timed pass has not bought anything permanent, and more ad-free minutes are a
 *    real prize to them — the game stacks them onto the pass they are running (`extendPassExpiry`).
 * 2. **`no-pass-product` is a CONFIGURATION hole**: a game that records ad-free minutes against a
 *    store product has nowhere to write them while that product id is blank (a supported "not for
 *    sale" state). A game whose pass needs no product id passes `noAdsGrantable: true` always.
 *
 * `forever-owned` WINS when both apply — it is the reason that is true about the player.
 */
export function resolveLoginBonusPayout(
  segment: LoginBonusSegment,
  policy: LoginBonusPolicy,
  ctx: { noAdsForeverOwned: boolean; noAdsGrantable: boolean },
): LoginBonusPayout {
  if (segment.noAdsMinutes > 0) {
    const why: LoginBonusSubstitution =
      ctx.noAdsForeverOwned ? 'forever-owned' : !ctx.noAdsGrantable ? 'no-pass-product' : '';
    if (why !== '') {
      const coins = Math.max(0, Math.floor(policy.noAdsSubstituteCoins));
      return { coins, noAdsMinutes: 0, substituted: why };
    }
  }
  return { coins: Math.max(0, Math.floor(segment.coins)), noAdsMinutes: segment.noAdsMinutes, substituted: '' };
}

/** The device-local record of the last claim, as a game stores it. */
export interface LoginBonusClaim {
  /** The local calendar day claimed, `''` = never claimed. */
  day: DateKey | '';
  /** The clock reading at the moment of the claim; 0 = never. */
  atMs: number;
}

/**
 * Why a spin is not owed. Returned rather than a bare `false` because "no bonus" has four very
 * different causes, and a silent boolean makes the wrong one impossible to diagnose on a device.
 */
export type LoginBonusVerdict =
  | { available: true }
  | { available: false; why: 'disabled' | 'no-wheel' | 'claimed-today' | 'clock-behind' };

/**
 * Is a spin owed right now?
 *
 * ⚠️ **This fails CLOSED on a wound-back clock.** Failing open is an unbounded coin faucet for
 * anyone who sets their device date back — a two-tap exploit players know and share. So a `nowMs`
 * BEHIND the recorded claim instant refuses, and stays refusing until the clock catches up. (Court's
 * interstitial pacing fails OPEN on the same shape, deliberately: two clocks, two threat models.)
 *
 * What this does NOT defend is a clock wound FORWARD — nothing without a server can. A game with a
 * trusted anchor passes it as `nowMs` (Court: `effectiveNow()`), which makes this check a backstop;
 * a game without one accepts forward-winding as the residual cost.
 */
export function loginBonusAvailability(ctx: {
  policy: LoginBonusPolicy;
  claim: LoginBonusClaim;
  nowMs: number;
  /** How many slices the wheel actually has — `loginBonusSegments(policy).length`. */
  segmentCount: number;
}): LoginBonusVerdict {
  if (!ctx.policy.enabled) return { available: false, why: 'disabled' };
  if (ctx.segmentCount === 0) return { available: false, why: 'no-wheel' };
  // Never claimed. Stated explicitly rather than falling out of the day comparison below, so a
  // fake clock starting at 0 in a test cannot make the never-case accidentally correct.
  if (ctx.claim.day === '' || ctx.claim.atMs === 0) return { available: true };
  // The fail-closed check, BEFORE the day comparison. ⚠️ **Still a lock, not just a label.** In one zone
  // an earlier instant is never on a later local day, so there the day key below would refuse it anyway.
  // Across zones it is not: claim at 22:00 UTC on the 13th, move the device to Tokyo and wind the clock
  // back an hour, and the instant is EARLIER than the claim while the local date reads the 14th —
  // strictly later, so the day key alone owes a second spin. This check is what refuses it.
  if (ctx.nowMs < ctx.claim.atMs) return { available: false, why: 'clock-behind' };
  // ⚠️ **STRICTLY LATER, never merely DIFFERENT — this is the half that closes the TIME ZONE hole.**
  // `dateKeyOf` is the LOCAL civil date, so a player who switches time zone changes the day key
  // while `nowMs` keeps increasing: Tokyo → Kiritimati reads as tomorrow, and Kiritimati → Tokyo
  // reads as yesterday. A `!==` comparison calls BOTH "a new day", so toggling the zone back and
  // forth was an unbounded coin faucet on a correctly-clocked device — the check above cannot see
  // it, because the instant never goes backwards, and a trusted anchor does not help either: it
  // protects the INSTANT, not the CALENDAR.
  //
  // Ordering the keys instead bounds it to ONE pulled-forward claim, ever: reaching the furthest
  // zone stamps that date, coming back is not later, and real time must catch up past the stamp
  // before another spin is owed. ISO `YYYY-MM-DD` orders correctly as a plain string, which is the
  // whole reason `dateKeyOf` emits that shape.
  //
  // The accepted cost: a real traveller flying EAST-to-WEST across the date line loses one day's
  // bonus. A far cheaper error than the faucet.
  if (dateKeyOf(ctx.nowMs) <= ctx.claim.day) return { available: false, why: 'claimed-today' };
  return { available: true };
}

/**
 * The claim record a successful spin should store. Split out from the write so the exact bytes that
 * go to disk are testable without storage.
 *
 * `atMs` is the claim INSTANT, not the day's midnight: `loginBonusAvailability`'s fail-closed check
 * compares against it (a lock of its own across a zone change — see there), and it IDENTIFIES the claim,
 * so a game can key per-claim state on it (a reveal latch, a claim whose write is still unconfirmed).
 */
export function loginBonusClaimRecord(nowMs: number): LoginBonusClaim {
  return { day: dateKeyOf(nowMs), atMs: nowMs };
}
