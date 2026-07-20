/** Built-in primitive mesh geometries.
 *  When Renderable.mesh matches a primitive name, the renderer uses
 *  Three.js built-in geometry instead of loading from a GLB. */

import * as THREE from 'three';

const PRIMITIVES: Record<string, (size: number) => THREE.BufferGeometry> = {
  'cube':     (s) => new THREE.BoxGeometry(s, s, s),
  'box':      (s) => new THREE.BoxGeometry(s, s, s),
  'sphere':   (s) => new THREE.SphereGeometry(s / 2, 32, 16),
  'cylinder': (s) => new THREE.CylinderGeometry(s / 2, s / 2, s, 32),
  'cone':     (s) => new THREE.ConeGeometry(s / 2, s, 32),
  'plane':    (s) => new THREE.PlaneGeometry(s, s),
  'torus':    (s) => new THREE.TorusGeometry(s / 2, s / 6, 16, 48),
  'capsule':  (s) => new THREE.CapsuleGeometry(s / 4, s / 2, 8, 16),
};

/** List of available primitive names */
export const PRIMITIVE_NAMES = Object.keys(PRIMITIVES);

/** Check if a mesh name is a built-in primitive */
export function isPrimitive(meshName: string): boolean {
  return Object.hasOwn(PRIMITIVES, meshName);
}

/** Create a Three.js mesh for a primitive. If `skipDefaultMaterial` is true,
 *  the mesh is returned with a throwaway material reference that the caller
 *  is expected to replace immediately — useful when an override material is
 *  already known so we avoid alloc+dispose churn. */
export function createPrimitiveMesh(meshName: string, size: number, color: number, skipDefaultMaterial = false): THREE.Mesh | null {
  const factory = PRIMITIVES[meshName];
  if (!factory) return null;
  const geo = factory(size);
  // We always need *some* material for THREE.Mesh; use a shared sentinel when
  // caller will overwrite it. The sentinel must never be disposed.
  const mat = skipDefaultMaterial
    ? _placeholderMaterial
    : new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
  return new THREE.Mesh(geo, mat);
}

const _placeholderMaterial = new THREE.MeshBasicMaterial({ visible: false });
