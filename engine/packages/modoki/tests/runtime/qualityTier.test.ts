/** Quality tiers (#121 P3) — `runtime/rendering/qualityTier.ts`.
 *
 *  Everything here is pure: `resolveTier` takes facts, `evaluateTierChange` takes a profile, a
 *  state and a clock reading. No probe, no timers, no waiting real seconds.
 *
 *  The assertion that matters most is the vsync one. Judging headroom by `frameMs` while
 *  vsync-bound would promote a device that has none — `frameMs` is pinned at the display
 *  interval there and reports "barely making 60" and "trivially making 60" identically. */

import { describe, it, expect } from 'vitest';
import {
  resolveTier, evaluateTierChange, freshTierChangeState, promotionCeiling,
  tierShadowMapSize, shadowBiasScale,
  TIER_ALLOWLIST, TIER_SETTINGS, DEFAULT_TIER_SETTING,
  iosModelTier, parseAppleModel, IOS_TIER_MIN_GENERATION,
  TIER_ORDER, isQualityTier, tierAbove, tierBelow,
  PROMOTION_HOLD_MS, DEMOTION_HOLD_MS, MIN_SAMPLES_TO_JUDGE,
  type QualityTier, type TierResolution, type TierSource,
  applyTierToThree, applyTierToPixi, applyTierToTargetFps,
  tierAllowsEffect, tierAllowsIBL, tierAmbientBoost, tierExposureBoost,
  UNCLAMPED_OVERRIDES, resolveTierOverrides, configCount, maskPostFXRequest,
  ALL_POSTFX, NO_POSTFX, POSTFX_EFFECTS,
  type TierRenderOverrides, type AuthoredTiers, type PostFXMask,
} from '../../src/runtime/rendering/qualityTier';
import { BUDGET_30FPS_MS, type FrameProfile } from '../../src/runtime/core/frameProfiler';

/** Build a FrameProfile with the fields the tier policy reads. */
function profile(o: {
  frameMs: number; cpuMs: number; vsyncBound?: boolean; samples?: number;
}): FrameProfile {
  const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
  return {
    samples: o.samples ?? 60,
    frameMs: stat(o.frameMs),
    cpuMs: stat(o.cpuMs),
    restMs: stat(Math.max(0, o.frameMs - o.cpuMs)),
    fps: 1000 / o.frameMs,
    vsyncBound: o.vsyncBound ?? false,
    overBudget: o.frameMs > BUDGET_30FPS_MS,
    discontinuities: 0,
  };
}

/** The ceiling every test about the PROMOTION POLICY passes, so those tests keep asking their own
 *  question — does sustained headroom promote — rather than accidentally testing the cap. The cap
 *  has its own describe block below, and it is the only place a lower ceiling appears. */
const UNCAPPED: QualityTier = 'high';

/** Temporarily add allowlist entries — the shipped list is empty on purpose, so matching can
 *  only be exercised by injecting. Android only; iOS resolves from the model id instead. */
type AllowEntry = { pattern: RegExp; tier: QualityTier };
function withAllowlist(fn: () => void, android: AllowEntry[] = []) {
  const a = TIER_ALLOWLIST.androidGpuPatterns as AllowEntry[];
  a.push(...android);
  try { fn(); } finally { a.length = 0; }
}

describe('resolveTier — precedence', () => {
  it('the player wins over everything — they can see the screen and we cannot', () => {
    const r = resolveTier({
      platform: 'ios', playerChoice: 'low', projectSetting: 'high', deviceModel: 'iPhone17,1',
    });
    expect(r).toMatchObject({ tier: 'low', source: 'player' });
  });

  it('a pinned project setting beats the iOS model id', () => {
    // The pin wins because `resolveTier` returns at it before ever consulting the model — which
    // is what makes "does a pin beat the probe?" answer itself: the probe lives further down.
    const r = resolveTier({ platform: 'ios', deviceModel: 'iPhone17,1', projectSetting: 'low' });
    expect(r).toMatchObject({ tier: 'low', source: 'project' });
  });

  it('DEFAULTS TO auto, so an unrecognised phone launches in low-end spec (#155)', () => {
    // Owner decision: a game launches low unless the device is allowlisted. Measured cost of the
    // old `'high'` placeholder — a Y6 2019 took a 6388 ms post-FX submit, lost its GPU context,
    // and stayed blank; the same device holds 27-33 fps under auto.
    expect(DEFAULT_TIER_SETTING).toBe('auto');
    const r = resolveTier({ platform: 'web' });
    expect(r).toMatchObject({ tier: 'low', source: 'calibrating' });
  });
});

describe('resolveTier — auto', () => {
  it('starts an unrecognised device LOW and marks it calibrating', () => {
    // Booting high and guessing wrong is a lost context and a permanent black screen; booting
    // low and guessing wrong costs a beat of ugliness. The asymmetry decides the default.
    const r = resolveTier({ platform: 'android', projectSetting: 'auto', gpuRenderer: 'Mali-G57' });
    expect(r).toMatchObject({ tier: 'low', source: 'calibrating' });
  });

  it('keeps a DESKTOP on high — it is not the hardware the low default guards (#155)', () => {
    const r = resolveTier({ platform: 'web', projectSetting: 'auto', formFactor: 'desktop' });
    expect(r).toMatchObject({ tier: 'high', source: 'desktop' });
  });

  it('does NOT infer desktop from platform "web" — a phone browser reports exactly that', () => {
    // The trap #155 was nearly built on. The demos publish web-only, so `platform === 'web'`
    // meaning "desktop" would hand their whole mobile-web audience the tier that bricked the Y6.
    const r = resolveTier({ platform: 'web', projectSetting: 'auto', formFactor: 'mobile' });
    expect(r).toMatchObject({ tier: 'low', source: 'calibrating' });
  });

  it('treats an ABSENT formFactor as a handheld — a failed probe lands on the safe side', () => {
    const r = resolveTier({ platform: '', projectSetting: 'auto' });
    expect(r).toMatchObject({ tier: 'low', source: 'calibrating' });
  });

  it('lets a project pin high, outranking the desktop/calibrating fall-through', () => {
    const r = resolveTier({ platform: 'android', projectSetting: 'high', formFactor: 'mobile' });
    expect(r).toMatchObject({ tier: 'high', source: 'project' });
  });

  it('ships with an EMPTY allowlist — an unmeasured entry is what ossifies', () => {
    expect(TIER_ALLOWLIST.androidGpuPatterns).toHaveLength(0);
  });

  it('matches an allowlisted Android GPU STRING, not a model name', () => {
    // The A23 is why: 4G ships Adreno 610, 5G ships Adreno 619, same marketing name.
    withAllowlist(() => {
      const r = resolveTier({
        platform: 'android', gpuRenderer: 'Adreno (TM) 619', projectSetting: 'auto',
      });
      expect(r).toMatchObject({ tier: 'high', source: 'allowlist' });
    }, [{ pattern: /Adreno \(TM\) 6[12]9/, tier: 'high' }]);
  });

  it('lets an allowlist entry name `mid` — a shortcut that can only say `high` would have to lie', () => {
    // The entries carried no tier until #188, so the first GPU anyone measured into the MIDDLE
    // band could only have been added as `high`. Empty in production, so this changes nothing
    // today; it changes what the next measurement is able to express.
    withAllowlist(() => {
      expect(resolveTier({ platform: 'android', gpuRenderer: 'Mali-G57 MC2', projectSetting: 'auto' }))
        .toMatchObject({ tier: 'mid', source: 'allowlist' });
    }, [{ pattern: /Mali-G57/, tier: 'mid' }]);
  });

  it('falls through to calibrating when the allowlist does not match', () => {
    withAllowlist(() => {
      const r = resolveTier({
        platform: 'android', gpuRenderer: 'Adreno (TM) 610', projectSetting: 'auto',
      });
      expect(r.source).toBe('calibrating');
    }, [{ pattern: /Adreno \(TM\) 619/, tier: 'high' }]);
  });
});

