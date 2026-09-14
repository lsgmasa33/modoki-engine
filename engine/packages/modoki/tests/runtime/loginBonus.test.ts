/**
 * The login bonus wheel's decisions (#372, promoted to the engine in #926).
 *
 * `runtime/core/loginBonus.ts` is pure and takes `nowMs` and `roll`, so every case is exact: no
 * clock is stubbed and no seed is involved. Moved from `games/court/tests/loginBonus.test.ts` with
 * the assertions intact, over a local policy rather than Court's defaults — the numbers are each
 * game's, and Court's own suite still pins its defaults, its EV and its trait agreement. The one
 * case added on the move is the TIME ZONE switch: the strictly-later day comparison was carried
 * verbatim, but nothing pinned it, so a `!==` regression would have passed.
 */

import { describe, it, expect } from 'vitest';
import {
  loginBonusSegments, drawLoginBonusSegment, resolveLoginBonusPayout,
  loginBonusAvailability, loginBonusClaimRecord, type LoginBonusPolicy, type LoginBonusSegment,
} from '../../src/runtime/core/loginBonus';
import { dateKeyOf } from '../../src/runtime/core/dailyCalendar';

/** A policy that passes every gate, so each case can break exactly one thing. Weights total 100. */
const POLICY: LoginBonusPolicy = {
  enabled: true,
  tiers: [
    { coins: 10, weight: 25 },
    { coins: 20, weight: 33 },
    { coins: 30, weight: 26 },
    { coins: 100, weight: 3 },
  ],
  noAdsMinutes: 30,
  noAdsWeight: 13,
  noAdsSubstituteCoins: 20,
};

describe('loginBonusSegments — composing the wheel', () => {
  it('composes every tier plus the no-ads slice, in ladder order', () => {
    const segs = loginBonusSegments(POLICY);
    expect(segs.map((s) => s.id)).toEqual(['coins-1', 'coins-2', 'coins-3', 'coins-4', 'no-ads']);
    expect(segs.map((s) => s.coins)).toEqual([10, 20, 30, 100, 0]);
    const noAds = segs.find((s) => s.id === 'no-ads')!;
    expect(noAds.noAdsMinutes).toBe(30);
    expect(noAds.coins).toBe(0);
  });

  it('drops a tier with a zero, negative, or non-finite weight — a landable-nowhere slice is a near-miss dark pattern', () => {
    const policy: LoginBonusPolicy = {
      ...POLICY,
      tiers: [
        { coins: 10, weight: 0 },
        { coins: 15, weight: -5 },
        { coins: 20, weight: NaN },
        { coins: 30, weight: 14 },
      ],
    };
    const ids = loginBonusSegments(policy).map((s) => s.id);
    expect(ids).not.toContain('coins-1');
    expect(ids).not.toContain('coins-2');
    expect(ids).not.toContain('coins-3');
    expect(ids).toContain('coins-4');
  });

  it('drops a tier paying zero coins — a blank on the wheel', () => {
    const policy: LoginBonusPolicy = { ...POLICY, tiers: [{ coins: 0, weight: 24 }, ...POLICY.tiers.slice(1)] };
    expect(loginBonusSegments(policy).map((s) => s.id)).not.toContain('coins-1');
  });

  it('drops the no-ads slice when its weight is zero', () => {
    expect(loginBonusSegments({ ...POLICY, noAdsWeight: 0 }).map((s) => s.id)).not.toContain('no-ads');
  });

  it('drops the no-ads slice when its minutes are zero — nothing to pay is nothing to draw', () => {
    expect(loginBonusSegments({ ...POLICY, noAdsMinutes: 0 }).map((s) => s.id)).not.toContain('no-ads');
  });

  it('an over-long tiers array does not mint unnamed ids — the 5th+ entries are ignored', () => {
    const policy: LoginBonusPolicy = {
      ...POLICY,
      tiers: [...POLICY.tiers, { coins: 999, weight: 999 }, { coins: 1, weight: 1 }],
    };
    const segs = loginBonusSegments(policy);
    expect(segs.filter((s) => s.id.startsWith('coins-'))).toHaveLength(4);
    expect(segs.some((s) => s.coins === 999)).toBe(false);
  });

  it('floors fractional authored values', () => {
    const policy: LoginBonusPolicy = {
      ...POLICY,
      tiers: [{ coins: 10.7, weight: 24 }, ...POLICY.tiers.slice(1)],
      noAdsMinutes: 30.9,
    };
    const segs = loginBonusSegments(policy);
    expect(segs.find((s) => s.id === 'coins-1')!.coins).toBe(10);
    expect(segs.find((s) => s.id === 'no-ads')!.noAdsMinutes).toBe(30);
  });
});

