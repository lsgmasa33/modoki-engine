/** Pure math behind the SceneView orientation gizmo (SceneViewGizmo):
 *  - axisSnapCameraPosition: the snap-tween END position (look down an axis at a distance)
 *  - slerpCameraOffset: constant-distance arc between two camera offsets
 *  - projectGizmoAxis + GIZMO_AXES: world-axis → 2D gizmo face + depth
 *  No renderer/DOM — real three math objects in, plain numbers out. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  axisSnapCameraPosition,
  slerpCameraOffset,
  projectGizmoAxis,
  GIZMO_AXES,
  perspHalfHeightAtDistance,
  perspDistanceForHalfHeight,
  orthoFrustumForHalfHeight,
} from '../../src/editor/scene/sceneViewMath';
import { layoutAxes } from '../../src/editor/panels/SceneViewGizmo';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('axisSnapCameraPosition', () => {
  it('places the camera down the axis at the given distance from target', () => {
    const target = new THREE.Vector3(2, 3, 4);
    const p = axisSnapCameraPosition(target, new THREE.Vector3(0, 1, 0), 10);
    // +Y offset → straight above the target
    expect(p.x).toBeCloseTo(2, 6);
    expect(p.y).toBeCloseTo(13, 6);
    expect(p.z).toBeCloseTo(4, 6);
  });

  it('normalizes a non-unit dir so distance is exact', () => {
    const target = new THREE.Vector3();
    const p = axisSnapCameraPosition(target, new THREE.Vector3(0, 0, 5), 7);
    expect(p.length()).toBeCloseTo(7, 6);
    expect(p.z).toBeCloseTo(7, 6);
  });

  it('falls back to +Z for a degenerate dir (never NaN)', () => {
    const p = axisSnapCameraPosition(new THREE.Vector3(), new THREE.Vector3(0, 0, 0), 3);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(p.z).toBeCloseTo(3, 6);
  });
});

describe('slerpCameraOffset', () => {
  const from = new THREE.Vector3(10, 0, 0);
  const to = new THREE.Vector3(0, 0, 10);

  it('t=0 returns the from offset, t=1 the to offset', () => {
    expect(slerpCameraOffset(from, to, 0).distanceTo(from)).toBeLessThan(1e-6);
    expect(slerpCameraOffset(from, to, 1).distanceTo(to)).toBeLessThan(1e-6);
  });

  it('keeps constant distance across the arc (no dip toward target)', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(near(slerpCameraOffset(from, to, t).length(), 10, 1e-4)).toBe(true);
    }
  });

  it('lerps magnitude when the two offsets differ in length', () => {
    const shortTo = new THREE.Vector3(0, 0, 4);
    expect(slerpCameraOffset(from, shortTo, 0.5).length()).toBeCloseTo(7, 4); // (10+4)/2
  });

  it('handles antipodal offsets without NaN', () => {
    const a = new THREE.Vector3(0, 5, 0);
    const b = new THREE.Vector3(0, -5, 0);
    const mid = slerpCameraOffset(a, b, 0.5);
    expect(Number.isFinite(mid.x) && Number.isFinite(mid.y) && Number.isFinite(mid.z)).toBe(true);
    expect(mid.length()).toBeCloseTo(5, 4);
  });

  // REGRESSION (workflow review, HIGH): an exactly-antipodal snap — the Top→Bottom / Front→Back /
  // Left→Right gesture — must LAND ON the clicked opposite axis at t=1, not the perpendicular
  // side. The antipodal branch once swept only π/2, landing on (±X) instead of the antipode.
  it('reaches the ANTIPODE (not a perpendicular axis) at t=1 for opposite-axis snaps', () => {
    const ry = slerpCameraOffset(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -5, 0), 1);
    expect(ry.x).toBeCloseTo(0, 6); expect(ry.y).toBeCloseTo(-5, 6); expect(ry.z).toBeCloseTo(0, 6);
    const rz = slerpCameraOffset(new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, -8), 1);
    expect(rz.x).toBeCloseTo(0, 6); expect(rz.y).toBeCloseTo(0, 6); expect(rz.z).toBeCloseTo(-8, 6);
    expect(ry.length()).toBeCloseTo(5, 6);
  });

  it('antipodal midpoint lies on the perpendicular great-circle (constant radius, ⟂ to start)', () => {
    const from = new THREE.Vector3(0, 5, 0);
    const mid = slerpCameraOffset(from, new THREE.Vector3(0, -5, 0), 0.5);
    expect(mid.length()).toBeCloseTo(5, 6);
    expect(mid.clone().normalize().dot(from.clone().normalize())).toBeCloseTo(0, 6); // 90° from start
  });

  it('is continuous across the antipodal threshold (no jump to a perpendicular axis)', () => {
    // A pair JUST short of exactly antipodal, vs exactly antipodal — endpoints must agree.
    const from = new THREE.Vector3(0, 5, 0);
    const nearTo = new THREE.Vector3(0, -4.997, 0.173).normalize().multiplyScalar(5);
    const near = slerpCameraOffset(from, nearTo, 1);
    const exact = slerpCameraOffset(from, new THREE.Vector3(0, -5, 0), 1);
    expect(near.distanceTo(exact)).toBeLessThan(0.25); // both end near (0,-5,0), no 90° jump
    expect(exact.y).toBeLessThan(-4.9);
  });

  it('clamps t outside [0,1]', () => {
    expect(slerpCameraOffset(from, to, -1).distanceTo(from)).toBeLessThan(1e-6);
    expect(slerpCameraOffset(from, to, 2).distanceTo(to)).toBeLessThan(1e-6);
  });
});

describe('projectGizmoAxis + GIZMO_AXES', () => {
  it('has 6 axes with unit dirs and opposite-signed pairs', () => {
    expect(GIZMO_AXES).toHaveLength(6);
    const byName = Object.fromEntries(GIZMO_AXES.map(a => [a.name, a.dir]));
    for (const ax of ['x', 'y', 'z']) {
      const p = byName[`+${ax}`], n = byName[`-${ax}`];
      expect([p[0] + n[0], p[1] + n[1], p[2] + n[2]]).toEqual([0, 0, 0]);
    }
  });

  it('with an identity camera (no rotation), world axes map to screen: +X right, +Y up, +Z toward viewer', () => {
    const q = new THREE.Quaternion(); // identity
    const px = projectGizmoAxis(new THREE.Vector3(1, 0, 0), q);
    expect(px.x).toBeCloseTo(1, 6); expect(px.depth).toBeCloseTo(0, 6);
    const py = projectGizmoAxis(new THREE.Vector3(0, 1, 0), q);
    expect(py.y).toBeCloseTo(1, 6); expect(py.depth).toBeCloseTo(0, 6);
    const pz = projectGizmoAxis(new THREE.Vector3(0, 0, 1), q);
    expect(pz.depth).toBeCloseTo(1, 6); // +Z points at the viewer (camera looks down −Z)
  });

  it('depth flips sign for the axis the camera faces vs. away', () => {
    // Camera rotated 180° about Y now looks down +Z, so world +Z is BEHIND (negative depth).
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const pz = projectGizmoAxis(new THREE.Vector3(0, 0, 1), q);
    expect(pz.depth).toBeCloseTo(-1, 5);
  });

  // Identity and 180°-about-Y are symmetric and would hide a missing `.invert()`. A general
  // tilted+yawed orientation pins the inverse-rotation contract: project(w) == w in camera space.
  it('equals the world axis transformed into camera space, under a general tilted orientation', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 6, Math.PI / 4, 0));
    const inv = q.clone().invert();
    for (const w of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const wv = new THREE.Vector3(...w);
      const e = wv.clone().applyQuaternion(inv);
      const p = projectGizmoAxis(wv, q);
      expect(p.x).toBeCloseTo(e.x, 6);
      expect(p.y).toBeCloseTo(e.y, 6);
      expect(p.depth).toBeCloseTo(e.z, 6);
      for (const c of [p.x, p.y, p.depth]) { expect(c).toBeGreaterThanOrEqual(-1.0000001); expect(c).toBeLessThanOrEqual(1.0000001); }
    }
  });
});

describe('layoutAxes (SceneViewGizmo painter order)', () => {
  it('returns all 6 axes sorted back-to-front so the viewer-facing cone draws last', () => {
    const out = layoutAxes(new THREE.Quaternion()); // identity camera looks down −Z at world −Z
    expect(out).toHaveLength(6);
    const depths = out.map(a => a.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b)); // non-decreasing (farthest first)
    expect(out[out.length - 1].name).toBe('+z'); // +Z faces the viewer → drawn last (on top)
    expect(out[out.length - 1].depth).toBeCloseTo(1, 6);
    expect(out[0].name).toBe('-z');
    expect(out[0].depth).toBeCloseTo(-1, 6);
    for (const a of out) { expect(Number.isFinite(a.x)).toBe(true); expect(Number.isFinite(a.y)).toBe(true); }
  });
});

describe('perspective ↔ ortho frustum matching', () => {
  it('perspHalfHeightAtDistance ↔ perspDistanceForHalfHeight are inverses', () => {
    const fov = 50;
    const halfH = perspHalfHeightAtDistance(fov, 30);
    expect(perspDistanceForHalfHeight(fov, halfH)).toBeCloseTo(30, 6);
  });

  it('half-height matches THREE PerspectiveCamera geometry (dist·tan(fov/2))', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const dist = 12;
    const expected = dist * Math.tan((cam.fov * Math.PI) / 360);
    expect(perspHalfHeightAtDistance(cam.fov, dist)).toBeCloseTo(expected, 9);
  });

  it('perspDistanceForHalfHeight guards a degenerate ~0 fov (no divide-by-zero)', () => {
    expect(Number.isFinite(perspDistanceForHalfHeight(0, 5))).toBe(true);
  });

  it('orthoFrustumForHalfHeight is centered and respects aspect', () => {
    const f = orthoFrustumForHalfHeight(4, 1.5);
    expect(f.top).toBe(4); expect(f.bottom).toBe(-4);
    expect(f.right).toBe(6); expect(f.left).toBe(-6); // 4 * 1.5
    expect(f.top + f.bottom).toBe(0);
    expect(f.left + f.right).toBe(0);
  });

  it('an ortho frustum built from the persp half-height frames the same vertical extent', () => {
    // At the pivot, ±halfH world units should map to the ortho frustum's top/bottom exactly.
    const fov = 45, dist = 20, aspect = 16 / 9;
    const halfH = perspHalfHeightAtDistance(fov, dist);
    const f = orthoFrustumForHalfHeight(halfH, aspect);
    expect(f.top).toBeCloseTo(halfH, 9);
    expect(f.right / f.top).toBeCloseTo(aspect, 9);
  });
});