describe('resolveTier — the boot ramp probe (#188)', () => {
  const mobile = { platform: 'android', projectSetting: 'auto' as const, formFactor: 'mobile' as const };

  it('promotes a device the probe measured as capable', () => {
    expect(resolveTier({ ...mobile, probeClass: 'capable' }))
      .toMatchObject({ tier: 'high', source: 'measured' });
  });

  it('keeps a measured-weak device low, and SAYS it measured it', () => {
    // `weak` and `unknown` both land on low, but they are different statements: one is a
    // measurement, the other is the absence of one. If the reason did not distinguish them, an
    // inert probe would be indistinguishable from a probe that ran and said no.
    const weak = resolveTier({ ...mobile, probeClass: 'weak' });
    const none = resolveTier({ ...mobile });
    expect(weak).toMatchObject({ tier: 'low', source: 'measured' });
    expect(none).toMatchObject({ tier: 'low', source: 'calibrating' });
    expect(weak.reason).not.toBe(none.reason);
  });

  it('puts a measured-middle device on the `mid` tier (#188)', () => {
    // The whole point of the three-band probe. Before `mid` existed, the A23 and the iPhone 8 —
    // which the probe places ~10x above the Y6 — were filed with it on `low`, and this project
    // had already MEASURED that wrong: forest-camp's IBL costs +2.9ms of GPU on the A23 and fits.
    const r = resolveTier({ ...mobile, probeClass: 'middle' });
    expect(r).toMatchObject({ tier: 'mid', source: 'measured' });
    expect(r.reason).toContain('middle');
  });

  it('gives each band its own reason, so a surprising tier is explainable', () => {
    const reasons = (['weak', 'middle', 'capable'] as const)
      .map((probeClass) => resolveTier({ ...mobile, probeClass }).reason);
    expect(new Set(reasons).size).toBe(3);
  });

  it('treats an `unknown` verdict as no information — exactly today\'s behaviour', () => {
    // This is the shipped state (PROBE_THRESHOLDS unset), so it is the case that must not change
    // any device's tier.
    expect(resolveTier({ ...mobile, probeClass: 'unknown' }))
      .toMatchObject({ tier: 'low', source: 'calibrating' });
  });

  it('never lets the probe override a player choice or a project pin', () => {
    expect(resolveTier({ ...mobile, probeClass: 'capable', playerChoice: 'low' }))
      .toMatchObject({ tier: 'low', source: 'player' });
    expect(resolveTier({ ...mobile, projectSetting: 'low', probeClass: 'capable' }))
      .toMatchObject({ tier: 'low', source: 'project' });
  });

  it('sits BELOW the desktop carve-out, so a desktop never pays a launch-blocking probe', () => {
    const r = resolveTier({ platform: 'web', projectSetting: 'auto', formFactor: 'desktop' });
    expect(r.source).toBe('desktop');
    // The caller keys off exactly this: anything other than `calibrating` means "already
    // answered", so the probe is never run at all.
    expect(r.source).not.toBe('calibrating');
  });

  it('sits BELOW the iOS model id, which answers statically and for free', () => {
    expect(resolveTier({ platform: 'ios', deviceModel: 'iPhone10,1', projectSetting: 'auto' }).source)
      .toBe('model');
  });
});

describe('iOS resolves from the model id (owner, 2026-08-09)', () => {
  it('parses a model id into family + generation', () => {
    expect(parseAppleModel('iPhone10,1')).toEqual({ family: 'iPhone', generation: 10 });
    expect(parseAppleModel(' iPad13,4 ')).toEqual({ family: 'iPad', generation: 13 });
  });

  it('refuses anything unparseable rather than coercing it to a tier', () => {
    // A masked, spoofed or simulator string must fall through to the measured path, not be
    // rounded into a confident answer.
    for (const junk of ['', 'iPhone', 'x86_64', 'iPhone,1', 'Apple GPU']) {
      expect(parseAppleModel(junk)).toBeNull();
      expect(iosModelTier(junk)).toBeNull();
    }
    expect(iosModelTier(undefined)).toBeNull();
  });

  it('puts the iPhone 8 on MID, agreeing with what the ramp probe measures it as (#188)', () => {
    // ⚠️ This asserted `low` until #188, and that became a contradiction between the engine's two
    // classifiers on the same phone: the probe reads an iPhone 8 at 3.9 Mpx/ms + 15.8 calls/ms —
    // the MIDDLE band, which it is one of the two devices DEFINING. So a native build said `low`
    // from this table while the same handset on iOS web said `mid` from the probe. What the A11
    // measurement actually shows is 27 -> 56 ms *with NPR*, i.e. it cannot afford post-FX — the
    // knob `mid` turns off.
    expect(iosModelTier('iPhone10,1')).toBe('mid');
    // ...and the iPhone X is iPhone10,3, the SAME A11 silicon, so grouping them is correct.
    expect(iosModelTier('iPhone10,3')).toBe('mid');
  });

  it('agrees with the probe on the same hardware — two classifiers must not disagree', () => {
    // The property the module header promises, asserted directly rather than left to inspection.
    // An iPhone 8 native (model id) and the same phone on iOS web (no model id, so the probe)
    // must land on the same tier.
    const native = resolveTier({
      platform: 'ios', projectSetting: 'auto', formFactor: 'mobile',
      deviceModel: 'iPhone10,1', probeClass: 'middle',
    });
    const web = resolveTier({
      platform: 'web', projectSetting: 'auto', formFactor: 'mobile', probeClass: 'middle',
    });
    expect(native.tier).toBe(web.tier);
    expect(native.source).toBe('model');   // still answered statically, without paying the probe
    expect(web.source).toBe('measured');
  });

  it('still puts pre-A11 silicon on low — unmeasured, so the conservative side', () => {
    expect(iosModelTier('iPhone9,1')).toBe('low');   // A10, iPhone 7
    expect(resolveTier({ platform: 'ios', deviceModel: 'iPhone9,1', projectSetting: 'auto' }).reason)
      .toContain('below the mid-tier floor');
  });

  it('is a THRESHOLD, so hardware that does not exist yet is never wrongly demoted', () => {
    // The failure mode of an enumerated list: a phone absent from it gets `low` forever. A
    // `>= N` rule cannot do that, because newer Apple silicon is only ever faster.
    expect(iosModelTier('iPhone11,8')).toBe('high');
    expect(iosModelTier('iPhone99,1')).toBe('high');
  });

  it('does not borrow the iPhone number for iPads — they run their own sequence', () => {
    // Compared by VALUE: `not.toBe` on the two rows is object identity and passes vacuously now
    // that each row is an object rather than a number.
    expect(IOS_TIER_MIN_GENERATION.iPad.high).not.toBe(IOS_TIER_MIN_GENERATION.iPhone.high);
    expect(iosModelTier('iPad11,1')).toBe('high');
  });

  it('gives iPads NO mid band, because no iPad below A12 has been measured', () => {
    // `mid === high` on that row is deliberate: inventing a mid floor here is exactly the kind of
    // unmeasured number this table's design exists to avoid. iPad behaviour is unchanged by #188.
    expect(IOS_TIER_MIN_GENERATION.iPad.mid).toBe(IOS_TIER_MIN_GENERATION.iPad.high);
    expect(iosModelTier('iPad7,11')).toBe('low');    // A10 iPad — low, as before
    expect(iosModelTier('iPad11,1')).toBe('high');   // A12 iPad mini 5 — measured `capable`
  });

  it('falls through for a family with no floor, rather than inventing one', () => {
    // No iPod touch can run the iOS 16.4 floor, so one appearing is out of scope.
    expect(iosModelTier('iPod9,1')).toBeNull();
    expect(resolveTier({ platform: 'ios', deviceModel: 'iPod9,1', projectSetting: 'auto' }).source)
      .toBe('calibrating');
  });

  it('resolves the tier from the model, reporting `model` as the source', () => {
    const r = resolveTier({ platform: 'ios', deviceModel: 'iPhone16,2', projectSetting: 'auto' });
    expect(r).toMatchObject({ tier: 'high', source: 'model' });
    expect(r.reason).toMatch(/iPhone16,2/);
  });

  it('leaves iOS WEB on the measured path — mobile Safari reports no model', () => {
    // Every published demo ships web-only, so this is not an edge case: with no `GameDebug`
    // plugin there is no model id, and the model rule must not fire on its absence.
    expect(resolveTier({ platform: 'ios', projectSetting: 'auto' }).source).toBe('calibrating');
  });
});

