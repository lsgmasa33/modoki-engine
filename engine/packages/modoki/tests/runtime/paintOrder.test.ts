/** computePaintOrder — hierarchy DFS by sortOrder, the shared paint-order source. */

import { describe, it, expect } from 'vitest';
import { computePaintOrder } from '../../src/runtime/rendering/paintOrder';

/** Convenience: build the two maps from a flat list of {id, parent, sort}. */
function build(list: { id: number; parent: number; sort: number }[]) {
  const sortOrderOf = new Map(list.map((e) => [e.id, e.sort]));
  const parentOf = new Map(list.map((e) => [e.id, e.parent]));
  return computePaintOrder(sortOrderOf, parentOf);
}

describe('computePaintOrder', () => {
  it('orders root siblings by sortOrder (lower painted first)', () => {
    const o = build([
      { id: 1, parent: 0, sort: 2 },
      { id: 2, parent: 0, sort: 0 },
      { id: 3, parent: 0, sort: 1 },
    ]);
    expect(o.get(2)).toBe(0);
    expect(o.get(3)).toBe(1);
    expect(o.get(1)).toBe(2);
  });

  it('walks depth-first: a parent paints before its children, children before the next sibling', () => {
    // root(10, sort0) → a(11, sort1), b(12, sort0); sibling root(20, sort1)
    const o = build([
      { id: 10, parent: 0, sort: 0 },
      { id: 11, parent: 10, sort: 1 },
      { id: 12, parent: 10, sort: 0 },
      { id: 20, parent: 0, sort: 1 },
    ]);
    // DFS: 10, then its children sorted (12 sort0, 11 sort1), then sibling 20
    expect([...o.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]))
      .toEqual([10, 12, 11, 20]);
  });

  it('keeps insertion (query) order for equal sortOrder siblings', () => {
    const o = build([
      { id: 5, parent: 0, sort: 0 },
      { id: 6, parent: 0, sort: 0 },
      { id: 7, parent: 0, sort: 0 },
    ]);
    expect(o.get(5)).toBeLessThan(o.get(6)!);
    expect(o.get(6)).toBeLessThan(o.get(7)!);
  });

  it('does not loop on a cyclic parent and still assigns every entity an index', () => {
    const sortOrderOf = new Map([[1, 0], [2, 0]]);
    const parentOf = new Map([[1, 2], [2, 1]]); // mutual cycle, neither reaches root
    const o = computePaintOrder(sortOrderOf, parentOf);
    expect(o.size).toBe(2);
    expect(new Set(o.values()).size).toBe(2); // distinct indices, no collision
  });

  it('appends orphans (parent points at a missing entity) after the rooted tree', () => {
    const o = build([
      { id: 1, parent: 0, sort: 0 },
      { id: 9, parent: 99, sort: 0 }, // 99 does not exist
    ]);
    expect(o.get(1)).toBe(0);
    expect(o.get(9)).toBe(1);
  });

  describe('orderInLayer override', () => {
    it('re-ranks primarily by orderInLayer (higher = on top), independent of the tree', () => {
      // Two sprites parented to DIFFERENT deep branches: A under branch-1, B under branch-2.
      // Hierarchy DFS would put A before B, but B has a higher layer → B on top.
      const sortOrderOf = new Map([[1, 0], [2, 0], [10, 0], [20, 0]]);
      const parentOf = new Map([[1, 0], [2, 0], [10, 1], [20, 2]]); // 10 under 1, 20 under 2
      const layer = new Map([[10, 1], [20, 5]]);                    // 20 sits in a higher layer
      const o = computePaintOrder(sortOrderOf, parentOf, layer);
      expect(o.get(20)!).toBeGreaterThan(o.get(10)!); // higher orderInLayer paints later (on top)
    });

    it('keeps hierarchy order as the tiebreak within one layer', () => {
      const sortOrderOf = new Map([[1, 2], [2, 0], [3, 1]]);
      const parentOf = new Map([[1, 0], [2, 0], [3, 0]]);
      const layer = new Map(); // all default 0 → pure hierarchy order preserved
      const o = computePaintOrder(sortOrderOf, parentOf, layer);
      expect(o.get(2)!).toBeLessThan(o.get(3)!);
      expect(o.get(3)!).toBeLessThan(o.get(1)!);
    });

    it('is a no-op (identical to no map) when omitted', () => {
      const s = new Map([[1, 0], [2, 1]]);
      const p = new Map([[1, 0], [2, 0]]);
      expect(computePaintOrder(s, p)).toEqual(computePaintOrder(s, p, new Map()));
    });
  });
});
