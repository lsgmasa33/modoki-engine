/** Pure tangent-handle math for the Curves view (extracted for testability — F2 regression).
 *
 *  A keyframe's in/out tangent is stored as a slope (value units per second) plus a weight
 *  (0..1 fraction of the segment to the neighbor). The editor draws a draggable handle at a
 *  screen offset derived from that slope+weight, and converts a dragged handle position back
 *  into slope+weight. `handlePt` (forward) and `deriveTangentFromHandle` (inverse) must
 *  round-trip: drag a handle to a data point, read it back, get the same data point. */

import { DEFAULT_TANGENT_WEIGHT, type Keyframe } from '../../../runtime/animation/types';

const EPS = 1e-3;

/** Time span from key `ki` to its relevant neighbor on `side` (out → next key, in →
 *  previous key), falling back to a phantom span for endpoint keys with no neighbor.
 *  Both the handle-draw (handleDataPt) and the handle-drag inverse
 *  (deriveTangentFromHandle) must use the SAME span for a handle to round-trip, so it
 *  lives here once instead of being recomputed identically in two CurvesView sites. */
export function segDtFor(keys: Keyframe[], ki: number, side: 'in' | 'out', phantomSeg: number): number {
  const k = keys[ki];
  return side === 'out'
    ? (keys[ki + 1]?.t ?? k.t + phantomSeg) - k.t
    : k.t - (keys[ki - 1]?.t ?? k.t - phantomSeg);
}

/** The data-space (t, v) endpoint of a key's in/out tangent handle.
 *  `segDt` is the time span to the relevant neighbor (or a phantom span for endpoints). */
export function handleDataPt(k: Keyframe, side: 'in' | 'out', segDt: number): { t: number; v: number } {
  if (side === 'out') {
    const w = k.outWeight ?? DEFAULT_TANGENT_WEIGHT;
    const dt = w * segDt;
    const m = Number.isFinite(k.outTangent) ? (k.outTangent as number) : 0;
    return { t: k.t + dt, v: k.v + m * dt };
  }
  const w = k.inWeight ?? DEFAULT_TANGENT_WEIGHT;
  const dt = w * segDt;
  const m = Number.isFinite(k.inTangent) ? (k.inTangent as number) : 0;
  return { t: k.t - dt, v: k.v - m * dt };
}

/** Inverse of {@link handleDataPt}: derive slope+weight for a key's in/out tangent from a
 *  dragged handle position in DATA space. Mirrors the runtime curve convention: the out
 *  handle points forward in time, the in handle backward. When `unified` (the key is not
 *  "broken"), the opposite tangent's slope is mirrored to keep the curve smooth. */
export function deriveTangentFromHandle(
  k: Keyframe,
  side: 'in' | 'out',
  dataT: number,
  dataV: number,
  segDt: number,
  unified: boolean,
): Partial<Keyframe> {
  if (side === 'out') {
    const ddt = Math.max(EPS, dataT - k.t);
    const slope = (dataV - k.v) / ddt;
    const w = Math.max(0.02, Math.min(1, ddt / Math.max(EPS, segDt)));
    const patch: Partial<Keyframe> = { outTangent: slope, outWeight: w };
    if (unified) patch.inTangent = slope;
    return patch;
  }
  const bdt = Math.max(EPS, k.t - dataT);
  const slope = (k.v - dataV) / bdt;
  const w = Math.max(0.02, Math.min(1, bdt / Math.max(EPS, segDt)));
  const patch: Partial<Keyframe> = { inTangent: slope, inWeight: w };
  if (unified) patch.outTangent = slope;
  return patch;
}
