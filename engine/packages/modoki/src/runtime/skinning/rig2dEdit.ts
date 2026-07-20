/** Pure structural edits to a 2D rig's bone list — add / remove a bone — remapping
 *  parent indices and per-vertex skinIndices/skinWeights so the rig stays valid. Used by
 *  the Skin-panel bone editor. Deterministic, no side effects (returns a new Rig2DFile). */

import { type Rig2DFile } from '../loaders/rig2dCache';
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

  const n = def.mesh?.verts?.length ?? 0;
  const oldIdx = def.skinIndices ?? [], oldW = def.skinWeights ?? [];
  const si = new Array(n * 4).fill(0), sw = new Array(n * 4).fill(0);
  for (let v = 0; v < n; v++) {
    const acc = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const w = oldW[v * 4 + k] ?? 0; if (w <= 0) continue;
      const nb = remap.get(oldIdx[v * 4 + k] ?? 0);
      if (nb == null || nb < 0) continue;    // deleted-root weight → dropped
      acc.set(nb, (acc.get(nb) ?? 0) + w);
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0; for (const [, w] of top) sum += w;
    for (let k = 0; k < top.length && sum > 0; k++) { si[v * 4 + k] = top[k][0]; sw[v * 4 + k] = top[k][1] / sum; }
  }
  return { ...def, bones: newBones, skinIndices: si, skinWeights: sw };
}
