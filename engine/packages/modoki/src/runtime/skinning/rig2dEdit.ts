/** Pure structural edits to a 2D rig's bone list — add / remove a bone — remapping
 *  parent indices and per-vertex skinIndices/skinWeights so the rig stays valid. Used by
 *  the Skin-panel bone editor. Deterministic, no side effects (returns a new Rig2DFile). */

import { type Rig2DFile } from './rig2dTypes';
import { deriveBindMatrices, invert2D, identity2D, apply2D, type BindBone } from './rig2dMath';

type Bones = NonNullable<Rig2DFile['bones']>;

function coerce(bones: Bones): BindBone[] {
  return bones.map((b) => ({ parent: b.parent ?? -1, x: b.x ?? 0, y: b.y ?? 0, rot: b.rot ?? 0 }));
}

/** Is `a` an ancestor of `b` in the bone tree? */
function isAncestor(bones: Bones, a: number, b: number): boolean {
  let p = bones[b]?.parent ?? -1;
  for (let g = 0; p >= 0 && g < bones.length + 1; g++) { if (p === a) return true; p = bones[p]?.parent ?? -1; }
  return false;
}

function uniqueBoneName(bones: Bones, base = 'bone'): string {
  const taken = new Set(bones.map((b) => b.name));
  for (let i = 1; ; i++) { const n = `${base}${i}`; if (!taken.has(n)) return n; }
}

/** Append a bone as a child of `parent` (−1 = root) at LOCAL position (x,y). Existing
 *  vertex weights are untouched — the new bone has no influence until it's weighted. */
export function addBone(def: Rig2DFile, parent: number, x: number, y: number): { def: Rig2DFile; index: number } {
  const bones: Bones = [...(def.bones ?? [])];
  const index = bones.length;
  bones.push({ name: uniqueBoneName(bones), parent, x, y, rot: 0 });
  return { def: { ...def, bones }, index };
}

/** Re-parent bone `child` under `newParent` (−1 = root), preserving its joint's WORLD
 *  position (its local x/y is recomputed relative to the new parent's bind). No-op if it
 *  would create a cycle (newParent is `child` or a descendant of `child`). */
export function reparentBone(def: Rig2DFile, child: number, newParent: number): Rig2DFile {
  const bones = def.bones ?? [];
  if (child < 0 || child >= bones.length || newParent >= bones.length) return def;
  if (newParent === child || (newParent >= 0 && isAncestor(bones, child, newParent))) return def;
  if ((bones[child].parent ?? -1) === newParent) return def;
  const { rootLocal } = deriveBindMatrices(coerce(bones));
  const world = rootLocal[child];
  const pInv = newParent >= 0 && rootLocal[newParent] ? invert2D(rootLocal[newParent]) : identity2D();
  const out = new Float32Array(2); apply2D(pInv, world.e, world.f, out, 0);
  const newBones = bones.map((b, i) => (i === child ? { ...b, parent: newParent, x: out[0], y: out[1] } : b));
  return { ...def, bones: newBones };
}

/** Remove bone `r`: its children re-parent to its parent, all parent indices shift to
 *  close the gap, and its vertex weights transfer to its parent (or drop if it was a
 *  root). Per-vertex weights are re-accumulated, capped at 4, and renormalized. */
