/** Pure evaluation of a deform (per-vertex mesh) timeline — no ECS, no renderer,
 *  fully unit-testable and deterministic. Mirrors `curveEval` for the scalar tracks.
 *
 *  A deform track's keys each hold a DENSE offset array (2×vertCount). We LINEARLY
 *  interpolate componentwise between the two bracketing keys, clamping (holding) at
 *  the endpoints — the standard Spine deform model. (Per-frame bezier curves on a
 *  deform key are a later refinement; linear covers the overwhelming majority.) */

import { findKeyIndex } from './curveEval';
import type { DeformTrack, Keyframe } from './types';

/** Evaluate `track` at `time`, returning a fresh dense offset array (2×vertCount),
 *  or null if the track has no keys. The array length is that of the keys' offsets
 *  (all keys share one vertex count); a defensive min-length guards a malformed clip. */
export function evalDeformTrack(track: DeformTrack, time: number): Float32Array | null {
  const keys = track.keys;
  const n = keys.length;
  if (n === 0) return null;
  if (n === 1) return Float32Array.from(keys[0].offsets);

  // Endpoint clamp (hold first/last frame outside the range).
  if (time <= keys[0].t) return Float32Array.from(keys[0].offsets);
  const last = keys[n - 1];
  if (time >= last.t) return Float32Array.from(last.offsets);

  // findKeyIndex only reads `.t`, so a DeformKey is compatible via a structural cast.
  const i = findKeyIndex(keys as unknown as Keyframe[], time);
  const a = keys[i];
  const b = keys[i + 1];
  const dt = b.t - a.t;
  const f = dt <= 0 ? 0 : (time - a.t) / dt;

  const len = Math.min(a.offsets.length, b.offsets.length);
  const out = new Float32Array(len);
  for (let k = 0; k < len; k++) out[k] = a.offsets[k] + (b.offsets[k] - a.offsets[k]) * f;
  return out;
}
