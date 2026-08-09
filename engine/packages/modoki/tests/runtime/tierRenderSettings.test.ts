/** The tier→renderer seam (#121 P3a) — `renderSettings`'s active-tier accessors.
 *
 *  `applyTierToThree` (the pure clamp) is tested in qualityTier.test.ts. This covers the part
 *  PRODUCTION actually goes through, which had no test at all: the accessor that
 *  `makeWebGPURenderer` reads when it allocates the first drawing buffer AND that Scene3D's
 *  ResizeObserver reads on every later resize.
 *
 *  THAT SHARED READ IS THE WHOLE POINT. If one of those two applied the tier and the other read
 *  the raw setting, the first resize would silently undo the tier — on a low-end device, exactly
 *  the saving the tier exists to make. A single accessor is the fix; these tests are what stop it
 *  being quietly split in two again. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRenderSettings, setRenderSettings, resetRenderSettings,
  setActiveQualityTier, getActiveQualityTier, getEffectiveThreeSettings, getActiveTierOrDefault,
} from '../../src/runtime/rendering/renderSettings';

const LOW = { tier: 'low' as const, source: 'project' as const, reason: 'test' };
const HIGH = { tier: 'high' as const, source: 'project' as const, reason: 'test' };

beforeEach(() => resetRenderSettings());

describe('getEffectiveThreeSettings', () => {
  it('returns the RAW settings before any tier resolves — pre-tier behaviour, unchanged', () => {
    // A call before renderer bring-up must behave exactly as it did before tiers existed.
    expect(getActiveQualityTier()).toBeNull();
    expect(getEffectiveThreeSettings()).toEqual(getRenderSettings().three);
  });

  it('is a NO-OP on high — which is what makes wiring tiers up safe for every existing project', () => {
    setActiveQualityTier(HIGH);
    expect(getEffectiveThreeSettings()).toEqual(getRenderSettings().three);
  });

  it('clamps on low', () => {
    setActiveQualityTier(LOW);
    expect(getEffectiveThreeSettings()).toMatchObject({
      pixelRatioCap: 1, antialias: false, shadows: false,
    });
  });

  it('never RAISES a project that authored leaner settings than the tier', () => {
    setRenderSettings({ three: { pixelRatioCap: 1, antialias: false, shadows: false } });
    setActiveQualityTier(HIGH);
    expect(getEffectiveThreeSettings()).toMatchObject({
      pixelRatioCap: 1, antialias: false, shadows: false,
    });
  });

  it('THE DIVERGENCE GUARD: bring-up and a later resize read the same value', () => {
    // Models the two real callers. makeWebGPURenderer reads once when it allocates the buffer;
    // Scene3D's ResizeObserver reads again on every resize. They must never disagree.
    setRenderSettings({ three: { pixelRatioCap: 2 } });
    setActiveQualityTier(LOW);
    const atBringUp = getEffectiveThreeSettings().pixelRatioCap;
    const atResize = getEffectiveThreeSettings().pixelRatioCap;
    expect(atResize).toBe(atBringUp);
    expect(atResize).toBe(1);          // and it is the TIER's value, not the project's 2
  });

  it('follows a live tier change, so a demotion reaches the next resize', () => {
    setActiveQualityTier(HIGH);
    expect(getEffectiveThreeSettings().shadows).toBe(true);
    setActiveQualityTier(LOW);          // what applyQualityTier does on a demotion
    expect(getEffectiveThreeSettings().shadows).toBe(false);
  });

  it('does not mutate the stored project settings — the tier is a VIEW, not a write', () => {
    setActiveQualityTier(LOW);
    getEffectiveThreeSettings();
    // The authored values must survive, or promoting back to high could never restore them.
    expect(getRenderSettings().three).toMatchObject({
      pixelRatioCap: 2, antialias: true, shadows: true,
    });
  });
});

describe('getActiveTierOrDefault', () => {
  it('defaults to high, so "no tier yet" cannot mean "no shadow-map ceiling"', () => {
    // syncLights clamps Light.shadowMapSize through this every frame. Defaulting to `low` would
    // silently shrink every shadow map before a tier resolves.
    expect(getActiveTierOrDefault()).toBe('high');
  });

  it('reports the resolved tier once one exists', () => {
    setActiveQualityTier(LOW);
    expect(getActiveTierOrDefault()).toBe('low');
  });
});

describe('resetRenderSettings', () => {
  it('clears the active tier too — or one test leaks a tier into the next', () => {
    setActiveQualityTier(LOW);
    resetRenderSettings();
    expect(getActiveQualityTier()).toBeNull();
    expect(getEffectiveThreeSettings()).toEqual(getRenderSettings().three);
  });
});