describe('evaluateTierChange — promotion', () => {
  const roomy = profile({ frameMs: 10, cpuMs: 4 });

  it('does not promote before the hold elapses', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS - 1, UNCAPPED);
    expect(b.decision.action).toBe('none');
  });

  it('promotes once headroom has held', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED);
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision.action).toBe('promote');
  });

  it('a single bad sample RESETS the streak — one lucky second is not evidence', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED);
    const b = evaluateTierChange('low', profile({ frameMs: 60, cpuMs: 50 }), a.state, 2000, UNCAPPED);
    expect(b.state.headroomSince).toBe(0);
    const c = evaluateTierChange('low', roomy, b.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED);
    expect(c.decision.action).toBe('none'); // streak restarted, hold not yet met
  });

  it('will not judge on too few samples', () => {
    const thin = profile({ frameMs: 10, cpuMs: 4, samples: MIN_SAMPLES_TO_JUDGE - 1 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', thin, s, 1000, UNCAPPED);
    const b = evaluateTierChange('low', thin, a.state, 1000 + PROMOTION_HOLD_MS * 3, UNCAPPED);
    expect(b.decision.action).toBe('none');
  });
});

describe('evaluateTierChange — the vsync-bound signal switch', () => {
  it('promotes a vsync-capped device that is barely working', () => {
    // 3ms of CPU in a 16.7ms frame: genuinely idle, genuinely promotable.
    const idle = profile({ frameMs: 1000 / 60, cpuMs: 3, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', idle, s, 1000, UNCAPPED);
    const b = evaluateTierChange('low', idle, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision.action).toBe('promote');
    expect(b.decision).toMatchObject({ reason: expect.stringContaining('cpu') });
  });

  it('REFUSES to promote a vsync-capped device that is nearly out of frame', () => {
    // THE test. 15ms of CPU in a 16.7ms frame is a device on the edge — but frameMs is pinned
    // at the display interval, identical to the idle case above, so a frameMs-based rule would
    // promote it and immediately blow the budget. Only cpuMs can tell these apart.
    const strained = profile({ frameMs: 1000 / 60, cpuMs: 15, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', strained, s, 1000, UNCAPPED);
    const b = evaluateTierChange('low', strained, a.state, 1000 + PROMOTION_HOLD_MS * 3, UNCAPPED);
    expect(b.decision.action).toBe('none');
  });
});

describe('promotionCeiling — a measurement is not overruled by a CPU streak (#188)', () => {
  const res = (tier: QualityTier, source: TierSource): TierResolution =>
    ({ tier, source, reason: 'test' });

  it('caps at the tier the boot probe measured', () => {
    // The A23 case. The probe measured cpu + shade on this hardware and said `middle`; a live
    // rule that reads cpuMs alone has strictly less information about the GPU than that.
    expect(promotionCeiling(res('mid', 'measured'))).toBe('mid');
    expect(promotionCeiling(res('low', 'measured'))).toBe('low');
  });

  it('caps at what the iOS model table and the allowlist answered', () => {
    expect(promotionCeiling(res('mid', 'model'))).toBe('mid');
    expect(promotionCeiling(res('mid', 'allowlist'))).toBe('mid');
  });

  it('caps a HUMAN decision at exactly what they chose', () => {
    // Calibration already refuses to run for these (tickTierCalibration early-returns), so this
    // is belt-and-braces — but an inference raising an explicit choice is the one thing those
    // controls exist to prevent, and it should be wrong in only one place if it is ever wrong.
    expect(promotionCeiling(res('low', 'player'))).toBe('low');
    expect(promotionCeiling(res('mid', 'project'))).toBe('mid');
  });

  it('gives an UNASSESSED device exactly one step — not none, and not the top', () => {
    // Not none: `auto` pinning unrecognised hardware to `low` forever is #155's stated cost, and
    // promotion is the mechanism that answers it. Not the top: `high` on a device nobody has ever
    // measured is the boot that cost a Huawei Y6 its GPU context.
    expect(promotionCeiling(res('low', 'calibrating'))).toBe('mid');
  });

  it('never returns a tier above the ladder, whatever it is handed', () => {
    expect(promotionCeiling(res('high', 'calibrating'))).toBe('high');
    expect(promotionCeiling(res('high', 'desktop'))).toBe('high');
    expect(promotionCeiling(null)).toBe('mid');
  });
});

describe('evaluateTierChange — the cap holds, and SAYS SO (#188)', () => {
  const roomy = profile({ frameMs: 10, cpuMs: 4 });

  /** Run the profile long enough that promotion would fire if the ceiling allowed. */
  const held = (tier: QualityTier, ceiling: QualityTier) => {
    const a = evaluateTierChange(tier, roomy, freshTierChangeState(), 1000, ceiling);
    return evaluateTierChange(tier, roomy, a.state, 1000 + PROMOTION_HOLD_MS, ceiling);
  };

  it('does NOT promote past the ceiling, however long the headroom holds', () => {
    expect(held('mid', 'mid').decision.action).not.toBe('promote');
    expect(held('low', 'low').decision.action).not.toBe('promote');
  });

  it('promotes freely up TO the ceiling — the cap is a limit, not an off switch', () => {
    expect(held('low', 'mid').decision).toMatchObject({ action: 'promote', tier: 'mid' });
    expect(held('mid', 'high').decision).toMatchObject({ action: 'promote', tier: 'high' });
  });

  it('reports `hold` rather than silence — "why is my A23 not promoting" needs an answer', () => {
    // THE distinction this action exists for: a device that held five seconds of headroom and was
    // capped must be distinguishable from one whose streak never started. Both do nothing.
    const capped = held('mid', 'mid');
    expect(capped.decision).toMatchObject({ action: 'hold', tier: 'high' });
    expect(capped.decision).toMatchObject({ reason: expect.stringContaining('assessed') });

    const noStreak = evaluateTierChange(
      'mid', profile({ frameMs: 1000 / 60, cpuMs: 15, vsyncBound: true }),
      freshTierChangeState(), 1000, 'mid',
    );
    expect(noStreak.decision.action).toBe('none');
  });

  it('re-reports every hold period rather than once and never again', () => {
    // The policy has no memory, deliberately — deduping is the consumer's job (one log per
    // session). If this reset were dropped the streak would sit latched and the consumer would
    // see one `hold` on a device that is still capped minutes later.
    const first = held('mid', 'mid');
    expect(first.state.headroomSince).toBe(0);
    const again = evaluateTierChange('mid', roomy, first.state, 1000 + PROMOTION_HOLD_MS, 'mid');
    expect(again.decision.action).toBe('none'); // streak restarted
    const later = evaluateTierChange('mid', roomy, again.state, 1000 + PROMOTION_HOLD_MS * 2, 'mid');
    expect(later.decision.action).toBe('hold');
  });

  it('leaves DEMOTION completely alone — being wrong downward is the recoverable direction', () => {
    const drowning = profile({ frameMs: 60, cpuMs: 50 });
    const a = evaluateTierChange('high', drowning, freshTierChangeState(), 1000, 'low');
    const b = evaluateTierChange('high', drowning, a.state, 1000 + DEMOTION_HOLD_MS, 'low');
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'mid' });
  });
});

describe('evaluateTierChange — demotion', () => {
  const slow = profile({ frameMs: 83, cpuMs: 48 }); // the Y6's measured profile

  it('demotes after sustained over-budget frames', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000, UNCAPPED);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision.action).toBe('demote');
  });

  it('demotes FASTER than it promotes — an emergency, not an upgrade', () => {
    expect(DEMOTION_HOLD_MS).toBeLessThan(PROMOTION_HOLD_MS);
  });

  it('a demotion is STICKY — never promote again, or the tier oscillates', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000, UNCAPPED);
    const demoted = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED);
    expect(demoted.state.demoted).toBe(true);

    // Now on `low` it runs beautifully — which is exactly what the low tier was FOR. Promoting
    // back would return it to the settings that just failed, and it would flap between them.
    const roomy = profile({ frameMs: 10, cpuMs: 4 });
    let st = demoted.state;
    for (const t of [2000, 8000, 20000, 60000]) {
      const r = evaluateTierChange('low', roomy, st, t, UNCAPPED);
      expect(r.decision.action).toBe('none');
      st = r.state;
    }
  });

  it('does not demote a high-tier device that is merely near budget', () => {
    const fine = profile({ frameMs: BUDGET_30FPS_MS - 1, cpuMs: 10 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', fine, s, 1000, UNCAPPED);
    const b = evaluateTierChange('high', fine, a.state, 1000 + DEMOTION_HOLD_MS * 5, UNCAPPED);
    expect(b.decision.action).toBe('none');
  });
});

