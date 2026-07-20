/** Pure point-edit logic behind the on-canvas collider-mesh editor (Phase 4.3). */

import { describe, it, expect } from 'vitest';
import {
  parseColliderPoints, serializeColliderPoints, moveVertex, insertVertex, removeVertex,
  nearestEdgeInsertion, minPointsForShape, type Pt,
} from '../../src/runtime/scene/colliderPoints';

const TRI: Pt[] = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 0, y: 50 }];

describe('colliderPoints — parse/serialize', () => {
  it('parses nested and flat forms identically', () => {
    expect(parseColliderPoints('[[-50,-50],[50,-50],[0,50]]')).toEqual(TRI);
    expect(parseColliderPoints('[-50,-50,50,-50,0,50]')).toEqual(TRI);
  });
  it('returns [] for invalid / empty / odd-length input', () => {
    expect(parseColliderPoints('')).toEqual([]);
    expect(parseColliderPoints('not json')).toEqual([]);
    expect(parseColliderPoints('[1,2,3]')).toEqual([]);       // odd flat length
    expect(parseColliderPoints('[[1]]')).toEqual([]);          // short pair
  });
  it('serializes nested + rounds to 2dp (no -0)', () => {
    expect(serializeColliderPoints([{ x: 1.238, y: -0.0001 }])).toBe('[[1.24,0]]');
  });
  it('round-trips', () => {
    expect(parseColliderPoints(serializeColliderPoints(TRI))).toEqual(TRI);
  });
});

describe('colliderPoints — mutation (immutable)', () => {
  it('moveVertex replaces one point and does not mutate the input', () => {
    const out = moveVertex(TRI, 2, 10, 20);
    expect(out[2]).toEqual({ x: 10, y: 20 });
    expect(TRI[2]).toEqual({ x: 0, y: 50 });   // original untouched
    expect(moveVertex(TRI, 9, 0, 0)).toBe(TRI); // out-of-range no-op
  });
  it('insertVertex splices at a clamped index', () => {
    expect(insertVertex(TRI, 1, 0, -50)).toHaveLength(4);
    expect(insertVertex(TRI, 1, 0, -50)[1]).toEqual({ x: 0, y: -50 });
    expect(insertVertex(TRI, 99, 1, 1)[3]).toEqual({ x: 1, y: 1 }); // clamp to end
  });
  it('removeVertex honors the shape minimum', () => {
    expect(removeVertex(TRI, 0, 3)).toBe(TRI);          // already at min 3 → no-op
    const quad = insertVertex(TRI, 3, 0, 0);
    expect(removeVertex(quad, 3, 3)).toHaveLength(3);   // 4 → 3 ok
  });
});

describe('colliderPoints — nearestEdgeInsertion', () => {
  it('finds the closest edge and the split index (closed polygon incl. wrap edge)', () => {
    // Click just below the midpoint of the wrap edge (vertex2 -> vertex0 of the triangle).
    const hit = nearestEdgeInsertion(TRI, -25, 5, true)!;
    expect(hit).not.toBeNull();
    // Wrap edge is index 2 (v2->v0) → insertion index 3.
    expect(hit.index).toBe(3);
  });
  it('open polyline ignores the wrap edge', () => {
    const closed = nearestEdgeInsertion(TRI, -25, 5, true)!;
    const open = nearestEdgeInsertion(TRI, -25, 5, false);
    // For the open chain the wrap edge doesn't exist, so the nearest edge differs.
    expect(open).not.toBeNull();
    expect(open!.index).not.toBe(closed.index);
  });
  it('needs at least 2 points', () => {
    expect(nearestEdgeInsertion([{ x: 0, y: 0 }], 0, 0, false)).toBeNull();
  });
});

describe('colliderPoints — minPointsForShape', () => {
  it('polygon=3, concave=3, polyline=2, else null', () => {
    expect(minPointsForShape('polygon')).toBe(3);
    expect(minPointsForShape('concave')).toBe(3);
    expect(minPointsForShape('polyline')).toBe(2);
    expect(minPointsForShape('box')).toBeNull();
    expect(minPointsForShape('circle')).toBeNull();
  });
});
