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

/** Scale an already-parsed outline by the collider entity's WORLD scale, mirroring the
 *  approximation physics2DSystem's `makeColliderDesc` applies to the LIVE Rapier collider: a
 *  circle's radius uses the mean of |sx|,|sy| (can't represent an ellipse); a capsule's radius
 *  likewise, but its half-height scales by |sy| alone (matches `* ay` there); polygon/polyline
 *  points scale per-axis with the SIGNED sx/sy (matches `scalePointsInPlace`, so a mirrored/
 *  negative scale flips the outline the same way it flips the live collider).
 *
 *  Used only by the DEBUG overlay draw paths (`drawColliderOutlineGfx`/`drawColliderOutline`) —
 *  `colliderOutline2D` itself stays unscaled for editing (colliderEdit2D, which operates in
 *  local collider space) and the collider-as-placeholder-sprite fill path (which gets scale for
 *  free from its own Pixi container transform). Without this the debug overlay stayed at its
 *  authored (unscaled) size regardless of Transform.scale, so a scaled floor/wall's TRUE (much
 *  larger) collider silently rendered small, buried inside or detached from the visual mesh —
 *  the 2D counterpart of the 3D wireframe bug (see colliderWorldScale3D). */
export function scaleColliderOutline2D(o: ColliderOutline, sx: number, sy: number): ColliderOutline {
  if (sx === 1 && sy === 1) return o;
  const ax = Math.abs(sx), ay = Math.abs(sy);
  switch (o.kind) {
    case 'circle': {
      const r = (ax + ay) / 2;
      return { kind: 'circle', radius: o.radius * r };
    }
    case 'capsule': {
      const r = (ax + ay) / 2;
      return { kind: 'capsule', radius: o.radius * r, halfH: o.halfH * ay };
    }
    case 'polygon':
    case 'polyline':
      return { kind: o.kind, points: o.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
  }
}