describe('the tier ladder (#188)', () => {
  it('is ordered weakest-first, and that ordering is the only one', () => {
    expect(TIER_ORDER).toEqual(['low', 'mid', 'high']);
  });

  it('steps one rung at a time and stops at the ends', () => {
    expect(tierAbove('low')).toBe('mid');
    expect(tierAbove('mid')).toBe('high');
    expect(tierAbove('high')).toBeNull();
    expect(tierBelow('high')).toBe('mid');
    expect(tierBelow('mid')).toBe('low');
    expect(tierBelow('low')).toBeNull();
  });

  it('validates a tier name — the guard every persistence site narrows through', () => {
    for (const t of TIER_ORDER) expect(isQualityTier(t)).toBe(true);
    expect(isQualityTier('auto')).toBe(false);   // a SETTING, not a tier
    expect(isQualityTier('ultra')).toBe(false);
    expect(isQualityTier(undefined)).toBe(false);
    expect(isQualityTier(2)).toBe(false);
  });

  it('has a settings row for every tier — a tier with no settings would crash at first use', () => {
    for (const t of TIER_ORDER) expect(TIER_SETTINGS[t]).toBeDefined();
  });
});

describe('evaluateTierChange — `mid` is the rung that moves BOTH ways', () => {
  const roomy = profile({ frameMs: 10, cpuMs: 4 });
  const drowning = profile({ frameMs: 60, cpuMs: 50 });

  it('promotes mid -> high, not straight past it', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED);
    const b = evaluateTierChange('mid', roomy, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision).toMatchObject({ action: 'promote', tier: 'high' });
  });

  it('demotes mid -> low', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('mid', drowning, s, 1000, UNCAPPED);
    const b = evaluateTierChange('mid', drowning, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'low' });
  });

  it('demotes high -> mid, and low promotes to mid — one rung each way', () => {
    const s = freshTierChangeState();
    const d = evaluateTierChange('high', drowning, s, 1000, UNCAPPED);
    expect(evaluateTierChange('high', drowning, d.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED).decision)
      .toMatchObject({ action: 'demote', tier: 'mid' });
    const u = evaluateTierChange('low', roomy, s, 1000, UNCAPPED);
    expect(evaluateTierChange('low', roomy, u.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED).decision)
      .toMatchObject({ action: 'promote', tier: 'mid' });
  });

  it('lets the headroom streak ACCUMULATE on mid — the bug a carried-over reset would have caused', () => {
    // While `high` was the only demotable tier, the demotion branch cleared `headroomSince` every
    // pass. Carried over verbatim that line would have made `mid` un-promotable: it can demote, so
    // it would have wiped the very streak promotion needs, silently and with every test still green.
    //
    // Asserted ACROSS TWO PASSES on purpose: after one pass the streak reads 1000 either way (the
    // promotion branch restarts what the demotion branch just cleared), so a single-pass check
    // passes against the bug. What the reset actually destroys is the streak's ORIGIN — it would
    // be re-stamped to `now` every pass and never age past the hold.
    const s = freshTierChangeState();
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED);
    const b = evaluateTierChange('mid', roomy, a.state, 3000, UNCAPPED);
    expect(b.state.headroomSince).toBe(1000);
  });

  it('resolves the both-true case in the SAFE direction — demotion wins', () => {
    // Real on a 30Hz display: a vsync-pinned 33.4ms frame is over the 33.3ms budget AND leaves the
    // CPU under 40% of the interval, so `overBudget` and `hasHeadroom` are both true. Demotion has
    // the shorter hold, so it fires first, and the sticky flag then ends the argument.
    const both = { ...profile({ frameMs: 33.4, cpuMs: 8, vsyncBound: true }), overBudget: true };
    const s = freshTierChangeState();
    const a = evaluateTierChange('mid', both, s, 1000, UNCAPPED);
    const b = evaluateTierChange('mid', both, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'low' });
    expect(b.state.demoted).toBe(true);
  });

  it('never promotes after a demotion, from any rung', () => {
    const s = { ...freshTierChangeState(), demoted: true };
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED);
    const b = evaluateTierChange('mid', roomy, a.state, 1000 + PROMOTION_HOLD_MS * 4, UNCAPPED);
    expect(b.decision.action).toBe('none');
  });
});

