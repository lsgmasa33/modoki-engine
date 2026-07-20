/** Pure editing logic for a Collider2D `points` list (polygon/mesh) — parse, mutate, and
 *  serialize the inline JSON point list in LOCAL collider space (world units, Y-down; same
 *  frame as colliderOutline2D). No rendering / no Rapier dependency, so the on-canvas
 *  collider-mesh editor (SceneView) can drive it and it stays unit-testable.
 *
 *  Points serialize as nested `[[x,y],…]` (the form the editor emits); parsing also accepts
 *  the flat `[x,y,x,y,…]` form for hand-authored lists. A polygon is a closed loop (the last
 *  vertex connects back to the first); a polyline is an open edge chain. */

export interface Pt { x: number; y: number }

/** Lenient parse — returns [] for invalid/empty input (the editor tolerates a mid-edit
 *  empty field; validation of min-count lives at the shape level). */
export function parseColliderPoints(src: string): Pt[] {
  let raw: unknown;
  try { raw = JSON.parse(src); } catch { return []; }
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const pts: Pt[] = [];
  if (Array.isArray(raw[0])) {
    for (const pair of raw as unknown[]) {
      if (!Array.isArray(pair) || pair.length < 2) return [];
      const x = Number(pair[0]); const y = Number(pair[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      pts.push({ x, y });
    }
  } else {
    const flat = raw as unknown[];
    if (flat.length % 2 !== 0) return [];
    for (let i = 0; i < flat.length; i += 2) {
      const x = Number(flat[i]); const y = Number(flat[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      pts.push({ x, y });
    }
  }
  return pts;
}

/** Serialize to nested `[[x,y],…]`, rounding to `dp` decimals to keep the JSON compact and
 *  scene diffs small (sub-pixel precision is meaningless for a collider outline). */
export function serializeColliderPoints(pts: Pt[], dp = 2): string {
  const r = (n: number) => {
    const f = Math.round(n * 10 ** dp) / 10 ** dp;
    return Object.is(f, -0) ? 0 : f;
  };
  return JSON.stringify(pts.map((p) => [r(p.x), r(p.y)]));
}

/** Move vertex `i` to (x,y). Returns a new array (no mutation); out-of-range i is a no-op. */
export function moveVertex(pts: Pt[], i: number, x: number, y: number): Pt[] {
  if (i < 0 || i >= pts.length) return pts;
  const next = pts.slice();
  next[i] = { x, y };
  return next;
}

/** Insert a vertex at array index `index` (clamped to [0,len]). */
export function insertVertex(pts: Pt[], index: number, x: number, y: number): Pt[] {
  const at = Math.max(0, Math.min(index, pts.length));
  const next = pts.slice();
  next.splice(at, 0, { x, y });
  return next;
}

/** Remove vertex `i`, but never drop below `minPoints` (3 for polygon, 2 for polyline) — a
 *  no-op if it would. Returns a new array. */
export function removeVertex(pts: Pt[], i: number, minPoints: number): Pt[] {
  if (i < 0 || i >= pts.length || pts.length <= minPoints) return pts;
  return pts.filter((_, k) => k !== i);
}

/** Closest point on segment a→b to p, plus the squared distance to it. */
function closestOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; distSq: number } {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  const dx = p.x - point.x, dy = p.y - point.y;
  return { point, distSq: dx * dx + dy * dy };
}

/** Find the edge nearest to (x,y) and where a new vertex would be inserted to split it.
 *  `closed` (polygon) also considers the wrap edge last→first. Returns the insertion
 *  index (splice position) + the projected point on that edge, or null for < 2 points. */
export function nearestEdgeInsertion(
  pts: Pt[], x: number, y: number, closed: boolean,
): { index: number; point: Pt; distSq: number } | null {
  if (pts.length < 2) return null;
  const p = { x, y };
  const edges = closed ? pts.length : pts.length - 1;
  let best: { index: number; point: Pt; distSq: number } | null = null;
  for (let i = 0; i < edges; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = closestOnSegment(p, a, b);
    if (!best || c.distSq < best.distSq) best = { index: i + 1, point: c.point, distSq: c.distSq };
  }
  return best;
}

/** Min vertices for a shape's point list (polygon/concave = 3, polyline = 2 for an open
 *  edge chain). Anything else has no editable point list. */
export function minPointsForShape(shape: string): number | null {
  if (shape === 'polygon' || shape === 'concave') return 3;
  if (shape === 'polyline') return 2;
  return null;
}
