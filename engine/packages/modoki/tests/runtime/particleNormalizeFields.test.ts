/** normalizeParticleDef unit tests for the Phase 0 2D-particle additive fields:
 *  polyline `shape.points` filtering, the editor-only `space` hint, `render.blend`
 *  passthrough of the new 2D blend modes, and back-compat (no phantom fields on a
 *  minimal old-style def). Pure — no fetch/manifest, just the normalize transform. */

import { describe, it, expect } from 'vitest';
import { normalizeParticleDef } from '../../src/runtime/loaders/particleCache';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

describe('normalizeParticleDef — polyline points', () => {
  it('keeps only finite [x,y] pairs, dropping non-finite / short / non-array entries', () => {
    const out = normalizeParticleDef({
      shape: { type: 'polyline', points: [[0, 0], [NaN, 1], [5, 5], [3], 'x'] as any },
    });
    expect(out.shape.type).toBe('polyline');
    expect(out.shape.points).toEqual([[0, 0], [5, 5]]);
  });

  it('leaves points untouched when the shape is not a polyline', () => {
    const out = normalizeParticleDef({
      shape: { type: 'cone', points: [[0, 0], [1, 1]] as any },
    });
    // Non-polyline shapes: the filter never runs, so whatever was passed survives verbatim.
    expect(out.shape.points).toEqual([[0, 0], [1, 1]]);
  });
});

describe('normalizeParticleDef — space hint', () => {
  it('drops an out-of-range space value', () => {
    const out = normalizeParticleDef({ space: 'diagonal' as any });
    expect(out.space).toBeUndefined();
  });

  it("preserves a valid '2d' space", () => {
    const out = normalizeParticleDef({ space: '2d' });
    expect(out.space).toBe('2d');
  });

  it("preserves a valid '3d' space", () => {
    const out = normalizeParticleDef({ space: '3d' });
    expect(out.space).toBe('3d');
  });
});

describe('normalizeParticleDef — blend passthrough', () => {
  it("keeps the new 'multiply' blend mode unchanged", () => {
    const out = normalizeParticleDef({ render: { blend: 'multiply' } });
    expect(out.render.blend).toBe('multiply');
  });

  it("keeps the new 'screen' blend mode unchanged", () => {
    const out = normalizeParticleDef({ render: { blend: 'screen' } });
    expect(out.render.blend).toBe('screen');
  });
});

describe('normalizeParticleDef — back-compat', () => {
  it('normalizes a minimal old-style def without introducing alignToVelocity / space', () => {
    // A pre-Phase-0 def (default shape, no new fields) must not gain the new fields.
    const old: Partial<ParticleEffectDef> = defaultParticleEffect();
    const out = normalizeParticleDef(old);

    expect(out.space).toBeUndefined();
    expect(out.render.alignToVelocity).toBeUndefined();

    // Existing fields survive intact.
    expect(out.maxParticles).toBe(1000);
    expect(out.duration).toBe(5);
    expect(out.shape.type).toBe('cone');
    expect(out.render.blend).toBe('additive');
    expect(out.startSpeed).toEqual({ min: 3, max: 5 });
  });
});
