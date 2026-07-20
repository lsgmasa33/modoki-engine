/** meshColliderGeometry — pure helpers to turn a THREE.BufferGeometry into the flat typed
 *  arrays Rapier's mesh colliders need, plus the Rapier desc builders for the mesh-derived
 *  Collider3D shapes (`convex`, `trimesh`). Kept out of physics3DSystem so the extraction is
 *  unit-testable without a Rapier world, and the desc builder takes the Rapier module as a
 *  param (no static Rapier import here).
 *
 *  Robustness (GLTFLoader geometry can bite you):
 *   - positions may be an InterleavedBufferAttribute (strided) — read via accessors, not `.array`.
 *   - the index may be Uint16 (Rapier requires Uint32) or absent (non-indexed triangle soup).
 *
 *  Scale: collider vertices are baked at the entity's Transform.scale so a mesh collider matches
 *  the scaled render mesh (Rapier bodies have no scale; the shape carries it). The geometry is in
 *  mesh-LOCAL space, which is exactly the body-local frame a collider wants. */

import type * as THREE from 'three';

/** A minimal view of the Rapier module's ColliderDesc — just what the mesh builders call. */
interface RapierLike {
  ColliderDesc: {
    convexHull(points: Float32Array): unknown | null;
    trimesh(vertices: Float32Array, indices: Uint32Array, flags?: number): unknown;
  };
  TriMeshFlags?: { MERGE_DUPLICATE_VERTICES: number; DELETE_DEGENERATE_TRIANGLES: number; FIX_INTERNAL_EDGES: number };
}

/** Flat `[x,y,z,…]` positions, scaled by (sx,sy,sz). Robust to interleaved / non-Float32 storage.
 *  Always returns a FRESH array when scaling is applied (safe for Rapier to copy). */
export function colliderPositions(geometry: THREE.BufferGeometry, sx = 1, sy = 1, sz = 1): Float32Array {
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = pos.getX(i) * sx;
    out[i * 3 + 1] = pos.getY(i) * sy;
    out[i * 3 + 2] = pos.getZ(i) * sz;
  }
  return out;
}

/** Flat Uint32 triangle index. Synthesizes 0..n-1 for non-indexed geometry; widens Uint16→Uint32. */
export function colliderIndices(geometry: THREE.BufferGeometry): Uint32Array {
  const idx = geometry.index;
  if (!idx) {
    const triVerts = geometry.getAttribute('position').count; // non-indexed → identity index
    const out = new Uint32Array(triVerts);
    for (let i = 0; i < triVerts; i++) out[i] = i;
    return out;
  }
  const arr = idx.array;
  if (arr instanceof Uint32Array) return arr;
  const out = new Uint32Array(arr.length);
  out.set(arr);   // element-wise widening copy (Uint16/Uint8 → Uint32)
  return out;
}

/** Box half-extents (world units) from a geometry's bounding box, scaled by Transform.scale.
 *  For the fit-to-bounds editor action. */
export function geometryBoxHalfExtents(geometry: THREE.BufferGeometry, sx = 1, sy = 1, sz = 1): { x: number; y: number; z: number } {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  return {
    x: Math.abs(bb.max.x - bb.min.x) * 0.5 * Math.abs(sx),
    y: Math.abs(bb.max.y - bb.min.y) * 0.5 * Math.abs(sy),
    z: Math.abs(bb.max.z - bb.min.z) * 0.5 * Math.abs(sz),
  };
}

/** Bounding-sphere radius (world units) from a geometry, scaled by the max scale component. */
export function geometryBoundingRadius(geometry: THREE.BufferGeometry, sx = 1, sy = 1, sz = 1): number {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return geometry.boundingSphere!.radius * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz));
}

/** Build the Rapier ColliderDesc(s) for a mesh-derived shape from a geometry, baking in scale.
 *  `convex` → one convex-hull desc (dynamic-safe; null if the hull degenerates). `trimesh` →
 *  one triangle-mesh desc (STATIC only — no interior). Returns null if the shape is unknown or
 *  the hull fails. `R` is the Rapier module (passed so this stays Rapier-import-free + testable). */
export function buildMeshColliderDescs(
  R: RapierLike, geometry: THREE.BufferGeometry, shape: 'convex' | 'trimesh', sx = 1, sy = 1, sz = 1,
): unknown[] | null {
  const positions = colliderPositions(geometry, sx, sy, sz);
  if (shape === 'convex') {
    const d = R.ColliderDesc.convexHull(positions);
    return d ? [d] : null;
  }
  // trimesh — recommended cleanup flags for arbitrary imported geometry.
  const flags = R.TriMeshFlags
    ? (R.TriMeshFlags.MERGE_DUPLICATE_VERTICES | R.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES | R.TriMeshFlags.FIX_INTERNAL_EDGES)
    : undefined;
  return [R.ColliderDesc.trimesh(positions, colliderIndices(geometry), flags)];
}
