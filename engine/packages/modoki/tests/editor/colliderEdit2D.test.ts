/** World↔local point math + vertex picking behind the on-canvas collider editor (4.3). */

import { describe, it, expect } from 'vitest';
import {
  localToWorld, worldPointToLocal, colliderEditInfo, pickVertex, colliderPickHalfExtents, type WT,
} from '../../src/editor/panels/colliderEdit2D';

const shape = (s: string, extra: Record<string, unknown> = {}) =>
  ({ shape: s, radius: 0, halfW: 0, halfH: 0, points: '', ...extra });

describe('colliderEdit2D — world/local point round-trip', () => {
  it('inverts translate + rotate + scale', () => {
    const wt: WT = { x: 100, y: -40, rz: Math.PI / 5, sx: 1.5, sy: 2 };
    const local = { x: 30, y: -25 };
    const world = localToWorld(local, wt);
    const back = worldPointToLocal(world.x, world.y, wt);
    expect(back.x).toBeCloseTo(local.x, 6);
    expect(back.y).toBeCloseTo(local.y, 6);
  });
  it('identity transform is a passthrough', () => {
    const wt: WT = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
    expect(localToWorld({ x: 7, y: 9 }, wt)).toEqual({ x: 7, y: 9 });
    expect(worldPointToLocal(7, 9, wt)).toEqual({ x: 7, y: 9 });
  });
  it('zero scale axis maps to 0 (no NaN)', () => {
    expect(worldPointToLocal(5, 5, { x: 0, y: 0, rz: 0, sx: 0, sy: 1 })).toEqual({ x: 0, y: 5 });
  });
});

describe('colliderEdit2D — colliderEditInfo', () => {
  it('polygon is closed, min 3', () => {
    expect(colliderEditInfo({ shape: 'polygon', points: '[[-1,-1],[1,-1],[0,1]]' }))
      .toEqual({ points: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 }], min: 3, closed: true });
  });
  it('polyline is open, min 2', () => {
    const info = colliderEditInfo({ shape: 'polyline', points: '[[0,0],[10,0]]' })!;
    expect(info.min).toBe(2);
    expect(info.closed).toBe(false);
  });
  it('box/circle have no editable points', () => {
    expect(colliderEditInfo({ shape: 'box', points: '' })).toBeNull();
    expect(colliderEditInfo({ shape: 'circle', points: '' })).toBeNull();
  });
});

describe('colliderEdit2D — colliderPickHalfExtents', () => {
  it('polygon → max abs extents of its points', () => {
    expect(colliderPickHalfExtents(shape('polygon', { points: '[[-170,70],[170,70],[170,-70]]' })))
      .toEqual({ halfW: 170, halfH: 70 });
  });
  it('circle → radius on both axes; box → its half-extents', () => {
    expect(colliderPickHalfExtents(shape('circle', { radius: 25 }))).toEqual({ halfW: 25, halfH: 25 });
    expect(colliderPickHalfExtents(shape('box', { halfW: 40, halfH: 12 }))).toEqual({ halfW: 40, halfH: 12 });
  });
  it('capsule → radius wide, (halfH+radius) tall', () => {
    expect(colliderPickHalfExtents(shape('capsule', { radius: 10, halfH: 30 }))).toEqual({ halfW: 10, halfH: 40 });
  });
  it('off-center polyline → symmetric superset (max abs)', () => {
    // y spans [-40,90] → halfH = 90 (contains the shape, superset below).
    expect(colliderPickHalfExtents(shape('polyline', { points: '[[-110,-40],[110,90]]' })))
      .toEqual({ halfW: 110, halfH: 90 });
  });
  it('no outline → null', () => {
    expect(colliderPickHalfExtents(shape('circle', { radius: 0 }))).toBeNull();
    expect(colliderPickHalfExtents(shape('nope'))).toBeNull();
  });
});

describe('colliderEdit2D — pickVertex', () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }];
  it('returns the nearest vertex within threshold', () => {
    expect(pickVertex({ x: 3, y: 2 }, pts, 10)).toBe(0);
    expect(pickVertex({ x: 48, y: -1 }, pts, 10)).toBe(1);
  });
  it('returns -1 when nothing is within threshold', () => {
    expect(pickVertex({ x: 25, y: 25 }, pts, 5)).toBe(-1);
  });
});
