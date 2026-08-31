/** Quality tiers (#121 P3) — `runtime/rendering/qualityTier.ts`.
 *
 *  Everything here is pure: `resolveTier` takes facts, `evaluateTierChange` takes a profile, a
 *  state and a clock reading. No probe, no timers, no waiting real seconds.
 *
 *  The assertion that matters most is the vsync one. Judging headroom by `frameMs` while
 *  vsync-bound would promote a device that has none — `frameMs` is pinned at the display
 *  interval there and reports "barely making 60" and "trivially making 60" identically. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveTier, evaluateTierChange, freshTierChangeState, promotionCeiling,
  PROMOTION_TARGET_SHARE, DEMOTION_CPU_SHARE,
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
  buildTierResolveInput, readCachedProbeVerdict,
  type TierRenderOverrides, type AuthoredTiers, type PostFXMask,
  type TierDefaultOverrides,
} from '../../src/runtime/rendering/qualityTier';
import {
  BUDGET_30FPS_MS, recordFrame, resetFrameProfile, setProfilerFrameCap, getFrameProfile,
  type FrameProfile,
} from '../../src/runtime/core/frameProfiler';
import { probeVerdictStore } from '../../src/runtime/core/probeVerdictStore';
import { probeFingerprint } from '../../src/runtime/rendering/rampProbe';

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
    // The threshold the fixture judged itself by — the demotion reason quotes it back.
    budgetMs: BUDGET_30FPS_MS,
    discontinuities: 0,
    worstStallMs: 0,
  };
}

/** The ceiling every test about the PROMOTION POLICY passes, so those tests keep asking their own
 *  question — does sustained headroom promote — rather than accidentally testing the cap. The cap
 *  has its own describe block below, and it is the only place a lower ceiling appears. */
const UNCAPPED: QualityTier = 'high';

/** The frame the tier ABOVE is asking for, in ms — what promotion is judged against since the
 *  headroom test stopped reading `frameMs` (owner, 2026-08-20). 60 fps is the fleet's default, so
 *  it is what most cases here mean by "the next tier"; the bar these tests must clear is therefore
 *  `T60 * PROMOTION_TARGET_SHARE` = 8.33 ms of engine CPU. Cases about a 30 fps next tier pass
 *  `T30` explicitly. */
const T60 = 1000 / 60;
const T30 = 1000 / 30;

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
    //
    // ⚠️ The renderer here must be one GPU IDENTITY CANNOT PLACE (#210). It used to read
    // `Mali-G57`, which is now a table hit resolving to `mid` — a realistic-looking string stopped
    // exercising this branch the moment the identity layer landed. Do not "improve" it back to a
    // real GPU name.
    const r = resolveTier({ platform: 'android', projectSetting: 'auto', gpuRenderer: 'Vivante GC7000' });
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

  it('falls through to calibrating when neither the allowlist NOR gpu identity matches', () => {
    withAllowlist(() => {
      // ⚠️ `Adreno (TM) 610` used to stand in for "no match" and is now a table hit (#210). The
      // fall-through needs a renderer BOTH layers decline — see the note in the unrecognised-device
      // test above.
      const r = resolveTier({
        platform: 'android', gpuRenderer: 'Vivante GC7000', projectSetting: 'auto',
      });
      expect(r.source).toBe('calibrating');
    }, [{ pattern: /Adreno \(TM\) 619/, tier: 'high' }]);
  });
});

