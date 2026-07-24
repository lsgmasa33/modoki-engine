/** Pure collider-outline geometry (editor overlay) — no Rapier/rendering. */

import { describe, it, expect } from 'vitest';
import { colliderOutline2D, scaleColliderOutline2D } from '../../src/runtime/rendering/colliderOutline2D';

const base = { shape: '', radius: 0, halfW: 0, halfH: 0, points: '' };

describe('colliderOutline2D', () => {
  it('circle → radius (or null if degenerate)', () => {
    expect(colliderOutline2D({ ...base, shape: 'circle', radius: 25 })).toEqual({ kind: 'circle', radius: 25 });
    expect(colliderOutline2D({ ...base, shape: 'circle', radius: 0 })).toBeNull();
  });

  it('box → 4 corners in local space (Y-down winding)', () => {
    const o = colliderOutline2D({ ...base, shape: 'box', halfW: 10, halfH: 5 });
    expect(o).toEqual({
      kind: 'polygon',
      points: [{ x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 }],
    });
  });

  it('capsule → halfH + radius', () => {
    expect(colliderOutline2D({ ...base, shape: 'capsule', halfH: 30, radius: 12 }))
      .toEqual({ kind: 'capsule', halfH: 30, radius: 12 });
  });

  it('polygon → closed loop of raw world-unit points (>=3)', () => {
    const o = colliderOutline2D({ ...base, shape: 'polygon', points: '[[-50,-50],[50,-50],[0,50]]' });
    expect(o).toEqual({ kind: 'polygon', points: [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 0, y: 50 }] });
    expect(colliderOutline2D({ ...base, shape: 'polygon', points: '[[0,0],[1,1]]' })).toBeNull(); // <3
  });

  it('polyline → open polyline (>=2)', () => {
    const o = colliderOutline2D({ ...base, shape: 'polyline', points: '[[-5,0],[0,-2],[5,0]]' });
    expect(o!.kind).toBe('polyline');
    expect((o as { points: unknown[] }).points).toHaveLength(3);
  });

  it('unknown / bad input → null', () => {
    expect(colliderOutline2D({ ...base, shape: 'nope' })).toBeNull();
    expect(colliderOutline2D({ ...base, shape: 'polygon', points: 'garbage' })).toBeNull();
  });
});

describe('scaleColliderOutline2D (debug-overlay scale must match makeColliderDesc\'s live Rapier collider)', () => {
  it('identity scale returns the same outline unchanged', () => {
    const o = colliderOutline2D({ ...base, shape: 'circle', radius: 25 })!;
    expect(scaleColliderOutline2D(o, 1, 1)).toEqual(o);
  });

  it('circle radius uses the mean of |sx|,|sy| — a non-uniform scale can\'t make an ellipse', () => {
    const o = colliderOutline2D({ ...base, shape: 'circle', radius: 10 })!;
    expect(scaleColliderOutline2D(o, 2, 4)).toEqual({ kind: 'circle', radius: 30 }); // 10 * (2+4)/2
  });

  it('capsule: radius uses mean(|sx|,|sy|), halfH scales by |sy| alone (matches makeColliderDesc\'s `* ay`)', () => {
    const o = colliderOutline2D({ ...base, shape: 'capsule', halfH: 10, radius: 5 })!;
    expect(scaleColliderOutline2D(o, 2, 6)).toEqual({ kind: 'capsule', radius: 20, halfH: 60 }); // r=5*4, h=10*6
  });

  it('box/polygon points scale per-axis with SIGNED sx/sy — a mirrored (negative) scale flips the shape', () => {
    const o = colliderOutline2D({ ...base, shape: 'box', halfW: 10, halfH: 5 })!;
    expect(scaleColliderOutline2D(o, 2, -3)).toEqual({
      kind: 'polygon',
      points: [{ x: -20, y: 15 }, { x: 20, y: 15 }, { x: 20, y: -15 }, { x: -20, y: -15 }],
    });
  });

  it('polyline points scale per-axis too', () => {
    const o = colliderOutline2D({ ...base, shape: 'polyline', points: '[[-5,0],[0,-2],[5,0]]' })!;
    expect(scaleColliderOutline2D(o, 2, 3)).toEqual({
      kind: 'polyline',
      points: [{ x: -10, y: 0 }, { x: 0, y: -6 }, { x: 10, y: 0 }],
    });
  });
});