describe('drawLoginBonusSegment — the weights contract', () => {
  const segs = loginBonusSegments(POLICY);
  const WEIGHTS = [25, 33, 26, 3, 13];
  const TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);

  it('walks the boundary of every cumulative weight, derived rather than hardcoded', () => {
    expect(drawLoginBonusSegment(segs, 0)?.id).toBe('coins-1');
    let cumulative = 0;
    for (let i = 0; i < segs.length; i++) {
      cumulative += WEIGHTS[i];
      const boundaryRoll = cumulative / TOTAL;
      // Strictly under/over rather than AT the boundary: `cumulative / TOTAL * TOTAL` does not always
      // round-trip (58/100*100 === 57.99999999999999), so the exact boundary is not well-defined.
      expect(drawLoginBonusSegment(segs, boundaryRoll - 1e-9)?.id, `just under boundary ${i}`).toBe(segs[i].id);
      if (i < segs.length - 1) {
        expect(drawLoginBonusSegment(segs, boundaryRoll + 1e-9)?.id, `just over boundary ${i}`).toBe(segs[i + 1].id);
      }
    }
  });

  it('matches the authored weights over a fine deterministic grid — no flake, no seed', () => {
    const N = 100_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const seg = drawLoginBonusSegment(segs, i / N);
      counts.set(seg!.id, (counts.get(seg!.id) ?? 0) + 1);
    }
    segs.forEach((seg, i) => {
      expect((counts.get(seg.id) ?? 0) / N, `${seg.id} share vs its weight`).toBeCloseTo(WEIGHTS[i] / TOTAL, 3);
    });
  });

  it('returns null for an empty wheel and for an all-zero-weight wheel', () => {
    expect(drawLoginBonusSegment([], 0.5)).toBeNull();
    const zeroed: LoginBonusSegment[] = [
      { id: 'coins-1', weight: 0, coins: 10, noAdsMinutes: 0 },
      { id: 'coins-2', weight: 0, coins: 15, noAdsMinutes: 0 },
    ];
    expect(drawLoginBonusSegment(zeroed, 0.5)).toBeNull();
  });

  it('clamps a broken roll rather than trusting it — never null, never undefined, never throws', () => {
    for (const roll of [1, NaN, -0.5, 2]) {
      const seg = drawLoginBonusSegment(segs, roll);
      expect(seg, `roll=${roll} must return a real slice`).not.toBeNull();
      expect(seg, `roll=${roll} must return a real slice`).not.toBeUndefined();
    }
    expect(drawLoginBonusSegment(segs, 1)?.id, 'roll=1 lands on the LAST slice by wheel order').toBe('no-ads');
  });
});