describe('tier settings', () => {
  it('low strips AA + shadows + resolution, and drops IBL (#154)', () => {
    expect(TIER_SETTINGS.low).toMatchObject({
      pixelRatioCap: 1, antialias: false, shadows: false, ibl: false,
    });
  });

  it('mid loosens ONLY what was measured, and keeps the rest at low\'s values (#188)', () => {
    // Each field is either measured on a mid-band device or a deliberate carry-forward; none is
    // invented. IBL because the A23 affords it (+2.9ms GPU inside 60fps); shadows because the band
    // is 10x the Y6; post-FX off because an iPhone 8 — squarely mid-band — goes 27ms -> 56ms on
    // NPR alone. Resolution and AA stay at `low` because nothing has measured them here, which
    // costs nothing today: every mid-band device currently resolves `low` anyway.
    expect(TIER_SETTINGS.mid).toMatchObject({
      ibl: true, shadows: true, postFX: NO_POSTFX, pixelRatioCap: 1, antialias: false,
    });
  });

  it('mid sits strictly between the two on every knob it changes', () => {
    // The property that makes it a LADDER rather than three unrelated presets. A knob that went
    // the wrong way at `mid` would make a promotion cost more than the tier it left.
    expect(TIER_SETTINGS.mid.shadowMapCeiling).toBeGreaterThan(TIER_SETTINGS.low.shadowMapCeiling);
    expect(TIER_SETTINGS.high.shadowMapCeiling).toBe(0); // 0 = no ceiling, i.e. the loosest
    expect(TIER_SETTINGS.mid.maxDirectional).toBeGreaterThan(TIER_SETTINGS.low.maxDirectional);
    expect(TIER_SETTINGS.mid.maxLocal).toBeGreaterThan(TIER_SETTINGS.low.maxLocal);
    expect(TIER_SETTINGS.high.maxDirectional).toBe(0); // 0 = unlimited
    expect(tierAllowsIBL(TIER_SETTINGS.mid)).toBe(true);
    expect(tierAllowsEffect(TIER_SETTINGS.mid, 'npr')).toBe(false);
  });

  it('clamps a mid shadow map to 1024 — above the measured-unusable 512, below high', () => {
    expect(tierShadowMapSize(2048, TIER_SETTINGS.mid)).toBe(1024);
    expect(tierShadowMapSize(512, TIER_SETTINGS.mid)).toBe(512);   // never UPSCALES
  });

  it('mid needs no IBL compensation, because it has IBL', () => {
    expect(tierAmbientBoost(TIER_SETTINGS.mid)).toBe(1);
    expect(tierExposureBoost(TIER_SETTINGS.mid)).toBe(1);
  });

  it('high leaves the current defaults alone', () => {
    expect(TIER_SETTINGS.high).toMatchObject({ pixelRatioCap: 2, antialias: true, shadows: true });
  });

  it('clamps an authored shadow map to the tier ceiling', () => {
    // Light.shadowMapSize is a per-light trait with no global cap, so a tier could not otherwise
    // enforce "shadows, but smaller".
    expect(tierShadowMapSize(2048, TIER_SETTINGS.low)).toBe(512);
    expect(tierShadowMapSize(256, TIER_SETTINGS.low)).toBe(256);   // never UPSCALES an authored value
  });

  it('high imposes no shadow ceiling', () => {
    expect(tierShadowMapSize(4096, TIER_SETTINGS.high)).toBe(4096);
  });

  // §0b "Shadows on `low` would render ACNE" (docs/plans/low-end-device-support.md) — a
  // clamped shadow map without a matching bias adjustment self-shadows. Bias scaling alone was
  // MEASURED on a Huawei Y6 not to make a clamped map look good (still dithered/under-sampled —
  // see the comment on `shadowBiasScale`); this is a texel-correctness fix, not a quality one.
  describe('shadowBiasScale — bias compensation for a clamped shadow map', () => {
    it('is exactly 1 when unclamped (high tier)', () => {
      expect(shadowBiasScale(2048, 2048)).toBe(1);
      // Even if the "actual" size is LARGER than authored (never happens in practice, but the
      // >= branch must not require exact equality).
      expect(shadowBiasScale(2048, 4096)).toBe(1);
    });

    it('scales by the clamp ratio — forest-camp\'s 2048 -> 512 repro', () => {
      expect(shadowBiasScale(2048, 512)).toBe(4);
    });

    it('scales by the clamp ratio — a milder 2048 -> 1024 clamp', () => {
      expect(shadowBiasScale(2048, 1024)).toBe(2);
    });

    it('falls back to 1 (no scaling) on degenerate inputs', () => {
      expect(shadowBiasScale(0, 512)).toBe(1);
      expect(shadowBiasScale(2048, 0)).toBe(1);
      expect(shadowBiasScale(-2048, 512)).toBe(1);
      expect(shadowBiasScale(2048, -512)).toBe(1);
    });
  });

  it('every tier has settings', () => {
    for (const t of ['low', 'high'] as QualityTier[]) expect(TIER_SETTINGS[t]).toBeDefined();
  });

  it('low drops every post-FX effect; high allows all of them (#121 P3c)', () => {
    // Post-FX is screen-space, so its cost is paid per pixel however simple the scene is — the
    // dominant remaining cost on a weak device (iPhone 8: 27ms baseline -> 56ms with NPR alone).
    for (const effect of POSTFX_EFFECTS) {
      expect(tierAllowsEffect(TIER_SETTINGS.low, effect)).toBe(false);
      expect(tierAllowsEffect(TIER_SETTINGS.high, effect)).toBe(true);
    }
  });

  // ── applyTierToThree (#121 P3a) ─────────────────────────────────────────────────────────
  // A TIER CLAMPS, IT NEVER RAISES. This is what makes wiring tiers up a no-op for every
  // existing project, and what stops `high` from overriding a deliberate authoring choice.
  describe('applyTierToThree', () => {
    const authored = { backend: 'auto', antialias: true, pixelRatioCap: 2, shadows: true, extra: 'kept' };

    it('TIER_SETTINGS.high leaves default settings byte-identical — the seed row is a no-op clamp', () => {
      expect(applyTierToThree(authored, TIER_SETTINGS.high)).toEqual(authored);
    });

    it('low takes everything away, resolution included (#154: 2x measured at 14 fps)', () => {
      expect(applyTierToThree(authored, TIER_SETTINGS.low)).toMatchObject({
        pixelRatioCap: 1, antialias: false, shadows: false,
      });
    });

    it('NEVER raises a value the project deliberately lowered', () => {
      // A project that authored a DPR cap of 1 / shadows off is not asking for more work just
      // because it landed on the high tier. Regression guard: `replace` semantics would silently
      // undo hand-tuned settings like sling's Y6 workaround (8e85b7b3).
      const lean = { ...authored, pixelRatioCap: 1, antialias: false, shadows: false };
      expect(applyTierToThree(lean, TIER_SETTINGS.high)).toMatchObject({
        pixelRatioCap: 1, antialias: false, shadows: false,
      });
    });

    it('preserves fields it does not own, and does not mutate the input', () => {
      const input = { ...authored };
      const out = applyTierToThree(input, TIER_SETTINGS.low);
      expect(out.extra).toBe('kept');
      expect(out.backend).toBe('auto');
      expect(input).toEqual(authored); // untouched
      expect(out).not.toBe(input);
    });

    // ⭐ Owner decision, 2026-08-11 (docs/rendering.md § "Quality tiers"): the DEFAULT
    // config is the ABSENCE of clamping, and `UNCLAMPED_OVERRIDES` — not `TIER_SETTINGS.high` — is
    // what production now resolves for it (`getActiveTierOverrides`). The two differ on EXACTLY
    // one field: `TIER_SETTINGS.high.pixelRatioCap` is 2, which is NOT a no-op against an authored
    // 3 — `Math.min(3, 2)` silently clamps it. `UNCLAMPED_OVERRIDES.pixelRatioCap` is `Infinity`,
    // which is a TRUE identity. This is the games/court bug (pixelRatioCap: 3 silently rendering
    // at 2 on every device that resolved `high`) pinned as a regression guard.
    it('the UNCLAMPED default is a TRUE identity — pixelRatioCap: 3 passes through unchanged', () => {
      const court = { backend: 'auto', antialias: true, pixelRatioCap: 3, shadows: true, extra: 'kept' };
      expect(applyTierToThree(court, UNCLAMPED_OVERRIDES)).toEqual(court);
      // The specific case `TIER_SETTINGS.high` would have gotten wrong:
      expect(applyTierToThree(court, TIER_SETTINGS.high).pixelRatioCap).toBe(2); // the OLD bug
      expect(applyTierToThree(court, UNCLAMPED_OVERRIDES).pixelRatioCap).toBe(3); // the FIX
    });
  });
});

