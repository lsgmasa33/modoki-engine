/**
 * A scale drag must read the FACTOR the gizmo applied, never the proxy's absolute scale.
 *
 * `TransformControls` scales by `object.scale = _scaleStart × factor`, where `_scaleStart` is
 * whatever the attached object held at pointer-down. For a mesh that object carries the entity's
 * own pose. For a mesh-LESS entity it is an editor ICON that nothing syncs — so the absolute
 * read-back is a number the entity never had, every drag compounds the last, and the undo entry
 * records the stale value as `before`. Measured on `games/anim-bug`'s `Sun`
 * (bug `euf2YDw0bXcPZ6CziuSU`): 1 → 8959.28 → 87721.01 → 858883.50, with Cmd+Z restoring 8959.28.
 */
import { describe, it, expect } from 'vitest';
import { scaleFromGizmoRatio } from '../../src/editor/scene/gizmoTransform';

const S = (n: number) => ({ sx: n, sy: n, sz: n });
const V = (n: number) => ({ x: n, y: n, z: n });

describe('scaleFromGizmoRatio', () => {
  it('applies the drag factor to the ENTITY value, not to the proxy value', () => {
    // The reported case: entity at 1, icon left at 8959.28 by the previous drag, gizmo doubles it.
    const stale = 8959.278364346446;             // the icon's scale, left there by the last drag
    const absolute = stale * 2;                  // what the old absolute read-back handed the entity
    const out = scaleFromGizmoRatio(S(1), V(stale), V(absolute), S(absolute));
    expect(out.sx).toBeCloseTo(2, 12);
    expect(out.sx).not.toBeCloseTo(absolute, 0);
  });

  it('does not compound across repeated identical drags', () => {
    // Three drags of the same factor from the same authored scale must give the same answer,
    // even though the proxy grows by that factor each time and is never reset.
    let proxy = 1;
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = proxy;
      proxy = start * 3;                        // the gizmo multiplies whatever it found
      results.push(scaleFromGizmoRatio(S(1), V(start), V(proxy), S(proxy)).sx);
    }
    expect(results).toEqual([3, 3, 3]);
  });

  it('agrees with the absolute read-back when the proxy IS in sync (the mesh path)', () => {
    // A mesh's Object3D scale is written from the entity every frame, so start === before and the
    // ratio result must equal what worldToLocalTransform decomposes. This is the regression guard
    // for the path that already worked.
    const before = { sx: 2, sy: 3, sz: 4 };
    const now = { x: 5, y: 7.5, z: 10 };        // ×2.5 on every axis
    const decomposed = { sx: 5, sy: 7.5, sz: 10 };
    const out = scaleFromGizmoRatio(before, { x: 2, y: 3, z: 4 }, now, decomposed);
    expect(out.sx).toBeCloseTo(decomposed.sx, 12);
    expect(out.sy).toBeCloseTo(decomposed.sy, 12);
    expect(out.sz).toBeCloseTo(decomposed.sz, 12);
  });

  it('is parent-invariant — the local ratio equals the world ratio', () => {
    // A child at local 2 under a parent scaled 10 has world scale 20. The gizmo works in world
    // space and halves it (20 → 10); the child's local scale must land on 1, and the ratio needs
    // to know nothing about the parent to get there.
    const out = scaleFromGizmoRatio(S(2), V(20), V(10), S(1));
    expect(out.sx).toBeCloseTo(1, 12);
  });

  it('preserves a sign flip past the pivot for the clamp to catch', () => {
    // Crossing the pivot must reach the caller as a NEGATIVE value; clampScaleCrossingPivot is
    // what stops it. Swallowing the sign here would silently disable that guard.
    expect(scaleFromGizmoRatio(S(2), V(1), V(-0.5), S(-1)).sx).toBeCloseTo(-1, 12);
  });

  it('falls back to the decomposed value on an axis whose proxy started at 0', () => {
    // 0 has no ratio. Scaling to zero is a supported "hidden" idiom, so this must not divide by
    // it, produce Infinity, or pin the axis — it hands back exactly what the mesh path computes.
    const out = scaleFromGizmoRatio(S(2), { x: 0, y: 1, z: 1 }, { x: 4, y: 2, z: 2 }, { sx: 9, sy: 0, sz: 0 });
    expect(out.sx).toBe(9);
    expect(out.sy).toBeCloseTo(4, 12);
  });

  it('falls back on a non-finite proxy rather than propagating NaN into the Transform', () => {
    const out = scaleFromGizmoRatio(S(2), { x: NaN, y: Infinity, z: 1 }, { x: 1, y: 1, z: NaN }, S(7));
    expect(out).toEqual({ sx: 7, sy: 7, sz: 7 });
  });
});