describe('resolveTier — GPU identity (#210)', () => {
  it('classifies the two real Android anchors from the string alone, with no probe', () => {
    // The whole point: this is the launch-#1 answer, and `probeClass` is absent in both calls.
    expect(resolveTier({
      platform: 'android', projectSetting: 'auto',
      gpuRenderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)',
    })).toMatchObject({ tier: 'high', source: 'gpu-benchmark' });

    expect(resolveTier({ platform: 'android', projectSetting: 'auto', gpuRenderer: 'Mali-G57 MC2' }))
      .toMatchObject({ tier: 'mid', source: 'gpu-benchmark' });
  });

  it('⚠️ a DESKTOP is decided before the table, which is mobile', () => {
    // The vendored table carries mobile Intel/NVIDIA parts, and a desktop reporting an integrated
    // Intel GPU matches a row reading 30 — so the wrong order silently DEMOTES an authoring
    // machine to `mid`. This is the assertion that pins the placement.
    expect(resolveTier({
      platform: 'web', projectSetting: 'auto', formFactor: 'desktop',
      gpuRenderer: 'Intel Mesa DRI Intel HD Graphics 5500',
    })).toMatchObject({ tier: 'high', source: 'desktop' });
  });

  it('identity BEATS the probe — it is right on launch #1 and the probe is not', () => {
    // A device the probe measured as `weak` but whose GPU we have data for. Identity wins, because
    // the probe's verdict is a boot-contaminated median that needs three launches to settle.
    expect(resolveTier({
      platform: 'android', projectSetting: 'auto',
      gpuRenderer: 'Adreno (TM) 730', probeClass: 'weak',
    })).toMatchObject({ tier: 'high', source: 'gpu-benchmark' });
  });

  it('hands an unplaceable GPU to the probe rather than guessing', () => {
    // Adding the identity layer must only move devices that had NO confident answer. A string it
    // declines lands exactly where it landed before.
    expect(resolveTier({
      platform: 'android', projectSetting: 'auto',
      gpuRenderer: 'Vivante GC7000', probeClass: 'middle',
    })).toMatchObject({ tier: 'mid', source: 'measured' });
  });

  it('a hand-written allowlist entry still outranks the table', () => {
    // The allowlist is the escape hatch for a device we learn is misclassified, so it has to win.
    withAllowlist(() => {
      expect(resolveTier({
        platform: 'android', projectSetting: 'auto', gpuRenderer: 'Adreno (TM) 730',
      })).toMatchObject({ tier: 'low', source: 'allowlist' });
    }, [{ pattern: /Adreno \(TM\) 730/, tier: 'low' }]);
  });

  it('⭐ SKIPS THE LAUNCH-BLOCKING PROBE — this is the condition scene3DSync branches on', () => {
    // `resolveActiveTierOnce` resolves once with `useProbe: false` and only pays for the ramp when
    // that comes back `'calibrating'`. So "a recognised GPU costs no launch time" is not a separate
    // mechanism to build — it is exactly this assertion, and it is the whole first-impression win
    // (0.5-2.6 s of blocked launch, on every Android device, gone).
    const cheap = resolveTier(buildTierResolveInput(
      { platform: 'android', gpuRenderer: 'Adreno (TM) 730', formFactor: 'mobile' },
      'auto',
      { useProbe: false },
    ));
    expect(cheap.source).not.toBe('calibrating');
    expect(cheap).toMatchObject({ tier: 'high', source: 'gpu-benchmark' });

    // ...and the converse, or the assertion above would pass for the wrong reason: a GPU identity
    // cannot place still reaches the probe.
    const unknown = resolveTier(buildTierResolveInput(
      { platform: 'android', gpuRenderer: 'Vivante GC7000', formFactor: 'mobile' },
      'auto',
      { useProbe: false },
    ));
    expect(unknown.source).toBe('calibrating');
  });

  it('iOS still answers from the model id, never from the masked renderer string', () => {
    // WebGL reports `Apple GPU` on every iPhone, so identity declines by design and the model
    // table — which is strictly better — keeps the decision.
    expect(resolveTier({
      platform: 'ios', projectSetting: 'auto', deviceModel: 'iPhone14,2', gpuRenderer: 'Apple GPU',
    })).toMatchObject({ source: 'model' });
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

describe('buildTierResolveInput — the ONE input builder both boot and player Auto go through', () => {
  // ⚠️ THE DEFECT THIS EXISTS FOR: `choosePlayerQualityTier(null)` used to hand-assemble its own
  // input and simply omit `probeClass`, so a device the boot probe had measured got no credit for
  // it the moment its player tapped "Auto". A single builder means a caller cannot forget the
  // field — see (4)'s test in playerQualityTier.test.ts for the end-to-end shape of that bug.
  const caps = { platform: 'android', deviceModel: 'SM-S901U1', gpuRenderer: 'Adreno (TM) 730' };

  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const viewportPx = (g.innerWidth ?? 0) * (g.innerHeight ?? 0);
  const matchingFingerprint = probeFingerprint({ ...caps, viewportPx });

  afterEach(() => probeVerdictStore.reset());

  it('carries the cached verdict when the fingerprint matches this device', () => {
    probeVerdictStore.provide({
      read: () => ({ fingerprint: matchingFingerprint, deviceClass: 'middle', samples: [], final: true }),
      write: () => {},
      session: () => undefined,
    });
    const input = buildTierResolveInput(caps, 'auto');
    expect(input.probeClass).toBe('middle');
  });

  it('omits the verdict when the fingerprint does NOT match — different hardware, not this device\'s answer', () => {
    probeVerdictStore.provide({
      read: () => ({ fingerprint: 'v3|android|SM-OTHER||100', deviceClass: 'capable', samples: [], final: true }),
      write: () => {},
      session: () => undefined,
    });
    const input = buildTierResolveInput(caps, 'auto');
    expect(input.probeClass).toBeUndefined();
  });

  it('`useProbe: false` omits the probe class even when a matching verdict exists — boot\'s deliberate first pass', () => {
    probeVerdictStore.provide({
      read: () => ({ fingerprint: matchingFingerprint, deviceClass: 'middle', samples: [], final: true }),
      write: () => {},
      session: () => undefined,
    });
    const input = buildTierResolveInput(caps, 'auto', { useProbe: false });
    expect(input.probeClass).toBeUndefined();
  });

  it('an explicit `opts.probeClass` overrides the cache — boot\'s fresher-than-cache measurement', () => {
    probeVerdictStore.provide({
      read: () => ({ fingerprint: matchingFingerprint, deviceClass: 'weak', samples: [], final: true }),
      write: () => {},
      session: () => undefined,
    });
    const input = buildTierResolveInput(caps, 'auto', { probeClass: 'capable' });
    expect(input.probeClass).toBe('capable');
  });
});

describe('readCachedProbeVerdict', () => {
  const caps = { platform: 'android', deviceModel: 'SM-S901U1', gpuRenderer: 'Adreno (TM) 730' };
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const viewportPx = (g.innerWidth ?? 0) * (g.innerHeight ?? 0);
  const matchingFingerprint = probeFingerprint({ ...caps, viewportPx });

  afterEach(() => probeVerdictStore.reset());

  it('returns undefined with no provider installed', () => {
    probeVerdictStore.reset();
    expect(readCachedProbeVerdict(caps)).toBeUndefined();
  });

  it('returns the cached class on a fingerprint match', () => {
    probeVerdictStore.provide({
      read: () => ({ fingerprint: matchingFingerprint, deviceClass: 'capable', samples: [], final: true }),
      write: () => {},
      session: () => undefined,
    });
    expect(readCachedProbeVerdict(caps)?.deviceClass).toBe('capable');
  });

  it('⭐ recomputes cpuLimited from the stored SAMPLES, not from a stored flag (#205)', () => {
    // A `middle` device whose stored samples clear the capable SHADE floor and miss its cpu floor.
    // The licence must survive a relaunch, and it must survive a threshold change — which is why
    // it is derived here rather than persisted beside the band. If this ever reads `false` on a
    // cache hit, a device promoted on launch 1 silently stops being promotable on launch 2.
    probeVerdictStore.provide({
      read: () => ({
        fingerprint: matchingFingerprint,
        deviceClass: 'middle',
        samples: [{ cpuUnitsPerMs: 5_000, shadeMfragPerMs: 0.5, fillMpxPerMs: 0 }],
        final: true,
      }),
      write: () => {},
      session: () => undefined,
    });

    const cached = readCachedProbeVerdict(caps);

    expect(cached?.deviceClass).toBe('middle');
    expect(cached?.cpuLimited).toBe(true);
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
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED, T60);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS - 1, UNCAPPED, T60);
    expect(b.decision.action).toBe('none');
  });

  it('promotes once headroom has held', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision.action).toBe('promote');
  });

  it('a single bad sample RESETS the streak — one lucky second is not evidence', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', profile({ frameMs: 60, cpuMs: 50 }), a.state, 2000, UNCAPPED, T60);
    expect(b.state.headroomSince).toBe(0);
    const c = evaluateTierChange('low', roomy, b.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60);
    expect(c.decision.action).toBe('none'); // streak restarted, hold not yet met
  });

  it('will not judge on too few samples', () => {
    const thin = profile({ frameMs: 10, cpuMs: 4, samples: MIN_SAMPLES_TO_JUDGE - 1 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', thin, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', thin, a.state, 1000 + PROMOTION_HOLD_MS * 3, UNCAPPED, T60);
    expect(b.decision.action).toBe('none');
  });
});

