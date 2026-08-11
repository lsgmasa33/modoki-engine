/** QualityTiersEditor's decision logic (docs/rendering.md § "Quality tiers") — the
 *  parts that must be exactly right for a reason bigger than this one panel: `configCount()`
 *  and A2's boot-probe gate read PRESENCE of `mid`/`low`, not any particular value, so a "remove"
 *  that leaves a stray key (or nulls/empties it instead of omitting it) silently re-arms a probe
 *  the owner explicitly wanted gone for a single-config project. */

import { describe, it, expect } from 'vitest';
import {
  normalizeAuthoredTiers, seedTier, addTier, removeTier, withField, withPostFX,
} from '../../packages/modoki/src/editor/panels/qualityTiersModel';
import {
  TIER_SETTINGS, configCount, NO_POSTFX,
  type AuthoredTiers, type TierRenderOverrides,
} from '../../packages/modoki/src/runtime/rendering/qualityTier';

describe('normalizeAuthoredTiers', () => {
  it('returns {} for undefined/null/non-object values', () => {
    expect(normalizeAuthoredTiers(undefined)).toEqual({});
    expect(normalizeAuthoredTiers(null)).toEqual({});
    expect(normalizeAuthoredTiers('nonsense')).toEqual({});
    expect(normalizeAuthoredTiers(42)).toEqual({});
  });

  it('passes through mid/low when they are objects, and drops anything else', () => {
    const mid = { pixelRatioCap: 1 };
    const out = normalizeAuthoredTiers({ mid, low: 'not-an-object', extra: true });
    expect(out).toEqual({ mid });
    expect('low' in out).toBe(false);
  });
});

describe('seedTier — "Add low" gives measured behaviour, not blank fields (owner requirement)', () => {
  it('seeds low from TIER_SETTINGS.low', () => {
    expect(seedTier('low')).toEqual(TIER_SETTINGS.low);
  });

  it('seeds mid from TIER_SETTINGS.mid', () => {
    expect(seedTier('mid')).toEqual(TIER_SETTINGS.mid);
  });

  it('is a deep copy — mutating the seed must never mutate the engine table', () => {
    const seeded = seedTier('low');
    seeded.pixelRatioCap = 999;
    (seeded.postFX as Record<string, boolean>).npr = true;
    expect(TIER_SETTINGS.low.pixelRatioCap).not.toBe(999);
    expect(TIER_SETTINGS.low.postFX.npr).toBe(false);
    // Also not the same postFX object reference (NO_POSTFX is shared across tiers/sessions).
    expect(seedTier('low').postFX).not.toBe(NO_POSTFX);
  });
});

describe('addTier', () => {
  it('adds a seeded tier to an undefined AuthoredTiers', () => {
    const out = addTier(undefined, 'low');
    expect(out).toEqual({ low: TIER_SETTINGS.low });
  });

  it('adds alongside an existing tier without disturbing it', () => {
    const existingMid = seedTier('mid');
    const out = addTier({ mid: existingMid }, 'low');
    expect(out.mid).toBe(existingMid);
    expect(out.low).toEqual(TIER_SETTINGS.low);
  });

  it('never mutates the input object', () => {
    const input: AuthoredTiers = { mid: seedTier('mid') };
    const before = { ...input };
    addTier(input, 'low');
    expect(input).toEqual(before);
  });
});

describe('removeTier — THE invariant: omit the key, never null/empty it', () => {
  it('removing the only tier yields an object where the key is fully ABSENT', () => {
    const authored: AuthoredTiers = { low: seedTier('low') };
    const result = removeTier(authored, 'low');
    expect('low' in result).toBe(false);
    // Not present as undefined either — a real omission, not a nulled/blanked field.
    expect(Object.prototype.hasOwnProperty.call(result, 'low')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('low');
  });

  it('removing one of two tiers leaves the other completely untouched', () => {
    const mid = seedTier('mid');
    const low = seedTier('low');
    const result = removeTier({ mid, low }, 'low');
    expect('low' in result).toBe(false);
    expect(result.mid).toBe(mid);
  });

  it('configCount() drops by exactly one when a tier is removed', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid'), low: seedTier('low') };
    expect(configCount(authored)).toBe(3);
    const afterRemovingLow = removeTier(authored, 'low');
    expect(configCount(afterRemovingLow)).toBe(2);
    const afterRemovingBoth = removeTier(afterRemovingLow, 'mid');
    expect(configCount(afterRemovingBoth)).toBe(1);
  });

  it('removing an absent tier is a no-op, not an error, and stays keyless', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid') };
    const result = removeTier(authored, 'low');
    expect(result).toEqual(authored);
    expect('low' in result).toBe(false);
  });

  it('removing from undefined yields {} — never null, never a stray key', () => {
    expect(removeTier(undefined, 'low')).toEqual({});
  });

  it('never mutates the input object', () => {
    const authored: AuthoredTiers = { mid: seedTier('mid'), low: seedTier('low') };
    const before = structuredClone(authored);
    removeTier(authored, 'low');
    expect(authored).toEqual(before);
  });
});

describe('withField', () => {
  it('sets one field and leaves the rest of the config unchanged', () => {
    const cfg = seedTier('low');
    const next = withField(cfg, 'pixelRatioCap', 2);
    expect(next.pixelRatioCap).toBe(2);
    expect(next).not.toBe(cfg);
    expect({ ...next, pixelRatioCap: cfg.pixelRatioCap }).toEqual(cfg);
  });

  it('never mutates the input config', () => {
    const cfg = seedTier('mid');
    const before = structuredClone(cfg);
    withField(cfg, 'shadowMapCeiling', 2048);
    expect(cfg).toEqual(before);
  });
});

describe('withPostFX — toggling one effect', () => {
  it('flips exactly the requested effect and leaves the other four untouched', () => {
    const cfg = seedTier('low'); // NO_POSTFX — every effect starts false
    const next = withPostFX(cfg, 'bloom', true);
    expect(next.postFX.bloom).toBe(true);
    for (const effect of ['npr', 'ao', 'dof', 'vignette'] as const) {
      expect(next.postFX[effect]).toBe(cfg.postFX[effect]);
    }
  });

  it('never mutates the input config or its (possibly shared) postFX object', () => {
    const cfg = seedTier('low');
    const beforePostFX = { ...cfg.postFX };
    withPostFX(cfg, 'npr', true);
    expect(cfg.postFX).toEqual(beforePostFX);
  });

  it('produces a NEW postFX object, not a mutated shared one', () => {
    const cfg = seedTier('low');
    const next = withPostFX(cfg, 'npr', true);
    expect(next.postFX).not.toBe(cfg.postFX);
  });
});

// A tiny sanity check that the fixture tiers really do have all ten TierRenderOverrides fields —
// if the engine adds an eleventh field, seedTier picks it up automatically (it clones the whole
// object) and this test documents that expectation rather than enumerating fields by hand.
describe('seeded tiers carry the full TierRenderOverrides shape', () => {
  const FIELDS: (keyof TierRenderOverrides)[] = [
    'pixelRatioCap', 'antialias', 'shadows', 'shadowMapCeiling', 'postFX',
    'maxDirectional', 'maxLocal', 'ibl', 'iblOffAmbientBoost', 'iblOffExposure',
  ];
  it.each(['mid', 'low'] as const)('%s has every field', (tier) => {
    const seeded = seedTier(tier);
    for (const f of FIELDS) expect(seeded[f]).not.toBeUndefined();
  });
});
