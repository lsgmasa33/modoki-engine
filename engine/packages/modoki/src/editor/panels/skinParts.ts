/** Active-part view over a `.rig2d.json` (Rig2DFile) for the Skin editor. A v2 rig has
 *  many parts sharing the skeleton; a v1 rig is a single implicit part (its top-level
 *  sprite/mesh/skinIndices/skinWeights). These helpers let the editor read + write "the
 *  active part" uniformly, so the same authoring UI works for both. Bones are shared and
 *  edited on `def.bones` directly (not part-scoped). */

import type { Rig2DFile, Rig2DPart } from '../../runtime/loaders/rig2dCache';

/** Fields the editor reads/writes per part (a subset of Rig2DPart / the v1 top-level). */
export type PartView = Pick<Rig2DPart, 'sprite' | 'mesh' | 'skinIndices' | 'skinWeights'>;

/** Number of parts (a v1 rig counts as one). */
export function partCount(def: Rig2DFile | null | undefined): number {
  return def?.parts?.length || 1;
}

/** The parts list for display (names), synthesizing a single entry for a v1 rig. */
export function partsOf(def: Rig2DFile | null | undefined): { name: string; visible: boolean }[] {
  if (def?.parts?.length) return def.parts.map((p, i) => ({ name: p.name || `part${i}`, visible: p.visible !== false }));
  return [{ name: 'main', visible: true }];
}

/** Clamp an active-part index into range for `def`. */
export function clampPart(def: Rig2DFile | null | undefined, idx: number): number {
  const n = partCount(def);
  return Math.max(0, Math.min(n - 1, idx | 0));
}

/** Read the active part as a uniform view (v2 → parts[idx]; v1 → top-level fields). */
export function activePartOf(def: Rig2DFile | null | undefined, idx: number): PartView {
  if (!def) return {};
  if (def.parts?.length) {
    const p = def.parts[clampPart(def, idx)];
    return { sprite: p?.sprite, mesh: p?.mesh, skinIndices: p?.skinIndices, skinWeights: p?.skinWeights };
  }
  return { sprite: def.sprite, mesh: def.mesh, skinIndices: def.skinIndices, skinWeights: def.skinWeights };
}

/** Return a NEW def with `patch` applied to the active part (v2 → parts[idx]; v1 → top-level). */
export function withActivePart(def: Rig2DFile, idx: number, patch: Partial<PartView>): Rig2DFile {
  if (def.parts?.length) {
    const i = clampPart(def, idx);
    return { ...def, parts: def.parts.map((p, k) => (k === i ? { ...p, ...patch } : p)) };
  }
  return { ...def, ...patch };
}

// ── Structural part edits (add / remove / reorder / rename / visibility) ──

/** Normalize a v1 rig into an explicit one-element `parts[]` (moving the top-level mesh
 *  fields into `parts[0]`), so structural edits have an array to work on. No-op for v2. */
export function ensurePartsArray(def: Rig2DFile): Rig2DFile {
  if (def.parts?.length) return def;
  const { sprite, mesh, skinIndices, skinWeights, ...rest } = def;
  return { ...rest, parts: [{ name: 'main', sprite, mesh, skinIndices, skinWeights, order: 0 }] };
}

/** Renumber each part's `order` to its array index (lower = drawn behind). Keeps draw
 *  order in sync with list order after add/remove/reorder. */
function reindex(parts: Rig2DPart[]): Rig2DPart[] {
  return parts.map((p, i) => ({ ...p, order: i }));
}

/** Append a new empty part (front-most). Returns the def + the new part's index. */
export function addPart(def: Rig2DFile): { def: Rig2DFile; index: number } {
  const d = ensurePartsArray(def);
  const parts = reindex([...(d.parts ?? []), { name: `part${(d.parts ?? []).length}`, sprite: '', mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] }]);
  return { def: { ...d, parts }, index: parts.length - 1 };
}

/** Remove a part (keeps at least one). */
export function removePart(def: Rig2DFile, idx: number): Rig2DFile {
  const d = ensurePartsArray(def);
  if ((d.parts?.length ?? 0) <= 1) return d;
  return { ...d, parts: reindex(d.parts!.filter((_, i) => i !== idx)) };
}

