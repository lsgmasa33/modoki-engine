/** Tier calibration loop (#121 P3b) — `runtime/rendering/tierCalibration.ts`.
 *
 *  The DECISION is `qualityTier.ts`'s and is tested there. These cover only what this module
 *  adds: the throttle, the auto-only gate, and — the load-bearing one — that a demotion applies
 *  IMMEDIATELY while a promotion WAITS for a scene boundary. Getting that pair backwards is the
 *  failure this design exists to avoid: a mid-play promotion recompiles shaders and can freeze
 *  longer than the low tier it escapes, while a deferred demotion leaves a struggling device
 *  struggling until the next scene load, which for a one-scene game is never. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  getPendingTierPromotion, CALIBRATION_INTERVAL_MS,
} from '../../src/runtime/rendering/tierCalibration';
import {
  setRenderSettings, resetRenderSettings, setActiveQualityTier, getActiveQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import { PROMOTION_HOLD_MS, DEMOTION_HOLD_MS } from '../../src/runtime/rendering/qualityTier';

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
  setRenderSettings({ three: { qualityTier: 'auto' } });
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

  it('demotes once over budget has held, with no scene boundary needed', () => {
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    const active = getActiveQualityTier();
    expect(active?.tier).toBe('low');
    expect(active?.source).toBe('measured');
    expect(getPendingTierPromotion()).toBeNull(); // it did NOT queue
  });

  it('pushes the live knobs it can: shadows off + a resize to re-clamp the pixel ratio', () => {
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(mockRenderer.shadowMap.enabled).toBe(false);
    // pixelRatioCap is only meaningful against the live container size, so applying it IS
    // re-running each surface's resize — one implementation of the clamp, not two.
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
    expect(getPendingTierPromotion()).toMatchObject({ tier: 'high' });
    expect(getActiveQualityTier()?.tier).toBe('low');  // still low, deliberately
    expect(mockRenderer.shadowMap.enabled).toBe(true); // untouched
    expect(resizeCalls).toBe(0);
  });

  it('applies at the boundary, and reports WHY it was deferred', () => {
    sustainHeadroom();
    applyPendingTierPromotion();
    const active = getActiveQualityTier();
    expect(active?.tier).toBe('high');
    expect(active?.source).toBe('measured');
    expect(active?.reason).toContain('scene boundary');
    expect(getPendingTierPromotion()).toBeNull(); // consumed exactly once
  });

  it('applying with nothing queued is a no-op', () => {
    applyPendingTierPromotion();
    expect(getActiveQualityTier()?.tier).toBe('low');
    expect(resizeCalls).toBe(0);
  });

  it('never promotes again after a demotion — the sticky rule survives this layer', () => {
    // Demote first...
    setActiveQualityTier({ tier: 'high', source: 'calibrating', reason: 'x' });
    mockProfile = DROWNING();
    for (let t = 0; t <= DEMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getActiveQualityTier()?.tier).toBe('low');
    // ...then hand it a perfect profile forever. Oscillating between a tier that is too slow and
    // one that is too pretty is worse than either.
    mockProfile = ROOMY();
    for (let t = 10_000; t <= 10_000 + PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).toBeNull();
    expect(getActiveQualityTier()?.tier).toBe('low');
  });
});
