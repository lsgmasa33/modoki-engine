/**
 * gizmoTransform — parented-gizmo world↔local round-trip (engine-review C2 / sceneview F4).
 *
 * The 3D TransformControls gizmo writes a WORLD-space transform; `worldToLocalTransform`
 * must recover the child's LOCAL TRS by inverting the parent's world transform. The
 * round-trip invariant: compose(parentWorld, localChild) → childWorld, feed childWorld
 * back through the helper, and the original localChild must come back out. A broken
 * parent-inverse (the bug this guards) silently mis-places parented entities on drag.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  worldToLocalTransform,
  clampScaleCrossingPivot,
  scaleCrossedPivot,
  type TransformTRS,
} from '../../src/editor/scene/gizmoTransform';

/** Build a THREE Object3D positioned at the world transform implied by parentWorld ⊗ local. */
function childObjectInWorld(parent: TransformTRS | null, local: TransformTRS): THREE.Object3D {
  const localMat = new THREE.Matrix4().compose(
    new THREE.Vector3(local.x, local.y, local.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(local.rx, local.ry, local.rz)),
    new THREE.Vector3(local.sx, local.sy, local.sz),
  );
  let worldMat = localMat;
  if (parent) {
    const parentMat = new THREE.Matrix4().compose(
      new THREE.Vector3(parent.x, parent.y, parent.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(parent.rx, parent.ry, parent.rz)),
      new THREE.Vector3(parent.sx, parent.sy, parent.sz),
    );
    worldMat = parentMat.multiply(localMat);
  }
  const obj = new THREE.Object3D();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  worldMat.decompose(p, q, s);
  obj.position.copy(p);
  obj.rotation.setFromQuaternion(q);
  obj.scale.copy(s);
  return obj;
}

/** Compare two TRS via their composed matrices (Euler aliasing makes raw field compare unsafe). */
function expectSameTransform(a: TransformTRS, b: TransformTRS) {
  const ma = new THREE.Matrix4().compose(
    new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(a.rx, a.ry, a.rz)),
    new THREE.Vector3(a.sx, a.sy, a.sz),
  );
  const mb = new THREE.Matrix4().compose(
    new THREE.Vector3(b.x, b.y, b.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(b.rx, b.ry, b.rz)),
    new THREE.Vector3(b.sx, b.sy, b.sz),
  );
  for (let i = 0; i < 16; i++) expect(ma.elements[i]).toBeCloseTo(mb.elements[i], 5);
}

const identityScaleLocal: TransformTRS = { x: 2, y: -3, z: 1, rx: 0.3, ry: -0.7, rz: 1.1, sx: 1, sy: 1, sz: 1 };

