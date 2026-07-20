/** colliderOutline3D — pure builder for a 3D collider WIREFRAME geometry (the editor's collider
 *  gizmo), mirroring the role of colliderOutline2D for 2D. Given a Collider3D's shape + dims it
 *  returns a THREE.BufferGeometry of edges to render as LineSegments; the editor SceneView owns
 *  the LineSegments object, its material, and following the entity's world transform.
 *
 *  Primitives map 1:1 to THREE geometries (built at collider dims, in world units — colliders do
 *  NOT scale with Transform.scale, so the wireframe follows the entity's world position+rotation
 *  only). Mesh-derived shapes (`convex`/`trimesh`) have no analytic form, so the caller passes the
 *  resolved mesh geometry and we edge it. Kept pure (no Rapier, no editor deps) so it's unit-testable
 *  and lives in the shipped runtime/rendering barrel (tree-shaken from games that don't use it). */

import * as THREE from 'three';

export interface ColliderOutline3DParams {
  shape: string;
  radius: number; halfW: number; halfH: number; halfD: number; halfHeight: number;
}

/** Change-detection signature — rebuild the wireframe only when shape/dims change (mesh shapes
 *  also key on the passed geometry's uuid, folded in by the caller). Mirrors colliderGeomSig. */
export function colliderOutlineSig3D(c: ColliderOutline3DParams): string {
  return `${c.shape}:${c.radius}:${c.halfW}:${c.halfH}:${c.halfD}:${c.halfHeight}`;
}

/** Build the wireframe (edges) geometry for a collider, or null if it can't be represented (an
 *  unknown shape, or a mesh shape with no geometry supplied). The caller disposes the returned
 *  geometry when it rebuilds/removes the gizmo. For `convex`/`trimesh` pass the collider's mesh
 *  `THREE.BufferGeometry`. */
export function colliderWireframeGeometry(c: ColliderOutline3DParams, meshGeometry?: THREE.BufferGeometry | null): THREE.BufferGeometry | null {
  let solid: THREE.BufferGeometry | null = null;
  switch (c.shape) {
    case 'box':
      solid = new THREE.BoxGeometry(c.halfW * 2, c.halfH * 2, c.halfD * 2);
      break;
    case 'sphere':
      solid = new THREE.SphereGeometry(Math.max(1e-4, c.radius), 16, 12);
      break;
    case 'cylinder':
      solid = new THREE.CylinderGeometry(c.radius, c.radius, c.halfHeight * 2, 20);
      break;
    case 'cone':
      solid = new THREE.ConeGeometry(c.radius, c.halfHeight * 2, 20);
      break;
    // THREE CapsuleGeometry(radius, length): length is the cylinder segment (= 2×halfHeight).
    case 'capsule':
      solid = new THREE.CapsuleGeometry(c.radius, c.halfHeight * 2, 6, 12);
      break;
    case 'convex':
    case 'trimesh':
      if (!meshGeometry) return null;
      // The collider IS the mesh — edge the resolved geometry directly (already mesh-local).
      return new THREE.EdgesGeometry(meshGeometry, 1);
    default:
      return null;
  }
  const edges = new THREE.EdgesGeometry(solid, 1);
  solid.dispose();   // only the edge lines are kept
  return edges;
}
