/**
 * Canonical sim-formula tests (simSpec.ts) — the pure, headless half of the CPU↔GPU parity
 * story (engine-review runtime-particles F9). These lock the exact noise/drag/force/spawn-radius
 * math the CPU sim USES and the GPU TSL kernel is transcribed from, so a future edit to the
 * formula must update both (and these tests catch a drift on the CPU side). Full GPU parity needs
 * a WebGPU harness (out of scope), but the scalar reference is anchored here.
 */

import { describe, it, expect } from 'vitest';
import {
  accumNoise,
  accumForce,
  dragFactor,
  annulusRadius,
  sphereRadius,
  type Vec3,
} from '../../src/runtime/particles/simSpec';
import type { ForceField } from '../../src/runtime/particles/types';

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });

describe('accumNoise', () => {
  it('matches the canonical curl-ish formula with the documented phase offsets', () => {
    const acc = v();
    const px = 0.3, py = -0.7, pz = 1.1, f = 2, t = 0.5, s = 1.5;
    accumNoise(acc, px, py, pz, f, t, s);
    expect(acc.x).toBeCloseTo((Math.sin(py * f + t) + Math.cos(pz * f - t * 0.7)) * s, 12);
    expect(acc.y).toBeCloseTo((Math.sin(pz * f + t * 1.3) + Math.cos(px * f - t)) * s, 12);
    expect(acc.z).toBeCloseTo((Math.sin(px * f + t * 0.8) + Math.cos(py * f - t * 1.1)) * s, 12);
  });

  it('scales linearly with strength and is zero at strength 0', () => {
    const a1 = v(); accumNoise(a1, 1, 2, 3, 1, 0.25, 1);
    const a2 = v(); accumNoise(a2, 1, 2, 3, 1, 0.25, 2);
    expect(a2.x).toBeCloseTo(a1.x * 2, 12);
    expect(a2.y).toBeCloseTo(a1.y * 2, 12);
    expect(a2.z).toBeCloseTo(a1.z * 2, 12);
    const z = v(); accumNoise(z, 1, 2, 3, 1, 0.25, 0);
    expect([z.x, z.y, z.z]).toEqual([0, 0, 0]);
  });

  it('accumulates onto existing acceleration (does not overwrite)', () => {
    const acc: Vec3 = { x: 10, y: 20, z: 30 };
    accumNoise(acc, 0, 0, 0, 1, 0, 1); // sin(0)+cos(0)=1 on each axis
    expect(acc.x).toBeCloseTo(11, 12);
    expect(acc.y).toBeCloseTo(21, 12);
    expect(acc.z).toBeCloseTo(31, 12);
  });
});

describe('accumForce', () => {
  it('directional adds dir·strength regardless of particle position', () => {
    const f: ForceField = { type: 'directional', x: 1, y: -2, z: 0.5, strength: 3 };
    const acc = v();
    accumForce(acc, 99, 99, 99, f);
    expect(acc).toEqual({ x: 3, y: -6, z: 1.5 });
  });

  it('point adds the unit vector toward the center times strength (attract)', () => {
    const f: ForceField = { type: 'point', x: 3, y: 0, z: 0, strength: 2 };
    const acc = v();
    accumForce(acc, 0, 0, 0, f); // toward +x, distance 3, unit (1,0,0)
    expect(acc.x).toBeCloseTo(2, 12);
    expect(acc.y).toBeCloseTo(0, 12);
    expect(acc.z).toBeCloseTo(0, 12);
  });

  it('point with negative strength repels (points away from center)', () => {
    const f: ForceField = { type: 'point', x: 5, y: 0, z: 0, strength: -4 };
    const acc = v();
    accumForce(acc, 0, 0, 0, f);
    expect(acc.x).toBeCloseTo(-4, 12); // away from +x center
  });

  it('point stays finite when the particle sits exactly on the source (epsilon guard)', () => {
    const f: ForceField = { type: 'point', x: 0, y: 0, z: 0, strength: 7 };
    const acc = v();
    accumForce(acc, 0, 0, 0, f);
    expect(Number.isFinite(acc.x)).toBe(true);
    expect(Number.isFinite(acc.y)).toBe(true);
    expect(Number.isFinite(acc.z)).toBe(true);
  });
});

describe('dragFactor', () => {
  it('is 1 with no drag and 1 − drag·dt for small steps', () => {
    expect(dragFactor(0, 0.016)).toBe(1);
    expect(dragFactor(2, 0.1)).toBeCloseTo(0.8, 12);
  });

  it('clamps to 0 instead of going negative for a large drag·dt', () => {
    expect(dragFactor(100, 0.5)).toBe(0); // 1 − 50 → clamped
  });
});

describe('annulusRadius (uniform area density)', () => {
  it('reduces to out·sqrt(u) when inner = 0', () => {
    expect(annulusRadius(0, 2, 0.25)).toBeCloseTo(2 * Math.sqrt(0.25), 12);
    expect(annulusRadius(0, 2, 0)).toBe(0);
  });

  it('is exactly outer when inner = outer (thin shell)', () => {
    expect(annulusRadius(1.5, 1.5, 0)).toBeCloseTo(1.5, 12);
    expect(annulusRadius(1.5, 1.5, 1)).toBeCloseTo(1.5, 12);
  });

  it('interpolates in squared space: r(0)=inner, r(1)=outer', () => {
    expect(annulusRadius(1, 3, 0)).toBeCloseTo(1, 12);
    expect(annulusRadius(1, 3, 1)).toBeCloseTo(3, 12);
  });
});

describe('sphereRadius (uniform volume density)', () => {
  it('reduces to out·cbrt(u) when inner = 0', () => {
    expect(sphereRadius(0, 2, 0.125)).toBeCloseTo(2 * Math.cbrt(0.125), 12);
    expect(sphereRadius(0, 2, 0)).toBe(0);
  });

  it('is exactly outer when inner = outer', () => {
    expect(sphereRadius(2, 2, 0.4)).toBeCloseTo(2, 12);
  });

  it('interpolates in cubed space: r(0)=inner, r(1)=outer', () => {
    expect(sphereRadius(1, 4, 0)).toBeCloseTo(1, 12);
    expect(sphereRadius(1, 4, 1)).toBeCloseTo(4, 12);
  });
});