describe('worldToLocalTransform', () => {
  it('root entity (no parent): world transform IS the local transform', () => {
    const local = identityScaleLocal;
    const obj = childObjectInWorld(null, local);
    const out = worldToLocalTransform(obj, null);
    expectSameTransform(out, local);
  });

  it('treats undefined parent the same as null', () => {
    const obj = childObjectInWorld(null, identityScaleLocal);
    expectSameTransform(worldToLocalTransform(obj, undefined), identityScaleLocal);
  });

  it('parented entity: recovers local TRS by inverting the parent world (translation+rotation)', () => {
    const parent: TransformTRS = { x: 10, y: 5, z: -2, rx: 0, ry: Math.PI / 4, rz: 0, sx: 1, sy: 1, sz: 1 };
    const local: TransformTRS = { x: 1, y: 0, z: 3, rx: 0.2, ry: 0, rz: -0.5, sx: 1, sy: 1, sz: 1 };
    const obj = childObjectInWorld(parent, local);
    expectSameTransform(worldToLocalTransform(obj, parent), local);
  });

  it('parented entity under non-uniform parent scale, axis-aligned child: round-trips', () => {
    // Non-uniform parent scale + a ROTATED child shears the world matrix, which TRS
    // decomposition can't invert uniquely — an inherent limit of the gizmo write-back,
    // not this helper. An axis-aligned child (the common case) round-trips cleanly.
    const parent: TransformTRS = { x: -4, y: 2, z: 7, rx: 0.1, ry: 0.2, rz: 0.3, sx: 2, sy: 3, sz: 0.5 };
    const local: TransformTRS = { x: 1.5, y: -2, z: 0.25, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    const obj = childObjectInWorld(parent, local);
    expectSameTransform(worldToLocalTransform(obj, parent), local);
  });

  it('a wrong (identity) parent inverse would NOT round-trip — guards the actual bug', () => {
    const parent: TransformTRS = { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    const local: TransformTRS = { x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    const obj = childObjectInWorld(parent, local);
    // Passing null (skipping the parent-inverse) returns the WORLD position (x≈11), not local x=1.
    const wrong = worldToLocalTransform(obj, null);
    expect(wrong.x).toBeCloseTo(11, 5);
    expect(wrong.x).not.toBeCloseTo(local.x, 1);
  });
});


/** A scale drag that crosses the pivot must STOP at 0, not mirror the entity — the 3D twin of
 *  Gizmo2D's F9 clamp. Testboard 1Rg36fFvZBdeNmUrtjs7. */
describe('clampScaleCrossingPivot', () => {
  const base: TransformTRS = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
  const positive = { x: 1, y: 1, z: 1 };

  it('passes an ordinary positive scale through untouched', () => {
    const local = { ...base, sx: 2.5, sy: 2.5, sz: 2.5 };
    expect(clampScaleCrossingPivot(local, { x: 2.5, y: 2.5, z: 2.5 }, positive)).toEqual(local);
  });

  it('zeroes ALL THREE axes for a uniform mirror, despite decompose parking the sign on X alone', () => {
    // three applied d = -14.7 to every axis; decompose reports (-14.7, +14.7, +14.7).
    const local = { ...base, sx: -14.7, sy: 14.7, sz: 14.7 };
    const out = clampScaleCrossingPivot(local, { x: -14.7, y: -14.7, z: -14.7 }, positive);
    expect([out.sx, out.sy, out.sz]).toEqual([0, 0, 0]);
  });

  it('zeroes only the axis that flipped on a single-axis drag', () => {
    const local = { ...base, sx: -3, sy: 1, sz: 1 };
    const out = clampScaleCrossingPivot(local, { x: -3, y: 1, z: 1 }, positive);
    expect([out.sx, out.sy, out.sz]).toEqual([0, 1, 1]);
  });

  it('KEEPS an authored negative scale — only a sign change within the drag is caught', () => {
    const local = { ...base, sx: -6, sy: 2, sz: 2 };
    const out = clampScaleCrossingPivot(local, { x: -6, y: 2, z: 2 }, { x: -1, y: 1, z: 1 });
    expect([out.sx, out.sy, out.sz]).toEqual([-6, 2, 2]);
  });

  it('is a no-op when no start sign was captured', () => {
    const local = { ...base, sx: -6, sy: 2, sz: 2 };
    expect(clampScaleCrossingPivot(local, { x: -6, y: 2, z: 2 }, null)).toEqual(local);
  });

  it('leaves rotation and position alone', () => {
    const local = { ...base, x: 3, rx: 0.5, sx: -1, sy: -1, sz: -1 };
    const out = clampScaleCrossingPivot(local, { x: -1, y: -1, z: -1 }, positive);
    expect(out.x).toBe(3);
    expect(out.rx).toBe(0.5);
  });

  // #258 close-out review. `Math.sign(0) === 0`, so an axis that STARTED at 0 differs from every
  // non-zero drag value and was clamped straight back to 0 on every tick — an entity authored
  // hidden (scale 0, the idiom #258 exists to support) could never be dragged back into being.
  // The trap always existed for ROOT entities; #258 widened it to CHILDREN by making the world
  // composition report a collapsed child's scale honestly as 0 instead of the old identity lie.
  it('an axis that started at ZERO can be dragged back out — 0 has no pivot to cross', () => {
    const out = clampScaleCrossingPivot({ ...base, sx: 0.3 }, { x: 0.3, y: 1, z: 1 }, { x: 0, y: 1, z: 1 });
    expect(out.sx).toBe(0.3);
  });

  it('…in the negative direction too, and independently per axis', () => {
    const out = clampScaleCrossingPivot(
      { ...base, sx: -0.4, sy: 2, sz: 3 },
      { x: -0.4, y: -2, z: 3 },
      { x: 0, y: 1, z: 1 },   // x started collapsed; y started positive and has now flipped
    );
    expect(out.sx).toBe(-0.4); // exempt — no side to cross
    expect(out.sy).toBe(0);    // a REAL sign flip is still caught
    expect(out.sz).toBe(3);
  });
});


/** The MULTI-SELECT half of the same rule. A group scale spreads every member's offset from the
 *  pivot by the ratio, so a mirrored frame throws them through it — measured at `sy:3229` and a
 *  member at `(953, 0, -15998)` before the guard. The caller drops such a frame entirely. */
describe('scaleCrossedPivot', () => {
  const positive = { x: 1, y: 1, z: 1 };

  it('is false for an ordinary shrink or grow', () => {
    expect(scaleCrossedPivot({ x: 0.2, y: 0.2, z: 0.2 }, positive)).toBe(false);
    expect(scaleCrossedPivot({ x: 9, y: 9, z: 9 }, positive)).toBe(false);
  });

  it('is true the moment ANY axis changes sign — one mirrored axis is a crossed pivot', () => {
    expect(scaleCrossedPivot({ x: -1, y: -1, z: -1 }, positive)).toBe(true);
    expect(scaleCrossedPivot({ x: -1, y: 1, z: 1 }, positive)).toBe(true);
  });

  // #258 close-out — must agree with clampScaleCrossingPivot's zero exemption. See its doc.
  it('a zero-start axis is not a crossing', () => {
    expect(scaleCrossedPivot({ x: 5, y: 1, z: 1 }, { x: 0, y: 1, z: 1 })).toBe(false);
    expect(scaleCrossedPivot({ x: 5, y: -1, z: 1 }, { x: 0, y: 1, z: 1 })).toBe(true); // y really flipped
  });

  it('respects a selection that STARTED mirrored, so an authored flip is not a crossing', () => {
    const mirrored = { x: -1, y: 1, z: 1 };
    expect(scaleCrossedPivot({ x: -4, y: 4, z: 4 }, mirrored)).toBe(false);
    expect(scaleCrossedPivot({ x: 4, y: 4, z: 4 }, mirrored)).toBe(true);
  });

  it('is false when no start sign was captured — never block a drag on a missing baseline', () => {
    expect(scaleCrossedPivot({ x: -1, y: -1, z: -1 }, null)).toBe(false);
  });
});