describe('IBL tier gate (#154) — the single biggest render cost on a low-end device', () => {
  it('allows IBL on high and suppresses it on low', () => {
    expect(tierAllowsIBL(TIER_SETTINGS.high)).toBe(true);
    expect(tierAllowsIBL(TIER_SETTINGS.low)).toBe(false);
  });

  it('leaves the authored lighting completely untouched on high', () => {
    // Boosts are multipliers, so 1 means "pass the authored value through". A tier that keeps IBL
    // must not also brighten the scene — that would double-light it.
    expect(tierAmbientBoost(TIER_SETTINGS.high)).toBe(1);
    expect(tierExposureBoost(TIER_SETTINGS.high)).toBe(1);
  });

  it('compensates on low, where IBL is off — otherwise the scene renders dark and flat', () => {
    expect(tierAmbientBoost(TIER_SETTINGS.low)).toBeGreaterThan(1);
    expect(tierExposureBoost(TIER_SETTINGS.low)).toBeGreaterThan(1);
  });

  it('keeps the compensation tied to the gate, not hardcoded per tier', () => {
    // The accessors must return 1 whenever `ibl` is true, for ANY tier — so flipping a tier's
    // `ibl` back on cannot leave a stale brightening multiplier behind.
    for (const tier of ['low', 'high'] as QualityTier[]) {
      const o = TIER_SETTINGS[tier];
      if (o.ibl) {
        expect(tierAmbientBoost(o)).toBe(1);
        expect(tierExposureBoost(o)).toBe(1);
      } else {
        expect(tierAmbientBoost(o)).toBe(o.iblOffAmbientBoost);
        expect(tierExposureBoost(o)).toBe(o.iblOffExposure);
      }
    }
  });
});

describe('the prewarm must model the tier it will DRAW, not the scene as authored (#154)', () => {
  it('a tier with IBL off must not mirror the environment into the prewarm scene', () => {
    // Regression guard for a real bug in the IBL gate's first version. `prewarmShadersForWorld`
    // mirrors scene.environment so compileAsync produces the envMap shader variant; with IBL
    // suppressed the real render has NO environment, so mirroring it compiles a variant that is
    // never used AND leaves the first real frame to compile the non-env one synchronously —
    // reintroducing exactly the cold-compile boot stall the mirror exists to prevent (measured at
    // 3926 ms on the Y6). The gate and the mirror must read the SAME predicate.
    expect(tierAllowsIBL(TIER_SETTINGS.low)).toBe(false);
    expect(tierAllowsIBL(TIER_SETTINGS.high)).toBe(true);
  });
});

// ── Authored tier configs (docs/rendering.md § "Quality tiers") ────────────────────────────────
// A project starts with ONE config — the default, which is what it authored — and adds `mid`/
// `low` only if it wants degradation. `TIER_SETTINGS` above stops being live policy and becomes
// the SEED an added config starts from.

describe('resolveTierOverrides — falls DOWN to the nearest authored config, never up', () => {
  it('every tier resolves the UNCLAMPED default when the project has authored NOTHING', () => {
    for (const tier of TIER_ORDER) {
      expect(resolveTierOverrides(tier, undefined)).toBe(UNCLAMPED_OVERRIDES);
    }
    // Same for an explicitly empty (but present) AuthoredTiers object.
    for (const tier of TIER_ORDER) {
      expect(resolveTierOverrides(tier, {})).toBe(UNCLAMPED_OVERRIDES);
    }
  });

  it('`high` is NEVER authored — it always resolves the unclamped default', () => {
    const authored: AuthoredTiers = { mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low };
    expect(resolveTierOverrides('high', authored)).toBe(UNCLAMPED_OVERRIDES);
  });

  it('a `low` on a project that authored only `mid` FALLS to `mid`, not the default', () => {
    // The author's most conservative config is the closest thing to what they meant — reaching
    // for the unclamped default would hand the weakest hardware the settings they were explicitly
    // degrading away from.
    const mid: TierRenderOverrides = { ...TIER_SETTINGS.mid };
    const authored: AuthoredTiers = { mid };
    expect(resolveTierOverrides('mid', authored)).toBe(mid);
    expect(resolveTierOverrides('low', authored)).toBe(mid);
  });

  it('a project that authored only `low` leaves `mid` at the unclamped default', () => {
    // `low` does not backfill `mid` — falling down only ever reaches for what was actually
    // authored at or below the requested tier's own rung.
    const low: TierRenderOverrides = { ...TIER_SETTINGS.low };
    const authored: AuthoredTiers = { low };
    expect(resolveTierOverrides('low', authored)).toBe(low);
    expect(resolveTierOverrides('mid', authored)).toBe(UNCLAMPED_OVERRIDES);
  });

  it('with both authored, each tier gets its OWN config', () => {
    const mid: TierRenderOverrides = { ...TIER_SETTINGS.mid };
    const low: TierRenderOverrides = { ...TIER_SETTINGS.low };
    const authored: AuthoredTiers = { mid, low };
    expect(resolveTierOverrides('mid', authored)).toBe(mid);
    expect(resolveTierOverrides('low', authored)).toBe(low);
  });
});

describe('configCount — the boot-probe gate reads this (A2): >1 config is the only reason to probe', () => {
  it('is 1 with nothing authored — the default alone, so a probe could not change the outcome', () => {
    expect(configCount(undefined)).toBe(1);
    expect(configCount({})).toBe(1);
  });

  it('is 2 with exactly one tier authored, either one', () => {
    expect(configCount({ mid: TIER_SETTINGS.mid })).toBe(2);
    expect(configCount({ low: TIER_SETTINGS.low })).toBe(2);
  });

  it('is 3 with both authored', () => {
    expect(configCount({ mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low })).toBe(3);
  });
});