/** Move a part earlier (dir -1 = behind) or later (dir +1 = front) in draw order. */
export function movePart(def: Rig2DFile, idx: number, dir: -1 | 1): Rig2DFile {
  const d = ensurePartsArray(def);
  const parts = [...d.parts!], j = idx + dir;
  if (j < 0 || j >= parts.length) return d;
  [parts[idx], parts[j]] = [parts[j], parts[idx]];
  return { ...d, parts: reindex(parts) };
}

/** Move a part from index `from` to index `to` (drag-reorder in the Parts list). The moved
 *  part lands AT `to`; the rest close up. No-op for out-of-range or identical indices. */
export function reorderPart(def: Rig2DFile, from: number, to: number): Rig2DFile {
  const d = ensurePartsArray(def);
  const parts = [...d.parts!];
  if (from < 0 || from >= parts.length || to < 0 || to >= parts.length || from === to) return d;
  const [moved] = parts.splice(from, 1);
  parts.splice(to, 0, moved);
  return { ...d, parts: reindex(parts) };
}

/** Where `activePart` lands after a `reorderPart(from → to)`, so the same logical part stays
 *  selected as indices shift. */
export function reorderActiveIndex(active: number, from: number, to: number): number {
  if (active === from) return to;
  if (from < active && active <= to) return active - 1;
  if (to <= active && active < from) return active + 1;
  return active;
}

export function renamePart(def: Rig2DFile, idx: number, name: string): Rig2DFile {
  const d = ensurePartsArray(def);
  return { ...d, parts: d.parts!.map((p, i) => (i === idx ? { ...p, name } : p)) };
}

export function setPartVisible(def: Rig2DFile, idx: number, visible: boolean): Rig2DFile {
  const d = ensurePartsArray(def);
  return { ...d, parts: d.parts!.map((p, i) => (i === idx ? { ...p, visible } : p)) };
}

// ── Part geometry helpers (position/rotation are implicit in the mesh verts) ──

/** Solve the affine UV→position map from the first non-degenerate triangle. Exact for a
 *  rigidly transformed grid; a single-affine approximation for a deformed mesh. Null when
 *  there are no UVs or no usable triangle. Shared by the SkinCanvas backdrop + the Parts
 *  inspector (both read the part's orientation from this map). */
export function uvToPosAffine(verts: number[][], uvs: number[][], tris: number[]): { m00: number; m01: number; m10: number; m11: number; tx: number; ty: number } | null {
  if (uvs.length !== verts.length || tris.length < 3) return null;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const uv0 = uvs[tris[t]], uv1 = uvs[tris[t + 1]], uv2 = uvs[tris[t + 2]];
    const p0 = verts[tris[t]], p1 = verts[tris[t + 1]], p2 = verts[tris[t + 2]];
    if (!uv0 || !uv1 || !uv2 || !p0 || !p1 || !p2) continue;
    const e1x = uv1[0] - uv0[0], e1y = uv1[1] - uv0[1];
    const e2x = uv2[0] - uv0[0], e2y = uv2[1] - uv0[1];
    const det = e1x * e2y - e2x * e1y;
    if (Math.abs(det) < 1e-9) continue; // collinear UVs → skip
    const f1x = p1[0] - p0[0], f1y = p1[1] - p0[1];
    const f2x = p2[0] - p0[0], f2y = p2[1] - p0[1];
    const m00 = (f1x * e2y - f2x * e1y) / det, m01 = (-f1x * e2x + f2x * e1x) / det;
    const m10 = (f1y * e2y - f2y * e1y) / det, m11 = (-f1y * e2x + f2y * e1x) / det;
    return { m00, m01, m10, m11, tx: p0[0] - (m00 * uv0[0] + m01 * uv0[1]), ty: p0[1] - (m10 * uv0[0] + m11 * uv0[1]) };
  }
  return null;
}

/** The part's rotation (radians) — the angle of the UV→vert affine's x-axis. 0 for a fresh
 *  (unrotated) grid; tracks the Parts-mode rotate gizmo. Null when no affine is derivable. */
export function partAngle(verts: number[][], uvs: number[][], tris: number[]): number | null {
  const a = uvToPosAffine(verts, uvs, tris);
  return a ? Math.atan2(a.m10, a.m00) : null;
}
