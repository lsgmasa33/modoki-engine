/** Weight painting for 2D skinning rigs — brush a bone's influence onto mesh vertices
 *  near a point, preserving the relative proportions of other bones and renormalizing
 *  to <=4 influences per vertex. This is the computational core of the (planned) weight-
 *  paint UI: the panel supplies a brush position/radius/strength + target bone, this
 *  returns updated skinIndices/skinWeights. Pure + deterministic.
 *
 *  "Add" semantics (like Blender's Add weight-paint): each affected vertex's target
 *  weight moves toward 1 by `t = strength·falloff`, and its OTHER weights are scaled so
 *  the four still sum to 1 — so painting a bone in grows it without wiping the blend. */

export interface PaintWeightsOptions {
  verts: ReadonlyArray<readonly number[]>; // texture-space [x,y]
  skinIndices: ReadonlyArray<number>;      // current, packed 4 per vertex
  skinWeights: ReadonlyArray<number>;      // current, packed 4 per vertex
  boneIndex: number;                       // bone to paint in
  center: readonly [number, number];       // brush center (texture space)
  radius: number;                          // brush radius (px)
  strength: number;                        // 0..1 amount at the brush center
  /** Brush profile across the radius: 'smooth' (smoothstep falloff, default) or
   *  'constant' (hard edge). */
  falloff?: 'smooth' | 'constant';
  /** 'add' (default) grows the target bone's weight toward 1; 'subtract' shrinks it
   *  toward 0; 'set' blends it toward `strength` (used as the TARGET weight, not an
   *  intensity). Other bones rebalance to keep each vertex summing to 1. */
  mode?: 'add' | 'subtract' | 'set';
  /** Per-bone bind position [x,y] (same space as `verts`). Used by the eraser to hand
   *  the freed weight to the NEAREST other bone when the target is a vertex's SOLE
   *  influence — otherwise erasing there renormalizes straight back to 1. */
  bonePositions?: ReadonlyArray<readonly number[]>;
}

export interface PaintWeightsResult {
  skinIndices: number[];
  skinWeights: number[];
}

function brushFactor(dist: number, radius: number, mode: 'smooth' | 'constant'): number {
  if (radius <= 0 || dist >= radius) return 0;
  if (mode === 'constant') return 1;
  const x = 1 - dist / radius; // 1 at center → 0 at edge
  return x * x * (3 - 2 * x);   // smoothstep
}

/** Paint `boneIndex` into the vertices within the brush. Returns fresh packed arrays;
 *  inputs are not mutated. Vertices outside the brush are copied through unchanged. */
export function paintWeights(opts: PaintWeightsOptions): PaintWeightsResult {
  const n = opts.verts.length;
  const profile = opts.falloff ?? 'smooth';
  const subtract = opts.mode === 'subtract';
  const setMode = opts.mode === 'set';
  const strength = Math.max(0, Math.min(1, opts.strength));
  const outIdx = opts.skinIndices.slice(0, n * 4);
  const outW = opts.skinWeights.slice(0, n * 4);

  for (let v = 0; v < n; v++) {
    const dx = opts.verts[v][0] - opts.center[0];
    const dy = opts.verts[v][1] - opts.center[1];
    const bf = brushFactor(Math.hypot(dx, dy), opts.radius, profile);
    if (bf <= 0) continue;

    // Gather this vertex's current influences into a bone→weight map.
    const wmap = new Map<number, number>();
    for (let i = 0; i < 4; i++) {
      const w = outW[v * 4 + i];
      if (w > 0) wmap.set(outIdx[v * 4 + i], (wmap.get(outIdx[v * 4 + i]) ?? 0) + w);
    }
    const wt = wmap.get(opts.boneIndex) ?? 0;
    const wtNew = setMode
      ? wt + (strength - wt) * bf                    // blend toward the target weight (= strength)
      : subtract
        ? wt * (1 - strength * bf)                   // toward 0 (subtract)
        : wt + (1 - wt) * (strength * bf);           // toward 1 (add)
    const rest = 1 - wt;                            // old non-target mass
    if (wtNew < wt - 1e-9 && rest <= 1e-6) {
      // Reducing a SOLE-influence vertex (subtract, or set below its current weight): the
      // freed weight has nowhere to go via rebalancing (others are 0), so it would
      // renormalize straight back to 1. Hand it to the nearest OTHER bone instead.
      wmap.set(opts.boneIndex, wtNew);
      const freed = wt - wtNew;
      const bp = opts.bonePositions;
      if (freed > 0 && bp && bp.length > 1) {
        const vx = opts.verts[v][0], vy = opts.verts[v][1];
        let best = -1, bestD = Infinity;
        for (let b = 0; b < bp.length; b++) {
          if (b === opts.boneIndex) continue;
          const dx = vx - (bp[b][0] ?? 0), dy = vy - (bp[b][1] ?? 0), dd = dx * dx + dy * dy;
          if (dd < bestD) { bestD = dd; best = b; }
        }
        if (best >= 0) wmap.set(best, (wmap.get(best) ?? 0) + freed);
      }
    } else {
      const scale = rest > 1e-6 ? (1 - wtNew) / rest : 0;
      for (const [b, w] of wmap) wmap.set(b, b === opts.boneIndex ? wtNew : w * scale);
      wmap.set(opts.boneIndex, wtNew);
    }

    // Keep the top 4, renormalize, write back.
    const top = [...wmap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, w] of top) sum += w;
    for (let i = 0; i < 4; i++) {
      if (i < top.length && sum > 0) { outIdx[v * 4 + i] = top[i][0]; outW[v * 4 + i] = top[i][1] / sum; }
      else { outIdx[v * 4 + i] = 0; outW[v * 4 + i] = 0; }
    }
  }

  return { skinIndices: outIdx, skinWeights: outW };
}

/** Per-vertex DOMINANT bone (the index of each vertex's highest-weight influence) —
 *  for a whole-rig influence segmentation view (color each vertex by which bone owns
 *  it most). Accepts the rig's packed typed arrays. */
export function dominantBoneField(
  skinIndices: ArrayLike<number>,
  skinWeights: ArrayLike<number>,
  vertCount: number,
): number[] {
  const out = new Array(vertCount).fill(0);
  for (let v = 0; v < vertCount; v++) {
    let best = 0, bestW = -1;
    for (let i = 0; i < 4; i++) {
      const w = skinWeights[v * 4 + i] ?? 0;
      if (w > bestW) { bestW = w; best = skinIndices[v * 4 + i] ?? 0; }
    }
    out[v] = best;
  }
  return out;
}

/** Extract a single bone's per-vertex weight (0..1) — for a weight heatmap overlay.
 *  Accepts number[] or the rig's packed typed arrays (Uint32Array/Float32Array). */
export function boneWeightField(
  skinIndices: ArrayLike<number>,
  skinWeights: ArrayLike<number>,
  boneIndex: number,
  vertCount: number,
): number[] {
  const out = new Array(vertCount).fill(0);
  for (let v = 0; v < vertCount; v++) {
    for (let i = 0; i < 4; i++) {
      if (skinIndices[v * 4 + i] === boneIndex) { out[v] += skinWeights[v * 4 + i]; }
    }
  }
  return out;
}
