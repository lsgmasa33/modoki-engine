/** assetSchemas — field metadata + warn-but-write validation for material /
 *  particle / animation asset files (so an agent authors them without guessing). */

import { describe, it, expect } from 'vitest';
import {
  getAssetSchema, defaultAssetData, validateAssetData, normalizeAssetData,
} from '../../src/runtime/assets/assetSchemas';

describe('getAssetSchema', () => {
  it('returns fields + a valid example for each type', () => {
    for (const type of ['material', 'particle', 'animation', 'spriteanim'] as const) {
      const s = getAssetSchema(type)!;
      expect(s.type).toBe(type);
      expect(s.fields.length).toBeGreaterThan(0);
      expect(s.example).toBeTruthy();
      // The example must itself pass validation (no hard errors).
      expect(validateAssetData(type, s.example).errors).toEqual([]);
    }
  });
});

describe('validateAssetData (warn-but-write)', () => {
  it('hard-errors on a non-object document', () => {
    expect(validateAssetData('material', 42).errors.length).toBe(1);
    expect(validateAssetData('material', [] as unknown).errors.length).toBe(1);
  });

  it('warns (not errors) on a field type mismatch', () => {
    const r = validateAssetData('material', { roughness: 'high' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/roughness/);
  });

  it('warns on out-of-range numbers and unknown enum values', () => {
    const r = validateAssetData('material', { opacity: 5, side: 'sideways' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/above max/);
    expect(r.warnings.join('\n')).toMatch(/not one of/);
  });

  it('errors when animation.tracks is not an array', () => {
    expect(validateAssetData('animation', { tracks: 'nope' }).errors.length).toBe(1);
  });
});

describe('spriteanim schema', () => {
  it('scaffolds a set with one editable "idle" clip', () => {
    const def = defaultAssetData('spriteanim') as { clips: Record<string, unknown> };
    expect(Object.keys(def.clips)).toContain('idle');
    expect(validateAssetData('spriteanim', def).errors).toEqual([]);
  });

  it('hard-errors when clips is missing or not an object', () => {
    expect(validateAssetData('spriteanim', {}).errors.length).toBe(1);
    expect(validateAssetData('spriteanim', { clips: [] }).errors.length).toBe(1);
    expect(validateAssetData('spriteanim', { clips: 'x' }).errors.length).toBe(1);
  });

  it('warns (not errors) when a clip\'s frames is not an array', () => {
    const r = validateAssetData('spriteanim', { clips: { walk: { frames: 'nope', fps: 12 } } });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('walk') && w.includes('frames'))).toBe(true);
  });

  it('accepts a well-formed clip with sprite-GUID frames', () => {
    const r = validateAssetData('spriteanim', {
      clips: { walk: { frames: ['guid-a', 'guid-b'], fps: 10, mode: 'loop', cycles: 0 } },
    });
    expect(r.errors).toEqual([]);
  });
});

describe('defaultAssetData / normalizeAssetData', () => {
  it('scaffolds a valid default per type', () => {
    for (const type of ['material', 'particle', 'animation', 'spriteanim'] as const) {
      expect(validateAssetData(type, defaultAssetData(type)).errors).toEqual([]);
    }
  });

  it('normalizes a partial animation clip (fills tracks, sorts keys)', () => {
    const out = normalizeAssetData('animation', { name: 'x' }) as { tracks: unknown[]; duration: number };
    expect(Array.isArray(out.tracks)).toBe(true);
    expect(out.duration).toBe(1);
  });
});