export function removeBone(def: Rig2DFile, r: number): Rig2DFile {
  const bones = def.bones ?? [];
  if (r < 0 || r >= bones.length) return def;
  const parent = bones[r].parent ?? -1;

  // old bone index → new bone index (the deleted bone maps to its parent's new index,
  // so weights transfer up; a deleted root maps to -1 → those weights drop).
  const remap = new Map<number, number>();
  const newBones: Bones = [];
  let ni = 0;
  for (let i = 0; i < bones.length; i++) { if (i === r) continue; remap.set(i, ni++); newBones.push({ ...bones[i] }); }
  remap.set(r, parent < 0 ? -1 : (remap.get(parent) ?? -1));
  for (const b of newBones) {
    let p = b.parent ?? -1;
    if (p === r) p = parent;                 // child of the deleted bone → grandparent (old idx)
    b.parent = p < 0 ? -1 : (remap.get(p) ?? -1);
  }

  // EVERY mesh in the rig has to go through the remap, and a v2 rig has one per PART.
  // This used to run over `def.mesh`/`def.skinIndices` only — the v1 top-level fields — while
  // `def.parts` rode through the spread untouched, still indexed against the pre-delete numbering.
  // `ensurePartsArray` STRIPS those top-level fields when it promotes a rig to v2, so on a
  // multi-part rig the loop saw `n = 0`, did nothing, and wrote empty arrays: every part silently
  // kept stale indices. On load `normalizePart` then clamps an index past the end to bone 0, so the
  // damage shows up two ways — vertices bound to whatever bone shifted into the slot, and (for the
  // last bone) vertices snapped to the root. Saved to disk either way. (#179)
  const meshWeights = (
    vertCount: number,
    oldIdx: number[],
    oldW: number[],
  ): { skinIndices: number[]; skinWeights: number[] } => {
    const si = new Array(vertCount * 4).fill(0), sw = new Array(vertCount * 4).fill(0);
    for (let v = 0; v < vertCount; v++) {
      const acc = new Map<number, number>();
      for (let k = 0; k < 4; k++) {
        // `!(w > 0)`, not `w <= 0`: NaN fails EVERY comparison, so `<=` would let a NaN weight
        // through, poison `sum`, and zero the whole vertex including its valid buckets.
        const w = oldW[v * 4 + k] ?? 0; if (!(w > 0)) continue;
        const nb = remap.get(oldIdx[v * 4 + k] ?? 0);
        if (nb == null || nb < 0) continue;    // deleted-root weight → dropped
        acc.set(nb, (acc.get(nb) ?? 0) + w);
      }
      const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      let sum = 0; for (const [, w] of top) sum += w;
      if (!top.length || sum <= 0) {
        // Every bucket dropped — a vertex bound ENTIRELY to the deleted bone. It must fall back to
        // bone 0 at full weight, which is exactly what `normalizePart` does for a degenerate vertex
        // on load. Leaving all four slots at 0 (what this did before) is not equivalent: the editor
        // deforms from the RAW def, and `SkinCanvas.deformMesh` skips every zero-weight term, so the
        // vertex collapsed to the local origin until the panel was reopened and the load path
        // quietly repaired it. The invariant to hold onto: removeBone's output must NORMALIZE TO
        // ITSELF, so the live preview and the reloaded rig cannot disagree.
        si[v * 4] = 0; sw[v * 4] = 1;
        continue;
      }
      for (let k = 0; k < top.length; k++) { si[v * 4 + k] = top[k][0]; sw[v * 4 + k] = top[k][1] / sum; }
    }
    return { skinIndices: si, skinWeights: sw };
  };

  // v2: remap EVERY part against its OWN vertex count — parts do not share a mesh. The top-level v1
  // fields are deliberately left ALONE here rather than overwritten with an empty array computed
  // from an absent `def.mesh`: `normalizeRig2D` ignores them whenever `parts` is present, so
  // writing them would be inventing data, and it is what made the old bug invisible.
  if (def.parts?.length) {
    const parts = def.parts.map((p) => {
      const n = p.mesh?.verts?.length ?? 0;
      if (!n) return p;                        // a part with no mesh has no weights to remap
      return { ...p, ...meshWeights(n, p.skinIndices ?? [], p.skinWeights ?? []) };
    });
    return { ...def, bones: newBones, parts };
  }

  // v1: the single implicit part lives in the top-level fields.
  const n = def.mesh?.verts?.length ?? 0;
  return { ...def, bones: newBones, ...meshWeights(n, def.skinIndices ?? [], def.skinWeights ?? []) };
}
