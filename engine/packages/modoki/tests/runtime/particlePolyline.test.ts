/**
 * Polyline emitter-shape tests (2D particle Phase 0). Covers `resolveShape` arc-length
 * precompute + the pure `samplePolyline` sampler: corner placement, uniform-by-arc-length
 * distribution, degenerate inputs, and determinism.
 */

import { describe, it, expect } from 'vitest';
import { resolveShape, samplePolyline } from '../../src/runtime/particles/emitterShapes';
import type { EmitterShape } from '../../src/runtime/particles/types';

const poly = (points: [number, number][]): EmitterShape => ({ type: 'polyline', points });
const sample = (rs: ReturnType<typeof resolveShape>, u: number) => {
  const out = { x: 0, y: 0 };
  samplePolyline(rs, u, out);
  return out;
};

describe('resolveShape (polyline)', () => {
  it('builds cumulative arc length and total length', () => {
    const rs = resolveShape(poly([[0, 0], [10, 0], [10, 10]]));
    expect(rs.type).toBe('polyline');
    expect(rs.polyLen).toBeCloseTo(20, 10);
    expect(rs.polyCum.length).toBe(2);
    expect(rs.polyCum[0]).toBeCloseTo(10, 10);
    expect(rs.polyCum[1]).toBeCloseTo(20, 10);
    expect(rs.poly).toEqual([0, 0, 10, 0, 10, 10]);
  });
});

describe('samplePolyline', () => {
  const rs = resolveShape(poly([[0, 0], [10, 0], [10, 10]]));

  it('u=0 -> first point', () => {
    const p = sample(rs, 0);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(0, 10);
  });

  it('u=1 -> last point', () => {
    const p = sample(rs, 1);
    expect(p.x).toBeCloseTo(10, 10);
    expect(p.y).toBeCloseTo(10, 10);
  });

  it('u=0.5 -> the corner (arc length 10)', () => {
    const p = sample(rs, 0.5);
    expect(p.x).toBeCloseTo(10, 10);
    expect(p.y).toBeCloseTo(0, 10);
  });

  it('a u within the 2nd segment lands on it', () => {
    // u=0.75 -> arc length 15 -> 5 up the vertical second segment
    const p = sample(rs, 0.75);
    expect(p.x).toBeCloseTo(10, 10);
    expect(p.y).toBeCloseTo(5, 10);
  });

  it('clamps out-of-range u', () => {
    const lo = sample(rs, -3);
    expect(lo.x).toBeCloseTo(0, 10);
    expect(lo.y).toBeCloseTo(0, 10);
    const hi = sample(rs, 5);
    expect(hi.x).toBeCloseTo(10, 10);
    expect(hi.y).toBeCloseTo(10, 10);
  });

  it('is deterministic — same u -> same out', () => {
    const a = sample(rs, 0.333);
    const b = sample(rs, 0.333);
    expect(a).toEqual(b);
  });
});

describe('samplePolyline uniform-by-arc-length', () => {
  it('distributes proportional to segment length (30:10 -> ~75%:25%)', () => {
    // seg0 length 30 (x 0->30), seg1 length 10 (x 30->40); split at x=30.
    const rs = resolveShape(poly([[0, 0], [30, 0], [40, 0]]));
    expect(rs.polyLen).toBeCloseTo(40, 10);
    const N = 1000;
    let seg0 = 0;
    let seg1 = 0;
    for (let i = 0; i < N; i++) {
      const p = sample(rs, i / N);
      // x < 30 -> seg0; x >= 30 -> seg1 (x=30 corner belongs to seg1 boundary — count as seg1)
      if (p.x < 30) seg0++;
      else seg1++;
    }
    // ~75% in seg0, ~25% in seg1, within a few %
    expect(seg0 / N).toBeGreaterThan(0.72);
    expect(seg0 / N).toBeLessThan(0.78);
    expect(seg1 / N).toBeGreaterThan(0.22);
    expect(seg1 / N).toBeLessThan(0.28);
  });
});

describe('samplePolyline degenerate inputs', () => {
  it('0 points -> origin', () => {
    const rs = resolveShape(poly([]));
    expect(rs.polyLen).toBe(0);
    const p = sample(rs, 0.5);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it('1 point -> that point', () => {
    const rs = resolveShape(poly([[7, 3]]));
    expect(rs.polyLen).toBe(0);
    const p = sample(rs, 0.9);
    expect(p.x).toBeCloseTo(7, 10);
    expect(p.y).toBeCloseTo(3, 10);
  });

  it('two coincident points (zero length) -> that point, never NaN', () => {
    const rs = resolveShape(poly([[4, 5], [4, 5]]));
    expect(rs.polyLen).toBe(0);
    for (const u of [0, 0.5, 1]) {
      const p = sample(rs, u);
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
      expect(p.x).toBeCloseTo(4, 10);
      expect(p.y).toBeCloseTo(5, 10);
    }
  });
});
