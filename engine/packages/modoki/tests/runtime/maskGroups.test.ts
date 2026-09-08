/** maskGroups — pins the semantics `Mask2D`'s doc comment promises: ancestor-or-self,
 *  nearest-wins with `parentMaskOf` capturing the nesting chain, and the same sparse/lazy +
 *  pseudo-root + cycle handling as `computeGroupAlpha` (`groupAlpha.test.ts` is the template). */

import { describe, it, expect } from 'vitest';
import { computeMaskGroups } from '../../src/runtime/rendering/maskGroups';

/** entityId → parentId, 0 = root — same shape Scene2D feeds computePaintOrder/computeGroupAlpha. */
const tree = (pairs: [number, number][]) => new Map<number, number>(pairs);
const ids = (...xs: number[]) => new Set<number>(xs);

describe('computeMaskGroups', () => {
  it('is empty when there are no masks — an unused feature costs two maps, no walk', () => {
    const { groupOf, parentMaskOf } = computeMaskGroups(ids(), tree([[1, 0], [2, 1]]));
    expect(groupOf.size).toBe(0);
    expect(parentMaskOf.size).toBe(0);
  });

  it('a single mask clips itself and every descendant', () => {
    const { groupOf, parentMaskOf } = computeMaskGroups(ids(1), tree([[1, 0], [2, 1], [3, 2]]));
    expect(groupOf.get(1)).toBe(1); // ancestor-or-self
    expect(groupOf.get(2)).toBe(1);
    expect(groupOf.get(3)).toBe(1);
    expect(parentMaskOf.size).toBe(0); // top-level mask has no mask ancestor
  });

  it('leaves a sibling subtree under no mask absent from groupOf', () => {
    const { groupOf } = computeMaskGroups(ids(1), tree([[1, 0], [2, 1], [9, 0], [10, 9]]));
    expect(groupOf.has(9)).toBe(false);
    expect(groupOf.has(10)).toBe(false);
  });

  it('nested masks: inner wins in groupOf, parentMaskOf records outer, descendants of inner map to inner', () => {
    const { groupOf, parentMaskOf } = computeMaskGroups(
      ids(1, 2),
      tree([[1, 0], [2, 1], [3, 2]]),
    );
    expect(groupOf.get(1)).toBe(1);
    expect(groupOf.get(2)).toBe(2); // inner mask shadows outer for itself
    expect(groupOf.get(3)).toBe(2); // descendant of inner ⇒ inner, not outer
    expect(parentMaskOf.get(2)).toBe(1);
    expect(parentMaskOf.has(1)).toBe(false); // outer has no mask ancestor of its own
  });

  it('three levels of nesting chain correctly in parentMaskOf', () => {
    const { groupOf, parentMaskOf } = computeMaskGroups(
      ids(1, 2, 3),
      tree([[1, 0], [2, 1], [3, 2], [4, 3]]),
    );
    expect(parentMaskOf.get(2)).toBe(1);
    expect(parentMaskOf.get(3)).toBe(2);
    expect(parentMaskOf.has(1)).toBe(false);
    expect(groupOf.get(4)).toBe(3); // nearest mask wins for the leaf
  });

  it('still clips children of a mask whose parent id is absent from parentOf (pseudo-root)', () => {
    // entity 5 carries the mask but has no EntityAttributes (absent from parentOf's keys);
    // 6 is its child and must still inherit the mask.
    const { groupOf } = computeMaskGroups(ids(5), tree([[6, 5]]));
    expect(groupOf.get(5)).toBe(5);
    expect(groupOf.get(6)).toBe(5);
  });

  it('survives a cyclic parent chain instead of hanging, and the cycle member still masks itself', () => {
    const { groupOf } = computeMaskGroups(ids(1), tree([[1, 2], [2, 1]]));
    expect(groupOf.get(1)).toBe(1); // reached by the fallback pass, not the root walk
  });

  it('does not mask a non-mask descendant hanging off an unreached cycle', () => {
    const { groupOf } = computeMaskGroups(ids(2), tree([[1, 2], [2, 1], [3, 2]]));
    expect(groupOf.get(2)).toBe(2);
    expect(groupOf.has(3)).toBe(false);
  });
});
