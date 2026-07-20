/** Pure geometry for the editor's 2D collider debug overlay — turns a Collider2D's
 *  shape + params into an outline in LOCAL collider space (world units, Y-down, same
 *  frame as Transform). No Rapier / no rendering dependency, so it is unit-tested and
 *  reused by whatever draws it (Scene2D / SceneView). The caller applies the entity's
 *  world transform. Returns null for an unresolvable shape (e.g. bad point list). */

import { parseColliderPoints } from '../scene/colliderPoints';

export type ColliderOutline =
  | { kind: 'circle'; radius: number }
  | { kind: 'capsule'; halfH: number; radius: number }
  | { kind: 'polygon'; points: { x: number; y: number }[] } // closed loop
  | { kind: 'polyline'; points: { x: number; y: number }[] }; // open chain

export interface ColliderShapeParams {
  shape: string;
  radius: number;
  halfW: number;
  halfH: number;
  points: string;
}

/** Signature of the GEOMETRY fields that define a collider's outline/shape (no material).
 *  The single definition shared by render change-detection (colliderOutlineSig) and the
 *  physics reconciler's structural rebuild check (colliderGeomSig on the entity). Pure. */
export function colliderGeomSig(c: ColliderShapeParams): string {
  return `${c.shape}:${c.radius}:${c.halfW}:${c.halfH}:${c.points}`;
}

/** Parse an inline point list ([[x,y],…] or flat [x,y,…]) into world-unit points for drawing
 *  in the ECS frame. Thin wrapper over the shared parser + a min-count gate. Null if < min. */
function parseOutlinePoints(src: string, min: number): { x: number; y: number }[] | null {
  const pts = parseColliderPoints(src);   // shared: [] on invalid
  return pts.length >= min ? pts : null;
}

export function colliderOutline2D(c: ColliderShapeParams): ColliderOutline | null {
  switch (c.shape) {
    case 'circle':
      return c.radius > 0 ? { kind: 'circle', radius: c.radius } : null;
    case 'box': {
      if (c.halfW <= 0 || c.halfH <= 0) return null;
      const { halfW: w, halfH: h } = c;
      return { kind: 'polygon', points: [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }] };
    }
    case 'capsule':
      return c.radius > 0 ? { kind: 'capsule', halfH: c.halfH, radius: c.radius } : null;
    case 'polygon':
    case 'concave': {
      // Both draw as the closed outline of the authored points (concave shows its true
      // concave silhouette; its convex decomposition is a physics-only detail).
      const pts = parseOutlinePoints(c.points, 3);
      return pts ? { kind: 'polygon', points: pts } : null;
    }
    case 'polyline': {
      const pts = parseOutlinePoints(c.points, 2);
      return pts ? { kind: 'polyline', points: pts } : null;
    }
    default:
      return null;
  }
}
