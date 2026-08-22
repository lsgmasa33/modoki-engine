/** GroupAlpha — the 2D alpha product down the hierarchy (#211).
 *
 *  `Scene2D` renders a FLAT PixiJS tree (every display object goes straight onto its Canvas2D
 *  slot container), so a parent's alpha never reaches its children the way nested DOM opacity
 *  does for UI. `computeGroupAlpha` is the ancestor product that replaces it, and these tests
 *  pin the semantics the trait documents: multiplies self AND descendants, composes with
 *  `Renderable2D.opacity` rather than replacing it, nests, and costs nothing when unused. */

import { describe, it, expect } from 'vitest';
import { computeGroupAlpha } from '../../src/runtime/rendering/groupAlpha';

/** entityId → parentId, 0 = root — the same shape Scene2D feeds computePaintOrder. */
const tree = (pairs: [number, number][]) => new Map<number, number>(pairs);

describe('computeGroupAlpha', () => {
  it('is empty when nothing carries the trait — an unused feature costs one map', () => {
    const out = computeGroupAlpha(new Map(), tree([[1, 0], [2, 1]]));
    expect(out.size).toBe(0);
  });

  it('applies to the entity itself AND its descendants (Unity CanvasGroup semantics)', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5]]), tree([[1, 0], [2, 1], [3, 2]]));
    expect(out.get(1)).toBe(0.5); // self
    expect(out.get(2)).toBe(0.5); // child
    expect(out.get(3)).toBe(0.5); // grandchild
  });

  it('leaves siblings outside the group untouched', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5]]), tree([[1, 0], [2, 1], [9, 0], [10, 9]]));
    expect(out.has(9)).toBe(false);
    expect(out.has(10)).toBe(false);
  });

  it('multiplies nested groups', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5], [2, 0.5]]), tree([[1, 0], [2, 1], [3, 2]]));
    expect(out.get(1)).toBe(0.5);
    expect(out.get(2)).toBe(0.25);
    expect(out.get(3)).toBe(0.25);
  });

  it('clamps per level, so an authored 1.4 cannot brighten an ancestor fade back up', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5], [2, 1.4]]), tree([[1, 0], [2, 1]]));
    expect(out.get(2)).toBe(0.5);
  });

  it('clamps a negative to 0 rather than inverting the subtree', () => {
    const out = computeGroupAlpha(new Map([[1, -2]]), tree([[1, 0], [2, 1]]));
    expect(out.get(1)).toBe(0);
    expect(out.get(2)).toBe(0);
  });

  it('omits entities whose product is exactly 1 — the map stays sparse', () => {
    const out = computeGroupAlpha(new Map([[1, 1]]), tree([[1, 0], [2, 1]]));
    expect(out.size).toBe(0);
  });

  it('survives a cyclic parent chain instead of hanging', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5]]), tree([[1, 2], [2, 1]]));
    expect(out.get(1)).toBe(0.5); // reached by the orphan pass, not the root walk
  });

  it('still applies a group whose parent is missing from the tree (an orphan subtree)', () => {
    // parent 77 is not itself a key — treated as a root, so the group is not silently dropped.
    const out = computeGroupAlpha(new Map([[5, 0.25]]), tree([[5, 77], [6, 5]]));
    expect(out.get(5)).toBe(0.25);
    expect(out.get(6)).toBe(0.25);
  });
  // Pins the LIMIT, not a wish: a cyclic parent chain is malformed data, and no walk reaches a
  // descendant hanging off it. Identical in the pre-rewrite code, and `computePaintOrder` is
  // equally undefined for a cycle — so this asserts what the function actually promises rather
  // than leaving a future reader to discover it from a scene that half-fades.
  it('fades a cycle member itself but NOT a descendant hanging off the cycle', () => {
    const out = computeGroupAlpha(new Map([[2, 0.5]]), tree([[1, 2], [2, 1], [3, 2]]));
    expect(out.get(2)).toBe(0.5);
    expect(out.get(3)).toBeUndefined();
  });

  // Pins the PROPERTY (nested groups compound exactly once), not the `seen` guard — that guard
  // is unreachable by construction and deleting it fails nothing, which this test was checked
  // against rather than assumed.
  it('compounds nested groups once, not twice, across the root and pseudo-root walks', () => {
    const out = computeGroupAlpha(new Map([[5, 0.5], [6, 0.5]]), tree([[6, 5], [7, 6]]));
    expect(out.get(6)).toBe(0.25);
    expect(out.get(7)).toBe(0.25); // 0.125 would mean 5's group was applied twice
  });

  // Close-out finding: `parentOf` is built from entities carrying EntityAttributes, so a group
  // spawned WITHOUT one (`world.spawn(GroupAlpha, …)` — which the trait explicitly invites) is
  // absent from that map while its children still name it as their parent. Re-pointing such an
  // edge at the root detached the subtree and it inherited nothing.
  it('fades children of a group that is itself absent from the parent map', () => {
    // entity 5 carries the group but has no EntityAttributes; 6 is its child.
    const out = computeGroupAlpha(new Map([[5, 0.25]]), tree([[6, 5]]));
    expect(out.get(5)).toBe(0.25); // the group itself
    expect(out.get(6)).toBe(0.25); // and its child, which is the half that was broken
  });

  it('still walks the subtree under a genuinely dangling parent id', () => {
    // 99 names no entity and carries no group, so the child keeps only its OWN group.
    const out = computeGroupAlpha(new Map([[7, 0.5]]), tree([[7, 99]]));
    expect(out.get(7)).toBe(0.5);
  });

  it('treats a non-finite authored alpha as 1 instead of rendering the subtree as nothing', () => {
    // Math.min(1, Math.max(0, NaN)) is NaN, which would reach obj.alpha and blank the subtree.
    const out = computeGroupAlpha(new Map([[1, NaN]]), tree([[1, 0], [2, 1]]));
    expect(out.has(1)).toBe(false);
    expect(out.has(2)).toBe(false);
  });

  it('does not let a NaN group blank a subtree that a valid ancestor already fades', () => {
    const out = computeGroupAlpha(new Map([[1, 0.5], [2, NaN]]), tree([[1, 0], [2, 1], [3, 2]]));
    expect(out.get(2)).toBe(0.5); // NaN ignored, ancestor's fade preserved
    expect(out.get(3)).toBe(0.5);
  });
});