describe('resolveLoginBonusPayout', () => {
  const segs = loginBonusSegments(POLICY);
  const coinSeg = segs.find((s) => s.id === 'coins-2')!; // 20 coins
  const noAdsSeg = segs.find((s) => s.id === 'no-ads')!; // 30 minutes

  it('a coin slice pays its coins and no minutes, unsubstituted, regardless of ctx', () => {
    for (const ctx of [
      { noAdsForeverOwned: false, noAdsGrantable: true }, { noAdsForeverOwned: true, noAdsGrantable: true },
      { noAdsForeverOwned: false, noAdsGrantable: false }, { noAdsForeverOwned: true, noAdsGrantable: false },
    ]) {
      expect(resolveLoginBonusPayout(coinSeg, POLICY, ctx)).toEqual({ coins: 20, noAdsMinutes: 0, substituted: '' });
    }
  });

  it('the no-ads slice pays its minutes when the forever unlock is not owned and the pass is grantable', () => {
    expect(resolveLoginBonusPayout(noAdsSeg, POLICY, { noAdsForeverOwned: false, noAdsGrantable: true }))
      .toEqual({ coins: 0, noAdsMinutes: 30, substituted: '' });
  });

  it('the no-ads slice is substituted for coins when the player owns the forever unlock', () => {
    expect(resolveLoginBonusPayout(noAdsSeg, POLICY, { noAdsForeverOwned: true, noAdsGrantable: true }))
      .toEqual({ coins: POLICY.noAdsSubstituteCoins, noAdsMinutes: 0, substituted: 'forever-owned' });
  });

  it('the no-ads slice is substituted for coins when the pass is not grantable — the "no-pass-product" hole', () => {
    expect(resolveLoginBonusPayout(noAdsSeg, POLICY, { noAdsForeverOwned: false, noAdsGrantable: false }))
      .toEqual({ coins: POLICY.noAdsSubstituteCoins, noAdsMinutes: 0, substituted: 'no-pass-product' });
  });

  it('forever-owned takes precedence over a non-grantable pass when both apply', () => {
    expect(resolveLoginBonusPayout(noAdsSeg, POLICY, { noAdsForeverOwned: true, noAdsGrantable: false }).substituted)
      .toBe('forever-owned');
  });
});

