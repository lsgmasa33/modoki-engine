/** Auto-weighting for 2D skinning rigs — assigns each mesh vertex up to 4 bone
 *  influences by inverse distance to the bone's bind-pose JOINT (nearest-joint wins),
 *  then normalizes. This is the "weights" half of "auto-rig from a sprite" — the cheap,
 *  robust heuristic (Unity ships bounded-biharmonic; that's a later upgrade). Pure +
 *  deterministic: no wall-clock/RNG.
 *
 *  Why joints, not bone segments: a "bone segment" (joint → parent joint) is ambiguous
 *  for a COLINEAR chain — e.g. a straight limb's upper bone segment spans the whole
 *  limb and would dominate the lower verts too. Distance to the joint POINT splits a
 *  limb cleanly at the midpoint between consecutive joints, which is what you want.
 *
 *  Bone bind-pose rig-origin positions are derived from the bind hierarchy via
 *  `deriveBindMatrices` (a bone's origin is the translation of its root-local matrix),
 *  so the caller passes the SAME `bones` array that goes into the `.rig2d.json`. */

import { deriveBindMatrices, type BindBone } from './rig2dMath';

export interface AutoWeights {
  skinIndices: number[]; // 4 bone indices per vertex
  skinWeights: number[]; // 4 weights per vertex, normalized to 1 (unused slots 0)
}

export interface AutoWeightOptions {
  /** Influence falloff exponent on distance (default 2). Higher = tighter/more rigid,
   *  lower = softer/broader blends. With `radius` it shapes the bounded curve
   *  `(1 - d/radius)^falloff`; without it, the legacy inverse-distance `1/d^falloff`. */
  falloff?: number;
  /** Bounded influence radius (texture units): a bone contributes 0 past this distance
   *  from its joint, giving localized, clean deformation. Omitted/≤0 → unbounded
   *  inverse-distance (legacy). Verts beyond EVERY bone's radius fall back to the
   *  nearest bone. */
  radius?: number;
  /** Max influences per vertex (1..4, default 4). */
  maxInfluences?: number;
}

/** Compute per-vertex bone weights for a mesh. `verts` are texture-space [x,y] (the
 *  same frame the bind bones live in). Returns packed 4-per-vertex indices+weights. */
export function computeAutoWeights(
  verts: readonly (readonly number[])[],
  bones: readonly BindBone[],
  opts: AutoWeightOptions = {},
): AutoWeights {
  const falloff = opts.falloff ?? 2;
  const radius = opts.radius && opts.radius > 0 ? opts.radius : Infinity;
  const maxInf = Math.max(1, Math.min(4, Math.floor(opts.maxInfluences ?? 4)));
  const EPS = 1e-4;

  // Bone rig-origin positions (translation of each root-local bind matrix).
  const { rootLocal } = deriveBindMatrices(bones);
  const origin = rootLocal.map((m) => ({ x: m.e, y: m.f }));

  const n = verts.length;
  const nb = bones.length;
  const skinIndices = new Array(n * 4).fill(0);
  const skinWeights = new Array(n * 4).fill(0);

  for (let v = 0; v < n; v++) {
    const px = verts[v][0], py = verts[v][1];
    // Score every bone by (bounded or inverse) distance to its bind-pose joint.
    const scored: Array<{ b: number; w: number }> = [];
    let nearestB = 0, nearestD = Infinity;
    for (let b = 0; b < nb; b++) {
      const dist = Math.hypot(px - origin[b].x, py - origin[b].y);
      if (dist < nearestD) { nearestD = dist; nearestB = b; }
      const w = radius === Infinity
        ? 1 / (Math.pow(dist, falloff) + EPS)                       // unbounded inverse-distance
        : dist >= radius ? 0 : Math.pow(1 - dist / radius, falloff); // bounded radial falloff
      if (w > 0) scored.push({ b, w });
    }
    // Keep the top maxInf, normalize.
    scored.sort((a, c) => c.w - a.w);
    const kept = scored.slice(0, maxInf);
    let sum = 0;
    for (const k of kept) sum += k.w;
    // Beyond every bone's radius → fall back to the single nearest bone.
    if (sum <= 0) { skinIndices[v * 4] = nearestB; skinWeights[v * 4] = 1; continue; }
    for (let i = 0; i < kept.length; i++) {
      skinIndices[v * 4 + i] = kept[i].b;
      skinWeights[v * 4 + i] = kept[i].w / sum;
    }
  }

  return { skinIndices, skinWeights };
}
