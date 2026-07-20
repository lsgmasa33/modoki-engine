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
