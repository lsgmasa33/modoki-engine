/** Pure coordinate-conversion tests — the ECS(Y-down, world units) ↔ Rapier
 *  (Y-up, meters) frame map. No Rapier/WASM needed; this is where round-trip bugs
 *  in the most error-prone part of the integration get caught. */

import { describe, it, expect } from 'vitest';
import {
  vecEcsToPhys, vecPhysToEcs, angEcsToPhys, angPhysToEcs, lenToPhys, packCollisionGroups,
  parsePointsToPhys,
} from '../../src/runtime/systems/physics2DConvert';

describe('physics2DConvert', () => {
  it('Y is flipped and scaled by pixelsPerMeter', () => {
    // 100 world units down (+Y) at ppm 100 → 1 m UP-negated in Rapier (-1 m).
    expect(vecEcsToPhys(200, 100, 100)).toEqual({ x: 2, y: -1 });
    expect(vecPhysToEcs(2, -1, 100)).toEqual({ x: 200, y: 100 });
  });

  it('vector conversion round-trips (position AND velocity)', () => {
    for (const [x, y] of [[0, 0], [123.5, -456.25], [-1000, 9999]]) {
      const p = vecEcsToPhys(x, y, 100);
      const back = vecPhysToEcs(p.x, p.y, 100);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('angle negates (reflection reverses handedness) and round-trips', () => {
    expect(angEcsToPhys(1)).toBe(-1);
    expect(angPhysToEcs(-1)).toBe(1);
    for (const a of [0, 0.5, -1.25, Math.PI, -Math.PI / 3]) {
      expect(angPhysToEcs(angEcsToPhys(a))).toBeCloseTo(a, 12);
    }
  });

  it('lengths scale but never flip sign', () => {
    expect(lenToPhys(50, 100)).toBe(0.5);
    expect(lenToPhys(0, 100)).toBe(0);
  });

  it('packs collision groups into Rapier u32 (membership<<16 | filter)', () => {
    expect(packCollisionGroups(0x0001, 0xffff)).toBe(0x0001ffff);
    expect(packCollisionGroups(0xffff, 0xffff)).toBe(0xffffffff);
    // stays unsigned
    expect(packCollisionGroups(0x8000, 0x0001)).toBeGreaterThan(0);
  });

  describe('parsePointsToPhys', () => {
    it('parses nested [[x,y],…] with ppm scale + Y-flip', () => {
      const out = parsePointsToPhys('[[100,200],[-50,0]]', 100, 2);
      expect(Array.from(out!)).toEqual([1, -2, -0.5, -0]);
    });
    it('parses flat [x,y,…]', () => {
      const out = parsePointsToPhys('[100,200,300,400]', 100, 2);
      expect(Array.from(out!)).toEqual([1, -2, 3, -4]);
    });
    it('rejects invalid / too-few / malformed input', () => {
      expect(parsePointsToPhys('not json', 100)).toBeNull();
      expect(parsePointsToPhys('[]', 100)).toBeNull();
      expect(parsePointsToPhys('[1,2,3]', 100)).toBeNull();          // odd flat length
      expect(parsePointsToPhys('[[0,0]]', 100, 3)).toBeNull();       // fewer than minPoints
      expect(parsePointsToPhys('[[0,"x"]]', 100, 1)).toBeNull();     // non-finite
    });
  });
});
