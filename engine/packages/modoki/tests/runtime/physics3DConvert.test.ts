import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  vecEcsToPhys, vecPhysToEcs, lenToPhys, packCollisionGroups,
  eulerToQuat, quatToEuler,
} from '../../src/runtime/systems/physics3DConvert';

describe('physics3DConvert — vectors & lengths (no flip, right-handed Y-up both sides)', () => {
  it('scales by unitsPerMeter with NO axis flip', () => {
    // upm 1 → world units already meters, pass-through.
    expect(vecEcsToPhys(2, 1, 3, 1)).toEqual({ x: 2, y: 1, z: 3 });
    // upm 100 → 100 units per meter.
    expect(vecEcsToPhys(200, 100, 300, 100)).toEqual({ x: 2, y: 1, z: 3 });
  });

  it('vector conversion round-trips', () => {
    for (const [x, y, z] of [[0, 0, 0], [123.5, -456.25, 78], [-1000, 9999, -3]]) {
      const p = vecEcsToPhys(x, y, z, 100);
      const back = vecPhysToEcs(p.x, p.y, p.z, 100);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
      expect(back.z).toBeCloseTo(z, 9);
    }
  });

  it('lengths scale but never flip sign', () => {
    expect(lenToPhys(50, 100)).toBe(0.5);
    expect(lenToPhys(0.5, 1)).toBe(0.5);
    expect(lenToPhys(0, 100)).toBe(0);
  });

  it('packs collision groups into Rapier u32 (membership<<16 | filter)', () => {
    expect(packCollisionGroups(0x0001, 0xffff)).toBe(0x0001ffff);
    expect(packCollisionGroups(0xffff, 0xffff)).toBe(0xffffffff);
    expect(packCollisionGroups(0x8000, 0x0001) >>> 0).toBe(0x80000001);
  });
});

describe('physics3DConvert — Euler↔quaternion (order XYZ, matches transformPropagation)', () => {
  it('identity euler → identity quaternion', () => {
    expect(eulerToQuat(0, 0, 0)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('90° about Y → {0, sin45, 0, cos45}', () => {
    const q = eulerToQuat(0, Math.PI / 2, 0);
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 9);
    expect(q.z).toBeCloseTo(0, 9);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('exactly matches THREE.Quaternion.setFromEuler(order "XYZ")', () => {
    for (const [rx, ry, rz] of [[0.3, 0.5, -0.7], [0.1, 0.2, 0.3], [-0.9, 0.4, 1.1]]) {
      const q = eulerToQuat(rx, ry, rz);
      const ref = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
      expect(q.x).toBeCloseTo(ref.x, 12);
      expect(q.y).toBeCloseTo(ref.y, 12);
      expect(q.z).toBeCloseTo(ref.z, 12);
      expect(q.w).toBeCloseTo(ref.w, 12);
    }
  });

  it('euler → quat → euler round-trips (away from gimbal lock)', () => {
    for (const [rx, ry, rz] of [[0.3, 0.5, -0.7], [0.1, 0.2, 0.3], [-0.9, 0.4, 1.1]]) {
      const q = eulerToQuat(rx, ry, rz);
      const e = quatToEuler(q.x, q.y, q.z, q.w);
      expect(e.rx).toBeCloseTo(rx, 9);
      expect(e.ry).toBeCloseTo(ry, 9);
      expect(e.rz).toBeCloseTo(rz, 9);
    }
  });
});