describe('loginBonusAvailability', () => {
  // A fixed base instant — no Date.now() anywhere in this suite. 2026-06-15 12:00 local.
  const BASE = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const NEVER = { day: '' as const, atMs: 0 };
  const HOUR = 3_600_000;

  it('is available when never claimed', () => {
    expect(loginBonusAvailability({ policy: POLICY, claim: NEVER, nowMs: BASE, segmentCount: 5 }))
      .toEqual({ available: true });
  });

  it('refuses when claimed earlier the SAME local calendar day', () => {
    const claim = loginBonusClaimRecord(new Date(2026, 5, 15, 6, 0, 0).getTime());
    expect(loginBonusAvailability({ policy: POLICY, claim, nowMs: BASE, segmentCount: 5 }))
      .toEqual({ available: false, why: 'claimed-today' });
  });

  it('is available again after crossing local midnight', () => {
    const claim = loginBonusClaimRecord(new Date(2026, 5, 14, 12, 0, 0).getTime());
    expect(loginBonusAvailability({ policy: POLICY, claim, nowMs: BASE, segmentCount: 5 }))
      .toEqual({ available: true });
  });

  it('disabled wins over every other reason', () => {
    const claim = loginBonusClaimRecord(new Date(2026, 5, 15, 6, 0, 0).getTime());
    expect(loginBonusAvailability({ policy: { ...POLICY, enabled: false }, claim, nowMs: BASE, segmentCount: 5 }))
      .toEqual({ available: false, why: 'disabled' });
  });

  it('reports no-wheel when every slice has been dropped', () => {
    expect(loginBonusAvailability({ policy: POLICY, claim: NEVER, nowMs: BASE, segmentCount: 0 }))
      .toEqual({ available: false, why: 'no-wheel' });
  });

  it('fails CLOSED on a wound-back clock — the security-shaped case', () => {
    // A player sets their device date BACK after claiming today's spin. A naive day-string
    // comparison sees a different day and calls it available — repeatable indefinitely.
    const claimedNow = loginBonusClaimRecord(BASE);
    const woundBackToPreviousDay = new Date(2026, 5, 14, 12, 0, 0).getTime();
    expect(dateKeyOf(woundBackToPreviousDay)).not.toBe(claimedNow.day); // it IS a different calendar day
    expect(loginBonusAvailability({ policy: POLICY, claim: claimedNow, nowMs: woundBackToPreviousDay, segmentCount: 5 }))
      .toEqual({ available: false, why: 'clock-behind' });
  });

  it('fails CLOSED on a clock wound back within the SAME calendar day too', () => {
    const claimedNow = loginBonusClaimRecord(new Date(2026, 5, 15, 18, 0, 0).getTime());
    const woundBackSameDay = new Date(2026, 5, 15, 6, 0, 0).getTime();
    expect(loginBonusAvailability({ policy: POLICY, claim: claimedNow, nowMs: woundBackSameDay, segmentCount: 5 }))
      .toEqual({ available: false, why: 'clock-behind' });
  });

  it('a TIME ZONE switch EAST plus a clock wound back is refused by the clock check, which the day key alone would pay', () => {
    // The claim was stamped in a zone a day BEHIND (its local date reads yesterday), and the device clock
    // is now an hour EARLIER than the claim instant. The local date is strictly later than the stamp, so
    // the day key alone calls it a new day — only `nowMs < atMs` refuses. Built from `dateKeyOf` on both
    // sides, so it holds under any machine TZ. (Close-out review of #926: a comment briefly called this
    // check redundant, and no test could have said otherwise.)
    const behindDay = dateKeyOf(BASE - 24 * HOUR);
    expect(dateKeyOf(BASE - HOUR) > behindDay, 'fixture: the wound-back instant is on a later local day').toBe(true);
    const claim = { day: behindDay, atMs: BASE };
    expect(loginBonusAvailability({ policy: POLICY, claim, nowMs: BASE - HOUR, segmentCount: 5 }))
      .toEqual({ available: false, why: 'clock-behind' });
  });

  it('a TIME ZONE switch back west does not re-open the day — the key must be strictly LATER, not merely different', () => {
    // The claim was made an hour ago while the device sat in a zone a calendar day AHEAD (Kiritimati),
    // so it stamped tomorrow's local date. Back in the home zone the instant has moved FORWARD (so
    // the clock-behind check cannot see it) while the local date reads as the day before the stamp.
    // `!==` calls that a new day; ordering the keys refuses it. Built from `dateKeyOf` on both sides,
    // so it holds under any machine TZ.
    const aheadDay = dateKeyOf(BASE + 24 * HOUR);
    expect(aheadDay > dateKeyOf(BASE), 'fixture: the stamped day is later than the home-zone day').toBe(true);
    const claim = { day: aheadDay, atMs: BASE - HOUR };
    expect(loginBonusAvailability({ policy: POLICY, claim, nowMs: BASE, segmentCount: 5 }))
      .toEqual({ available: false, why: 'claimed-today' });
    // ...and real time catching up past the stamped day re-opens it — one pulled-forward claim, not a lockout.
    const pastStamp = new Date(2026, 5, 17, 12, 0, 0).getTime();
    expect(dateKeyOf(pastStamp) > aheadDay).toBe(true);
    expect(loginBonusAvailability({ policy: POLICY, claim, nowMs: pastStamp, segmentCount: 5 }))
      .toEqual({ available: true });
  });
});

describe('loginBonusClaimRecord', () => {
  it("stamps the claim INSTANT, not the day's midnight", () => {
    const instant = new Date(2026, 5, 15, 18, 30, 0).getTime();
    const record = loginBonusClaimRecord(instant);
    expect(record.day).toBe(dateKeyOf(instant));
    expect(record.atMs).toBe(instant);
    expect(record.atMs).not.toBe(new Date(2026, 5, 15, 0, 0, 0).getTime());
  });
});
