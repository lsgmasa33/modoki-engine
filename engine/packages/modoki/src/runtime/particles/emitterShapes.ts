/**
 * Emitter-shape geometry — pure, allocation-light math shared by the CPU simulator and the
 * GPU compute backend (which uploads the resolved form as uniforms). Mirrors the role of
 * colliders.ts for collision: `resolveShape` flattens the authoring {@link EmitterShape} into
 * a runtime form (annulus inner/outer radii, cylinder orthonormal basis, box shell extents)
 * so both backends sample the same way and old assets keep working without migration.
 *
 * The per-particle sampling itself lives in each backend (plain JS in cpuSimulator, TSL in
 * gpuComputeBackend) but uses the SAME formulas so the look matches:
 * - disc shapes (cone/circle/cylinder cross-section): `r = sqrt(mix(in², out², u))`
 * - sphere volume: `r = cbrt(mix(in³, out³, u))`
 * These reduce to the legacy `radius·sqrt(u)` / `radius·cbrt(u)` solid fill when `inner = 0`,
 * and to exactly `radius` (a thin shell) when `inner = outer` (legacy `fromShell`).
 */

import type { EmitterShape, EmitterShapeType } from './types';

/** Runtime form of an {@link EmitterShape} — defaults filled, cylinder basis precomputed. */
export interface ResolvedShape {
  type: EmitterShapeType;
  /** annulus inner/outer radius (cone/sphere/circle/cylinder) */
  innerR: number;
  outerR: number;
  /** cone half-angle, radians */
  angle: number;
  /** cylinder full length along the axis */
  length: number;
  /** cylinder unit axis */
  ax: number; ay: number; az: number;
  /** cylinder cross-section basis: two unit vectors perpendicular to the axis and each other */
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  /** box: true = hollow frame between inHalf and outHalf; false = solid fill of outHalf */
  boxShell: boolean;
  inHalf: [number, number, number];
  outHalf: [number, number, number];
  /** polyline (2D): flattened local-XY points `[x0,y0,x1,y1,…]`. Empty for non-polyline shapes. */
  poly: number[];
  /** polyline: cumulative arc length at the END of each segment (`polyCum[k]` = summed length of
   *  segments 0..k, where segment k joins point k→k+1). Length = pointCount−1. */
  polyCum: number[];
  /** polyline: total arc length (`polyCum`'s last entry, or 0). */
  polyLen: number;
}

/**
 * Build an orthonormal basis `(a, u, v)` from an arbitrary (possibly non-unit) axis. `a` is the
 * normalized axis; `u`, `v` are unit vectors spanning the plane perpendicular to it. The helper
 * vector is the X axis, swapped to Y when the axis is nearly parallel to X (so the cross product
 * never degenerates). Pure — returns plain numbers, no allocation beyond the result object.
 */
export function perpBasis(axis: [number, number, number]): {
  ax: number; ay: number; az: number;
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
} {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const ax = axis[0] / len, ay = axis[1] / len, az = axis[2] / len;
  // helper not parallel to the axis
  const hx = Math.abs(ax) < 0.9 ? 1 : 0;
  const hy = Math.abs(ax) < 0.9 ? 0 : 1;
  const hz = 0;
  // u = normalize(helper × a)
  let ux = hy * az - hz * ay;
  let uy = hz * ax - hx * az;
  let uz = hx * ay - hy * ax;
  const ulen = Math.hypot(ux, uy, uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  // v = a × u (already unit length: |a|=|u|=1 and a⊥u)
  const vx = ay * uz - az * uy;
  const vy = az * ux - ax * uz;
  const vz = ax * uy - ay * ux;
  return { ax, ay, az, ux, uy, uz, vx, vy, vz };
}

export function resolveShape(s: EmitterShape): ResolvedShape {
  const outerR = s.radiusEnd ?? s.radius ?? 1;
  const innerR = s.radiusStart ?? (s.fromShell ? outerR : 0);
  const basis = perpBasis(s.axis ?? [0, 1, 0]);
  const outHalf = s.sizeEnd ?? s.size ?? [1, 1, 1];
  const inHalf = s.sizeStart ?? [0, 0, 0];
  const boxShell = !!s.sizeStart && (inHalf[0] > 0 || inHalf[1] > 0 || inHalf[2] > 0);

  // polyline: flatten finite [x,y] points and precompute cumulative arc length so the sim can
  // sample uniformly by length (long segments get proportionally more particles). Non-finite
  // points are dropped defensively (normalizeParticleDef already filters, but resolveShape is
  // also called directly in tests / on raw defs).
  const poly: number[] = [];
  const polyCum: number[] = [];
  let polyLen = 0;
  if (s.type === 'polyline' && s.points) {
    for (const p of s.points) {
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) poly.push(p[0], p[1]);
    }
    const n = poly.length / 2;
    for (let k = 0; k + 1 < n; k++) {
      polyLen += Math.hypot(poly[(k + 1) * 2] - poly[k * 2], poly[(k + 1) * 2 + 1] - poly[k * 2 + 1]);
      polyCum.push(polyLen);
    }
  }

  return {
    type: s.type,
    innerR, outerR,
    angle: ((s.angle ?? 25) * Math.PI) / 180,
    length: s.length ?? 1,
    ...basis,
    boxShell,
    inHalf: [inHalf[0], inHalf[1], inHalf[2]],
    outHalf: [outHalf[0], outHalf[1], outHalf[2]],
    poly, polyCum, polyLen,
  };
}

/**
 * Sample a point on a resolved polyline at arc-length fraction `u ∈ [0,1]`, writing XY into the
 * caller-owned `out` (allocation-free). Uniform by arc length: the segment containing `u·polyLen`
 * is found, then lerped within. Degenerate cases are safe — no points → origin; one point or
 * zero total length → the first point. Pure; the risky spawn math, unit-tested in isolation.
 */
export function samplePolyline(rs: ResolvedShape, u: number, out: { x: number; y: number }): void {
  const poly = rs.poly;
  const n = poly.length / 2;
  if (n === 0) { out.x = 0; out.y = 0; return; }
  if (n === 1 || rs.polyLen <= 0) { out.x = poly[0]; out.y = poly[1]; return; }
  const target = Math.min(Math.max(u, 0), 1) * rs.polyLen;
  const cum = rs.polyCum;
  // first segment whose cumulative end-length reaches `target` (last segment absorbs u=1).
  let seg = 0;
  while (seg < cum.length - 1 && cum[seg] < target) seg++;
  const segStart = seg === 0 ? 0 : cum[seg - 1];
  const segLen = cum[seg] - segStart;
  const f = segLen > 0 ? (target - segStart) / segLen : 0;
  const ax = poly[seg * 2], ay = poly[seg * 2 + 1];
  const bx = poly[(seg + 1) * 2], by = poly[(seg + 1) * 2 + 1];
  out.x = ax + (bx - ax) * f;
  out.y = ay + (by - ay) * f;
}
