/**
 * Pure curve evaluation for keyframe tracks — no THREE, no ECS, fully unit-testable.
 *
 * `evalTrack` evaluates a numeric track the way Unity's AnimationCurve does:
 *   - constant clamp outside the key range,
 *   - cubic Hermite interpolation between keys using each key's out/in tangents,
 *   - a STEPPED (Infinity) outgoing tangent holds the left value until the next key.
 *
 * Weighted-tangent (bezier-in-x) evaluation is a Phase-3 refinement; Phase 1 uses
 * free (non-weighted) Hermite, which already gives editable tangent handles.
 */

import { lerp } from '../particles/curves';
import { DEFAULT_TANGENT_WEIGHT, STEPPED, type AnimationTrack, type Keyframe, type TangentMode, type TrackValueType } from './types';

/** Find the index `i` of the last key with `keys[i].t <= time`, via binary search.
 *  Returns -1 if `time` is before the first key. Assumes keys sorted by `t`. */
export function findKeyIndex(keys: Keyframe[], time: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= time) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Cubic bezier scalar at parameter `u`. */
function bezier(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
}

/** Derivative of the cubic bezier scalar at `u`. */
function bezierDeriv(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u;
  return 3 * (m * m * (p1 - p0) + 2 * m * u * (p2 - p1) + u * u * (p3 - p2));
}

/** Evaluate the cubic-bezier segment between two keys at absolute `time`.
 *  Tangents are slopes (value/sec); weights (0..1, default 1/3) set handle length
 *  along the segment — so handle LENGTH affects the curve (Unity weighted mode).
 *  With both weights at 1/3 this reduces to the familiar Hermite shape. */
function evalSegment(a: Keyframe, b: Keyframe, time: number): number {
  const dt = b.t - a.t;
  if (dt <= 0) return b.v;
  const mA = Number.isFinite(a.outTangent) ? a.outTangent : 0;
  const mB = Number.isFinite(b.inTangent) ? b.inTangent : 0;
  let wA = clamp(a.outWeight ?? DEFAULT_TANGENT_WEIGHT, 0, 0.999);
  let wB = clamp(b.inWeight ?? DEFAULT_TANGENT_WEIGHT, 0, 0.999);

  // The time-axis control points are x1 = wA·dt and x2 = dt − wB·dt. The
  // time→parameter map x(u) is invertible only when x1 ≤ x2, i.e. wA + wB ≤ 1.
  // Two heavy handles (e.g. wA = wB = 0.9 → x1 = 0.9·dt > x2 = 0.1·dt) make x(u)
  // non-monotonic, so Newton can converge to the wrong branch and return a wildly
  // off value. Clamp the SUM by scaling both weights down proportionally; this
  // preserves the relative handle ratio while keeping x(u) monotonic. The handle
  // SLOPES (mA/mB) are unchanged, so endpoints and shape near them stay correct.
  const wSum = wA + wB;
  if (wSum > 1) {
    const s = 1 / wSum;
    wA *= s;
    wB *= s;
  }

  // Control points in (relative-time, value) space.
  const x1 = wA * dt;
  const x2 = dt - wB * dt;
  const y0 = a.v;
  const y1 = a.v + mA * (wA * dt);
  const y2 = b.v - mB * (wB * dt);
  const y3 = b.v;

  // Solve for the bezier parameter `u` where x(u) = targetX. x(u) is now monotonic
  // in [0,1], so we bracket the root and run Newton with a real bisection fallback:
  // if a Newton step leaves the current [lo,hi] bracket (or the derivative vanishes),
  // fall back to the bracket midpoint. This can never diverge to the wrong root.
  const targetX = time - a.t;
  let lo = 0;
  let hi = 1;
  let u = clamp(targetX / dt, 0, 1); // good initial guess (x is near-linear in u for typical weights)
  for (let i = 0; i < 24; i++) {
    const x = bezier(0, x1, x2, dt, u) - targetX;
    if (Math.abs(x) < 1e-7) break;
    // Maintain the bracket: x(u) is increasing, so x<0 means root is to the right.
    if (x < 0) lo = u;
    else hi = u;
    const dx = bezierDeriv(0, x1, x2, dt, u);
    let next = dx > 1e-12 ? u - x / dx : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2; // Newton escaped the bracket → bisect
    u = next;
  }
  return bezier(y0, y1, y2, y3, u);
}

/** Evaluate a numeric track (weighted bezier + stepped + endpoint clamp). */
export function evalTrack(keys: Keyframe[], time: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1) return keys[0].v;
  if (time <= keys[0].t) return keys[0].v;
  const last = keys[n - 1];
  if (time >= last.t) return last.v;

  const i = findKeyIndex(keys, time);
  const left = keys[i];
  const right = keys[i + 1];

  // Stepped segment: hold the left value until the next key.
  if (left.outTangent === STEPPED || !Number.isFinite(left.outTangent)) return left.v;

  const dt = right.t - left.t;
  if (dt <= 0) return right.v;
  return evalSegment(left, right, time);
}

