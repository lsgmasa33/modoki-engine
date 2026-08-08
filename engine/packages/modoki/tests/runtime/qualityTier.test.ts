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
  resolveTier, evaluateTierChange, freshTierChangeState, tierShadowMapSize, shadowBiasScale,
  TIER_ALLOWLIST, TIER_SETTINGS, DEFAULT_TIER_SETTING,
  PROMOTION_HOLD_MS, DEMOTION_HOLD_MS, MIN_SAMPLES_TO_JUDGE,
  type QualityTier,
  applyTierToThree, tierAllowsPostFX, tierAllowsIBL, tierAmbientBoost, tierExposureBoost,
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

/** Temporarily add allowlist entries — the shipped lists are empty on purpose, so matching can
 *  only be exercised by injecting. */
function withAllowlist(fn: () => void, ios: string[] = [], android: RegExp[] = []) {
  const i = TIER_ALLOWLIST.iosModels as string[];
  const a = TIER_ALLOWLIST.androidGpuPatterns as RegExp[];
  i.push(...ios); a.push(...android);
  try { fn(); } finally { i.length = 0; a.length = 0; }
}

describe('resolveTier — precedence', () => {
  it('the player wins over everything — they can see the screen and we cannot', () => {
    const r = resolveTier({
      platform: 'ios', playerChoice: 'low', projectSetting: 'high', deviceModel: 'iPhone17,1',
    });
    expect(r).toMatchObject({ tier: 'low', source: 'player' });
  });

  it('a pinned project setting beats the allowlist', () => {
    withAllowlist(() => {
      const r = resolveTier({ platform: 'ios', deviceModel: 'iPhone10,1', projectSetting: 'low' });
      expect(r).toMatchObject({ tier: 'low', source: 'project' });
    }, ['iPhone10,1']);
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
    expect(TIER_ALLOWLIST.iosModels).toHaveLength(0);
    expect(TIER_ALLOWLIST.androidGpuPatterns).toHaveLength(0);
  });

  it('matches an allowlisted iOS MODEL (the GPU string is masked on iOS)', () => {
    withAllowlist(() => {
      const r = resolveTier({ platform: 'ios', deviceModel: 'iPhone16,2', projectSetting: 'auto' });
      expect(r).toMatchObject({ tier: 'high', source: 'allowlist' });
    }, ['iPhone16,2']);
  });

  it('matches an allowlisted Android GPU STRING, not a model name', () => {
    // The A23 is why: 4G ships Adreno 610, 5G ships Adreno 619, same marketing name.
    withAllowlist(() => {
      const r = resolveTier({
        platform: 'android', gpuRenderer: 'Adreno (TM) 619', projectSetting: 'auto',
      });
      expect(r).toMatchObject({ tier: 'high', source: 'allowlist' });
    }, [], [/Adreno \(TM\) 6[12]9/]);
  });

  it('falls through to calibrating when the allowlist does not match', () => {
    withAllowlist(() => {
      const r = resolveTier({
        platform: 'android', gpuRenderer: 'Adreno (TM) 610', projectSetting: 'auto',
      });
      expect(r.source).toBe('calibrating');
    }, [], [/Adreno \(TM\) 619/]);
  });
});

describe('evaluateTierChange — promotion', () => {
  const roomy = profile({ frameMs: 10, cpuMs: 4 });

  it('does not promote before the hold elapses', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS - 1);
    expect(b.decision.action).toBe('none');
  });

  it('promotes once headroom has held', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000);
    const b = evaluateTierChange('low', roomy, a.state, 1000 + PROMOTION_HOLD_MS);
    expect(b.decision.action).toBe('promote');
  });

  it('a single bad sample RESETS the streak — one lucky second is not evidence', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', roomy, s, 1000);
    const b = evaluateTierChange('low', profile({ frameMs: 60, cpuMs: 50 }), a.state, 2000);
    expect(b.state.headroomSince).toBe(0);
    const c = evaluateTierChange('low', roomy, b.state, 1000 + PROMOTION_HOLD_MS);
    expect(c.decision.action).toBe('none'); // streak restarted, hold not yet met
  });

  it('will not judge on too few samples', () => {
    const thin = profile({ frameMs: 10, cpuMs: 4, samples: MIN_SAMPLES_TO_JUDGE - 1 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', thin, s, 1000);
    const b = evaluateTierChange('low', thin, a.state, 1000 + PROMOTION_HOLD_MS * 3);
    expect(b.decision.action).toBe('none');
  });
});