describe('evaluateTierChange — promotion is judged on CPU against the NEXT tier\'s frame', () => {
  // ⚠️ THIS BLOCK WAS "the vsync-bound signal switch" AND THE SWITCH IS GONE (owner, 2026-08-20).
  // Promotion used to read `frameMs` and needed `vsyncBound` to know which regime the interval was
  // in; `vsyncBound` is a guess assembled from a hardcoded list of display rates, and a phone whose
  // panel idles to 24 Hz (an LTPO S22 does) is in no listed regime at all. The interval is set by
  // whatever paces the frame — workload, our cap, or the display — and only the first is ours. So
  // the question is now "would our work fit in the frame the tier above asks for", and these cases
  // still hold because they were always really about `cpuMs`; only the reason they hold changed.
  it('promotes a device that is barely working', () => {
    // 3ms of CPU against a 16.7ms next-tier frame — under the 8.33ms bar, genuinely promotable.
    const idle = profile({ frameMs: 1000 / 60, cpuMs: 3, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', idle, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', idle, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision.action).toBe('promote');
    expect(b.decision).toMatchObject({ reason: expect.stringContaining('cpu') });
  });

  it('does NOT promote a GPU-bound device just because its CPU is idle', () => {
    // ⚠️ THE HOLE THE CPU-ONLY RULE OPENED, found in close-out the same day it landed. Judging
    // promotion purely on `cpuMs` means a frame can be catastrophic for reasons the CPU never
    // sees — `promotionCeiling` says it outright ("a CPU streak cannot see a GPU-bound frame")
    // and is only allowed to ignore it where the GPU axis already cleared the band above.
    //
    // Not exotic, either: the Android GPU allowlist ships EMPTY, so `calibrating` is the ordinary
    // state there and such a device boots `low` with a ceiling of `mid`. At ~100 ms frames with
    // 5 ms of CPU it clears the 8.3 ms bar, promotes into a tier that renders it slower still —
    // and cannot come back, because `frameIsFull` reads that same idle CPU and refuses to demote.
    // One-way, sticky, and in the direction that hurts.
    const gpuBound: FrameProfile = {
      ...profile({ frameMs: 100, cpuMs: 5 }), overBudget: true, budgetMs: 40,
    };
    const s = freshTierChangeState();
    let st = s;
    for (const t of [1000, 6000, 20000, 60000]) {
      const r = evaluateTierChange('low', gpuBound, st, t, UNCAPPED, T60);
      expect(r.decision.action).toBe('none');
      st = r.state;
    }
  });

  it('still promotes a device that is MEETING its budget with an idle CPU', () => {
    // The control for the guard above, so it cannot degrade into "never promote". Same idle CPU,
    // but the device is comfortably inside the budget it currently has — which is the entire
    // population the promotion path exists for. If this goes quiet, live promotion is dead again
    // (it already was, fleet-wide, before the #202 close-out).
    const comfortable: FrameProfile = {
      ...profile({ frameMs: 33.3, cpuMs: 5 }), overBudget: false, budgetMs: 40,
    };
    const a = evaluateTierChange('low', comfortable, freshTierChangeState(), 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', comfortable, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'promote' });
  });

  it('scales the promote bar with the NEXT tier\'s target, not the current one', () => {
    // ⭐ THE WHOLE POINT OF PASSING THE TARGET IN (owner, 2026-08-20: "current cpu time is less
    // than 16, and next tier target fps is 60, we should promote?"). The same 12ms of engine CPU
    // is promotable into a 30fps tier (33.3ms frame, 16.7ms bar) and is NOT promotable into a
    // 60fps one (16.7ms frame, 8.3ms bar) — because the device has to fit in the frame it is
    // moving TO, not the roomy one it is leaving. Judging by the CURRENT tier's frame is the
    // mistake this parameter exists to prevent: a `low` device on a 30fps cap would look idle
    // and get promoted into a 60fps tier it cannot hold.
    const p = profile({ frameMs: 33.3, cpuMs: 12 });
    const climb = (target: number) => {
      const a = evaluateTierChange('low', p, freshTierChangeState(), 1000, UNCAPPED, target);
      return evaluateTierChange('low', p, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, target)
        .decision.action;
    };
    expect(climb(T30)).toBe('promote');
    expect(climb(T60)).toBe('none');
  });

  it('cannot promote a device that would immediately qualify to demote', () => {
    // ⚠️ THE FLAP, and why the bar is HALF the next frame rather than "does it fit". Promotion and
    // demotion are judged against different references — the next tier's TARGET frame vs the
    // current tier's BUDGET — so nothing structurally stops them overlapping, and an overlap is
    // the worst outcome available: `demoted` is sticky, so a device would promote, re-qualify as
    // over-budget-and-full, demote, and land BELOW where it started, permanently.
    //
    // Asserted as a property over both targets rather than one fixture, so a later tweak to either
    // constant that reopens the gap fails here instead of on a phone.
    for (const targetMs of [T60, T30]) {
      const promoteBar = targetMs * PROMOTION_TARGET_SHARE;
      const demoteBar = (targetMs * 1.2) * DEMOTION_CPU_SHARE; // budgetMs is the target * 1.2
      expect(promoteBar).toBeLessThan(demoteBar);
    }
  });

  it('REFUSES to promote a device that is nearly out of frame', () => {
    // THE test, and it survives the rewrite unchanged. 15ms of CPU in a 16.7ms frame is a device
    // on the edge — but its `frameMs` is identical to the idle case above, so any rule reading the
    // interval promotes it and immediately blows the budget. Only `cpuMs` can tell these apart.
    const strained = profile({ frameMs: 1000 / 60, cpuMs: 15, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', strained, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('low', strained, a.state, 1000 + PROMOTION_HOLD_MS * 3, UNCAPPED, T60);
    expect(b.decision.action).toBe('none');
  });
});

describe('evaluateTierChange — promotion under the ENGINE\'S OWN frame cap (#202 close-out)', () => {
  // ⚠️ THE DEFECT THIS BLOCK EXISTS FOR. `low`'s seeded `targetFps: 30` made `frameMs.median`
  // land at ~33.3ms, which `isVsyncBound` could not recognise (it only knew display intervals) —
  // so a capped-and-comfortable device fell to the `frameMs <= BUDGET_30FPS_MS * 0.5` branch,
  // asking for <= 16.67ms under a 30fps cap. Unreachable. Promotion out of `low` was therefore
  // impossible fleet-wide, and every EXISTING promotion test in this file stayed green throughout
  // because they hand-set `vsyncBound: true` via the `profile()` fixture — a frame the `low` tier
  // could never actually produce. This block drives the REAL profiler (recordFrame +
  // setProfilerFrameCap) instead, so `vsyncBound` comes from `isVsyncBound()` like it does in
  // production.
  afterEach(() => setProfilerFrameCap(0));

  function realCappedProfile(cpuMs: number): FrameProfile {
    resetFrameProfile();
    setProfilerFrameCap(30);
    let t = 0;
    recordFrame(t, t + 1);
    for (let i = 0; i < 40; i++) {
      t += 1000 / 30;
      recordFrame(t, t + cpuMs);
    }
    return getFrameProfile();
  }

  it('a capped device with comfortable CPU headroom IS promotable — driven through the real profiler', () => {
    const p = realCappedProfile(4); // 4ms of CPU, well under the 8.33ms bar for a 60fps next tier
    // `vsyncBound` is still asserted, but as a statement about the PROFILER rather than about the
    // decision: since 2026-08-20 promotion does not read it at all. Kept because this block's value
    // is that it drives the real `recordFrame`/`setProfilerFrameCap` path instead of a hand-set
    // fixture — that is what made it catch #202, and it is still the only promotion test that does.
    expect(p.vsyncBound).toBe(true);
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', p, s, 1000, 'high', T60);
    const b = evaluateTierChange('low', p, a.state, 1000 + PROMOTION_HOLD_MS, 'high', T60);
    expect(b.decision.action).toBe('promote');
  });

  it('a capped device with NO cpu headroom does not promote — the cap alone is not evidence', () => {
    // Distinguishing control: same cap, same regime, only the CPU cost differs — 20ms is well past
    // the 8.33ms a 60fps next tier allows.
    const p = realCappedProfile(20);
    expect(p.vsyncBound).toBe(true);
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', p, s, 1000, 'high', T60);
    const b = evaluateTierChange('low', p, a.state, 1000 + PROMOTION_HOLD_MS * 3, 'high', T60);
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

  it('caps at what GPU IDENTITY answered — it is a lookup, not an inference (#210)', () => {
    // These two sources arrived with #210 and nothing pinned them. A device identified as `mid`
    // must not be promoted to `high` by a CPU-only streak, for exactly the reason the probe case
    // above gives — and more so, since identity is the MORE reliable signal of the two.
    expect(promotionCeiling(res('mid', 'gpu-benchmark'))).toBe('mid');
    expect(promotionCeiling(res('low', 'gpu-benchmark'))).toBe('low');
    expect(promotionCeiling(res('high', 'gpu-generation'))).toBe('high');
  });

  it('⛔ does NOT grant a GPU-limited probe verdict a promotion step (#210)', () => {
    // The tempting change, and why it is still refused for this case. #210 measured the probe
    // UNDER-reporting on Android (the S22 reads `middle` where identity and the truth say `high`),
    // which argues for letting a `measured` device climb. It is refused wherever the GPU is what
    // fell short, because `hasHeadroom` is CPU-ONLY and the SAME campaign measured why that is
    // fatal here: the Huawei Y6 sat at `cpu 1.7ms of an 18.6ms frame` — abundant CPU headroom
    // while the GPU was the limiter. Granting the step would promote GPU-bound devices into IBL
    // and post-FX on a signal that cannot see the GPU, the hole `promotionCeiling` closes (#188).
    //
    // ⚠️ `cpuLimited` UNSET is the default and means exactly this case — no licence.
    expect(promotionCeiling(res('mid', 'measured'))).toBe('mid');
    expect(promotionCeiling(res('low', 'measured'))).toBe('low');
    expect(promotionCeiling({ ...res('mid', 'measured'), cpuLimited: false })).toBe('mid');
  });

  it('⭐ DOES grant a CPU-LIMITED probe verdict exactly one step (#205, owner 2026-08-13)', () => {
    // The one crack in "a measurement is the ceiling", and it is narrow by construction:
    // `cpuLimited` is set only when the reading missed the next band on the CPU axis ALONE, with
    // the GPU axis already clear. So there is no GPU verdict being overruled — the objection in
    // the test above cannot arise — and the live signal (`hasHeadroom`, cpu-only) measures the
    // SAME quantity the boot probe under-read by a measured 20-30%.
    expect(promotionCeiling({ ...res('mid', 'measured'), cpuLimited: true })).toBe('high');
    expect(promotionCeiling({ ...res('low', 'measured'), cpuLimited: true })).toBe('mid');
  });

  it('the cpu-limited licence is ONE step, and never off the top of the ladder', () => {
    expect(promotionCeiling({ ...res('high', 'measured'), cpuLimited: true })).toBe('high');
  });

  it('the licence does NOT leak to any other source', () => {
    // `cpuLimited` is only ever set on a `measured` resolution, but a defensive check costs
    // nothing and this is the function where a stray flag would be most expensive: identity is
    // the MORE reliable signal of the two and must not be climbable.
    expect(promotionCeiling({ ...res('mid', 'gpu-benchmark'), cpuLimited: true })).toBe('mid');
    expect(promotionCeiling({ ...res('mid', 'model'), cpuLimited: true })).toBe('mid');
    expect(promotionCeiling({ ...res('mid', 'project'), cpuLimited: true })).toBe('mid');
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
    const a = evaluateTierChange(tier, roomy, freshTierChangeState(), 1000, ceiling, T60);
    return evaluateTierChange(tier, roomy, a.state, 1000 + PROMOTION_HOLD_MS, ceiling, T60);
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
    T60,
    );
    expect(noStreak.decision.action).toBe('none');
  });

  it('re-reports every hold period rather than once and never again', () => {
    // The policy has no memory, deliberately — deduping is the consumer's job (one log per
    // session). If this reset were dropped the streak would sit latched and the consumer would
    // see one `hold` on a device that is still capped minutes later.
    const first = held('mid', 'mid');
    expect(first.state.headroomSince).toBe(0);
    const again = evaluateTierChange('mid', roomy, first.state, 1000 + PROMOTION_HOLD_MS, 'mid', T60);
    expect(again.decision.action).toBe('none'); // streak restarted
    const later = evaluateTierChange('mid', roomy, again.state, 1000 + PROMOTION_HOLD_MS * 2, 'mid', T60);
    expect(later.decision.action).toBe('hold');
  });

  it('leaves DEMOTION completely alone — being wrong downward is the recoverable direction', () => {
    const drowning = profile({ frameMs: 60, cpuMs: 50 });
    const a = evaluateTierChange('high', drowning, freshTierChangeState(), 1000, 'low', T60);
    const b = evaluateTierChange('high', drowning, a.state, 1000 + DEMOTION_HOLD_MS, 'low', T60);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'mid' });
  });
});

describe('evaluateTierChange — demotion', () => {
  const slow = profile({ frameMs: 83, cpuMs: 48 }); // the Y6's measured profile

  it('demotes after sustained over-budget frames', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000, UNCAPPED, T60);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision.action).toBe('demote');
  });

  it('demotes FASTER than it promotes — an emergency, not an upgrade', () => {
    expect(DEMOTION_HOLD_MS).toBeLessThan(PROMOTION_HOLD_MS);
  });

  it('says which budget it actually missed, not a hardcoded 30 fps (close-out 2026-08-12)', () => {
    // ⚠️ THE DEFECT. `overBudget` reads the FRAME CAP in force (`frameProfiler.setProfilerFrameCap`),
    // so at the fleet's `targetFps: 60` the real threshold is 20 ms — but the reason string was
    // built from `BUDGET_30FPS_MS`, so a device demoting at a 22 ms median logged "22.0ms over the
    // 33.3ms budget": a sentence contradicting itself, on the one surface that exists to explain a
    // surprising tier. Restore the literal and this fails; nothing else does, which is the point —
    // the DECISION was right all along, only the account of it was wrong.
    // `cpuMs` is 18 rather than the original 12 because a demotion now requires the engine to be
    // FILLING the frame (`frameIsFull`) — 12 ms is below the bar for this fixture's 20 ms budget
    // (16.67 ms since 2026-08-22; it was 14 ms when this comment was written), so the old value
    // stopped reaching the branch whose REASON STRING this test is about. 18 clears either.
    const capped: FrameProfile = { ...profile({ frameMs: 22, cpuMs: 18 }), overBudget: true, budgetMs: 20 };
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', capped, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('high', capped, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'demote' });
    expect(b.decision).toMatchObject({ reason: expect.stringContaining('22.0ms over the 20.0ms budget') });
    expect(String((b.decision as { reason: string }).reason)).not.toContain('33.3');
  });

  it('a demotion is STICKY — never promote again, or the tier oscillates', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000, UNCAPPED, T60);
    const demoted = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(demoted.state.demoted).toBe(true);

    // Now on `low` it runs beautifully — which is exactly what the low tier was FOR. Promoting
    // back would return it to the settings that just failed, and it would flap between them.
    const roomy = profile({ frameMs: 10, cpuMs: 4 });
    let st = demoted.state;
    for (const t of [2000, 8000, 20000, 60000]) {
      const r = evaluateTierChange('low', roomy, st, t, UNCAPPED, T60);
      expect(r.decision.action).toBe('none');
      st = r.state;
    }
  });

  it('does NOT demote a frame the engine is not filling — the S22 adaptive-panel defect', () => {
    // ⚠️ THE MEASUREMENT, on a Galaxy S22 running `games/court` (2026-08-20). Its LTPO panel drops
    // 120 Hz → 24 Hz after ~20 s of static content, rAF follows, and `frameMs` becomes 41.6 ms —
    // 1000/24 — against a 20 ms budget while the engine uses 8.4 ms of it. `overBudget` alone
    // therefore said "slow device" about the fastest Android handset in the lab, demoting it
    // high → mid → low; promotion could not fire either (see the promotion block), so the session
    // never recovered in practice and the player got
    // pixelRatioCap 1 on a flagship. The numbers below are the ones read off the device.
    const panelPaced: FrameProfile = {
      ...profile({ frameMs: 41.6, cpuMs: 8.4 }), overBudget: true, budgetMs: 20,
    };
    const s = freshTierChangeState();
    let st = s;
    for (const t of [1000, 3000, 9000, 30000, 120000]) {
      const r = evaluateTierChange('high', panelPaced, st, t, UNCAPPED, T60);
      expect(r.decision.action).toBe('none');
      st = r.state;
    }
    expect(st.demoted).toBe(false);
  });

  it('demotes the Huawei Y6 2019 off `mid` — measured on the phone, at both tiers', () => {
    // ⚠️ THE ACCEPTED COST HAS A LIMIT, AND THIS IS WHERE IT SITS. `frameIsFull` declines to demote
    // a device whose CPU is idle, which raises the obvious worry: does that strand the weak hardware
    // this whole system exists for? Answered with the device rather than with arithmetic — Court was
    // installed on the Huawei Y6 2019 (API 28, PowerVR Rogue GE8300, throughput index 4.782 against
    // an S22's 143.244) on 2026-08-21 by temporarily lowering `androidMinSdk`, then PINNED to each
    // tier in turn with `quality.set` and profiled while being played:
    //
    //     low (30fps cap):   frame 33.2ms = 30.1 fps   cpu 20.7ms   rest 12.6ms   over? no
    //     mid (inherits 60): frame 22.0ms = 45.5 fps   cpu 20.5ms   rest  1.4ms   over? YES
    //
    // Court's `mid` authors `targetFps: 0`, so it inherits the project's 60 → budgetMs 20 → the
    // fullness bar is 14ms. The Y6 spends 20.5ms of engine CPU there, well past it: this device
    // demotes, and the guard is nowhere near wide enough to protect it from relief it needs.
    //
    // ⚠️ **THE Y6 IS CPU-BOUND, WHICH IS WHY A CPU BAR IS SAFE ON WEAK HARDWARE.** `restMs` on
    // `mid` is 1.4ms — the GPU is barely waited on; the engine's own main thread IS the frame. It
    // cannot reach 60 fps by arithmetic rather than by luck: 20.5ms of CPU does not fit in a
    // 16.67ms frame whatever the GPU does. On `low` it makes its 30 fps target exactly and is NOT
    // over budget, so nothing demotes it — the tier it boots into is already the right one.
    //
    // (On the phone the GPU table resolves `low` at boot and `promotionCeiling` pins it there, so
    // it logged zero `@tier` events all session. This is the `mid` case the ladder would take on a
    // device the table did not recognise.)
    //
    // ⚠️ An earlier version of this comment cited `frame 61.4ms / cpu 24.5ms` and called `low`
    // 16 fps. That sample was taken seconds after boot with a 1678ms stall inside the window. The
    // owner, watching the screen, said "when low, the game was running 30 fps constant" and was
    // right — a re-read on a settled window gives 33.2ms, p95 33.6, `vsyncBound: true`. Recorded
    // because the INSTRUMENT was what was wrong: a profiler read from a boot-adjacent window is
    // not evidence about steady-state play, however precise its decimals look.
    const y6OnMid: FrameProfile = {
      ...profile({ frameMs: 22, cpuMs: 20.5 }), overBudget: true, budgetMs: 20,
    };
    const a = evaluateTierChange('mid', y6OnMid, freshTierChangeState(), 1000, UNCAPPED, T60);
    const b = evaluateTierChange('mid', y6OnMid, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'low' });
  });

  it('still demotes when the engine IS filling the frame — the relief path is intact', () => {
    // The other half of the same rule, so the fix cannot be "never demote". A Y6-2019-shaped frame:
    // 83 ms with ~48 ms of it engine CPU (the measurement `frameProfiler`'s own docblock was
    // written from). That clears the fullness bar with room to spare and must still demote.
    const genuinelySlow: FrameProfile = {
      ...profile({ frameMs: 83, cpuMs: 48 }), overBudget: true, budgetMs: 20,
    };
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', genuinelySlow, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('high', genuinelySlow, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'mid' });
    expect(String((b.decision as { reason: string }).reason)).toContain('engine cpu 48.0ms');
  });

  it('scales the fullness bar with the TARGET FPS, not a fixed millisecond count', () => {
    // owner, 2026-08-20: "if the current target fps is 30, we should increase the threshold".
    // It is a ratio of the budget, and the budget is derived from the frame cap in force — so a
    // 30 fps project (budget 40 ms) demands 28 ms of engine CPU where a 60 fps one (budget 20 ms)
    // demands 14. The SAME 20 ms of CPU is therefore full at 60 fps and not full at 30 fps, which
    // is the whole point: at 30 fps that engine still has half its frame left.
    const at60: FrameProfile = { ...profile({ frameMs: 45, cpuMs: 20 }), overBudget: true, budgetMs: 20 };
    const at30: FrameProfile = { ...profile({ frameMs: 45, cpuMs: 20 }), overBudget: true, budgetMs: 40 };
    const step = (p: FrameProfile) => {
      const a = evaluateTierChange('high', p, freshTierChangeState(), 1000, UNCAPPED, T60);
      return evaluateTierChange('high', p, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60).decision.action;
    };
    expect(step(at60)).toBe('demote');
    expect(step(at30)).toBe('none');
  });

  it('does not demote a high-tier device that is merely near budget', () => {
    const fine = profile({ frameMs: BUDGET_30FPS_MS - 1, cpuMs: 10 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', fine, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('high', fine, a.state, 1000 + DEMOTION_HOLD_MS * 5, UNCAPPED, T60);
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
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('mid', roomy, a.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'promote', tier: 'high' });
  });

  it('demotes mid -> low', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('mid', drowning, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('mid', drowning, a.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60);
    expect(b.decision).toMatchObject({ action: 'demote', tier: 'low' });
  });

  it('demotes high -> mid, and low promotes to mid — one rung each way', () => {
    const s = freshTierChangeState();
    const d = evaluateTierChange('high', drowning, s, 1000, UNCAPPED, T60);
    expect(evaluateTierChange('high', drowning, d.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60).decision)
      .toMatchObject({ action: 'demote', tier: 'mid' });
    const u = evaluateTierChange('low', roomy, s, 1000, UNCAPPED, T60);
    expect(evaluateTierChange('low', roomy, u.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60).decision)
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
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('mid', roomy, a.state, 3000, UNCAPPED, T60);
    expect(b.state.headroomSince).toBe(1000);
  });

  it('promotion and demotion can never BOTH qualify — they are mutually exclusive now', () => {
    // ⚠️ THIS TEST HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND THE HISTORY IS THE POINT.
    //
    // v1 asserted a demotion on `frameMs: 33.4, cpuMs: 8, vsyncBound` — "real on a 30Hz display".
    // That is exactly the shape a panel produces when IT is pacing the frame, and it was defending
    // the S22 defect: the demotion it demanded is the one that put a flagship on `low`.
    //
    // v2 (same day) kept the "both true, demotion wins" claim with a fixture contrived to satisfy
    // both branches at once. That claim is now DEAD, structurally: promotion requires
    // `!overBudget` and demotion requires `overBudget`, so no profile can qualify for both. The
    // ordering rule it tested cannot be exercised because the situation it ordered cannot arise.
    //
    // So this asserts the stronger property instead — swept across the whole plausible space
    // rather than at one hand-picked point, because "these are exclusive" is a claim about ALL
    // profiles and a single fixture cannot make it.
    // ⚠️ A SWEEP ASSERTING "never both" IS VACUOUS IF NEITHER EVER FIRES, and nothing in the
    // assertion itself would say so — `false && false` passes exactly as loudly as a real
    // exclusion. So both outcomes are counted and required below; a future change that quietly
    // stopped either branch from ever qualifying fails here instead of leaving 90 green no-ops.
    let promoted = 0, demoted = 0;
    for (const frameMs of [8, 16, 22, 33.4, 41.6, 83]) {
      for (const cpuMs of [2, 8, 15, 28, 60]) {
        for (const budgetMs of [10, 20, 40]) {
          const p: FrameProfile = {
            ...profile({ frameMs, cpuMs }), overBudget: frameMs > budgetMs, budgetMs,
          };
          // Run each branch in isolation: `low` cannot demote, `high` cannot promote, so whatever
          // each returns is that branch's own verdict rather than the pair's resolution.
          const up1 = evaluateTierChange('low', p, freshTierChangeState(), 1000, UNCAPPED, T60);
          const promotes = evaluateTierChange('low', p, up1.state, 1000 + PROMOTION_HOLD_MS, UNCAPPED, T60)
            .decision.action === 'promote';
          const dn1 = evaluateTierChange('high', p, freshTierChangeState(), 1000, UNCAPPED, T60);
          const demotes = evaluateTierChange('high', p, dn1.state, 1000 + DEMOTION_HOLD_MS, UNCAPPED, T60)
            .decision.action === 'demote';
          if (promotes) promoted++;
          if (demotes) demoted++;
          expect(promotes && demotes).toBe(false);
        }
      }
    }
    expect(promoted).toBeGreaterThan(0);
    expect(demoted).toBeGreaterThan(0);
  });

  it('never promotes after a demotion, from any rung', () => {
    const s = { ...freshTierChangeState(), demoted: true };
    const a = evaluateTierChange('mid', roomy, s, 1000, UNCAPPED, T60);
    const b = evaluateTierChange('mid', roomy, a.state, 1000 + PROMOTION_HOLD_MS * 4, UNCAPPED, T60);
    expect(b.decision.action).toBe('none');
  });
});

