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

  _childWorld.decompose(_outPos, _outQuat, _outScale);
  _outEuler.setFromQuaternion(_outQuat);
  return {
    x: _outPos.x, y: _outPos.y, z: _outPos.z,
    rx: _outEuler.x, ry: _outEuler.y, rz: _outEuler.z,
    sx: _outScale.x, sy: _outScale.y, sz: _outScale.z,
  };
}
