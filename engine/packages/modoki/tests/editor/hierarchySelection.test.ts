/** hierarchySelection — visible-order flattening + Shift-range computation that
 *  powers the Hierarchy's multi-select gestures. */

import { describe, it, expect } from 'vitest';
import { flattenVisibleIds, rangeBetween, type FlattenNode } from '../../src/editor/panels/hierarchySelection';

// Tree:
//   1
//   ├─ 2
//   │  └─ 3
//   └─ 4
//   5
const tree: FlattenNode[] = [
  { id: 1, children: [{ id: 2, children: [{ id: 3 }] }, { id: 4 }] },
  { id: 5 },
];

describe('flattenVisibleIds', () => {
  it('flattens depth-first in render order when nothing is collapsed', () => {
    expect(flattenVisibleIds(tree, new Set())).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips children of a collapsed node', () => {
    // Collapsing 2 hides 3 but keeps 2 and its sibling 4 visible.
    expect(flattenVisibleIds(tree, new Set([2]))).toEqual([1, 2, 4, 5]);
  });

  it('skips an entire collapsed subtree', () => {
    expect(flattenVisibleIds(tree, new Set([1]))).toEqual([1, 5]);
  });

  it('handles an empty tree', () => {
    expect(flattenVisibleIds([], new Set())).toEqual([]);
  });
});

describe('rangeBetween', () => {
  const order = [1, 2, 3, 4, 5];

  it('returns the inclusive slice anchor→target (forward)', () => {
    expect(rangeBetween(order, 2, 4)).toEqual([2, 3, 4]);
  });

  it('returns the inclusive slice when anchor is below target (reverse)', () => {
    expect(rangeBetween(order, 4, 2)).toEqual([2, 3, 4]);
  });

  it('returns a single id when anchor === target', () => {
    expect(rangeBetween(order, 3, 3)).toEqual([3]);
  });

  it('spans the whole list end-to-end', () => {
    expect(rangeBetween(order, 1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null when an id is not in the visible order (e.g. collapsed away)', () => {
    expect(rangeBetween([1, 2, 4, 5], 2, 3)).toBeNull();
    expect(rangeBetween(order, 99, 2)).toBeNull();
  });
});
