/** On-canvas collider-mesh editing helpers (Phase 4.3) — the geometry the 2D SceneView
 *  uses to draw + drag polygon/polyline collider vertices. Kept out of the big SceneView
 *  component so the world↔local point math and vertex picking stay unit-testable.
 *
 *  A collider's `points` are in the entity's LOCAL frame (world units, Y-down); the
 *  handles are drawn by mapping each point through the entity's world Transform, and a
 *  pointer position is mapped back to local before editing the list. */

import type { Pt } from '../../runtime/scene/colliderPoints';
import { parseColliderPoints, minPointsForShape } from '../../runtime/scene/colliderPoints';
import { colliderOutline2D, type ColliderShapeParams } from '../../runtime/rendering/colliderOutline2D';

/** Origin-centered AABB half-extents that fully contain a collider's outline — used to
 *  click-pick a `sprite:'collider'` entity by its actual shape (not the Renderable2D
 *  width/height). Symmetric about the entity origin (a superset for off-center shapes),
 *  which is fine for hit-testing. Null if the shape has no outline. */
export function colliderPickHalfExtents(c: ColliderShapeParams): { halfW: number; halfH: number } | null {
  const o = colliderOutline2D(c);
  if (!o) return null;
  if (o.kind === 'circle') return { halfW: o.radius, halfH: o.radius };
  if (o.kind === 'capsule') return { halfW: o.radius, halfH: o.halfH + o.radius };
  let halfW = 0, halfH = 0;
  for (const p of o.points) { halfW = Math.max(halfW, Math.abs(p.x)); halfH = Math.max(halfH, Math.abs(p.y)); }
  return halfW > 0 && halfH > 0 ? { halfW, halfH } : null;
}

/** A 2D world transform (the composed getWorldTransform2D result). */
export interface WT { x: number; y: number; rz: number; sx: number; sy: number }

/** Local collider-space point → world/reference space (apply scale, rotate, translate). */
export function localToWorld(p: Pt, wt: WT): Pt {
  const sx = p.x * wt.sx, sy = p.y * wt.sy;
  const c = Math.cos(wt.rz), s = Math.sin(wt.rz);
  return { x: wt.x + sx * c - sy * s, y: wt.y + sx * s + sy * c };
}

/** World/reference point → local collider space (inverse of localToWorld). A zero scale
 *  axis maps to 0 on that axis (avoids divide-by-zero; a degenerate collider anyway). */
export function worldPointToLocal(px: number, py: number, wt: WT): Pt {
  const dx = px - wt.x, dy = py - wt.y;
  const c = Math.cos(-wt.rz), s = Math.sin(-wt.rz);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  return { x: wt.sx ? rx / wt.sx : 0, y: wt.sy ? ry / wt.sy : 0 };
}

export interface ColliderEditInfo { points: Pt[]; min: number; closed: boolean }

/** If the collider data has an editable point list (polygon/polyline/concave), return its parsed
 *  points + minimum count + whether it's a closed loop. Null for box/circle/capsule. */
export function colliderEditInfo(data: { shape: string; points: string }): ColliderEditInfo | null {
  const min = minPointsForShape(data.shape);
  if (min == null) return null;
  const closed = data.shape === 'polygon' || data.shape === 'concave';
  return { points: parseColliderPoints(data.points), min, closed };
}

/** Index of the vertex within `threshold` (local units) of `local`, nearest wins, or -1. */
export function pickVertex(local: Pt, points: Pt[], threshold: number): number {
  let best = -1;
  let bestD = threshold * threshold;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - local.x, dy = points[i].y - local.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}
