/** Model settings tests — defaults, merge, suffix conventions. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_SETTINGS, resolveModelSettings, lodUrlSuffix,
  getLodEncoder, getLodMeshopt, getLodAggressive,
} from '../../src/runtime/loaders/modelSettings';

describe('resolveModelSettings', () => {
  it('fills defaults for missing/empty meta', () => {
    expect(resolveModelSettings(undefined)).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(resolveModelSettings({})).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('merges a partial settings block over the defaults', () => {
    const s = resolveModelSettings({ model: { encoder: 'gltfpack', simplifyError: 0.05 } });
    expect(s.encoder).toBe('gltfpack');
    expect(s.simplifyError).toBe(0.05);
    expect(s.lodCount).toBe(DEFAULT_MODEL_SETTINGS.lodCount);
  });

  it('aligns ratios/distances arrays to lodCount', () => {
    const s = resolveModelSettings({ model: { lodCount: 2 } });
    expect(s.lodCount).toBe(2);
    expect(s.lodRatios).toHaveLength(2);
    expect(s.lodDistances).toHaveLength(2);
  });

  it('keeps explicit per-level overrides when matching lodCount', () => {
    const s = resolveModelSettings({ model: { lodCount: 3, lodRatios: [1, 0.5, 0.1] } });
    expect(s.lodRatios).toEqual([1, 0.5, 0.1]);
  });
});

describe('lodUrlSuffix', () => {
  it('LOD0 → .processed.glb (legacy/hint name preserved)', () => {
    expect(lodUrlSuffix(0)).toBe('.processed.glb');
  });

  it('LOD1+ → .lod<N>.glb', () => {
    expect(lodUrlSuffix(1)).toBe('.lod1.glb');
    expect(lodUrlSuffix(2)).toBe('.lod2.glb');
  });
});

describe('getLodEncoder', () => {
  it('falls back to the global encoder when no per-LOD override is set', () => {
    const s = resolveModelSettings({ model: { encoder: 'gltfpack' } });
    expect(getLodEncoder(s, 0)).toBe('gltfpack');
    expect(getLodEncoder(s, 2)).toBe('gltfpack');
  });

  it('uses per-LOD override when set, global encoder when not', () => {
    const s = resolveModelSettings({
      model: { encoder: 'gltf-transform', lodEncoders: ['gltf-transform', 'gltfpack', 'gltfpack'] },
    });
    expect(getLodEncoder(s, 0)).toBe('gltf-transform');
    expect(getLodEncoder(s, 1)).toBe('gltfpack');
    expect(getLodEncoder(s, 2)).toBe('gltfpack');
  });

  it('falls back to global encoder when override array is shorter than the LOD index', () => {
    const s = resolveModelSettings({
      model: { encoder: 'gltf-transform', lodCount: 3, lodEncoders: ['gltfpack'] },
    });
    expect(getLodEncoder(s, 0)).toBe('gltfpack');
    expect(getLodEncoder(s, 1)).toBe('gltf-transform');
    expect(getLodEncoder(s, 2)).toBe('gltf-transform');
  });
});

describe('getLodMeshopt', () => {
  it('falls back to global meshopt when no per-LOD override', () => {
    const s = resolveModelSettings({ model: { meshopt: false } });
    expect(getLodMeshopt(s, 0)).toBe(false);
    expect(getLodMeshopt(s, 1)).toBe(false);
  });

  it('per-LOD override wins over global meshopt', () => {
    const s = resolveModelSettings({
      model: { meshopt: false, lodMeshopt: [false, true, true] },
    });
    expect(getLodMeshopt(s, 0)).toBe(false);
    expect(getLodMeshopt(s, 1)).toBe(true);
    expect(getLodMeshopt(s, 2)).toBe(true);
  });

  it('falls back to global when per-LOD override index is missing', () => {
    const s = resolveModelSettings({
      model: { meshopt: true, lodCount: 3, lodMeshopt: [false] },
    });
    expect(getLodMeshopt(s, 0)).toBe(false);
    expect(getLodMeshopt(s, 1)).toBe(true);
    expect(getLodMeshopt(s, 2)).toBe(true);
  });
});

describe('getLodAggressive', () => {
  it('falls back to global aggressiveSimplify when no per-LOD override', () => {
    const s = resolveModelSettings({ model: { aggressiveSimplify: true } });
    expect(getLodAggressive(s, 0)).toBe(true);
    expect(getLodAggressive(s, 2)).toBe(true);
  });

  it('per-LOD override wins over global aggressiveSimplify', () => {
    const s = resolveModelSettings({
      model: { aggressiveSimplify: false, lodAggressive: [false, false, true] },
    });
    expect(getLodAggressive(s, 0)).toBe(false);
    expect(getLodAggressive(s, 1)).toBe(false);
    expect(getLodAggressive(s, 2)).toBe(true);
  });
});