describe('maskPostFXRequest — the tier FILTERS the frame\'s request, per effect (owner, 2026-08-11)', () => {
  it('keeps allowed effects and drops disallowed ones', () => {
    const mask: PostFXMask = { npr: false, ao: true, dof: false, bloom: true, vignette: false };
    const overrides: TierRenderOverrides = { ...UNCLAMPED_OVERRIDES, postFX: mask };
    const req: Record<string, unknown> = { npr: { fake: 'npr-config' }, ao: { fake: 'ao-config' }, bloom: { fake: 'bloom-config' } };
    const out = maskPostFXRequest(req, overrides);
    // npr was disallowed and present -> dropped. ao/bloom were allowed and present -> kept.
    // dof/vignette were disallowed but ABSENT to start -> masking must not ADD keys.
    expect(out).toEqual({ ao: { fake: 'ao-config' }, bloom: { fake: 'bloom-config' } });
    expect(out).toBe(req); // mutates + returns the same object, per its own doc comment
  });

  it('is a no-op under ALL_POSTFX, and empties the request under NO_POSTFX', () => {
    const full = { npr: 1, ao: 1, dof: 1, bloom: 1, vignette: 1 };
    expect(maskPostFXRequest({ ...full }, { ...UNCLAMPED_OVERRIDES, postFX: ALL_POSTFX })).toEqual(full);
    expect(maskPostFXRequest({ ...full }, { ...UNCLAMPED_OVERRIDES, postFX: NO_POSTFX })).toEqual({});
  });
});

// ── Verify by PERTURBING (not just green tests) ─────────────────────────────────────────────
// A value that coincides with either the old TIER_SETTINGS seed or the unclamped default cannot
// tell "read" from "ignored" — these three pick an authored value that would produce a WRONG
// answer under EITHER wrong source, so only an actually-wired read path can pass.
describe('verify by PERTURBING — an authored value the accessor must actually follow', () => {
  it('ibl: an authored `mid` flips IBL OFF, where both TIER_SETTINGS.mid AND the default are ON', () => {
    expect(TIER_SETTINGS.mid.ibl).toBe(true);
    expect(UNCLAMPED_OVERRIDES.ibl).toBe(true);
    const authoredMid: TierRenderOverrides = { ...TIER_SETTINGS.mid, ibl: false };
    const resolved = resolveTierOverrides('mid', { mid: authoredMid });
    // Falling back to EITHER TIER_SETTINGS.mid OR the unclamped default would read `true` here —
    // only actually reading the authored object produces `false`.
    expect(tierAllowsIBL(resolved)).toBe(false);
  });

  it('shadowMapCeiling: an authored value that is neither the seed rows nor the unclamped 0', () => {
    const CUSTOM = 777;
    expect(TIER_SETTINGS.mid.shadowMapCeiling).not.toBe(CUSTOM);
    expect(TIER_SETTINGS.low.shadowMapCeiling).not.toBe(CUSTOM);
    expect(UNCLAMPED_OVERRIDES.shadowMapCeiling).not.toBe(CUSTOM);
    const authoredMid: TierRenderOverrides = { ...TIER_SETTINGS.mid, shadowMapCeiling: CUSTOM };
    const resolved = resolveTierOverrides('mid', { mid: authoredMid });
    expect(tierShadowMapSize(2048, resolved)).toBe(CUSTOM);
  });

  it('a post-FX effect: an authored `low` turns bloom ON, distinguishing it from the seed\'s NO_POSTFX', () => {
    // The failure mode this specifically guards: a per-effect mask that was actually wired as
    // "still reads the OLD all-or-nothing TIER_SETTINGS.low.postFX" would show every effect off,
    // silently discarding the whole per-effect refinement §3 exists for.
    expect(TIER_SETTINGS.low.postFX.bloom).toBe(false);
    const authoredLow: TierRenderOverrides = {
      ...TIER_SETTINGS.low, postFX: { ...NO_POSTFX, bloom: true },
    };
    const resolved = resolveTierOverrides('low', { low: authoredLow });
    expect(tierAllowsEffect(resolved, 'bloom')).toBe(true);
    expect(tierAllowsEffect(resolved, 'npr')).toBe(false); // the rest of the authored mask still applies
  });
});

// ── The 2D layer and the frame cap (#202) ──────────────────────────────────────────────────

describe('applyTierToTargetFps — `0` means UNCAPPED on both sides, so `Math.min` is wrong', () => {
  const withCap = (targetFps: number): TierRenderOverrides => ({ ...UNCLAMPED_OVERRIDES, targetFps });

  it('a tier cap of 0 leaves the project`s authored value alone — the identity', () => {
    // THE BUG THIS EXISTS TO PREVENT: `Math.min(60, 0)` is 0, and 0 means UNCAPPED — so a naive
    // clamp would silently REMOVE the project's own 60 cap on every tier that does not set one.
    expect(applyTierToTargetFps(60, UNCLAMPED_OVERRIDES)).toBe(60);
    expect(applyTierToTargetFps(60, withCap(0))).toBe(60);
    expect(applyTierToTargetFps(30, withCap(0))).toBe(30);
  });

  it('an authored 0 (uncapped) is CAPPED by the tier — the other half of the same trap', () => {
    // And `Math.min(0, 30)` is 0, which would mean "uncapped" — i.e. the field would read as wired
    // and do nothing on exactly the projects that left `targetFps` at its default.
    expect(applyTierToTargetFps(0, withCap(30))).toBe(30);
  });

  it('the tighter of the two wins in both directions', () => {
    expect(applyTierToTargetFps(60, withCap(30))).toBe(30); // the tier is tighter
    expect(applyTierToTargetFps(24, withCap(30))).toBe(24); // the project is tighter — a tier
                                                            // CLAMPS, it never raises
  });

  it('uncapped on both sides round-trips to the 0 a config actually stores, not Infinity', () => {
    // The result is written back through `setTargetFPS`, where a non-finite value would be a live
    // `1000 / Infinity` interval rather than the uncapped branch.
    expect(applyTierToTargetFps(0, withCap(0))).toBe(0);
    expect(Number.isFinite(applyTierToTargetFps(0, UNCLAMPED_OVERRIDES))).toBe(true);
  });

  it('`low` seeds 30 and `mid` seeds none — the owner`s decision, pinned', () => {
    // ⚠️ `low`'s 30 is the ONE seeded value in the tier tables that is a deliberate behaviour
    // change rather than a carry-forward of what the fleet already did (owner, 2026-08-11). If
    // this assertion is ever relaxed, that decision is being reversed — do it deliberately.
    expect(TIER_SETTINGS.low.targetFps).toBe(30);
    expect(TIER_SETTINGS.mid.targetFps).toBe(0);
    expect(applyTierToTargetFps(60, TIER_SETTINGS.low)).toBe(30);
    expect(applyTierToTargetFps(60, TIER_SETTINGS.mid)).toBe(60);
  });
});