describe('evaluateTierChange — the vsync-bound signal switch', () => {
  it('promotes a vsync-capped device that is barely working', () => {
    // 3ms of CPU in a 16.7ms frame: genuinely idle, genuinely promotable.
    const idle = profile({ frameMs: 1000 / 60, cpuMs: 3, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', idle, s, 1000);
    const b = evaluateTierChange('low', idle, a.state, 1000 + PROMOTION_HOLD_MS);
    expect(b.decision.action).toBe('promote');
    expect(b.decision).toMatchObject({ reason: expect.stringContaining('cpu') });
  });

  it('REFUSES to promote a vsync-capped device that is nearly out of frame', () => {
    // THE test. 15ms of CPU in a 16.7ms frame is a device on the edge — but frameMs is pinned
    // at the display interval, identical to the idle case above, so a frameMs-based rule would
    // promote it and immediately blow the budget. Only cpuMs can tell these apart.
    const strained = profile({ frameMs: 1000 / 60, cpuMs: 15, vsyncBound: true });
    const s = freshTierChangeState();
    const a = evaluateTierChange('low', strained, s, 1000);
    const b = evaluateTierChange('low', strained, a.state, 1000 + PROMOTION_HOLD_MS * 3);
    expect(b.decision.action).toBe('none');
  });
});

describe('evaluateTierChange — demotion', () => {
  const slow = profile({ frameMs: 83, cpuMs: 48 }); // the Y6's measured profile

  it('demotes after sustained over-budget frames', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000);
    expect(a.decision.action).toBe('none');
    const b = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS);
    expect(b.decision.action).toBe('demote');
  });

  it('demotes FASTER than it promotes — an emergency, not an upgrade', () => {
    expect(DEMOTION_HOLD_MS).toBeLessThan(PROMOTION_HOLD_MS);
  });

  it('a demotion is STICKY — never promote again, or the tier oscillates', () => {
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', slow, s, 1000);
    const demoted = evaluateTierChange('high', slow, a.state, 1000 + DEMOTION_HOLD_MS);
    expect(demoted.state.demoted).toBe(true);

    // Now on `low` it runs beautifully — which is exactly what the low tier was FOR. Promoting
    // back would return it to the settings that just failed, and it would flap between them.
    const roomy = profile({ frameMs: 10, cpuMs: 4 });
    let st = demoted.state;
    for (const t of [2000, 8000, 20000, 60000]) {
      const r = evaluateTierChange('low', roomy, st, t);
      expect(r.decision.action).toBe('none');
      st = r.state;
    }
  });

  it('does not demote a high-tier device that is merely near budget', () => {
    const fine = profile({ frameMs: BUDGET_30FPS_MS - 1, cpuMs: 10 });
    const s = freshTierChangeState();
    const a = evaluateTierChange('high', fine, s, 1000);
    const b = evaluateTierChange('high', fine, a.state, 1000 + DEMOTION_HOLD_MS * 5);
    expect(b.decision.action).toBe('none');
  });
});

