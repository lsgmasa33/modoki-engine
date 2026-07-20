/** Pure coordinate + edit math for the particle CurveEditor (extracted for testability).
 *  The editor maps t,v ∈ [0,1] to/from SVG pixel space with a fixed PAD inset, and edits a
 *  point under endpoint-t-lock + interior-clamp-between-neighbours rules. */

import type { Curve, CurvePoint } from '@modoki/engine/runtime';

export const PAD = 8;

/** A flat 0→1 curve — the editor's fallback when a def has no curve yet. */
export const DEFAULT_CURVE_POINTS: CurvePoint[] = [{ t: 0, v: 1 }, { t: 1, v: 1 }];

/** Build the next curve def after a POINTS edit, preserving every other field of the
 *  prior curve — crucially `scale`, which the runtime sampler multiplies points by.
 *  Rebuilding as `{ points }` alone silently wiped an authored scale (anim-particle F1). */
export function withCurvePoints(prev: Curve | undefined, points: CurvePoint[]): Curve {
  return { ...prev, points };
}

/** Build the next curve def after a SCALE edit, preserving the prior points (or a flat
 *  default when the def had no curve yet). Lets the author push a particle past its base
 *  size while keeping the curve shape normalized in 0..1. */
export function withCurveScale(prev: Curve | undefined, scale: number): Curve {
  return { points: prev?.points ?? DEFAULT_CURVE_POINTS, ...prev, scale };
}

/** Client px → curve-space (t, v), clamped to [0,1]. `rect` is the SVG bounding box. */
export function toLocal(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { t: number; v: number } {
  const w = rect.width - PAD * 2;
  const h = rect.height - PAD * 2;
  const t = Math.max(0, Math.min(1, (clientX - rect.left - PAD) / w));
  const v = Math.max(0, Math.min(1, 1 - (clientY - rect.top - PAD) / h));
  return { t, v };
}

/** Curve-space t → SVG x (width `w`, PAD inset). */
export const curveX = (t: number, w: number) => PAD + t * (w - PAD * 2);
/** Curve-space v → SVG y (height `h`, PAD inset; v inverted). */
export const curveY = (v: number, h: number) => PAD + (1 - v) * (h - PAD * 2);

/** Apply a drag of point `i` to `(t, v)` under the editor's rules: index 0 locks t=0,
 *  the last index locks t=1, interior points clamp t strictly between their neighbours.
 *  `pts` must be sorted by t. Returns a NEW sorted-stable array (does not re-sort). */
export function editPoint(pts: CurvePoint[], i: number, t: number, v: number): CurvePoint[] {
  const next = pts.map((p) => ({ ...p }));
  if (i === 0) next[0] = { t: 0, v };
  else if (i === next.length - 1) next[i] = { t: 1, v };
  else {
    const lo = next[i - 1].t + 0.001;
    const hi = next[i + 1].t - 0.001;
    next[i] = { t: Math.max(lo, Math.min(hi, t)), v };
  }
  return next;
}
