/** assetSchemas — field metadata + warn-but-write validation for material /
 *  particle / animation asset files (so an agent authors them without guessing). */

import { describe, it, expect } from 'vitest';
import {
  getAssetSchema, defaultAssetData, validateAssetData, normalizeAssetData, ASSET_SCHEMA_TYPES,
} from '../../src/runtime/assets/assetSchemas';

describe('getAssetSchema', () => {
  // Iterate ASSET_SCHEMA_TYPES, never a hand-written list. This loop USED to spell out
  // ['material','particle','animation','spriteanim'] and had silently dropped 'timeline' — so the
  // one type whose schema had actually gone missing from the tools was also the one type this
  // suite never checked. A derived loop cannot miss the next one.
  it('returns fields + a valid example for each type', () => {
    for (const type of ASSET_SCHEMA_TYPES) {
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

describe('rig2d schema', () => {
  it('hard-errors when bones or parts is not an array', () => {
    expect(validateAssetData('rig2d', { bones: 'nope' }).errors).toHaveLength(1);
    expect(validateAssetData('rig2d', { bones: [], parts: 'nope' }).errors).toHaveLength(1);
  });

  it('accepts BOTH rig shapes — v1 top-level part and v2 parts[]', () => {
    // The dual shape is the point: the Skin editor converts v1 -> v2 on the first structural part
    // edit, so a validator that only accepted one of them would refuse either the file on disk or
    // the file the editor writes back.
    const v1 = { bones: [{ name: 'root', parent: -1 }], sprite: 'guid', mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] };
    const v2 = { bones: [{ name: 'root', parent: -1 }], parts: [{ name: 'main', sprite: 'guid', mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] }] };
    expect(validateAssetData('rig2d', v1).errors).toEqual([]);
    expect(validateAssetData('rig2d', v2).errors).toEqual([]);
  });

  it('warns (not errors) on a malformed part entry', () => {
    const r = validateAssetData('rig2d', { bones: [], parts: ['nope'] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/parts\[0\]/);
  });
});

describe('defaultAssetData / normalizeAssetData', () => {
  it('scaffolds a valid default per type', () => {
    for (const type of ASSET_SCHEMA_TYPES) {
      expect(validateAssetData(type, defaultAssetData(type)).errors).toEqual([]);
    }
  });

  it('scaffolds a rig2d that is a RIG, not the animation-clip fallthrough', () => {
    // `defaultAssetData` ends in `return defaultAnimationClip(...)`, so a type without its own
    // branch silently scaffolds an animation clip that validates fine as a rig (validation only
    // hard-errors on the fundamentals). Assert the SHAPE, or the fallthrough passes the loop above.
    const rig = defaultAssetData('rig2d') as { bones?: unknown[]; tracks?: unknown };
    expect(Array.isArray(rig.bones)).toBe(true);
    expect(rig.bones).toHaveLength(1);
    expect(rig.tracks).toBeUndefined();
  });

  it('normalizes a partial animation clip (fills tracks, sorts keys)', () => {
    const out = normalizeAssetData('animation', { name: 'x' }) as { tracks: unknown[]; duration: number };
    expect(Array.isArray(out.tracks)).toBe(true);
    expect(out.duration).toBe(1);
  });
});
