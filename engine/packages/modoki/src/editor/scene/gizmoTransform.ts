/**
 * gizmoTransform — pure world↔local conversion for the 3D TransformControls gizmo.
 *
 * The gizmo mesh lives in WORLD space, so when the user drags a *parented* entity
 * we must invert the parent's world transform to recover the child's LOCAL TRS
 * before writing it back to the `Transform` trait. This was previously inlined in
 * `SceneView.tsx`'s 920-line effect with no test (engine-review C2 / sceneview F4).
 *
 * Extracted here as a pure function so the parented-gizmo round-trip is unit-testable
 * (compose parent⊗localChild → childWorld, then `worldToLocalTransform` must recover
 * localChild). Uses its OWN scratch objects — it does not touch SceneView's shared
 * `_svP*` temporaries.
 */
import * as THREE from 'three';
import { decomposeTrs } from '../../runtime/core/ecs/decomposeTrs';

/** A transform expressed as translation/rotation(Euler XYZ)/scale, matching the `Transform` trait. */
export interface TransformTRS {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
}

/** Minimal THREE-like child handle (an `Object3D` satisfies this). */
export interface ChildWorldObject {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
}

const _childWorld = new THREE.Matrix4();
const _parentInv = new THREE.Matrix4();
const _pPos = new THREE.Vector3();
const _pQuat = new THREE.Quaternion();
const _pScale = new THREE.Vector3();
const _pEuler = new THREE.Euler();
const _outPos = new THREE.Vector3();
const _outQuat = new THREE.Quaternion();
const _outScale = new THREE.Vector3();
const _outEuler = new THREE.Euler();
const _childQuat = new THREE.Quaternion();

/**
 * Convert a child object's current WORLD transform into LOCAL TRS relative to
 * `parentWorld`. When `parentWorld` is null/undefined the child is a root entity
 * and its world transform IS its local transform (returned as-is, decomposed).
 *
 * Caveat (inherent, not a bug): a NON-UNIFORMLY-scaled parent applied to a ROTATED
 * child produces a sheared world matrix, which Matrix4.decompose cannot reduce back
 * to clean TRS. That combination won't round-trip exactly — same as the prior inline
 * gizmo code. Translation/rotation parents and axis-aligned children are exact.
 */
export function worldToLocalTransform(
  child: ChildWorldObject,
  parentWorld: TransformTRS | null | undefined,
): TransformTRS {
  _childWorld.compose(child.position, _childQuat.setFromEuler(child.rotation), child.scale);

  if (parentWorld) {
    _pPos.set(parentWorld.x, parentWorld.y, parentWorld.z);
    _pQuat.setFromEuler(_pEuler.set(parentWorld.rx, parentWorld.ry, parentWorld.rz));
    _pScale.set(parentWorld.sx, parentWorld.sy, parentWorld.sz);
    _parentInv.compose(_pPos, _pQuat, _pScale).invert();
    _childWorld.premultiply(_parentInv);
  }

  decomposeTrs(_childWorld, _outPos, _outQuat, _outScale); // singular-safe — see #258
  _outEuler.setFromQuaternion(_outQuat);
  return {
    x: _outPos.x, y: _outPos.y, z: _outPos.z,
    rx: _outEuler.x, ry: _outEuler.y, rz: _outEuler.z,
    sx: _outScale.x, sy: _outScale.y, sz: _outScale.z,
  };
}

/** Signs of a scale triple at drag start — 0 for an axis that started at 0. */
export interface ScaleSigns { x: number; y: number; z: number }