describe('tier settings', () => {
  it('low strips AA + shadows + resolution, and drops IBL (#154)', () => {
    expect(TIER_SETTINGS.low).toMatchObject({
      pixelRatioCap: 1, antialias: false, shadows: false, ibl: false,
    });
  });

  it('mid loosens ONLY what was measured (#188), resolution included as of 2026-08-12', () => {
    // Each field is either measured on a mid-band device or a deliberate carry-forward; none is
    // invented. IBL because the A23 affords it (+2.9ms GPU inside 60fps); shadows because the band
    // is 10x the Y6; post-FX off because an iPhone 8 — squarely mid-band — goes 27ms -> 56ms on
    // NPR alone.
    //
    // ⭐ `pixelRatioCap: 1.5` USED TO BE 1, and the change is a measurement rather than a loosening
    // of the rule. Measured on the band's own anchor (Galaxy A23, sling, uncapped): DPR 1 = 61.7fps
    // / 4.9ms GPU, DPR 1.5 = 59.5fps / 6.2ms, DPR 1.875 = 54.6fps / 7.2ms. 1.5 buys 2.2x the pixels
    // and holds 60; 2 does not. The curve bends BETWEEN the integers, which is why this sat at 1
    // while the only values anyone tried were 1 and 2.
    //
    // AA stays at `low`'s value — still nothing has measured it on this band, and it is
    // constructor-only so it cannot be A/B'd live the way resolution just was.
    expect(TIER_SETTINGS.mid).toMatchObject({
      ibl: true, shadows: true, postFX: NO_POSTFX, pixelRatioCap: 1.5, antialias: false,
    });
    // The ladder property this must not break: strictly between low and unclamped.
    expect(TIER_SETTINGS.mid.pixelRatioCap).toBeGreaterThan(TIER_SETTINGS.low.pixelRatioCap);
    expect(TIER_SETTINGS.mid.pixelRatioCap).toBeLessThan(UNCLAMPED_OVERRIDES.pixelRatioCap);
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

  // #212 texture LOD by quality tier — the seeds this task's build/runtime pieces read.
  it('textureMaxSize: low 512, mid 1024, high 0 (no cap) — the ladder, unclamped-then-loosening', () => {
    expect(TIER_SETTINGS.low.textureMaxSize).toBe(512);
    expect(TIER_SETTINGS.mid.textureMaxSize).toBe(1024);
    expect(TIER_SETTINGS.high.textureMaxSize).toBe(0);
    // The ladder property, mirroring `pixelRatioCap`'s own assertion above: strictly between
    // low and unclamped (0 reads as Infinity for THIS field's sentinel, so "greater" is the
    // right direction — mid's cap is looser, i.e. bigger, than low's).
    expect(TIER_SETTINGS.mid.textureMaxSize).toBeGreaterThan(TIER_SETTINGS.low.textureMaxSize);
  });

  it('UNCLAMPED_OVERRIDES.textureMaxSize is 0 — the "no cap" sentinel is already the identity, ' +
    'unlike pixelRatioCap which needs Infinity', () => {
    expect(UNCLAMPED_OVERRIDES.textureMaxSize).toBe(0);
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

  // "Shadows on `low` would render ACNE" (docs/rendering.md § "Quality tiers"; the Y6 evidence is
  // in git at 8bed9661:docs/plans/low-end-device-support.md, whose §0b was folded away) — a
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

  describe('`fxaa` — a PostFXRequest member POSTFX_EFFECTS could never reach (review 2026-08-12)', () => {
    // ⚠️ THE LEAK THIS CLOSES. `fxaa` is a full member of `PostFXRequest` but is not a
    // `PostFXEffect` / tier field, so the old mask — looping over `POSTFX_EFFECTS` — could never
    // even SEE it. A tier with every post-FX effect off still ran a full-screen FXAA pass every
    // frame. `fxaa`'s permission is the tier's `antialias` field, not a post-FX toggle — it is AA,
    // not an effect.
    it('drops fxaa under NO_POSTFX + antialias:false, alongside npr', () => {
      const req: Record<string, unknown> = { npr: { fake: 'npr' }, fxaa: { fake: 'fxaa' } };
      const overrides: TierRenderOverrides = { ...UNCLAMPED_OVERRIDES, postFX: NO_POSTFX, antialias: false };
      expect(maskPostFXRequest(req, overrides)).toEqual({});
    });

    it('is a no-op under UNCLAMPED_OVERRIDES — `high` keeps fxaa, so the no-op guarantee holds', () => {
      const req: Record<string, unknown> = { npr: { fake: 'npr' }, fxaa: { fake: 'fxaa' } };
      const out = maskPostFXRequest({ ...req }, UNCLAMPED_OVERRIDES);
      expect(out).toEqual(req);
    });

    it('SURVIVES with antialias:true even when every post-FX effect is off — fxaa is AA, not an effect', () => {
      const req: Record<string, unknown> = { fxaa: { fake: 'fxaa' } };
      const overrides: TierRenderOverrides = { ...UNCLAMPED_OVERRIDES, postFX: NO_POSTFX, antialias: true };
      expect(maskPostFXRequest(req, overrides)).toEqual({ fxaa: { fake: 'fxaa' } });
    });
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

describe('resolveTierOverrides — the project`s authored DEFAULT-tier fields (#403)', () => {
  /** A patch whose every field IS the engine identity. The shape a project has the day these
   *  fields were added: the keys exist in its resolved config, and none of them changes anything. */
  const identity: TierDefaultOverrides = {
    ibl: true, iblOffAmbientBoost: 1, iblOffExposure: 1, shadowMapCeiling: 0,
    maxDirectional: 0, maxLocal: 0, hysteresisMargin: 0, maxShadowCasters: 0,
  };

  it('an all-identity patch resolves UNCLAMPED_OVERRIDES ITSELF — adding the fields changed nothing', () => {
    // ⚠️ THE GUARANTEE THAT MADE THIS SAFE TO ADD. Every project in the fleet carries these keys
    // at their identity values now; if that produced a value-identical COPY rather than the shared
    // object, every identity comparison in the engine would flip on the day of the change — a
    // silent behaviour change for 22 configs, from a feature whose whole premise is that it is a
    // no-op until authored. `toBe`, deliberately, not `toEqual`: a copy passes `toEqual`.
    expect(resolveTierOverrides('high', undefined, identity)).toBe(UNCLAMPED_OVERRIDES);
    expect(resolveTierOverrides('low', undefined, identity)).toBe(UNCLAMPED_OVERRIDES);
  });

  it('omitting the patch entirely is the same as passing an all-identity one', () => {
    expect(resolveTierOverrides('high', undefined)).toBe(resolveTierOverrides('high', undefined, identity));
  });

  it('a NON-identity default reaches the resolved overrides at every tier', () => {
    // The actual feature: before #403 these seven could only be set inside a `mid`/`low` config,
    // so a project could degrade a value it had no way to author for the default tier.
    const defaults: TierDefaultOverrides = { ...identity, shadowMapCeiling: 1024, ibl: false };
    expect(resolveTierOverrides('high', undefined, defaults).shadowMapCeiling).toBe(1024);
    expect(resolveTierOverrides('high', undefined, defaults).ibl).toBe(false);
    // …and a tier that authors NOTHING inherits it, rather than snapping back to the engine value.
    expect(resolveTierOverrides('low', {}, defaults).shadowMapCeiling).toBe(1024);
  });

  it('an authored tier still WINS over the project default for a field it carries', () => {
    // Direction matters: the default is a base, not an override. A `low` that says 512 means 512,
    // whatever the project's default is — otherwise authoring a degradation would be impossible.
    const defaults: TierDefaultOverrides = { ...identity, shadowMapCeiling: 2048 };
    const low = { ...TIER_SETTINGS.low, shadowMapCeiling: 512 };
    expect(resolveTierOverrides('low', { low }, defaults).shadowMapCeiling).toBe(512);
  });

  it('a PARTIAL tier config falls back to the PROJECT default, not the engine identity', () => {
    // The seam the two-level completion exists for. A config written before a field existed (or
    // hand-edited) inherits what THIS project chose for its default tier — reaching past it to the
    // engine's own value would hand the weakest hardware a setting the author never asked for.
    const defaults: TierDefaultOverrides = { ...identity, maxDirectional: 4, maxShadowCasters: 2 };
    const partial = { pixelRatioCap: 1 } as TierRenderOverrides;
    const resolved = resolveTierOverrides('low', { low: partial }, defaults);
    expect(resolved.maxDirectional).toBe(4);
    expect(resolved.maxShadowCasters).toBe(2);
    expect(resolved.pixelRatioCap).toBe(1); // still the tier's own authored field
  });

  it('re-resolving with the SAME defaults object allocates nothing new', () => {
    const defaults: TierDefaultOverrides = { ...identity, maxLocal: 2 };
    const low = preFieldConfigFor();
    expect(resolveTierOverrides('low', { low }, defaults))
      .toBe(resolveTierOverrides('low', { low }, defaults));
  });

  it('the SAME tier config resolved against DIFFERENT defaults gives different results', () => {
    // ⚠️ THE FAILURE A SINGLE-LEVEL MEMO WOULD CAUSE. Keyed on the config alone, the completion
    // would be cached against whichever base it first met and then served forever — so a project
    // that changed a default would keep rendering with the old one, silently, until reload. This
    // is the distinguishing observation for that: same config object, two bases, both read.
    const low = preFieldConfigFor();
    const a: TierDefaultOverrides = { ...identity, maxLocal: 2 };
    const b: TierDefaultOverrides = { ...identity, maxLocal: 7 };
    expect(resolveTierOverrides('low', { low }, a).maxLocal).toBe(2);
    expect(resolveTierOverrides('low', { low }, b).maxLocal).toBe(7);
  });

  /** A config missing the fields a project may now default-author, so completion has to run. */
  function preFieldConfigFor(): TierRenderOverrides {
    const c = { ...TIER_SETTINGS.low } as Partial<TierRenderOverrides>;
    delete c.maxLocal; delete c.maxShadowCasters; delete c.maxDirectional;
    return c as TierRenderOverrides;
  }
});

describe('applyTierToThree — the `0 = uncapped` sentinel (close-out finding)', () => {
  // ⚠️ REGRESSION GUARD. `three.pixelRatioCap` carries the SAME sentinel as its 2D twin —
  // `basePixelRatio` reads it as `cap > 0 ? min(dpr, cap) : dpr`, and Project Settings advertises
  // it to the author as `2 (0 = uncapped)`. This clamped with a bare `Math.min` until #202's
  // close-out, so `min(0, 1)` was 0, i.e. STILL UNCAPPED — the `low` tier's DPR clamp, the single
  // measured saving behind that whole row, did nothing on any project that authored 0.
  const authored = (pixelRatioCap: number) => ({ pixelRatioCap, antialias: true, shadows: true });

  it('an authored 0 IS capped by the tier — the bug', () => {
    // ⚠️ Against the TIER'S OWN value, not a literal. This asserted `toBe(1)` for both tiers and
    // broke the day `mid` was retuned to 1.5 (2026-08-12) — a sentinel guard failing because a
    // TUNING number moved, which is the guard coupled to the wrong thing. What must hold is that
    // an authored 0 ("uncapped") comes back CLAMPED TO WHATEVER THE TIER SAYS; the tier's value is
    // the subject of `tier settings` above, and belongs only there.
    expect(applyTierToThree(authored(0), TIER_SETTINGS.low).pixelRatioCap)
      .toBe(TIER_SETTINGS.low.pixelRatioCap);
    expect(applyTierToThree(authored(0), TIER_SETTINGS.mid).pixelRatioCap)
      .toBe(TIER_SETTINGS.mid.pixelRatioCap);
    // And it is genuinely a clamp, not a pass-through of the sentinel.
    expect(applyTierToThree(authored(0), TIER_SETTINGS.mid).pixelRatioCap).not.toBe(0);
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

describe('⭐ the cpu-limited licence, END TO END through the builder (#205)', () => {
  // ⚠️ **THE UNIT TESTS ABOVE CANNOT CATCH THE FAILURE THIS EXISTS FOR.** `classifyReading` sets
  // the flag and `promotionCeiling` reads it, and both are covered — but the flag crosses THREE
  // module boundaries in between (`resolveProbeClass` -> `buildTierResolveInput` -> `resolveTier`
  // -> `TierResolution`), and a field dropped at any one of them leaves every unit test green
  // while the licence never reaches a device. That is this repo's dominant defect shape: a
  // mechanism that cannot fire.
  const caps = { platform: 'android', deviceModel: 'SM-X', gpuRenderer: 'Some Unlisted GPU 1' };

  afterEach(() => probeVerdictStore.reset());

  it('a cpu-limited probe verdict survives the builder and raises the ceiling', () => {
    const input = buildTierResolveInput(caps, 'auto', { probeClass: 'middle', probeCpuLimited: true });
    const resolved = resolveTier(input);

    expect(resolved.source).toBe('measured');
    expect(resolved.tier).toBe('mid');
    expect(promotionCeiling(resolved)).toBe('high');
    // The reason string is what a human reads in `diagnose` and the boot log when they ask why a
    // device climbed. A licence nobody can see explained is how this becomes folklore.
    expect(resolved.reason).toContain('cpu-limited');
  });

  it('a GPU-limited probe verdict goes through the same path and does NOT', () => {
    const resolved = resolveTier(
      buildTierResolveInput(caps, 'auto', { probeClass: 'middle', probeCpuLimited: false }));

    expect(resolved.source).toBe('measured');
    expect(promotionCeiling(resolved)).toBe('mid');
    expect(resolved.reason).not.toContain('cpu-limited');
  });

  it('⭐ and it survives a RELAUNCH — the licence is rebuilt from the cached samples', () => {
    // The builder reads the cache when no explicit probeClass is passed, which is the shape of
    // every launch after the verdict settles. If `cpuLimited` were dropped here, a device would
    // be promotable on the launch it was measured and never again — a bug that only shows up on
    // the SECOND launch, which is exactly the kind this suite is bad at noticing.
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    probeVerdictStore.provide({
      read: () => ({
        fingerprint: probeFingerprint({ ...caps, viewportPx: (g.innerWidth ?? 0) * (g.innerHeight ?? 0) }),
        deviceClass: 'middle',
        // Clears the capable SHADE floor (0.165), misses its cpu floor (14_500) — cpu-limited.
        samples: [{ cpuUnitsPerMs: 5_000, shadeMfragPerMs: 0.5, fillMpxPerMs: 0 }],
        final: true,
      }),
      write: () => {},
      session: () => undefined,
    });

    const resolved = resolveTier(buildTierResolveInput(caps, 'auto'));

    expect(resolved.source).toBe('measured');
    expect(promotionCeiling(resolved)).toBe('high');
  });
});

/**
 * THE DEMOTION BAR IS THE TARGET FRAME, NOT 84% OF IT (bug IoP332SFwkdFY2PpJzwq).
 *
 * `frameIsFull` asks whether the engine's OWN work is why a frame ran long — "a frame we are not
 * filling is not a frame we can relieve" (owner, 2026-08-20). It judges `cpuMs` against
 * `budgetMs * DEMOTION_CPU_SHARE`, and with the share at 0.7 that bar was `target * 1.2 * 0.7`
 * = **0.84 of the target frame** — i.e. BELOW the frame we are trying to hit, so a device
 * comfortably inside its target could still be called full.
 *
 * Measured on a Galaxy S22 whose panel had dropped to 24 Hz: target 60 fps → a 14.0 ms bar,
 * 14.3 ms of CPU, cleared by 0.3 ms — and the fastest phone in the fleet demoted itself
 * high → mid → low while using a third of the 41.7 ms frame the panel was giving it. The other
 * 27.4 ms was the panel's, not ours.
 *
 * Nothing in this file failed when the share was raised, which is precisely why it shipped: the
 * demotion bar was not pinned to a device anywhere. These two cases pin it from BOTH sides, so a
 * future tweak that reopens either failure lands here instead of on a phone.
 */
describe('evaluateTierChange — the demotion bar against real measured devices', () => {
  /** As `profile()` above, but with the real `budgetMs` a given targetFps produces. */
  const deviceProfile = (o: { frameMs: number; cpuMs: number; budgetMs: number }): FrameProfile => {
    const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
    return {
      samples: 60,
      frameMs: stat(o.frameMs), cpuMs: stat(o.cpuMs),
      restMs: stat(Math.max(0, o.frameMs - o.cpuMs)),
      fps: 1000 / o.frameMs,
      vsyncBound: false,
      overBudget: o.frameMs > o.budgetMs,
      budgetMs: o.budgetMs,
      discontinuities: 0, worstStallMs: 0,
    } as FrameProfile;
  };

  /** Hold the profile past DEMOTION_HOLD_MS, the way a real interacting stretch would. */
  const settle = (tier: QualityTier, p: FrameProfile) => {
    const a = evaluateTierChange(tier, p, freshTierChangeState(), 1000, UNCAPPED, T60);
    return evaluateTierChange(tier, p, a.state, 1000 + DEMOTION_HOLD_MS * 2, UNCAPPED, T60)
      .decision.action;
  };

  it('does NOT demote an S22 whose 24 Hz panel — not its CPU — is pacing the frame', () => {
    // target 60fps → budgetMs 20. The frame is long (41.7ms) and genuinely over budget, but the
    // CPU does not reach the 16.67ms frame we are aiming for, so the overage is not ours.
    // 14.6 is the WORSE of the two samples the device run captured (high→mid fired at 14.6,
    // mid→low at 14.3) — pin the tighter one, or the test passes a case the phone never hit.
    // Margin to the bar is 2.07ms.
    const s22 = deviceProfile({ frameMs: 1000 / 24, cpuMs: 14.6, budgetMs: 20 });
    expect(s22.overBudget).toBe(true); // the precondition really is met — this is not a vacuous pass
    expect(settle('high', s22)).not.toBe('demote');
  });

  it('DOES still demote a Y6-class device whose own CPU overruns the target frame', () => {
    // target 30fps → budgetMs 40. 48ms of CPU exceeds the 33.3ms target outright: this one is ours,
    // and it is the device the whole tier system exists for. The fix must not buy the S22's case
    // by giving up this one.
    const y6 = deviceProfile({ frameMs: 83, cpuMs: 48, budgetMs: 40 });
    expect(settle('high', y6)).toBe('demote');
  });

  it('keeps the promote and demote bars from overlapping at both fleet targets', () => {
    // The fleet runs exactly two targets, 30 and 60 (verified across every project.config.json).
    // Raising the demotion bar widens this gap rather than closing it, but assert it rather than
    // reason about it: an overlap is the worst outcome available, since `demoted` is sticky and a
    // device would promote, immediately re-qualify to demote, and land BELOW where it started.
    for (const targetMs of [T60, T30]) {
      expect(targetMs * PROMOTION_TARGET_SHARE).toBeLessThan((targetMs * 1.2) * DEMOTION_CPU_SHARE);
    }
  });
});
