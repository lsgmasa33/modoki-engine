/** Convex decomposition for DYNAMIC concave collider shapes (Phase 4.4). Rapier's dynamic
 *  colliders must be convex (a non-convex collider has no interior mass), so a genuine
 *  concave solid (cup, L-beam, star) is built as a COMPOUND of convex pieces. This module
 *  turns a Collider2D `points` list into those pieces using poly-decomp (Bayazit — a
 *  deterministic algorithm, no RNG, so it doesn't trip the determinism guard).
 *
 *  Input points are in world units, Y-down (the ECS/Collider frame); output pieces are in
 *  Rapier meters, Y-up (scaled by 1/ppm + Y-flip). Winding is irrelevant downstream — each
 *  piece feeds Rapier `convexHull`, which recomputes the hull. */

import { makeCCW, quickDecomp, isSimple, removeDuplicatePoints, type Polygon } from 'poly-decomp-es';
import { parseColliderPoints } from '../scene/colliderPoints';
import { ptsToPhysFloat32 } from './physics2DConvert';

/** Decompose a concave `points` string into convex pieces, each a flat physics-space
 *  Float32Array [x0,y0,x1,y1,…]. Returns null if the list is unusable (too few points,
 *  self-intersecting, or decomposition produced nothing) — the caller then falls back to
 *  a single convex hull so the body still gets a collider. */
export function decomposeConcaveToPhys(pointsStr: string, ppm: number): Float32Array[] | null {
  const pts = parseColliderPoints(pointsStr);
  if (pts.length < 4) return null;                 // <4 can't be concave — let the hull path handle it
  const poly: Polygon = pts.map((p) => [p.x, p.y]);
  removeDuplicatePoints(poly, 1e-6);
  if (poly.length < 4) return null;
  if (!isSimple(poly)) return null;                // self-intersecting — not decomposable
  makeCCW(poly);
  const pieces = quickDecomp(poly);
  if (!pieces || pieces.length === 0) return null;
  const out: Float32Array[] = [];
  for (const piece of pieces) {
    if (piece.length < 3) continue;
    // Route the ÷ppm + Y-flip through the shared packer (one home for that mapping).
    out.push(ptsToPhysFloat32(piece.map(([x, y]) => ({ x, y })), ppm));
  }
  return out.length > 0 ? out : null;
}
