/**
 * Pure sampling helpers for the particle schema — no THREE, no GPU, fully unit-testable.
 * Used by the CPU simulator to evaluate over-life modifiers and spawn values.
 */

import type { Curve, Gradient, MinMax, RGB } from './types';

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample a piecewise-linear curve at normalized time `t` (0..1). Returns 1 if empty. */
export function sampleCurve(curve: Curve | undefined, t: number): number {
  if (!curve || curve.points.length === 0) return 1;
  const pts = curve.points;
  const scale = curve.scale ?? 1;
  if (t <= pts[0].t) return pts[0].v * scale;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v * scale;
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (t <= b.t) {
      const a = pts[i - 1];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      return lerp(a.v, b.v, f) * scale;
    }
  }
  return last.v * scale;
}

/** Sample gradient color at `t` into `out` (RGB, channels 0..1). White if empty. */
export function sampleGradientColor(grad: Gradient | undefined, t: number, out: RGB): RGB {
  if (!grad || grad.colorStops.length === 0) {
    out.r = 1; out.g = 1; out.b = 1;
    return out;
  }
  const s = grad.colorStops;
  if (t <= s[0].t) { out.r = s[0].color.r; out.g = s[0].color.g; out.b = s[0].color.b; return out; }
  const last = s[s.length - 1];
  if (t >= last.t) { out.r = last.color.r; out.g = last.color.g; out.b = last.color.b; return out; }
  for (let i = 1; i < s.length; i++) {
    const b = s[i];
    if (t <= b.t) {
      const a = s[i - 1];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      out.r = lerp(a.color.r, b.color.r, f);
      out.g = lerp(a.color.g, b.color.g, f);
      out.b = lerp(a.color.b, b.color.b, f);
      return out;
    }
  }
  out.r = last.color.r; out.g = last.color.g; out.b = last.color.b;
  return out;
}

/** Sample gradient alpha at `t`. Returns 1 if no alpha stops. */
export function sampleGradientAlpha(grad: Gradient | undefined, t: number): number {
  if (!grad || grad.alphaStops.length === 0) return 1;
  const s = grad.alphaStops;
  if (t <= s[0].t) return s[0].alpha;
  const last = s[s.length - 1];
  if (t >= last.t) return last.alpha;
  for (let i = 1; i < s.length; i++) {
    const b = s[i];
    if (t <= b.t) {
      const a = s[i - 1];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      return lerp(a.alpha, b.alpha, f);
    }
  }
  return last.alpha;
}

/** Deterministic RNG (mulberry32) so simulation is reproducible in tests. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(mm: MinMax, rng: () => number): number {
  return mm.min + (mm.max - mm.min) * rng();
}