describe('applyTierToPixi — the 2D layer was untiered until #202', () => {
  const authored = { antialias: true, pixelRatioCap: 3, resolution: 0, backend: 'auto' as const };

  it('the unclamped default is a true identity', () => {
    expect(applyTierToPixi(authored, UNCLAMPED_OVERRIDES)).toEqual(authored);
  });

  it('clamps DPR and AA on `low` — the Y6 fill-rate measurement, applied to a Pixi canvas', () => {
    // court authors `pixi.pixelRatioCap: 3`; on `low` it must render at 1, the same value the 3D
    // layer has always clamped to, for the same reason (~4x cost for 2x DPR on a fill-bound GPU).
    expect(applyTierToPixi(authored, TIER_SETTINGS.low)).toMatchObject({
      pixelRatioCap: 1, antialias: false,
    });
  });

  it('never RAISES what the project authored — a tier only clamps', () => {
    const lean = { ...authored, antialias: false, pixelRatioCap: 1 };
    expect(applyTierToPixi(lean, UNCLAMPED_OVERRIDES)).toMatchObject({
      pixelRatioCap: 1, antialias: false,
    });
    expect(applyTierToPixi(lean, TIER_SETTINGS.high)).toMatchObject({ pixelRatioCap: 1 });
  });

  it('treats an authored cap of 0 as UNCAPPED, not as the tightest possible cap', () => {
    // `computeBackingSize` documents `<= 0` as uncapped and warns that 0 is the value a human
    // types by analogy with `pixi.resolution`'s "0 = auto". A bare `Math.min` would read that as
    // a cap of zero and shrink the backing buffer to nothing.
    expect(applyTierToPixi({ ...authored, pixelRatioCap: 0 }, TIER_SETTINGS.low).pixelRatioCap).toBe(1);
    expect(applyTierToPixi({ ...authored, pixelRatioCap: 0 }, UNCLAMPED_OVERRIDES).pixelRatioCap).toBe(0);
  });

  it('passes `resolution` and `backend` through untouched — neither is tier-clampable', () => {
    // A pinned resolution is never capped (capping a pin would make the pin a lie), and forcing a
    // backend on a weak device is a correctness risk rather than a saving.
    const pinned = { ...authored, resolution: 2 };
    const out = applyTierToPixi(pinned, TIER_SETTINGS.low);
    expect(out.resolution).toBe(2);
    expect(out.backend).toBe('auto');
  });

  it('does not mutate the caller`s settings', () => {
    const input = { ...authored };
    applyTierToPixi(input, TIER_SETTINGS.low);
    expect(input).toEqual(authored);
  });
});

describe('resolveTierOverrides — a config written before a field existed (#202)', () => {
  /** Exactly the shape A4 seeded into 22 project configs: the ten fields that existed then, and
   *  none of the three added by #202. This is not a hypothetical — every seeded project reached
   *  #202 in this state, and the seed script is idempotent, so nothing would have re-visited them. */
  const preFieldConfig = (): TierRenderOverrides => {
    const c = { ...TIER_SETTINGS.low } as Partial<TierRenderOverrides>;
    delete c.targetFps; delete c.pixiPixelRatioCap; delete c.pixiAntialias;
    return c as TierRenderOverrides;
  };

  it('fills a missing field from the UNCLAMPED default — NOT undefined, and NOT NaN', () => {
    // ⚠️ THE FAILURE THIS GUARDS: `Math.min(3, undefined)` is NaN, so a backing buffer of NaN
    // pixels, silently, on the projects the feature is aimed at. Absent must mean "unclamped" —
    // a config written before a field existed cannot have meant to clamp it.
    const resolved = resolveTierOverrides('low', { low: preFieldConfig() });
    expect(resolved.targetFps).toBe(UNCLAMPED_OVERRIDES.targetFps);
    expect(resolved.pixiPixelRatioCap).toBe(UNCLAMPED_OVERRIDES.pixiPixelRatioCap);
    expect(resolved.pixiAntialias).toBe(UNCLAMPED_OVERRIDES.pixiAntialias);

    expect(applyTierToTargetFps(60, resolved)).toBe(60);
    expect(applyTierToPixi({ antialias: true, pixelRatioCap: 3 }, resolved)).toEqual({
      antialias: true, pixelRatioCap: 3,
    });
  });

  it('keeps every field the config DID author', () => {
    const resolved = resolveTierOverrides('low', { low: preFieldConfig() });
    expect(resolved.pixelRatioCap).toBe(TIER_SETTINGS.low.pixelRatioCap);
    expect(resolved.ibl).toBe(false);
    expect(resolved.shadowMapCeiling).toBe(512);
  });

  it('completes a PARTIAL postFX mask to "on", so a missing effect is not read as "off"', () => {
    const partial = { ...TIER_SETTINGS.low, postFX: { npr: false } as unknown as PostFXMask };
    const resolved = resolveTierOverrides('low', { low: partial });
    expect(tierAllowsEffect(resolved, 'npr')).toBe(false);   // authored
    expect(tierAllowsEffect(resolved, 'bloom')).toBe(true);  // absent -> unclamped, not off
  });

  it('returns a COMPLETE config as itself, so the identity callers rely on is preserved', () => {
    const low = { ...TIER_SETTINGS.low };
    expect(resolveTierOverrides('low', { low })).toBe(low);
  });

  it('completes the same object to the same result — no per-frame allocation', () => {
    // `getActiveTierOverrides()` runs per frame in the render loop; completing by spread on every
    // read would allocate two objects a frame per call site, on precisely the weak hardware these
    // tiers exist for.
    const low = preFieldConfig();
    expect(resolveTierOverrides('low', { low })).toBe(resolveTierOverrides('low', { low }));
  });
});

describe('applyTierToThree — the `0 = uncapped` sentinel (close-out finding)', () => {
  // ⚠️ REGRESSION GUARD. `three.pixelRatioCap` carries the SAME sentinel as its 2D twin —
  // `basePixelRatio` reads it as `cap > 0 ? min(dpr, cap) : dpr`, and Project Settings advertises
  // it to the author as `2 (0 = uncapped)`. This clamped with a bare `Math.min` until #202's
  // close-out, so `min(0, 1)` was 0, i.e. STILL UNCAPPED — the `low` tier's DPR clamp, the single
  // measured saving behind that whole row, did nothing on any project that authored 0.
  const authored = (pixelRatioCap: number) => ({ pixelRatioCap, antialias: true, shadows: true });

  it('an authored 0 IS capped by the tier — the bug', () => {
    expect(applyTierToThree(authored(0), TIER_SETTINGS.low).pixelRatioCap).toBe(1);
    expect(applyTierToThree(authored(0), TIER_SETTINGS.mid).pixelRatioCap).toBe(1);
  });

  it('an authored 0 stays uncapped under the unclamped default, and round-trips as 0', () => {
    // Not Infinity: the result is written back into a settings object that `basePixelRatio` reads,
    // where 0 is the value meaning "no cap" and a non-finite number is not a value it expects.
    expect(applyTierToThree(authored(0), UNCLAMPED_OVERRIDES).pixelRatioCap).toBe(0);
  });

  it('positive caps are unaffected — the pre-existing behaviour is preserved exactly', () => {
    expect(applyTierToThree(authored(3), TIER_SETTINGS.low).pixelRatioCap).toBe(1);
    expect(applyTierToThree(authored(3), UNCLAMPED_OVERRIDES).pixelRatioCap).toBe(3);
    expect(applyTierToThree(authored(1), UNCLAMPED_OVERRIDES).pixelRatioCap).toBe(1);
  });

  it('matches applyTierToPixi on the same inputs — one sentinel rule, both layers', () => {
    // The two fields have identical semantics; they diverged for as long as only one was swept.
    for (const cap of [0, 1, 2, 3]) {
      expect(applyTierToThree(authored(cap), TIER_SETTINGS.low).pixelRatioCap)
        .toBe(applyTierToPixi({ pixelRatioCap: cap, antialias: true }, TIER_SETTINGS.low).pixelRatioCap);
    }
  });
});
