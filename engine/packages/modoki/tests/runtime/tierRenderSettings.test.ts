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
  getActiveTierOverrides, getEffectivePixiSettings, getEffectiveTargetFps,
} from '../../src/runtime/rendering/renderSettings';
import { UNCLAMPED_OVERRIDES, TIER_SETTINGS, tierAllowsIBL, type TierRenderOverrides } from '../../src/runtime/rendering/qualityTier';

const LOW = { tier: 'low' as const, source: 'project' as const, reason: 'test' };
const HIGH = { tier: 'high' as const, source: 'project' as const, reason: 'test' };

/** Authors `rendering.three.tiers.low` from the engine's seed table (docs/rendering.md §
 *  "Quality tiers") — since the DEFAULT is now the ABSENCE of clamping, `LOW` above is a no-op
 *  unless the project actually authored something to clamp with. The tests below that assert
 *  "low clamps" are testing THIS mechanism (the shared-read/divergence guard), not the seed
 *  values, so they author `low` from `TIER_SETTINGS.low` to keep exercising it. */
const authorLowTier = () => setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } });

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

  it('clamps on low — once the project has authored something to clamp with', () => {
    authorLowTier();
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
    authorLowTier();
    setRenderSettings({ three: { pixelRatioCap: 2 } });
    setActiveQualityTier(LOW);
    const atBringUp = getEffectiveThreeSettings().pixelRatioCap;
    const atResize = getEffectiveThreeSettings().pixelRatioCap;
    expect(atResize).toBe(atBringUp);
    expect(atResize).toBe(1);          // and it is the TIER's value, not the project's 2
  });

  it('follows a live tier change, so a demotion reaches the next resize', () => {
    authorLowTier();
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

// ── getActiveTierOverrides (docs/rendering.md § "Quality tiers") ────────────────────────────
// THE ONE RESOLUTION POINT every render-loop consumer (tierAllowsIBL, tierShadowMapSize,
// tierAmbientBoost, tierExposureBoost, tierAllowsEffect, applyTierToThree, the light-cap arming)
// reads instead of a raw `TIER_SETTINGS[tier]` lookup — so a project's authored `rendering.three
// .tiers` decides, never a code table.
describe('getActiveTierOverrides', () => {
  it('resolves the UNCLAMPED default when the project authored no tiers.mid/low', () => {
    expect(getActiveTierOverrides()).toBe(UNCLAMPED_OVERRIDES);
    setActiveQualityTier(HIGH);
    expect(getActiveTierOverrides()).toBe(UNCLAMPED_OVERRIDES);
  });

  it('follows the AUTHORED config for the active tier — not a code table', () => {
    // A value that appears nowhere in the engine's own TIER_SETTINGS/UNCLAMPED_OVERRIDES, so
    // this can only pass if getActiveTierOverrides is actually reading what was authored.
    const authoredLow: TierRenderOverrides = {
      pixelRatioCap: 1, antialias: false, shadows: false, shadowMapCeiling: 777,
      postFX: { npr: false, ao: false, dof: false, bloom: false, vignette: false },
      maxDirectional: 1, maxLocal: 1, ibl: false, iblOffAmbientBoost: 4, iblOffExposure: 1.25,
      // #202's fields, at values that appear in no engine table either — same argument as
      // shadowMapCeiling's 777 above. They also keep this config COMPLETE, which is what makes
      // the `toBe` identity below a statement about the resolver rather than about back-filling.
      targetFps: 24, pixiPixelRatioCap: 1, pixiAntialias: false,
      // #212's field, same argument again — 999 appears in no engine table.
      textureMaxSize: 999,
    };
    setRenderSettings({ three: { tiers: { low: authoredLow } } });
    setActiveQualityTier({ tier: 'low', source: 'project', reason: 'test' });
    const resolved = getActiveTierOverrides();
    expect(resolved).toBe(authoredLow);
    expect(resolved.shadowMapCeiling).toBe(777);
    expect(tierAllowsIBL(resolved)).toBe(false);
  });
});

// ── The 2D layer and the frame cap (#202) ──────────────────────────────────────────────────
//
// The 3D accessor above had a test because splitting it in two would silently undo the tier on
// the first resize. These two are the same seam for the other two layers, and they had NO
// mechanism at all before #202: `qualityTier.ts` held zero references to `pixi`, and `targetFps`
// was pushed into the frame driver once at boot and never re-read.

describe('getEffectivePixiSettings', () => {
  it('returns the RAW settings before any tier resolves — pre-tier behaviour, unchanged', () => {
    expect(getActiveQualityTier()).toBeNull();
    expect(getEffectivePixiSettings()).toEqual(getRenderSettings().pixi);
  });

  it('is a no-op on a project that authored no tiers — every tier resolves the default', () => {
    setRenderSettings({ pixi: { pixelRatioCap: 3, antialias: true } });
    for (const res of [LOW, HIGH]) {
      setActiveQualityTier(res);
      expect(getEffectivePixiSettings()).toMatchObject({ pixelRatioCap: 3, antialias: true });
    }
  });

  it('clamps DPR and AA once the project authors a `low` — court`s case, end to end', () => {
    // games/court authors `pixi.pixelRatioCap: 3`. On `low` that must reach the backing buffer as
    // 1 — the Y6 fill-rate measurement, which is not a Three.js fact and applies to a Pixi canvas
    // identically.
    setRenderSettings({ pixi: { pixelRatioCap: 3, antialias: true } });
    authorLowTier();
    setActiveQualityTier(LOW);
    expect(getEffectivePixiSettings()).toMatchObject({ pixelRatioCap: 1, antialias: false });
    // ...and `high` still gets exactly what the project asked for.
    setActiveQualityTier(HIGH);
    expect(getEffectivePixiSettings()).toMatchObject({ pixelRatioCap: 3, antialias: true });
  });

  it('leaves a PINNED resolution alone on every tier — capping a pin would make the pin a lie', () => {
    setRenderSettings({ pixi: { resolution: 2, pixelRatioCap: 3 } });
    authorLowTier();
    setActiveQualityTier(LOW);
    expect(getEffectivePixiSettings().resolution).toBe(2);
  });
});

describe('getEffectiveTargetFps', () => {
  it('returns the authored cap before any tier resolves', () => {
    setRenderSettings({ targetFps: 60 });
    expect(getActiveQualityTier()).toBeNull();
    expect(getEffectiveTargetFps()).toBe(60);
  });

  it('picks the project`s `rendering.targetFps` up through setRenderSettings', () => {
    // It reaches the registry now (it used to bypass it entirely and go straight to the frame
    // driver), which is what gives a tier something to clamp.
    setRenderSettings({ targetFps: 30 });
    expect(getRenderSettings().targetFps).toBe(30);
  });

  it('does not treat an authored 0 as absent — 0 is UNCAPPED, a real value', () => {
    setRenderSettings({ targetFps: 0 });
    expect(getRenderSettings().targetFps).toBe(0);
    expect(getEffectiveTargetFps()).toBe(0);
  });

  it('caps to the tier`s 30 on `low`, and restores the authored 60 on `high`', () => {
    setRenderSettings({ targetFps: 60 });
    authorLowTier();
    setActiveQualityTier(LOW);
    expect(getEffectiveTargetFps()).toBe(30);
    // Derived from the AUTHORED value every time, never remembered — so a promotion back up
    // restores what the project asked for rather than whatever a demotion left behind.
    setActiveQualityTier(HIGH);
    expect(getEffectiveTargetFps()).toBe(60);
  });

  it('is a no-op on a project that authored no tiers, even on `low`', () => {
    // "You cannot select a config that does not exist" — pinning `low` on an unauthored project
    // changes nothing, and the frame cap must follow that rule like every other field.
    setRenderSettings({ targetFps: 60 });
    setActiveQualityTier(LOW);
    expect(getEffectiveTargetFps()).toBe(60);
  });
});
