/**
 * multiTransform — group (multi-select) gizmo math for the 3D + 2D SceneView.
 *
 * Covers the two Unity toggles' semantics:
 *   - Move: same delta to every member (both pivot modes).
 *   - Center: rigid cluster orbit/spread around the selection centroid.
 *   - Pivot: rigid cluster orbit/spread around the active (last-selected) entity's origin — that
 *     entity stays put, every OTHER member orbits/spreads around it (NOT each member rotating
 *     about its own origin in place; see the "PIVOT pivot" cases below).
 *   - Descendant filtering: a selected child of a selected parent is dropped (moved once).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  filterOutDescendants,
  applyGroupTransform3D,
  applyGroupTransform2D,
  selectionCentroid3D,
  selectionCentroid2D,
  resolveGroupPivot2D,
  type Transform2D,
  type Group2DPivotMember,
} from '../../src/editor/scene/multiTransform';

const mat = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
const pos = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const decomp = (m: THREE.Matrix4) => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
};

describe('filterOutDescendants', () => {
  const parents: Record<number, number> = { 1: 0, 2: 1, 3: 1, 4: 2, 5: 0 };
  const parentOf = (id: number) => parents[id] ?? 0;

  it('drops a child when its parent is also selected', () => {
    expect(filterOutDescendants([1, 2], parentOf)).toEqual([1]);
  });
  it('drops a grandchild when an ancestor is selected', () => {
    expect(filterOutDescendants([1, 4], parentOf)).toEqual([1]);
  });
  it('keeps siblings and unrelated roots', () => {
    expect(filterOutDescendants([2, 3, 5], parentOf)).toEqual([2, 3, 5]);
  });
  it('keeps a child when the parent is NOT selected', () => {
    expect(filterOutDescendants([2, 5], parentOf)).toEqual([2, 5]);
  });
  it('preserves order', () => {
    expect(filterOutDescendants([5, 1, 2], parentOf)).toEqual([5, 1]);
  });
});

describe('applyGroupTransform3D — translate', () => {
  it('moves every member by the same world delta, keeping their own rotation/scale', () => {
    const members = [mat(0, 0, 0, 0.3, 0, 0), mat(5, 1, -2, 0, 0.7, 0, 2, 2, 2)];
    const pivotStart = mat(2.5, 0.5, -1);
    const pivotNow = mat(2.5 + 3, 0.5 - 4, -1 + 1); // translated by (3,-4,1)
    const out = applyGroupTransform3D({ memberStartWorld: members, pivotStart, pivotNow, mode: 'translate' });
    expect(pos(out[0]).x).toBeCloseTo(3); expect(pos(out[0]).y).toBeCloseTo(-4); expect(pos(out[0]).z).toBeCloseTo(1);
    expect(pos(out[1]).x).toBeCloseTo(8); expect(pos(out[1]).y).toBeCloseTo(-3); expect(pos(out[1]).z).toBeCloseTo(-1);
    // rotation + scale preserved on member 1
    const d = decomp(out[1]);
    expect(d.s.x).toBeCloseTo(2); expect(d.s.y).toBeCloseTo(2);
  });
});

describe('applyGroupTransform3D — rotate (rigid orbit around the pivot point)', () => {
  it('CENTER pivot (centroid at origin): both members orbit around the centre', () => {
    // Two members either side of the origin; rotate 90° about Z around origin.
    const members = [mat(1, 0, 0), mat(-1, 0, 0)];
    const pivotStart = mat(0, 0, 0);
    const pivotNow = mat(0, 0, 0, 0, 0, Math.PI / 2);
    const out = applyGroupTransform3D({ memberStartWorld: members, pivotStart, pivotNow, mode: 'rotate' });
    // (1,0,0) rotated 90° about Z → (0,1,0); (-1,0,0) → (0,-1,0)
    expect(pos(out[0]).x).toBeCloseTo(0); expect(pos(out[0]).y).toBeCloseTo(1);
    expect(pos(out[1]).x).toBeCloseTo(0); expect(pos(out[1]).y).toBeCloseTo(-1);
    // each member also picked up the rotation
    expect(new THREE.Euler().setFromQuaternion(decomp(out[0]).q).z).toBeCloseTo(Math.PI / 2);
  });

  it('PIVOT pivot (active origin): the active member STAYS, the rest orbit around it', () => {
    // pivot at member[0] = (1,0,0). Rotate 90° about Z: member[0] stays; member[1] orbits it.
    const members = [mat(1, 0, 0), mat(-1, 0, 0)];
    const pivotStart = mat(1, 0, 0);
    const pivotNow = mat(1, 0, 0, 0, 0, Math.PI / 2);
    const out = applyGroupTransform3D({ memberStartWorld: members, pivotStart, pivotNow, mode: 'rotate' });
    expect(pos(out[0]).x).toBeCloseTo(1); expect(pos(out[0]).y).toBeCloseTo(0); // active stays put
    // (-1,0,0) rel pivot = (-2,0,0), rotated 90° about Z → (0,-2,0), + pivot → (1,-2,0)
    expect(pos(out[1]).x).toBeCloseTo(1); expect(pos(out[1]).y).toBeCloseTo(-2);
    expect(new THREE.Euler().setFromQuaternion(decomp(out[1]).q).z).toBeCloseTo(Math.PI / 2);
  });
});

describe('applyGroupTransform3D — scale (rigid spread around the pivot point)', () => {
  it('CENTER pivot (origin): members spread from the centre and grow', () => {
    const members = [mat(2, 0, 0), mat(-2, 0, 0)];
    const pivotStart = mat(0, 0, 0);
    const pivotNow = mat(0, 0, 0, 0, 0, 0, 2, 2, 2); // uniform ×2 about origin
    const out = applyGroupTransform3D({ memberStartWorld: members, pivotStart, pivotNow, mode: 'scale' });
    expect(pos(out[0]).x).toBeCloseTo(4); // 2 → 4 (spread)
    expect(pos(out[1]).x).toBeCloseTo(-4);
    expect(decomp(out[0]).s.x).toBeCloseTo(2); // each grew ×2
  });

  it('PIVOT pivot (active origin): the active member STAYS, the rest spread from it', () => {
    const members = [mat(2, 0, 0, 0, 0, 0, 1, 1, 1), mat(-2, 0, 0, 0, 0, 0, 3, 3, 3)];
    const pivotStart = mat(2, 0, 0);
    const pivotNow = mat(2, 0, 0, 0, 0, 0, 2, 2, 2);
    const out = applyGroupTransform3D({ memberStartWorld: members, pivotStart, pivotNow, mode: 'scale' });
    expect(pos(out[0]).x).toBeCloseTo(2); // active (at pivot) stays
    // (-2,0,0) rel pivot = (-4,0,0) ×2 = (-8,0,0), + pivot (2) → -6
    expect(pos(out[1]).x).toBeCloseTo(-6);
    expect(decomp(out[0]).s.x).toBeCloseTo(2); // 1 × 2
    expect(decomp(out[1]).s.x).toBeCloseTo(6); // 3 × 2
  });
});

describe('selectionCentroid3D', () => {
  it('averages member origins', () => {
    const c = selectionCentroid3D([mat(0, 0, 0), mat(4, 2, -6)]);
    expect(c.x).toBeCloseTo(2); expect(c.y).toBeCloseTo(1); expect(c.z).toBeCloseTo(-3);
  });
});

// ─── 2D ──────────────────────────────────────────────────────────────────────

const t2 = (x: number, y: number, rz = 0, sx = 1, sy = 1): Transform2D => ({ x, y, rz, sx, sy });

describe('applyGroupTransform2D', () => {
  it('translate: same delta to all', () => {
    const out = applyGroupTransform2D({
      memberStart: [t2(0, 0, 0.5), t2(10, -3, 0, 2, 2)], pivot: { x: 5, y: -1.5 },
      mode: 'translate', delta: { dx: 3, dy: -4, dRz: 0, dSx: 1, dSy: 1 },
    });
    expect(out[0]).toMatchObject({ x: 3, y: -4, rz: 0.5 });
    expect(out[1]).toMatchObject({ x: 13, y: -7, sx: 2, sy: 2 });
  });

  it('rotate: members orbit around the pivot (centroid example)', () => {
    const out = applyGroupTransform2D({
      memberStart: [t2(1, 0), t2(-1, 0)], pivot: { x: 0, y: 0 },
      mode: 'rotate', delta: { dx: 0, dy: 0, dRz: Math.PI / 2, dSx: 1, dSy: 1 },
    });
    expect(out[0].x).toBeCloseTo(0); expect(out[0].y).toBeCloseTo(1); expect(out[0].rz).toBeCloseTo(Math.PI / 2);
    expect(out[1].x).toBeCloseTo(0); expect(out[1].y).toBeCloseTo(-1);
  });

  it('rotate: pivot at the active member → it stays, the rest orbit it', () => {
    const out = applyGroupTransform2D({
      memberStart: [t2(1, 0), t2(-1, 0)], pivot: { x: 1, y: 0 },
      mode: 'rotate', delta: { dx: 0, dy: 0, dRz: Math.PI / 2, dSx: 1, dSy: 1 },
    });
    expect(out[0].x).toBeCloseTo(1); expect(out[0].y).toBeCloseTo(0); // active stays
    // (-1,0) rel pivot = (-2,0), rotated 90° → (0,-2), + pivot → (1,-2)
    expect(out[1].x).toBeCloseTo(1); expect(out[1].y).toBeCloseTo(-2);
  });

  it('scale: members spread around the pivot (centroid example)', () => {
    const out = applyGroupTransform2D({
      memberStart: [t2(2, 0), t2(-2, 0)], pivot: { x: 0, y: 0 },
      mode: 'scale', delta: { dx: 0, dy: 0, dRz: 0, dSx: 2, dSy: 2 },
    });
    expect(out[0].x).toBeCloseTo(4); expect(out[0].sx).toBeCloseTo(2);
    expect(out[1].x).toBeCloseTo(-4);
  });

  it('scale: pivot at the active member → it stays, the rest spread from it', () => {
    const out = applyGroupTransform2D({
      memberStart: [t2(2, 0, 0, 1, 1), t2(-2, 0, 0, 3, 3)], pivot: { x: 2, y: 0 },
      mode: 'scale', delta: { dx: 0, dy: 0, dRz: 0, dSx: 2, dSy: 2 },
    });
    expect(out[0].x).toBeCloseTo(2); expect(out[0].sx).toBeCloseTo(2); // active stays
    // (-2,0) rel pivot = (-4,0) ×2 = (-8,0), + pivot (2) → -6
    expect(out[1].x).toBeCloseTo(-6); expect(out[1].sx).toBeCloseTo(6);
  });
});

describe('selectionCentroid2D', () => {
  it('averages member origins', () => {
    expect(selectionCentroid2D([t2(0, 0), t2(4, -2)])).toMatchObject({ x: 2, y: -1 });
  });
});

describe('resolveGroupPivot2D', () => {
  const pm = (id: number, x: number, y: number, rz = 0, sx = 1, sy = 1, halfW = 2, halfH = 2): Group2DPivotMember =>
    ({ id, x, y, rz, sx, sy, halfW, halfH });

  it('Pivot mode: sits on the active entity, boxed to it alone', () => {
    const members = [pm(1, 0, 0), pm(2, 10, 4, 0, 1, 1, 9, 7)];
    const r = resolveGroupPivot2D(members, 2, 'pivot', 'world');
    expect(r.pivotX).toBe(10); expect(r.pivotY).toBe(4);
    expect(r.gw).toBeCloseTo(9); expect(r.gh).toBeCloseTo(7); // above the 6-unit floor
  });

  it('Center mode: frames the whole selection at its bounding-box centre', () => {
    const members = [pm(1, -2, 0, 0, 1, 1, 1, 1), pm(2, 4, 0, 0, 1, 1, 1, 1)];
    const r = resolveGroupPivot2D(members, 2, 'center', 'world');
    // bbox spans x: [-3,5] -> centre 1
    expect(r.pivotX).toBeCloseTo(1); expect(r.pivotY).toBeCloseTo(0);
  });

  it('Pivot mode falls back to Center framing when the active id is not among the members', () => {
    // e.g. the active entity was filtered out (descendant of another selected entity) or
    // belongs to a different canvas — an arbitrary member's origin would be more confusing.
    const members = [pm(1, -2, 0), pm(2, 4, 0)];
    const r = resolveGroupPivot2D(members, 99, 'pivot', 'world');
    expect(r.pivotX).toBeCloseTo(1); // bbox centre, not member 1 or 2's origin
  });

  it('World space: pivotRz is 0 regardless of the active entity\'s rotation', () => {
    const members = [pm(1, 0, 0, 0.7), pm(2, 5, 0, 1.2)];
    expect(resolveGroupPivot2D(members, 2, 'pivot', 'world').pivotRz).toBe(0);
    expect(resolveGroupPivot2D(members, 2, 'center', 'world').pivotRz).toBe(0);
  });

  it('Local space: pivotRz follows the active entity\'s world rotation (regression — was hardcoded to 0)', () => {
    const members = [pm(1, 0, 0, 0.7), pm(2, 5, 0, 1.2)];
    // Independent of Pivot/Center — orientation tracks the ACTIVE entity either way.
    expect(resolveGroupPivot2D(members, 2, 'pivot', 'local').pivotRz).toBeCloseTo(1.2);
    expect(resolveGroupPivot2D(members, 2, 'center', 'local').pivotRz).toBeCloseTo(1.2);
    expect(resolveGroupPivot2D(members, 1, 'center', 'local').pivotRz).toBeCloseTo(0.7);
  });

  it('Local space with no resolvable active entity draws axis-aligned (pivotRz 0)', () => {
    const members = [pm(1, 0, 0, 0.7), pm(2, 5, 0, 1.2)];
    expect(resolveGroupPivot2D(members, 99, 'center', 'local').pivotRz).toBe(0);
  });
});
