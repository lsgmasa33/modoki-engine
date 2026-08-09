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

import { playerTierStore } from '../../src/runtime/core/playerTierStore';
import {
  getPlayerQualityTier, setPlayerQualityTier, hasPlayerQualityTier, choosePlayerQualityTier,
} from '../../src/runtime/rendering/playerQualityTier';
import {
  setRenderSettings, resetRenderSettings, getActiveQualityTier, setActiveQualityTier,
} from '../../src/runtime/rendering/renderSettings';
import {
  tickTierCalibration, resetTierCalibration, getPendingTierPromotion, CALIBRATION_INTERVAL_MS,
} from '../../src/runtime/rendering/tierCalibration';
import { PROMOTION_HOLD_MS } from '../../src/runtime/rendering/qualityTier';
import type { FrameProfile } from '../../src/runtime/core/frameProfiler';

let stored: 'low' | 'high' | null = null;
const stat = (v: number) => ({ median: v, p95: v, min: v, max: v });
const mockProfile: FrameProfile = {
  samples: 120, frameMs: stat(10), cpuMs: stat(4), restMs: stat(6), fps: 100,
  vsyncBound: false, overBudget: false, discontinuities: 0,
};

beforeEach(() => {
  stored = null;
  playerTierStore.reset();
  playerTierStore.provide({ read: () => stored, write: (t) => { stored = t; } });
  resetRenderSettings();
  resetTierCalibration();
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
    setRenderSettings({ three: { qualityTier: 'auto' } });
    setActiveQualityTier({ tier: 'low', source: 'calibrating', reason: 'x' });
    setPlayerQualityTier(null);

    for (let t = 0; t <= PROMOTION_HOLD_MS + CALIBRATION_INTERVAL_MS; t += CALIBRATION_INTERVAL_MS) {
      tickTierCalibration(t);
    }
    expect(getPendingTierPromotion()).toMatchObject({ tier: 'high' });
  });
});
