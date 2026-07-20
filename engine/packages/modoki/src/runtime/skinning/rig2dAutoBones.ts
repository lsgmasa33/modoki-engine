/** Auto bone placement for 2D skinning rigs — suggests a default bone chain along a
 *  sprite's principal axis, so "auto-rig from a sprite" needs zero manual bone work.
 *  Pure + deterministic. The editor can use this for a one-click default, then let the
 *  user drag/add/remove joints.
 *
 *  Heuristic: pick the longer axis (taller sprite → vertical chain, wider → horizontal),
 *  find the covered extent along it (via the optional alpha predicate, else the full
 *  rect), and drop `count` evenly-spaced joints spanning that extent as a parent chain.
 *  Bone locals are parent-relative in texture space (pivot-centered), matching the
 *  `.rig2d.json` convention. */

import type { Rig2DBone } from '../loaders/rig2dCache';

export interface SuggestBonesOptions {
  width: number;
  height: number;
  /** Number of joints (>=2). Omit to derive from the axis length (~1 per 96px, 2..6). */
  count?: number;
  pivotX?: number; // 0..1 (default 0.5)
  pivotY?: number; // 0..1 (default 0.5)
  /** Force the chain axis; 'auto' (default) picks the longer sprite dimension. */
  axis?: 'auto' | 'x' | 'y';
  /** Optional UV-space (0..1) coverage predicate — bones span the covered extent
   *  along the axis instead of the whole rect. */
  isInside?: (u: number, v: number) => boolean;
}

/** Find [lo,hi] in 0..1 along the chain axis where the sprite has any coverage.
 *  Samples a small grid; falls back to the full [0,1] if nothing is covered or no
 *  predicate is supplied. */
function coveredExtent(vertical: boolean, isInside?: (u: number, v: number) => boolean): [number, number] {
  if (!isInside) return [0, 1];
  const N = 32, M = 8;
  let lo = 1, hi = 0, any = false;
  for (let i = 0; i <= N; i++) {
    const a = i / N; // position along the chain axis
    let covered = false;
    for (let j = 0; j <= M; j++) {
      const b = j / M; // perpendicular
      const u = vertical ? b : a;
      const v = vertical ? a : b;
      if (isInside(u, v)) { covered = true; break; }
    }
    if (covered) { any = true; if (a < lo) lo = a; if (a > hi) hi = a; }
  }
  return any && hi > lo ? [lo, hi] : [0, 1];
}

/** Suggest a default bone chain for a sprite. Returns bones ready for `buildRig2D`. */
export function suggestBones(opts: SuggestBonesOptions): Rig2DBone[] {
  const w = opts.width, h = opts.height;
  const pvx = opts.pivotX ?? 0.5, pvy = opts.pivotY ?? 0.5;
  const vertical = opts.axis === 'y' ? true : opts.axis === 'x' ? false : h >= w;
  const axisLen = vertical ? h : w;
  const count = Math.max(2, Math.min(6, opts.count ?? Math.max(2, Math.round(axisLen / 96) + 1)));

  const [lo, hi] = coveredExtent(vertical, opts.isInside);

  // Joint positions in texture space along the axis (uv → pixel, pivot-centered).
  const joints: number[] = [];
  for (let k = 0; k < count; k++) {
    const t = lo + (hi - lo) * (k / (count - 1)); // uv along axis
    joints.push((t - (vertical ? pvy : pvx)) * axisLen);
  }

  const bones: Rig2DBone[] = [];
  for (let k = 0; k < count; k++) {
    const prev = k > 0 ? joints[k - 1] : 0;
    const localAlong = k === 0 ? joints[0] : joints[k] - prev; // parent-relative
    bones.push({
      name: k === 0 ? 'root' : `bone${k}`,
      parent: k - 1,
      x: vertical ? 0 : localAlong,
      y: vertical ? localAlong : 0,
      rot: 0,
    });
  }
  return bones;
}
