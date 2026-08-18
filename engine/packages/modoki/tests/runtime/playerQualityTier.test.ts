/** The player's quality-tier choice (#121 P3d) — `runtime/rendering/playerQualityTier.ts`.
 *
 *  The two assertions that matter: the player OUTRANKS everything (they can see the screen and we
 *  cannot), and calibration must not argue with them — without that, someone who picked `low` in a
 *  settings menu would be silently promoted back to `high` five seconds later by an inference. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/runtime/core/activeRenderer', () => ({ getActiveRenderer: () => null }));
vi.mock('../../src/runtime/rendering/resizeBus', () => ({ forceResizeAllSurfaces: () => {} }));
vi.mock('../../src/runtime/core/frameProfiler', async (orig) => {
  const actual = await orig<typeof import('../../src/runtime/core/frameProfiler')>();
  return { ...actual, getFrameProfile: () => mockProfile };
});
vi.mock('../../src/runtime/rendering/deviceCaps', () => ({ getDeviceCapsSync: () => mockCaps }));

import { playerTierStore } from '../../src/runtime/core/playerTierStore';
import { probeVerdictStore } from '../../src/runtime/core/probeVerdictStore';
import {
  getPlayerQualityTier, setPlayerQualityTier, hasPlayerQualityTier, choosePlayerQualityTier,
} from '../../src/runtime/rendering/playerQualityTier';
import {
  setRenderSettings, resetRenderSettings, getActiveQualityTier, setActiveQualityTier,
  getAssessedQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import {
  tickTierCalibration, resetTierCalibration, getPendingTierPromotion, CALIBRATION_INTERVAL_MS,
  armTierCalibration,
} from '../../src/runtime/rendering/tierCalibration';
import { PROMOTION_HOLD_MS, TIER_SETTINGS, promotionCeiling } from '../../src/runtime/rendering/qualityTier';
import { probeFingerprint } from '../../src/runtime/rendering/rampProbe';
import type { DeviceCaps } from '../../src/runtime/rendering/deviceCaps';
import { BUDGET_30FPS_MS, type FrameProfile } from '../../src/runtime/core/frameProfiler';

let mockCaps: DeviceCaps | null = null;

let stored: 'low' | 'mid' | 'high' | null = null;
const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
const mockProfile: FrameProfile = {
  samples: 120, frameMs: stat(10), cpuMs: stat(4), restMs: stat(6), fps: 100,
  vsyncBound: false, overBudget: false, budgetMs: BUDGET_30FPS_MS, discontinuities: 0,
};

beforeEach(() => {
  stored = null;
  mockCaps = null;
  playerTierStore.reset();
  playerTierStore.provide({ read: () => stored, write: (t) => { stored = t; } });
  probeVerdictStore.reset();
  resetRenderSettings();
  resetTierCalibration();
  // Since #227 the loop ignores the profile until a scene has loaded — see tierCalibration.test.ts.
  // This suite is about the PLAYER-choice gate, so it arms and asks its own question.
  armTierCalibration();
});

describe('storage round-trip', () => {
  it('reads back what was written, and null clears it', () => {
    expect(getPlayerQualityTier()).toBeNull();
    setPlayerQualityTier('low');
    expect(getPlayerQualityTier()).toBe('low');
    expect(hasPlayerQualityTier()).toBe(true);
    setPlayerQualityTier(null);
    expect(getPlayerQualityTier()).toBeNull();
    expect(hasPlayerQualityTier()).toBe(false);
  });

  it('rejects a bogus persisted value instead of passing it to the renderer', () => {
    // Prefs are JSON that outlives engine upgrades; an older build's value must not smuggle a
    // bad tier through.
    stored = 'ultra' as unknown as 'low';
    expect(getPlayerQualityTier()).toBeNull();
  });

  it('reads null when nothing provides the slot — a headless test or a DCE\'d build', () => {
    playerTierStore.reset();
    expect(getPlayerQualityTier()).toBeNull();
    expect(() => setPlayerQualityTier('low')).not.toThrow();
  });
});

describe('choosePlayerQualityTier', () => {
  it('persists AND applies immediately — the player is watching', () => {
    choosePlayerQualityTier('low');
    expect(stored).toBe('low');
    expect(getActiveQualityTier()).toMatchObject({ tier: 'low', source: 'player' });
  });

  it('Auto clears the override and falls back to the project setting', () => {
    setRenderSettings({ three: { qualityTier: 'high' } });
    choosePlayerQualityTier('low');
    expect(getActiveQualityTier()?.tier).toBe('low');

    choosePlayerQualityTier(null);
    expect(stored).toBeNull();
    const active = getActiveQualityTier();
    expect(active?.tier).toBe('high');          // back to the project's pin
    expect(active?.reason).toContain('Auto');
  });
});

describe('choosePlayerQualityTier(null) — "Auto" must NOT discard the boot probe verdict (#202 close-out)', () => {
  // ⚠️ THE DEFECT. This call site used to hand-assemble its own `resolveTier` input and omit
  // `probeClass` entirely. On Android, `TIER_ALLOWLIST.androidGpuPatterns` is empty, so with the
  // probe class gone nothing else can answer the tier question — a device the probe measured as
  // `middle` fell all the way to `calibrating -> low` the instant its player tapped "Auto".
  //
  // THIS IS THE DISTINGUISHING TEST: it asserts the tier ends up `mid`/`measured`, which is
  // reachable ONLY if `probeClass` survives the call. Revert `playerQualityTier.ts` back to its
  // hand-assembled `resolveTier({...})` call (dropping `probeClass`) and this must fail — see the
  // brief's verification instructions.
  it('an Android device the probe measured `middle` resolves to `mid`/`measured`, not `low`/`calibrating`', () => {
    mockCaps = {
      platform: 'android', webgpu: false, backend: 'WebGL',
      // ⚠️ A GPU **identity cannot place** (#210), and that is the point: this test is about the
      // PROBE path, and identity now answers ahead of it. `Mali-G57 MC2` used to sit here and is a
      // table hit resolving `mid`/`gpu-benchmark` — which would pass the tier assertion while
      // testing nothing about `probeClass`. Do not restore a real GPU name.
      gpuRenderer: 'Vivante GC7000', compressed: { astc: false, etc2: true, s3tc: false },
      formFactor: 'mobile',
    };
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    const viewportPx = (g.innerWidth ?? 0) * (g.innerHeight ?? 0);
    const fingerprint = probeFingerprint({
      platform: mockCaps.platform, deviceModel: mockCaps.deviceModel,
      gpuRenderer: mockCaps.gpuRenderer, viewportPx,
    });
    probeVerdictStore.provide({
      read: () => ({ fingerprint, deviceClass: 'middle', samples: [], final: true }),
      write: () => {},
    });
    setRenderSettings({ three: { qualityTier: 'auto' } });

    choosePlayerQualityTier(null);

    const active = getActiveQualityTier();
    expect(active?.tier).toBe('mid');
    expect(active?.source).toBe('measured');
  });
});

describe('a player pin is not an ASSESSMENT — the promotion ceiling must not latch it (#208)', () => {
  // ⚠️ THE DEFECT, observed on the A23. A pin persists in PlayerPrefs, so the next launch boots
  // straight into `{source:'player'}` and THAT was the first resolution `assessedTier` latched.
  // Switching back to Auto re-resolved and applied `mid`/`measured` correctly (the R1.2 fix), but
  // the assessment stayed `low`/`player` — so `promotionCeiling` sat at the pinned tier for the
  // rest of the process and live calibration could never climb back out of a demotion.
  //
  // THIS IS THE DISTINGUISHING ASSERTION: `assessed` after the Auto switch. The ACTIVE tier reads
  // `mid` either way, which is exactly why the bug survived a device pass — only the assessment
  // tells the two apart.
  const bootPinnedThenAuto = (): void => {
    mockCaps = {
      platform: 'android', webgpu: false, backend: 'WebGL',
      // ⚠️ A GPU **identity cannot place** (#210), and that is the point: this test is about the
      // PROBE path, and identity now answers ahead of it. `Mali-G57 MC2` used to sit here and is a
      // table hit resolving `mid`/`gpu-benchmark` — which would pass the tier assertion while
      // testing nothing about `probeClass`. Do not restore a real GPU name.
      gpuRenderer: 'Vivante GC7000', compressed: { astc: false, etc2: true, s3tc: false },
      formFactor: 'mobile',
    };
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    const fingerprint = probeFingerprint({
      platform: mockCaps.platform, deviceModel: mockCaps.deviceModel,
      gpuRenderer: mockCaps.gpuRenderer, viewportPx: (g.innerWidth ?? 0) * (g.innerHeight ?? 0),
    });
    probeVerdictStore.provide({
      read: () => ({ fingerprint, deviceClass: 'middle', samples: [], final: true }),
      write: () => {},
    });
    setRenderSettings({ three: { qualityTier: 'auto' } });
    // Launch 2: the stored pin is read before anything else and the probe never runs, so the
    // FIRST resolution of the session is the player's — this is `resolveActiveTierOnce`'s
    // player/pin branch, not a mid-session tap.
    stored = 'low';
    setActiveQualityTier({ tier: 'low', source: 'player', reason: 'player selected this tier' });
  };

  it('nothing assessed a device whose tier came from a pin, so there is no assessment to report', () => {
    bootPinnedThenAuto();
    expect(getActiveQualityTier()).toMatchObject({ tier: 'low', source: 'player' });
    // Honest: the probe never ran this launch. Null, not a human preference wearing the word
    // "assessed" — which is also what `diagnose` now shows.
    expect(getAssessedQualityTier()).toBeNull();
  });

  it('switching to Auto re-assesses the device, so the ceiling follows the measurement', () => {
    bootPinnedThenAuto();
    choosePlayerQualityTier(null);

    expect(getActiveQualityTier()).toMatchObject({ tier: 'mid', source: 'measured' });
    expect(getAssessedQualityTier()).toMatchObject({ tier: 'mid', source: 'measured' });
    // The consequence, stated in the terms the bug was about: promotion may reach `mid` again
    // after a demotion, instead of being pinned under the tier the player happened to pick.
    expect(promotionCeiling(getAssessedQualityTier())).toBe('mid');
  });

  it('a REAL assessment still wins over a later pin — the measurement is not re-latched', () => {
    // The other direction, which the fix must not break: boot in Auto (measured), then pin, then
    // Auto again. The original measurement stands throughout; nothing re-assesses on a whim.
    setActiveQualityTier({ tier: 'mid', source: 'measured', reason: 'boot ramp probe' });
    setActiveQualityTier({ tier: 'low', source: 'player', reason: 'player selected this tier' });
    expect(getAssessedQualityTier()).toMatchObject({ tier: 'mid', source: 'measured' });
  });
});

describe('calibration must not argue with the player', () => {
  it('does NOT promote a player who chose low, however much headroom there is', () => {
    setRenderSettings({ three: { qualityTier: 'auto' } });
    setActiveQualityTier({ tier: 'low', source: 'player', reason: 'player selected this tier' });
    setPlayerQualityTier('low');

    for (let t = 0; t <= PROMOTION_HOLD_MS * 4; t += CALIBRATION_INTERVAL_MS) tickTierCalibration(t);

    expect(getPendingTierPromotion()).toBeNull();
    expect(getActiveQualityTier()?.tier).toBe('low');
  });

  it('resumes calibrating once the player picks Auto', () => {
    // Authored configs, because since the owner's "one config ⇒ nothing to change to" rule
    // (plan §2.2) calibration only runs when there IS something to move to. This test is about
    // the player gate releasing, not about the config gate — so give it a ladder to climb.
    setRenderSettings({ three: { qualityTier: 'auto', tiers: { mid: TIER_SETTINGS.mid, low: TIER_SETTINGS.low } } });
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'x' });
    setPlayerQualityTier(null);

    for (let t = 0; t <= PROMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    // ONE STEP UP THE LADDER, so `low` promotes to `mid` and not to `high` (#188). Before `mid`
    // existed this read 'high' and meant the same thing — "the next tier up" — which is exactly
    // why the target now comes from the decision instead of from a literal at the call site.
    expect(getPendingTierPromotion()).toMatchObject({ tier: 'mid' });
  });
});