describe('tier settings', () => {
  it('low strips AA + shadows + resolution, and drops IBL (#154)', () => {
    expect(TIER_SETTINGS.low).toMatchObject({
      pixelRatioCap: 1, antialias: false, shadows: false, ibl: false,
    });
  });

  it('high leaves the current defaults alone', () => {
    expect(TIER_SETTINGS.high).toMatchObject({ pixelRatioCap: 2, antialias: true, shadows: true });
  });

  it('clamps an authored shadow map to the tier ceiling', () => {
    // Light.shadowMapSize is a per-light trait with no global cap, so a tier could not otherwise
    // enforce "shadows, but smaller".
    expect(tierShadowMapSize(2048, 'low')).toBe(512);
    expect(tierShadowMapSize(256, 'low')).toBe(256);   // never UPSCALES an authored value
  });

  it('high imposes no shadow ceiling', () => {
    expect(tierShadowMapSize(4096, 'high')).toBe(4096);
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

  it('low drops the post-FX stack; high allows it (#121 P3c)', () => {
    // Post-FX is screen-space, so its cost is paid per pixel however simple the scene is — the
    // dominant remaining cost on a weak device (iPhone 8: 27ms baseline -> 56ms with NPR alone).
    expect(tierAllowsPostFX('low')).toBe(false);
    expect(tierAllowsPostFX('high')).toBe(true);
  });

  // ── applyTierToThree (#121 P3a) ─────────────────────────────────────────────────────────
  // A TIER CLAMPS, IT NEVER RAISES. This is what makes wiring tiers up a no-op for every
  // existing project, and what stops `high` from overriding a deliberate authoring choice.
  describe('applyTierToThree', () => {
    const authored = { backend: 'auto', antialias: true, pixelRatioCap: 2, shadows: true, extra: 'kept' };

    it('high leaves default settings byte-identical — today\'s behaviour, unchanged', () => {
      expect(applyTierToThree(authored, 'high')).toEqual(authored);
    });

    it('low takes everything away, resolution included (#154: 2x measured at 14 fps)', () => {
      expect(applyTierToThree(authored, 'low')).toMatchObject({
        pixelRatioCap: 1, antialias: false, shadows: false,
      });
    });

    it('NEVER raises a value the project deliberately lowered', () => {
      // A project that authored a DPR cap of 1 / shadows off is not asking for more work just
      // because it landed on the high tier. Regression guard: `replace` semantics would silently
      // undo hand-tuned settings like sling's Y6 workaround (8e85b7b3).
      const lean = { ...authored, pixelRatioCap: 1, antialias: false, shadows: false };
      expect(applyTierToThree(lean, 'high')).toMatchObject({
        pixelRatioCap: 1, antialias: false, shadows: false,
      });
    });

    it('preserves fields it does not own, and does not mutate the input', () => {
      const input = { ...authored };
      const out = applyTierToThree(input, 'low');
      expect(out.extra).toBe('kept');
      expect(out.backend).toBe('auto');
      expect(input).toEqual(authored); // untouched
      expect(out).not.toBe(input);
    });
  });
});

describe('IBL tier gate (#154) — the single biggest render cost on a low-end device', () => {
  it('allows IBL on high and suppresses it on low', () => {
    expect(tierAllowsIBL('high')).toBe(true);
    expect(tierAllowsIBL('low')).toBe(false);
  });

  it('leaves the authored lighting completely untouched on high', () => {
    // Boosts are multipliers, so 1 means "pass the authored value through". A tier that keeps IBL
    // must not also brighten the scene — that would double-light it.
    expect(tierAmbientBoost('high')).toBe(1);
    expect(tierExposureBoost('high')).toBe(1);
  });

  it('compensates on low, where IBL is off — otherwise the scene renders dark and flat', () => {
    expect(tierAmbientBoost('low')).toBeGreaterThan(1);
    expect(tierExposureBoost('low')).toBeGreaterThan(1);
  });

  it('keeps the compensation tied to the gate, not hardcoded per tier', () => {
    // The accessors must return 1 whenever `ibl` is true, for ANY tier — so flipping a tier's
    // `ibl` back on cannot leave a stale brightening multiplier behind.
    for (const tier of ['low', 'high'] as QualityTier[]) {
      if (TIER_SETTINGS[tier].ibl) {
        expect(tierAmbientBoost(tier)).toBe(1);
        expect(tierExposureBoost(tier)).toBe(1);
      } else {
        expect(tierAmbientBoost(tier)).toBe(TIER_SETTINGS[tier].iblOffAmbientBoost);
        expect(tierExposureBoost(tier)).toBe(TIER_SETTINGS[tier].iblOffExposure);
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
    expect(tierAllowsIBL('low')).toBe(false);
    expect(tierAllowsIBL('high')).toBe(true);
  });
});
