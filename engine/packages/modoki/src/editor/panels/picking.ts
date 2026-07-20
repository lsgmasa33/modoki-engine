/** SceneView object picking — pure hit-test logic, decoupled from React/event handlers.
 *
 * Both functions are deliberately free of ECS/DOM access so they can be unit-tested
 * headlessly: the caller gathers candidate data (2D) or a mesh→entity map (3D) and
 * passes plain values in. Three.js `Raycaster` is pure math and needs no GPU. */

import * as THREE from 'three';

// ── 2D AABB picking ──

/** One pickable 2D entity, pre-resolved to world space by the caller. */
export interface Pick2DCandidate {
  id: number;
  /** World-space center-of-transform position (anchor before pivot offset). */
  wx: number;
  wy: number;
  /** World-space scale (sign matters; magnitude used for extents). */
  wsx: number;
  wsy: number;
  /** Local unscaled size. */
  width: number;
  height: number;
  /** Pivot in [0,1]; 0.5 = centered. Defaults applied by caller. */
  pivotX: number;
  pivotY: number;
  /** Global paint index (higher = painted later = visually on top). When
   *  provided, the topmost hit wins, so clicks select what's drawn on top —
   *  matching the paint order. Ties (or when omitted) fall back to the
   *  closest-center heuristic. */
  order?: number;
}

/**
 * Pick the topmost 2D entity whose axis-aligned bounding box contains (px, py).
 * "Topmost" = highest paint `order` (last painted, visually on top); equal
 * orders — or candidates with no order — fall back to closest box-center,
 * matching the original inline SceneView behavior.
 *
 * @returns the winning entity id, or null if nothing is hit.
 */
export function pick2D(px: number, py: number, candidates: readonly Pick2DCandidate[]): number | null {
  let bestId: number | null = null;
  let bestOrder = -Infinity;
  let bestDist = Infinity;
  for (const c of candidates) {
    const hw = c.width * Math.abs(c.wsx);
    const hh = c.height * Math.abs(c.wsy);
    // Pivot shifts the AABB center: pivot 0 → center at +hw, pivot 1 → center at -hw
    const cx = c.wx + hw * (1 - 2 * c.pivotX);
    const cy = c.wy + hh * (1 - 2 * c.pivotY);
    const dx = px - cx;
    const dy = py - cy;
    if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
      const order = c.order ?? 0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (order > bestOrder || (order === bestOrder && dist < bestDist)) {
        bestOrder = order;
        bestDist = dist;
        bestId = c.id;
      }
    }
  }
  return bestId;
}

// ── 3D raycast picking ──

/** A scene object tracked against an entity id (mesh, GLB LOD/group, or gizmo). */
export interface Pick3DEntry {
  id: number;
  object: THREE.Object3D;
}

/**
 * Raycast from normalized device coordinates (NDC, both in [-1, 1]) through the
 * camera and resolve the closest hit to a tracked entity.
 *
 * GLB models are stored as a THREE.LOD/group whose raycast hit is a nested child
 * mesh, not the tracked object — so we walk up from the hit object and return the
 * first ancestor that matches a tracked entry. `entries` order is the tie-break at
 * a given ancestor level (caller lists meshes before gizmos to match prior behavior).
 *
 * @returns the winning entity id, or null if nothing is hit.
 */
export function pick3D(
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  entries: readonly Pick3DEntry[],
  raycaster: THREE.Raycaster = new THREE.Raycaster(),
): number | null {
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const intersects = raycaster.intersectObjects(
    entries.map((e) => e.object),
    true,
  );
  if (intersects.length === 0) return null;

  let cur: THREE.Object3D | null = intersects[0].object;
  while (cur) {
    for (const entry of entries) {
      if (entry.object === cur) return entry.id;
    }
    cur = cur.parent;
  }
  return null;
}