/** Evaluate a packed-0xRRGGBB color track. Per-channel linear interpolation, but a
 *  STEPPED (or non-finite) out-tangent on the left key HOLDS that key's color (snap
 *  cut), matching the numeric `evalTrack` stepped behaviour — so an authored
 *  constant/stepped color key snaps instead of cross-fading. Returns 0xRRGGBB. */
export function evalColorTrack(keys: Keyframe[], time: number): number {
  const n = keys.length;
  if (n === 0) return 0xffffff;
  if (n === 1) return keys[0].v | 0;
  if (time <= keys[0].t) return keys[0].v | 0;
  const last = keys[n - 1];
  if (time >= last.t) return last.v | 0;

  const i = findKeyIndex(keys, time);
  const a = keys[i];
  const b = keys[i + 1];
  // Stepped segment: hold the left colour until the next key.
  if (a.outTangent === STEPPED || !Number.isFinite(a.outTangent)) return a.v | 0;
  const dt = b.t - a.t;
  const f = dt <= 0 ? 0 : (time - a.t) / dt;

  const ar = (a.v >> 16) & 0xff, ag = (a.v >> 8) & 0xff, ab = a.v & 0xff;
  const br = (b.v >> 16) & 0xff, bg = (b.v >> 8) & 0xff, bb = b.v & 0xff;
  const r = Math.round(lerp(ar, br, f)) & 0xff;
  const g = Math.round(lerp(ag, bg, f)) & 0xff;
  const bl = Math.round(lerp(ab, bb, f)) & 0xff;
  return (r << 16) | (g << 8) | bl;
}

/** Evaluate a boolean track — always stepped: returns the most recent key's value. */
export function evalBooleanTrack(keys: Keyframe[], time: number): number {
  if (keys.length === 0) return 0;
  if (time < keys[0].t) return keys[0].v ? 1 : 0;
  const i = findKeyIndex(keys, time);
  return keys[i].v ? 1 : 0;
}

/** Evaluate an enum/stepped track — holds the most recent key's RAW value (the
 *  option index). Unlike boolean it isn't squashed to 0/1, so multi-option enums
 *  keep their index. (Enums are discrete; honoring a numeric tangent ramp is
 *  intentionally NOT done — F4's prescribed fix is the color-STEPPED case only.) */
export function evalSteppedTrack(keys: Keyframe[], time: number): number {
  if (keys.length === 0) return 0;
  if (time < keys[0].t) return keys[0].v;
  return keys[findKeyIndex(keys, time)].v;
}

/** Evaluate a track of any value type, dispatching on `track.type`. */
export function evalTrackValue(track: AnimationTrack, time: number): number {
  switch (track.type) {
    case 'color': return evalColorTrack(track.keys, time);
    case 'boolean': return evalBooleanTrack(track.keys, time);
    case 'enum': return evalSteppedTrack(track.keys, time);
    default: return evalTrack(track.keys, time);
  }
}

export type { TangentMode };

/** Set the in/out tangents of `keys[i]` according to `mode`, using neighbor keys
 *  for slope estimation. Records the mode on the key (so recording / neighbor
 *  recompute can re-apply it). Mutates the key in place and returns it. Mirrors
 *  Unity's right-click keyframe tangent menu. */
export function applyTangentMode(keys: Keyframe[], i: number, mode: TangentMode): Keyframe {
  const k = keys[i];
  const prev = i > 0 ? keys[i - 1] : undefined;
  const next = i < keys.length - 1 ? keys[i + 1] : undefined;
  k.tangentMode = mode;

  switch (mode) {
    case 'constant':
      k.outTangent = STEPPED;
      k.broken = true;
      break;
    case 'linear': {
      // In tangent = secant to previous key; out tangent = secant to next key.
      if (prev) k.inTangent = (k.v - prev.v) / Math.max(1e-6, k.t - prev.t);
      if (next) k.outTangent = (next.v - k.v) / Math.max(1e-6, next.t - k.t);
      k.broken = true;
      break;
    }
    case 'auto': {
      // Smooth (Catmull-Rom-ish): slope through the surrounding two keys.
      const a = prev ?? k;
      const b = next ?? k;
      const span = b.t - a.t;
      const slope = span > 1e-6 ? (b.v - a.v) / span : 0;
      k.inTangent = slope;
      k.outTangent = slope;
      k.broken = false;
      break;
    }
    case 'free':
    default:
      // Leave tangents as-is; just mark broken so in/out move independently.
      k.broken = true;
      break;
  }
  return k;
}

/** Convenience used by the editor when first creating a key: smooth (auto) tangents. */
export function autoTangents(keys: Keyframe[], i: number): Keyframe {
  return applyTangentMode(keys, i, 'auto');
}

export { type TrackValueType };