/** Drag the scale gizmo far enough and the pointer crosses the pivot; three.js reads that as a
 *  MIRROR and takes the scale negative (`TransformControls.js`: `if (pointEnd.dot(pointStart) < 0)
 *  d *= -1`, and the per-axis branch's component divide does the same). The 2D gizmo already ruled
 *  against that — `Gizmo2D`'s F9 clamps each ratio to >= 0 so crossing the pivot stops at 0 instead
 *  of silently mirroring the entity — and 2D and 3D should not disagree about what the same gesture
 *  means. So: an axis whose sign flipped during the drag lands on 0.
 *
 *  The signs are read from the OBJECT's scale, not from the decomposed local TRS, and that matters:
 *  `Matrix4.decompose()` cannot represent a reflection in a TRS triple, so it parks the whole
 *  negative determinant on X. A uniform mirror therefore decomposes to `(-s, +s, +s)` — which is
 *  how testboard 1Rg36fFvZBdeNmUrtjs7 came to read as "the CENTER handle produces a NON-uniform,
 *  sign-flipped scale on one axis". It is one mirror, not a per-axis asymmetry; measured
 *  2026-08-19, and it reproduces from an ordinary camera, not the near-degenerate one that report
 *  suspected.
 *
 *  An entity AUTHORED with a negative scale keeps it: only a sign CHANGE within the drag is caught.
 *
 *  ⚠️ **An axis that STARTED at exactly 0 is left alone** (`startSign` component 0), and that
 *  exemption is load-bearing rather than tidy-up. `Math.sign(0) === 0`, so without it EVERY
 *  non-zero drag value differs from the start sign and the axis is clamped straight back to 0 on
 *  every tick — the entity looks like it grows during the drag (TransformControls mutates the
 *  object directly) and snaps back to invisible on mouse-up. There is no pivot to cross from 0:
 *  a flip needs two non-zero signs, and 0 has no side. Found in the #258 close-out review: the
 *  trap always existed for ROOT entities (their world scale is their local scale), and #258 made
 *  it reachable for CHILDREN too by fixing the world composition that used to report a collapsed
 *  child's scale as 1. Scaling to zero is a supported authoring idiom for "hidden", so being
 *  unable to drag back out of it is exactly the workflow that must keep working.
 */
export function clampScaleCrossingPivot(local: TransformTRS, objScale: { x: number; y: number; z: number }, startSign: ScaleSigns | null): TransformTRS {
  if (!startSign) return local;
  return {
    ...local,
    sx: startSign.x !== 0 && Math.sign(objScale.x) !== startSign.x ? 0 : local.sx,
    sy: startSign.y !== 0 && Math.sign(objScale.y) !== startSign.y ? 0 : local.sy,
    sz: startSign.z !== 0 && Math.sign(objScale.z) !== startSign.z ? 0 : local.sz,
  };
}

/** Did this frame of a scale drag cross the pivot — i.e. has any axis changed sign since the press?
 *
 *  The MULTI-SELECT path needs the question rather than the clamp. There the drag scales every
 *  member's OFFSET from the group pivot as well as its scale, so a mirrored frame does not merely
 *  invert a scale: it throws the members through the pivot and out the other side. Measured
 *  2026-08-19 on games/anim-bug — one 200x150 px drag past the pivot on a two-entity selection left
 *  `Sun` at `sx:-600, sy:3229, sz:2291` and moved `Sphere` to `(953, 0, -15998)`. Clamping the
 *  scale alone would leave those positions. The caller drops the whole frame instead, which stops
 *  the drag at its last valid state — the same "crossing the pivot stops, it does not mirror" rule
 *  `Gizmo2D`'s F9 sets for 2D and `clampScaleCrossingPivot` sets for a single entity. */
export function scaleCrossedPivot(objScale: { x: number; y: number; z: number }, startSign: ScaleSigns | null): boolean {
  if (!startSign) return false;
  // Same zero exemption as clampScaleCrossingPivot — see its doc comment. An axis that started at
  // 0 has no side to cross, and treating `Math.sign(0)` as a real sign would report EVERY drag as
  // a pivot crossing. The group path currently resets its proxy to (1,1,1) before each attach so
  // it cannot hit this today; the two helpers must still agree, or a later change that stops
  // resetting the proxy reintroduces the bug in the half nobody looked at.
  return (startSign.x !== 0 && Math.sign(objScale.x) !== startSign.x)
    || (startSign.y !== 0 && Math.sign(objScale.y) !== startSign.y)
    || (startSign.z !== 0 && Math.sign(objScale.z) !== startSign.z);
}
