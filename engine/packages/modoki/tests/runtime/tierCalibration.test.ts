/** Tier calibration loop (#121 P3b) — `runtime/rendering/tierCalibration.ts`.
 *
 *  The DECISION is `qualityTier.ts`'s and is tested there. These cover only what this module
 *  adds: the throttle, the auto-only gate, and — the load-bearing one — that a demotion applies
 *  IMMEDIATELY while a promotion WAITS for a scene boundary. Getting that pair backwards is the
 *  failure this design exists to avoid: a mid-play promotion recompiles shaders and can freeze
 *  longer than the low tier it escapes, while a deferred demotion leaves a struggling device
 *  struggling until the next scene load, which for a one-scene game is never. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/runtime/core/frameProfiler', async (orig) => {
  const actual = await orig<typeof import('../../src/runtime/core/frameProfiler')>();
  return { ...actual, getFrameProfile: () => mockProfile };
});
vi.mock('../../src/runtime/core/activeRenderer', () => ({
  getActiveRenderer: () => mockRenderer,
}));
vi.mock('../../src/runtime/rendering/resizeBus', () => ({
  forceResizeAllSurfaces: () => { resizeCalls++; },
}));

import { BUDGET_30FPS_MS, type FrameProfile } from '../../src/runtime/core/frameProfiler';
import {
  tickTierCalibration, applyPendingTierPromotion, resetTierCalibration,
  getPendingTierPromotion, CALIBRATION_INTERVAL_MS, applyActiveTierToRuntime, applyQualityTier,
  setTierFrameCapEnabled,
} from '../../src/runtime/rendering/tierCalibration';
import * as frameDriver from '../../src/runtime/rendering/frameDriver';
import {
  setRenderSettings, resetRenderSettings, setActiveQualityTier, getActiveQualityTier,
  getAssessedQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import { PROMOTION_HOLD_MS, DEMOTION_HOLD_MS, TIER_SETTINGS } from '../../src/runtime/rendering/qualityTier';

let mockRenderer: { shadowMap: { enabled: boolean } };
let resizeCalls = 0;
let mockProfile: FrameProfile;

const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
function profileOf(frameMs: number, cpuMs: number): FrameProfile {
  return {
    samples: 120, frameMs: stat(frameMs), cpuMs: stat(cpuMs),
    restMs: stat(Math.max(0, frameMs - cpuMs)), fps: 1000 / frameMs,
    vsyncBound: false, overBudget: frameMs > BUDGET_30FPS_MS, discontinuities: 0,
  };
}
const ROOMY = () => profileOf(10, 4);
const DROWNING = () => profileOf(80, 60);

beforeEach(() => {
  resetRenderSettings();
  resetTierCalibration();
  mockRenderer = { shadowMap: { enabled: true } };
  resizeCalls = 0;
  mockProfile = ROOMY();
  // ⚠️ AUTHOR THE CONFIGS. This suite tests the calibration MECHANISM, and since the owner's
  // "one config ⇒ nothing to change to" rule (plan §2.2) the mechanism only runs when a project
  // authored something to change to — which is also the only state that can reach it in
  // production, since `calibrating` is now unreachable without configs. Seeding from
  // TIER_SETTINGS keeps every assertion below about the ladder, not about the seed values.
  // The one describe block that deliberately authors NOTHING resets this itself.
  setRenderSettings({ three: { qualityTier: 'auto', tiers: { mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low } } });
});

describe('tickTierCalibration — gating', () => {
  it('does NOTHING unless the project asked for auto', () => {
    // A pinned tier is a decision the author already made; measuring our way out of it would
    // silently override them.
    setRenderSettings({ three: { qualityTier: 'high' } });
    setActiveQualityTier({ tier: 'high', source: 'project', reason: 'pinned' });
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS * 3; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('high'); // never demoted
  });

  it('does nothing before a renderer has resolved a tier', () => {
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS * 3; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()).toBeNull();
  });

  it('throttles — a burst of ticks inside one interval is judged once', () => {
    setActiveQualityTier({ tier: 'high', source: 'calibrating', reason: 'x' });
    mockProfile = DROWNING();
    // Hammer well past the demotion hold, but all within a single interval.
    for (let i = 0; i < 50; i++) tickTierCalibration(0);
    expect(getActiveQualityTier()?.tier).toBe('high'); // one sample cannot satisfy a hold
  });
});

describe('demotion applies IMMEDIATELY', () => {
  beforeEach(() => setActiveQualityTier({ tier: 'high', source: 'calibrating', reason: 'x' }));

  it('demotes ONE STEP once over budget has held, with no scene boundary needed', () => {
    // `mid`, not `low` (#188). A demotion drops one rung of `TIER_ORDER`: a device that misses the
    // budget on `high` has not been shown to need `low`, and jumping the whole ladder would throw
    // away IBL and shadows that a middling device was measured affording.
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    const active = getActiveQualityTier();
    expect(active?.tier).toBe('mid');
    expect(active?.source).toBe('measured');
    expect(getPendingTierPromotion()).toBeNull(); // it did NOT queue
  });

  it('demotes AGAIN from mid, so a device that is still drowning reaches low', () => {
    // The rung below is reachable, which is what makes one-step demotion safe rather than a
    // half-measure: the sticky flag blocks PROMOTION, never a second demotion.
    //
    // Since the DEFAULT is now the ABSENCE of clamping (docs/rendering.md § "Quality tiers"),
    // landing on `low` is a no-op unless the project authored something to clamp with —
    // author it from the seed table so this test keeps exercising the demotion MECHANISM (which
    // is what this suite is for; the decision itself is qualityTier.test.ts's job).
    setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } });
    setActiveQualityTier({ tier: 'mid', source: 'measured', reason: 'x' });
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).toBe('low');
    expect(mockRenderer.shadowMap.enabled).toBe(false); // `low` is the tier that drops shadows
  });

  it('pushes the live knobs it can: a resize to re-clamp the pixel ratio', () => {
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    // high -> mid KEEPS shadows (mid has them, clamped) but halves the pixel-ratio cap. And
    // pixelRatioCap is only meaningful against the live container size, so applying it IS
    // re-running each surface's resize — one implementation of the clamp, not two.
    expect(mockRenderer.shadowMap.enabled).toBe(true);
    expect(resizeCalls).toBeGreaterThan(0);
  });
});

describe('promotion WAITS for a scene boundary', () => {
  beforeEach(() => setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'x' }));

  function sustainHeadroom() {
    for (let t = 0; t <= PROMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
  }

  it('queues rather than applying — a mid-play shader recompile can freeze longer than the low tier it escapes', () => {
    sustainHeadroom();
    expect(getPendingTierPromotion()).toMatchObject({ tier: 'mid' });  // one step, not straight to high
    expect(getActiveQualityTier()?.tier).toBe('low');  // still low, deliberately
    expect(mockRenderer.shadowMap.enabled).toBe(true); // untouched
    expect(resizeCalls).toBe(0);
  });

  it('applies at the boundary, and reports WHY it was deferred', () => {
    sustainHeadroom();
    applyPendingTierPromotion();
    const active = getActiveQualityTier();
    expect(active?.tier).toBe('mid');
    expect(active?.source).toBe('measured');
    expect(active?.reason).toContain('scene boundary');
    expect(getPendingTierPromotion()).toBeNull(); // consumed exactly once
  });

  it('applying with nothing queued is a no-op', () => {
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('low');
    expect(resizeCalls).toBe(0);
  });

  it('STOPS at the tier the boot probe assessed, and says so exactly once (#188)', () => {
    // A device the probe measured as `middle`. It has CPU headroom to spare — the profile is the
    // same ROOMY one that promotes an unassessed device two tests up — and it must not move,
    // because the measurement that put it on `mid` looked at the GPU and this streak cannot.
    resetRenderSettings();
    resetTierCalibration();
    // Authored configs, because the ceiling only ever arises on a project that HAS more than one
    // — a device cannot be "measured as middle" unless there was something to measure between.
    setRenderSettings({ three: { qualityTier: 'auto', tiers: { mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low } } });
    setActiveQualityTier({ tier: 'mid', source: 'measured', reason: 'probe measured middle' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let t = 0; t <= PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
      expect(getPendingTierPromotion()).toBeNull();
      expect(getActiveQualityTier()?.tier).toBe('mid');
      // ONE explanation, not one every hold period. Four hold periods elapsed above; an undeduped
      // log would print on each and train everyone to filter the channel out.
      const holds = warn.mock.calls.filter((c) => String(c[0]).includes('holding at'));
      expect(holds).toHaveLength(1);
      expect(String(holds[0][0])).toContain('probe measured middle');
    } finally {
      warn.mockRestore();
    }
  });

  it('an unassessed device gets ONE step and stops — the ladder has a top (#188)', () => {
    // #155's cost is that `auto` pins unrecognised hardware to `low` forever, so promotion has to
    // do something here. What it must NOT do is walk the whole ladder: `high` on a device nobody
    // has ever measured is the boot that cost a Huawei Y6 its GPU context.
    sustainHeadroom();
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('mid');

    for (let t = 20_000; t <= 20_000 + PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).toBeNull();
    expect(getActiveQualityTier()?.tier).toBe('mid');

    // ⚠️ THE ASSERTION THAT ACTUALLY PINS THE MECHANISM. The two lines above pass whether the
    // ceiling is read from the assessed resolution or the live one, because a live change happens
    // to republish `source: 'measured'` and `'measured'` caps at its own tier — measured by
    // perturbing the call and watching all 12 tests stay green. So the cap's correctness rests on
    // the ASSESSMENT surviving intact, and that is what this checks: the device is still on record
    // as one nothing ever measured, however many times calibration has since written `'measured'`.
    expect(getAssessedQualityTier()).toMatchObject({ tier: 'low', source: 'calibrating' });
  });

  it('never promotes again after a demotion — the sticky rule survives this layer', () => {
    // Demote first...
    setActiveQualityTier({ tier: 'high', source: 'calibrating', reason: 'x' });
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).toBe('mid');
    // ...then hand it a perfect profile forever. Oscillating between a tier that is too slow and
    // one that is too pretty is worse than either — and with three tiers the oscillation would be
    // MORE tempting, not less, since `mid` is the one rung that can move in both directions.
    mockProfile = ROOMY();
    for (let t = 10_000; t <= 10_000 + PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).toBeNull();
    expect(getActiveQualityTier()?.tier).toBe('mid');
  });
});

describe('ONE CONFIG means the live half stands down too (plan §2.2/§4)', () => {
  // The boot probe skipping itself is the visible half of the owner's rule. This is the other
  // one, and it is the half that could plausibly have been forgotten: with only the default
  // authored, every tier resolves to the SAME unclamped overrides, so a demotion would move a
  // tier NAME, free no memory, drop no effect, and still pay a `forceResizeAllSurfaces()` and a
  // log line on a device that is already missing its frame budget.
  beforeEach(() => {
    resetRenderSettings();   // drops the file-level seeded configs — this block is about NONE
    setRenderSettings({ three: { qualityTier: 'auto' } });
    setActiveQualityTier({ tier: 'high', source: 'single-config', reason: 'x' });
    mockProfile = DROWNING();
  });

  const drownFor = (ms: number) => {
    for (let t = 0; t <= ms; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
  };

  it('does not demote a drowning device when the project authored nothing', () => {
    drownFor(DEMOTION_HOLD_MS * 3);
    expect(getActiveQualityTier()?.tier).toBe('high');
    expect(resizeCalls).toBe(0);   // no surface churn either
  });

  it('DOES demote once the project has authored a low — the gate is the config, not the tier', () => {
    // The distinguishing half. Same profile, same ticks, same starting tier: the ONLY difference
    // is that a config now exists to demote to. Without this pair, a gate that accidentally
    // disabled calibration outright would pass the test above and look correct.
    setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } });
    setActiveQualityTier({ tier: 'mid', source: 'measured', reason: 'x' });
    drownFor(DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS);
    expect(getActiveQualityTier()?.tier).toBe('low');
  });
});

// ── applyActiveTierToRuntime — the frame cap, and the publish point the plan missed (#202) ──
//
// ⚠️ WHY THIS IS ITS OWN BLOCK. The tier a device actually ships with is published by
// `scene3DSync.resolveActiveTierOnce` calling `setActiveQualityTier` DIRECTLY — it never goes
// through `applyQualityTier`, which runs only on a live promote/demote and on a player's menu
// choice. Three survives that because `makeWebGPURenderer` re-reads `getEffectiveThreeSettings()`
// on the next line; the frame cap has no such reader. So wiring `setTargetFPS` into
// `applyQualityTier` alone — which is what the plan specified — would have left it inert on the
// path nearly every device takes and never leaves. The mechanism is a function BOTH publish points
// call, and these tests pin that it is callable and correct on its own.
describe('applyActiveTierToRuntime — pushing the active tier into the live runtime', () => {
  beforeEach(() => {
    setRenderSettings({ targetFps: 60, three: { tiers: { low: TIER_SETTINGS.low } } });
    frameDriver.setTargetFPS(60);
  });

  it('caps the frame driver when the active tier authors one', () => {
    setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(30);
  });

  it('restores the project`s authored cap when the tier moves back up', () => {
    setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(30);
    // Re-derived from the authored value, not remembered — a promotion must not leave the device
    // pinned at whatever the demotion set.
    setActiveQualityTier({ tier: 'high', source: 'measured', reason: 'x' });
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(60);
  });

  it('leaves the cap alone on a project that authored no tiers', () => {
    resetRenderSettings();
    setRenderSettings({ targetFps: 60 });
    setActiveQualityTier({ tier: 'low', source: 'project', reason: 'x' });
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(60);
  });

  it('also re-runs every surface`s resize handler — how the 2D DPR cap reaches the buffer', () => {
    // `Canvas2DMount`'s `updateSize` is on this bus and re-reads `getEffectivePixiSettings()` on
    // every run, so a broadcast IS the whole of "apply the new 2D cap". Nothing diffs anything.
    resizeCalls = 0;
    setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
    applyActiveTierToRuntime();
    expect(resizeCalls).toBe(1);
    expect(mockRenderer.shadowMap.enabled).toBe(false);   // low authors shadows: false
  });

  it('a live demotion through applyQualityTier carries the frame cap with it', () => {
    // The end-to-end shape for the LIVE half: the same function the boot half calls, reached
    // through the path an emergency demotion takes.
    setActiveQualityTier({ tier: 'high', source: 'measured', reason: 'x' });
    applyQualityTier('low', 'measured', 'over budget');
    expect(frameDriver.targetFPS).toBe(30);
  });
});

describe('setTierFrameCapEnabled — the editor is not throttled by a phone`s cap (close-out finding)', () => {
  // `targetFPS` is ONE global in frameDriver gating every callback, the editor's own viewport and
  // gizmo passes included. `tickTierCalibration` runs from Scene3D, which the editor mounts, and
  // two viewports doing double the work is exactly what trips a demotion — so without this gate an
  // author's whole session drops to a phone's cap for a symptom their build never had.
  beforeEach(() => {
    setRenderSettings({ targetFps: 60, three: { tiers: { low: TIER_SETTINGS.low } } });
    frameDriver.setTargetFPS(60);
    setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
  });
  afterEach(() => setTierFrameCapEnabled(true));   // default; must not leak into a sibling test

  it('applies the cap by default — a shipped game is the case this exists for', () => {
    setTierFrameCapEnabled(true);
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(30);
  });

  it('leaves the frame driver ALONE when disabled', () => {
    setTierFrameCapEnabled(false);
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(60);
  });

  it('still applies every OTHER knob when the cap is off — it gates one field, not the tier', () => {
    // The distinguishing half: a gate that accidentally short-circuited the whole function would
    // pass the test above and be badly wrong.
    setTierFrameCapEnabled(false);
    resizeCalls = 0;
    mockRenderer.shadowMap.enabled = true;
    applyActiveTierToRuntime();
    expect(frameDriver.targetFPS).toBe(60);          // gated
    expect(mockRenderer.shadowMap.enabled).toBe(false); // low authors shadows: false — still applied
    expect(resizeCalls).toBe(1);                      // 2D/3D DPR still re-measured
  });
});
