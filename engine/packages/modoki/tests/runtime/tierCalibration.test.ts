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
// ⭐ EVERY TEST BELOW ASSUMES SOMEBODY IS PLAYING, and that assumption is now explicit rather
// than accidental. Calibration refuses to judge an IDLE window (owner, 2026-08-20): a phone
// nobody is touching has its clocks dropped by the governor, so the frames it produces describe
// a throttled device rather than a slow one — an idle Galaxy S22 walked itself high → mid → low
// on ~41.6 ms medians (bug `lvROp0yDYPSzS0VZM6LH`). Default `true` keeps these cases testing what
// they were written to test; the `idle window` block at the bottom flips it.
let playerIsInteracting = true;
vi.mock('../../src/runtime/core/userActivity', () => ({
  hasRecentUserInput: () => playerIsInteracting,
  msSinceUserInput: () => (playerIsInteracting ? 0 : Infinity),
  noteUserInput: () => {},
}));
vi.mock('../../src/runtime/rendering/resizeBus', () => ({
  forceResizeAllSurfaces: () => { resizeCalls++; },
}));

import { BUDGET_30FPS_MS, type FrameProfile } from '../../src/runtime/core/frameProfiler';
import * as profiler from '../../src/runtime/core/frameProfiler';
import {
  tickTierCalibration, applyPendingTierPromotion, resetTierCalibration,
  getPendingTierPromotion, CALIBRATION_INTERVAL_MS, applyActiveTierToRuntime, applyQualityTier,
  setTierFrameCapEnabled, setTierCalibrationEnabled, armTierCalibration, isTierCalibrationArmed,
  ARM_BACKSTOP_MS, PROMOTION_BOUNDARY_GRACE_MS, onTierSwitchOverlay, getTierSwitchOverlayMessage,
} from '../../src/runtime/rendering/tierCalibration';
import * as frameDriver from '../../src/runtime/rendering/frameDriver';
import {
  setRenderSettings, resetRenderSettings, setActiveQualityTier, getActiveQualityTier,
  getAssessedQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import { PROMOTION_HOLD_MS, DEMOTION_HOLD_MS, TIER_SETTINGS } from '../../src/runtime/rendering/qualityTier';
import { playerTierStore } from '../../src/runtime/core/playerTierStore';
import { getActiveTextureSizeCap, resetActiveTextureSizeCap } from '../../src/runtime/core/textureSizeCap';

let mockRenderer: { shadowMap: { enabled: boolean } };
let resizeCalls = 0;
let mockProfile: FrameProfile;

const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
function profileOf(frameMs: number, cpuMs: number): FrameProfile {
  return {
    samples: 120, frameMs: stat(frameMs), cpuMs: stat(cpuMs),
    restMs: stat(Math.max(0, frameMs - cpuMs)), fps: 1000 / frameMs,
    vsyncBound: false, overBudget: frameMs > BUDGET_30FPS_MS, budgetMs: BUDGET_30FPS_MS, discontinuities: 0, worstStallMs: 0,
  };
}
const ROOMY = () => profileOf(10, 4);
const DROWNING = () => profileOf(80, 60);

beforeEach(() => {
  playerIsInteracting = true;
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
  // ⚠️ ARM IT. Since #227 the loop ignores the frame profile until a scene has finished loading
  // (`onWorldSwap` → `armTierCalibration`), because otherwise it judges GLB parsing and shader
  // compilation — which demoted a correctly-assessed `mid` A23 to `low` for the session. Every
  // test below is about what the loop does with a profile it is ALLOWED to believe, so they arm
  // here; the arming rule has its own describe block at the bottom of this file.
  armTierCalibration();
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
    armTierCalibration();   // the reset above un-armed it (#227)
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

describe('applyPendingTierPromotion RE-RUNS ITS GATES (#202 close-out)', () => {
  // ⚠️ THE DEFECT. A queued promotion can be a whole scene old — the player can open a settings
  // menu and pin a tier, or a project setting can be edited live, in the meantime. Before this
  // fix, `applyPendingTierPromotion` applied whatever `tickTierCalibration` had queued with no
  // re-check, silently overwriting an explicit human choice made AFTER the queue decision. These
  // pin that the three gates it now re-runs (`qualityTier === 'auto'`, no player pin,
  // `configCount > 1`) each actually block the apply — and the positive control proves the gates
  // are not simply refusing everything.
  let playerTier: 'low' | 'mid' | 'high' | null = null;

  beforeEach(() => {
    playerTier = null;
    playerTierStore.reset();
    playerTierStore.provide({ read: () => playerTier, write: (t) => { playerTier = t; } });
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'x' });
  });

  function queuePromotion() {
    for (let t = 0; t <= PROMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).toMatchObject({ tier: 'mid' }); // sanity: it did queue
  }

  it('the positive control — with nothing pinned in the meantime, it DOES apply', () => {
    // Matters on its own: a gate that refused everything would pass the two negative tests below
    // for the wrong reason.
    queuePromotion();
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('mid');
  });

  it('does NOT apply once the player has pinned a tier after the promotion was queued', () => {
    queuePromotion();
    playerTier = 'low'; // the player's explicit choice, made AFTER the queue decision
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('low'); // unmoved — the human's choice wins
  });

  it('does NOT apply once the project setting is no longer `auto`', () => {
    queuePromotion();
    setRenderSettings({ three: { qualityTier: 'high', tiers: { mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low } } });
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('low'); // unmoved
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

  // #212 texture LOD by quality tier.
  describe('the texture size cap', () => {
    afterEach(() => resetActiveTextureSizeCap());

    it('publishes the active tier`s textureMaxSize to the L0 seam', () => {
      setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
      applyActiveTierToRuntime();
      expect(getActiveTextureSizeCap()).toBe(TIER_SETTINGS.low.textureMaxSize); // 512
    });

    it('restores the wider (or absent) cap when the tier moves back up', () => {
      setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'x' });
      applyActiveTierToRuntime();
      expect(getActiveTextureSizeCap()).toBe(512);
      setActiveQualityTier({ tier: 'high', source: 'measured', reason: 'x' });
      applyActiveTierToRuntime();
      expect(getActiveTextureSizeCap()).toBe(0); // high's config carries textureMaxSize: 0 here
    });

    it('leaves the cap at 0 on a project that authored no tiers', () => {
      resetRenderSettings();
      setRenderSettings({ targetFps: 60 });
      setActiveQualityTier({ tier: 'low', source: 'project', reason: 'x' });
      applyActiveTierToRuntime();
      expect(getActiveTextureSizeCap()).toBe(0);
    });
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

describe('setTierCalibrationEnabled — the editor does not auto-calibrate (R7.4)', () => {
  afterEach(() => setTierCalibrationEnabled(true));

  // ⚠️ BOTH DIRECTIONS. The positive control is what makes the negative meaningful: a gate that
  // refused everything would pass a "does not demote" assertion while having broken calibration
  // outright — the exact failure mode the "one config" gate's own tests were built to avoid.
  it('OFF: a drowning profile does NOT demote, and queues nothing', () => {
    setTierCalibrationEnabled(false);
    applyQualityTier('high', 'project', 'test');
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).toBe('high');
    expect(getPendingTierPromotion()).toBeNull();
  });

  it('ON: the same profile DOES demote — so the gate is what stopped it', () => {
    setTierCalibrationEnabled(true);
    applyQualityTier('high', 'project', 'test');
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).not.toBe('high');
  });

  // A promotion decided BEFORE the gate closed must not still land at the next scene boundary.
  it('OFF: a queued promotion is dropped rather than applied at a scene boundary', () => {
    setTierCalibrationEnabled(true);
    applyQualityTier('low', 'calibrating', 'test');
    mockProfile = ROOMY();
    for (let t = 0; t <= PROMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).not.toBeNull();

    setTierCalibrationEnabled(false);
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #227 — arming. Calibration must not judge a device on frames produced while its first scene
// was still loading.
//
// ⚠️ THESE TESTS DO NOT ARM IN `beforeEach` — they undo it. The suite-wide `armTierCalibration()`
// exists so every OTHER test is about the policy; here the arming IS the subject, so each case
// resets first and states its own starting point.
// ─────────────────────────────────────────────────────────────────────────────
describe('#227 — calibration is not armed until a scene has loaded', () => {
  /** Back to the un-armed state the suite's beforeEach leaves behind, with the configs a live
   *  project needs re-authored (resetTierCalibration does not touch render settings, but the
   *  active tier must be re-published for the loop to have anything to judge). */
  function unarmed(tier: 'low' | 'mid' = 'mid') {
    resetTierCalibration();
    setActiveQualityTier({ tier, source: 'gpu-benchmark', reason: 'a known GPU' });
  }

  it('⭐ does NOT demote on load frames — the A23 case this issue was filed for', () => {
    // The measured defect, in one test. On demos/forest-camp / Galaxy A23 two independent methods
    // assessed the device `mid`, and 3.57s later a 95.5ms median produced entirely inside GLB
    // parsing and shader compilation demoted it to `low` — stickily, for the whole session. Pinned
    // to `mid` the same scene on the same phone runs 16.8-20.5ms, inside the 20ms budget it was
    // condemned against.
    unarmed('mid');
    mockProfile = DROWNING();

    // Four full demotion hold periods of load-shaped frames. Before #227 this demoted on the first.
    for (let t = 0; t <= DEMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);

    expect(getActiveQualityTier()?.tier).toBe('mid');
  });

  it('demotes on the SAME profile once armed — so it is the arming that stopped it', () => {
    // The distinguishing control for the test above. Without this, "did not demote" is equally
    // explained by a broken profile, a missing config, or a gate somewhere else entirely.
    unarmed('mid');
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('mid');   // still un-armed

    armTierCalibration();
    const base = DEMOTION_HOLD_MS * 4;
    for (let t = base; t <= base + DEMOTION_HOLD_MS * 2; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('low');
  });

  it('suppresses PROMOTION too, not just the demotion that was observed misfiring', () => {
    // Both directions, deliberately: a promotion decided off load frames reads the same
    // contaminated window, and letting one direction through would make the window's meaning
    // depend on which way it happened to point.
    unarmed('low');
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'unrecognised device' });
    mockProfile = ROOMY();
    for (let t = 0; t <= PROMOTION_HOLD_MS * 3; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getPendingTierPromotion()).toBeNull();
  });

  it('arms on a world swap — the real signal, not a timer', async () => {
    unarmed('mid');
    expect(isTierCalibrationArmed()).toBe(false);

    // Drive a REAL world swap rather than calling armTierCalibration(): the subscription is the
    // thing under test, and asserting on the helper would pass just as well with nothing wired.
    const { createWorld } = await import('koota');
    const { setCurrentWorld } = await import('../../src/runtime/core/ecs/worldRegistry');
    setCurrentWorld(createWorld());

    expect(isTierCalibrationArmed()).toBe(true);
  });

  it('drops the frame window when it arms — gating the verdict alone is not enough', () => {
    // PROFILE_WINDOW_FRAMES is a frame COUNT (120), so at the A23's 95.5ms load frames the window
    // holds ~11.4s of history. Arming without dropping it would hand the policy a median still
    // dominated by the load it just waited out, and the demotion would fire a moment later anyway.
    unarmed('mid');
    const spy = vi.spyOn(profiler, 'resetFrameProfile');
    try {
      armTierCalibration();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('is idempotent — a game with many scene loads arms once, and does not re-drop the window', () => {
    unarmed('mid');
    const spy = vi.spyOn(profiler, 'resetFrameProfile');
    try {
      armTierCalibration();
      armTierCalibration();
      armTierCalibration();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('the BACKSTOP arms it when no scene ever loads, so calibration cannot sleep forever', () => {
    // The failsafe. Without it, "arm on a scene load" fails CLOSED on a project that never
    // completes one: a genuinely slow device could never be demoted because the mechanism is
    // politely waiting. That is #227 inverted, and it is the worse direction.
    unarmed('mid');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      tickTierCalibration(0);                       // starts the backstop clock
      tickTierCalibration(ARM_BACKSTOP_MS - 1);
      expect(isTierCalibrationArmed()).toBe(false); // not yet — a slow load must not trip it

      tickTierCalibration(ARM_BACKSTOP_MS);
      expect(isTierCalibrationArmed()).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('no world swap'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('does NOT arm — or touch the frame profile — when the editor has opted out', async () => {
    // Close-out finding. Arming calls resetFrameProfile(), and the editor opts out of live
    // calibration entirely (`main.tsx: setTierCalibrationEnabled(!__MODOKI_EDITOR__)`). A
    // MODULE-SCOPE onWorldSwap listener does not consult the tick's gates, so an ungated one
    // zeroed the profiler window on the editor's first scene load — the window
    // `debug/perfSources.ts` feeds to the Profiler panel and `modoki_profiler`. An agent
    // measuring right after loading the scene it wants to measure got percentiles over a
    // handful of frames, with nothing saying why.
    unarmed('mid');
    const spy = vi.spyOn(profiler, 'resetFrameProfile');
    setTierCalibrationEnabled(false);
    try {
      const { createWorld } = await import('koota');
      const { setCurrentWorld } = await import('../../src/runtime/core/ecs/worldRegistry');
      setCurrentWorld(createWorld());

      expect(isTierCalibrationArmed()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      setTierCalibrationEnabled(true);
      spy.mockRestore();
    }
  });

  it('the positive control — with calibration ON, the same swap DOES arm and reset', async () => {
    // Without this, the test above passes just as well if the listener were deleted outright.
    unarmed('mid');
    const spy = vi.spyOn(profiler, 'resetFrameProfile');
    try {
      const { createWorld } = await import('koota');
      const { setCurrentWorld } = await import('../../src/runtime/core/ecs/worldRegistry');
      setCurrentWorld(createWorld());

      expect(isTierCalibrationArmed()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('the backstop clears the worst load this repo has measured', () => {
    // Not a tautology on the constant: it pins the RELATIONSHIP the constant exists to satisfy.
    // postfx-demo's prewarm on a Huawei Y6 is 16.5s (scene3DSync.ts). A backstop shorter than that
    // would fire mid-load and hand the policy exactly the frames arming excludes — #227 verbatim.
    expect(ARM_BACKSTOP_MS).toBeGreaterThan(16_500);
  });
});

describe('#227 — a queued promotion that never gets a scene boundary', () => {
  it('applies mid-play once the grace expires, behind the tier-switch overlay', async () => {
    // A single-scene game reaches no boundary EVER, so without this the promotion path is dead for
    // a whole class of game and nothing says so.
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'unrecognised device' });
    mockProfile = ROOMY();
    const seen: (string | null)[] = [];
    const off = onTierSwitchOverlay((m) => seen.push(m));
    try {
      for (let t = 0; t <= PROMOTION_HOLD_MS * 2; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
      const queued = getPendingTierPromotion();
      expect(queued?.tier).toBe('mid');

      // Still waiting for a boundary that is not coming. Stepped by CALIBRATION_INTERVAL_MS, not
      // by 1 ms: the grace check sits BELOW the throttle, so two ticks a millisecond apart would
      // see only the first — the second would return at the throttle and the test would read a
      // working mechanism as broken.
      tickTierCalibration(queued!.since + PROMOTION_BOUNDARY_GRACE_MS - CALIBRATION_INTERVAL_MS);
      expect(getActiveQualityTier()?.tier).toBe('low');
      expect(getTierSwitchOverlayMessage()).toBeNull();

      tickTierCalibration(queued!.since + PROMOTION_BOUNDARY_GRACE_MS);
      // The overlay goes up BEFORE the switch — that ordering is the whole point, since the
      // recompile blocks the main thread and an overlay published afterwards would never paint.
      expect(seen[0]).toBeTruthy();
      expect(getPendingTierPromotion()).toBeNull();
    } finally { off(); }
  });

  it('a boundary that DOES arrive still wins — the mid-play path is the fallback, not the default', () => {
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'unrecognised device' });
    mockProfile = ROOMY();
    for (let t = 0; t <= PROMOTION_HOLD_MS * 2; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getPendingTierPromotion()?.tier).toBe('mid');

    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('mid');
    // Nothing left for the grace timer to fire on, and no overlay was ever shown: a boundary-applied
    // promotion hides inside a load the player already accepted and needs no explanation.
    expect(getPendingTierPromotion()).toBeNull();
    expect(getTierSwitchOverlayMessage()).toBeNull();
  });
});

describe('an IDLE window is not evidence (bug lvROp0yDYPSzS0VZM6LH)', () => {
  // Mobile CPU governors drop clocks when nothing is being touched, so the frames measured
  // during an idle window describe a THROTTLED device, not a slow one. Measured on a Galaxy S22
  // — the most powerful Android handset in the lab — sitting idle on Court's tutorial:
  //   {"tick":204,"tier":"mid","prev":"high","reason":"median frame 41.6ms over the 20.0ms budget for 2s"}
  //   {"tick":270,"tier":"low","prev":"mid","reason":"median frame 41.7ms over the 20.0ms budget for 2s"}
  // — two tiers in ~66 ticks, while the GPU identity table had deterministically resolved `high`
  // on that same phone at boot. The demotion is sticky in the direction that hurts: the player
  // taps, the CPU unthrottles, and the game runs at `low` on a flagship.
  //
  // The owner's rule (2026-08-20): idle is not evidence in EITHER direction — the same rule the
  // `armed` gate already applies to scene-load frames, rather than a demotion-only guard whose
  // meaning would depend on which way the sample happened to point.
  beforeEach(() => {
    setRenderSettings({ three: { qualityTier: 'auto', tiers: { low: { shadows: false }, high: {} } } } as never);
    setActiveQualityTier({ tier: 'high', source: 'gpu-benchmark', reason: 'Adreno (TM) 730 is a known GPU' });
    armTierCalibration();
  });

  it('does NOT demote on over-budget frames measured while nobody is playing', () => {
    playerIsInteracting = false;
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('high');
  });

  it('does NOT promote on roomy frames measured while nobody is playing', () => {
    // Both directions, deliberately. A promotion decided off an idle window is reading the same
    // uninformative sample, and letting one direction through would make the window mean
    // different things depending on its sign.
    setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'seed' });
    playerIsInteracting = false;
    mockProfile = ROOMY();
    for (let t = 0; t <= PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getPendingTierPromotion()).toBeNull();
    expect(getActiveQualityTier()?.tier).toBe('low');
  });

  it('DOES demote once the player is interacting again — the device is still judged, just not idle', () => {
    // The guard must not become "never demote". A phone that misses the budget while somebody is
    // actually playing is the case calibration exists for.
    playerIsInteracting = false;
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('high');

    playerIsInteracting = true;
    const base = DEMOTION_HOLD_MS * 8;
    for (let t = base; t <= base + DEMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('low');
  });

  it('does not let an idle stretch COUNT toward the sustain window it interrupts', () => {
    // The over-budget clock must not keep running through the idle gap and then fire the instant
    // input returns — that would demote on evidence that was almost entirely idle frames, which
    // is the reported bug in slow motion. The frame profiler fills its ring throughout the idle
    // stretch too, so the window is dropped on the way BACK, not on the way out.
    mockProfile = DROWNING();
    // Run long enough while interacting to genuinely arm the sustain clock. (The first tick alone
    // does not: `lastCheck` starts at 0, so tick(0) is swallowed by the throttle — an earlier
    // version of this test passed for exactly that reason and proved nothing.)
    for (let t = 0; t <= DEMOTION_HOLD_MS; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);
    expect(getActiveQualityTier()?.tier).toBe('high');    // not yet — the clock is running

    playerIsInteracting = false;
    const idleEnd = DEMOTION_HOLD_MS * 6;
    for (let t = DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t <= idleEnd; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);

    // One interacting tick must NOT be enough, even though the clock had nearly elapsed before
    // the gap and the gap itself was long.
    playerIsInteracting = true;
    tickTierCalibration(idleEnd + CALIBRATION_INTERVAL_MS);
    expect(getActiveQualityTier()?.tier).toBe('high');

    // ...and a full fresh sustain window of interacting frames still demotes, so the reset drops
    // evidence rather than disabling the mechanism.
    for (let t = idleEnd + CALIBRATION_INTERVAL_MS * 2; t <= idleEnd + DEMOTION_HOLD_MS * 3; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).toBe('low');
  });
});
