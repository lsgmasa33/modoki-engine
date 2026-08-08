/** Pure rig bone-list edits — add/remove with parent-index + skin-weight remapping. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { addBone, removeBone, reparentBone } from '../../src/runtime/skinning/rig2dEdit';
import { deriveBindMatrices } from '../../src/runtime/skinning/rig2dMath';
import { type Rig2DFile, normalizeRig2D, resetRig2DWarningsForTests } from '../../src/runtime/loaders/rig2dCache';

// root → mid → tip; one vertex split 0.2/0.3/0.5 across them.
const rig = (): Rig2DFile => ({
  id: 'g', sprite: 's',
  bones: [
    { name: 'root', parent: -1, x: 0, y: 0, rot: 0 },
    { name: 'mid', parent: 0, x: 0, y: 10, rot: 0 },
    { name: 'tip', parent: 1, x: 0, y: 20, rot: 0 },
  ],
  mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
  skinIndices: [0, 1, 2, 0],
  skinWeights: [0.2, 0.3, 0.5, 0],
});

const wByBone = (r: Rig2DFile) => {
  const m = new Map<number, number>();
  for (let k = 0; k < 4; k++) { const w = r.skinWeights![k]; if (w > 0) m.set(r.skinIndices![k], (m.get(r.skinIndices![k]) ?? 0) + w); }
  return m;
};

describe('addBone', () => {
  it('appends a child with a unique name; weights unchanged', () => {
    const r = addBone(rig(), 1, 5, 7);
    expect(r.index).toBe(3);
    expect(r.def.bones![3]).toMatchObject({ parent: 1, x: 5, y: 7 });
    expect(r.def.bones![3].name).toBe('bone1'); // root/mid/tip taken
    expect(r.def.skinWeights).toEqual([0.2, 0.3, 0.5, 0]);
  });
});

describe('removeBone', () => {
  it('reparents children, shifts indices, transfers weights to the parent', () => {
    const r = removeBone(rig(), 1); // remove 'mid'
    expect(r.bones!.map((b) => b.name)).toEqual(['root', 'tip']);
    expect(r.bones![1].parent).toBe(0); // tip reparented to root, index 2→1
    const w = wByBone(r);
    expect(w.get(0)).toBeCloseTo(0.5, 5); // root: 0.2 + mid's transferred 0.3
    expect(w.get(1)).toBeCloseTo(0.5, 5); // tip at its new index
  });

  it('dropping a root bone drops its weight and renormalizes the rest', () => {
    const r = removeBone(rig(), 0); // remove 'root'
    expect(r.bones!.map((b) => b.name)).toEqual(['mid', 'tip']);
    expect(r.bones![0].parent).toBe(-1); // mid becomes a root
    const w = wByBone(r);
    expect(w.get(0)).toBeCloseTo(0.3 / 0.8, 5); // mid, renormalized (root's 0.2 dropped)
    expect(w.get(1)).toBeCloseTo(0.5 / 0.8, 5); // tip
  });
});

// A v2 (multi-part) rig over the SAME root→mid→tip skeleton. The two parts are weighted to
// DIFFERENT bones on purpose: that is what makes a missed renumber visible, and it is the case the
// v1 fixture above structurally cannot express. Note there are no top-level mesh/skinIndices —
// `ensurePartsArray` strips them when a rig becomes v2, which is exactly why the old code, reading
// only those fields, saw an empty mesh and did nothing (#179).
const rigV2 = (): Rig2DFile => ({
  id: 'g',
  bones: [
    { name: 'root', parent: -1, x: 0, y: 0, rot: 0 },
    { name: 'mid', parent: 0, x: 0, y: 10, rot: 0 },
    { name: 'tip', parent: 1, x: 0, y: 20, rot: 0 },
  ],
  parts: [
    // one vertex bound entirely to 'tip' (index 2)
    { name: 'a', sprite: 'sa', mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [2, 0, 0, 0], skinWeights: [1, 0, 0, 0], order: 0 },
    // two vertices bound entirely to 'mid' (index 1) — a DIFFERENT bone, and a different vert count
    { name: 'b', sprite: 'sb', mesh: { verts: [[1, 1], [2, 2]], uvs: [[0, 0], [0, 0]], tris: [] }, skinIndices: [1, 0, 0, 0, 1, 0, 0, 0], skinWeights: [1, 0, 0, 0, 1, 0, 0, 0], order: 1 },
  ],
});

/** Which bone index carries vertex `v`'s whole weight, for a part. */
const soleBone = (part: { skinIndices?: number[]; skinWeights?: number[] }, v = 0) => {
  for (let k = 0; k < 4; k++) if ((part.skinWeights![v * 4 + k] ?? 0) > 0) return part.skinIndices![v * 4 + k];
  return -1;
};

describe('removeBone on a v2 (multi-part) rig — #179', () => {
  it('renumbers EVERY part, not just the top-level v1 fields', () => {
    const r = removeBone(rigV2(), 0); // remove 'root' → mid 1→0, tip 2→1
    expect(r.bones!.map((b) => b.name)).toEqual(['mid', 'tip']);
    // Part 'a' was on tip (2) → must follow it to 1. Before the fix it stayed at 2, which
    // normalizePart then clamps to bone 0 on load — the vertex snaps to the root.
    expect(soleBone(r.parts![0])).toBe(1);
    // Part 'b' was on mid (1) → must follow it to 0. Before the fix it stayed at 1, silently
    // deforming with 'tip' instead.
    expect(soleBone(r.parts![1])).toBe(0);
    expect(soleBone(r.parts![1], 1)).toBe(0); // its SECOND vertex too — per-part vert counts differ
  });

  it('a deleted bone transfers its weight to its parent, per part', () => {
    const r = removeBone(rigV2(), 1); // remove 'mid' → its weight goes to 'root' (0), tip 2→1
    expect(r.bones!.map((b) => b.name)).toEqual(['root', 'tip']);
    expect(soleBone(r.parts![0])).toBe(1);  // 'a' followed tip
    expect(soleBone(r.parts![1])).toBe(0);  // 'b' transferred from mid up to root
    expect(r.parts![1].skinWeights![0]).toBeCloseTo(1, 5); // renormalized, still fully bound
  });

  it('a deleted ROOT drops the weights bound to it and renormalizes what is left', () => {
    const d = rigV2();
    // Split part 'a' across root (0.25) and tip (0.75); dropping root must renormalize to 1.
    d.parts![0].skinIndices = [0, 2, 0, 0];
    d.parts![0].skinWeights = [0.25, 0.75, 0, 0];
    const r = removeBone(d, 0);
    expect(soleBone(r.parts![0])).toBe(1);                       // only tip survives, at its new index
    expect(r.parts![0].skinWeights![0]).toBeCloseTo(1, 5);       // 0.75 renormalized back to 1
  });

  // Found by the close-out review of the fix itself. A vertex bound ENTIRELY to the deleted bone
  // left all four slots at zero. The load path repairs that (normalizePart's degenerate branch), so
  // it looked fine — but the EDITOR deforms from the raw def, and SkinCanvas.deformMesh skips every
  // zero-weight term, so the vertex collapsed to the local origin until the panel was reopened.
  it('a vertex bound ENTIRELY to the deleted bone falls back to bone 0, not to all-zero weights', () => {
    const d = rigV2();
    d.parts![0].skinIndices = [0, 0, 0, 0];   // part 'a' is 100% on 'root'...
    d.parts![0].skinWeights = [1, 0, 0, 0];
    const r = removeBone(d, 0);               // ...which is the bone being deleted
    expect(r.parts![0].skinWeights![0]).toBe(1);
    expect(r.parts![0].skinIndices![0]).toBe(0);
  });

  // The invariant behind that fix, stated directly: what removeBone produces must survive a load
  // unchanged, or the live preview and the reloaded rig disagree about the same file.
  it('removeBone output NORMALIZES TO ITSELF — the preview and the reloaded rig agree', () => {
    const d = rigV2();
    d.parts![0].skinIndices = [0, 0, 0, 0];
    d.parts![0].skinWeights = [1, 0, 0, 0];
    const r = removeBone(d, 0);
    const loaded = normalizeRig2D(r);
    const part = loaded.parts.find((p) => p.name === 'a')!;
    expect(Array.from(part.skinWeights.slice(0, 4))).toEqual(Array.from(r.parts![0].skinWeights!.slice(0, 4)));
    expect(Array.from(part.skinIndices.slice(0, 4))).toEqual(Array.from(r.parts![0].skinIndices!.slice(0, 4)));
  });

  it('a NaN weight is skipped, not summed — it must not zero the vertex it shares', () => {
    const d = rigV2();
    // vertex 0: a NaN on 'root' beside a real 0.5 on 'tip'. `w <= 0` would let the NaN through,
    // poison the sum, and drop BOTH — taking the valid bucket with it.
    d.parts![0].skinIndices = [0, 2, 0, 0];
    d.parts![0].skinWeights = [NaN, 0.5, 0, 0];
    const r = removeBone(d, 1);               // remove 'mid' — neither bound bone is deleted
    expect(soleBone(r.parts![0])).toBe(1);    // 'tip', at its new index
    expect(r.parts![0].skinWeights![0]).toBeCloseTo(1, 5);
  });

  it('leaves the v1 top-level fields alone on a v2 rig instead of inventing empty arrays', () => {
    const r = removeBone(rigV2(), 1);
    // normalizeRig2D ignores these whenever `parts` is present, so writing a [] computed from an
    // absent `def.mesh` would be fabricating data — and it is what hid the bug.
    expect(r.skinIndices).toBeUndefined();
    expect(r.skinWeights).toBeUndefined();
  });

  it('a part with no mesh is passed through untouched', () => {
    const d = rigV2();
    d.parts!.push({ name: 'empty', sprite: 'se', order: 2 });
    const r = removeBone(d, 1);
    expect(r.parts![2]).toEqual({ name: 'empty', sprite: 'se', order: 2 });
  });
});

// THE SEAM. Unit-testing removeBone proves the arithmetic; it does not prove the rig still LOADS
// correctly, and loading is where #179 actually showed itself — `normalizePart` clamps an index
// past the end of the skeleton to bone 0, so a stale rig renders wrong rather than failing. These
// drive the real path: edit → normalize, the same order the editor does it (commit → save → load).
describe('removeBone → normalizeRig2D (the load path) — #179', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The warn is de-duped for the whole session (see rig2dTypes), so one test's corrupt rig would
  // otherwise silence the next one's — the reset is what keeps these independent.
  afterEach(() => { warn.mockClear(); resetRig2DWarningsForTests(); });

  it('an edited rig loads with every part still on the bone it was bound to, and warns about nothing', () => {
    const parsed = normalizeRig2D(removeBone(rigV2(), 0)); // drop 'root'
    expect(parsed.bones.map((b) => b.name)).toEqual(['mid', 'tip']);
    // 'a' was on tip, 'b' on mid — both must have followed their bone down one index.
    const byName = new Map(parsed.parts.map((p) => [p.name, p]));
    expect(byName.get('a')!.skinIndices[0]).toBe(1);
    expect(byName.get('b')!.skinIndices[0]).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE PER PART, naming it, when weights outrun the skeleton', () => {
    // Exactly the state the old removeBone left behind: bones renumbered, parts not.
    const stale = rigV2();
    stale.bones = stale.bones!.slice(0, 2);          // skeleton shrinks to root+mid...
    // ...while part 'a' still references bone 2 (gone) and 'b' stays valid on bone 1.
    const parsed = normalizeRig2D(stale);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('part "a"');
    expect(msg).toContain('2 bones');
    // Clamped, not dropped — the rig still has to render.
    expect(parsed.parts.find((p) => p.name === 'a')!.skinIndices[0]).toBe(0);
  });

  // WHY the dedupe exists: normalizeRig2D is NOT load-only. The editor's `applySkinDef` calls
  // setRig2D → normalizeRig2D on every edit, and its own comment says it is "safe to call per paint
  // move" — so dragging the weight brush across a corrupt rig re-normalizes it tens of times a
  // second. Un-deduped, the one actionable message becomes a wall of identical lines.
  it('re-normalizing the same corrupt rig (a paint drag) warns ONCE, not once per call', () => {
    const stale = rigV2();
    stale.bones = stale.bones!.slice(0, 2);
    for (let i = 0; i < 30; i++) normalizeRig2D(stale);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a rig that gets WORSE reports again rather than being silenced by the first report', () => {
    const stale = rigV2();
    stale.bones = stale.bones!.slice(0, 2);
    normalizeRig2D(stale);                       // part 'a': 1 bad index
    expect(warn).toHaveBeenCalledTimes(1);
    stale.parts![0].skinIndices = [2, 5, 0, 0];  // ...now 2 of them
    stale.parts![0].skinWeights = [0.5, 0.5, 0, 0];
    normalizeRig2D(stale);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // A rig with a mesh but NO bones yet is a normal authoring state (tessellate, then rig). Every
  // vertex defaults to index 0, which is out of range against an empty bone list — so an unguarded
  // check would warn on an unrigged mesh and blame a bone edit that never happened.
  it('says nothing about a mesh that has no bones yet', () => {
    const unrigged = rigV2();
    unrigged.bones = [];
    normalizeRig2D(unrigged);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn per VERTEX — a corrupted part reports once however many verts it has', () => {
    const stale = rigV2();
    stale.bones = stale.bones!.slice(0, 1);          // only 'root' survives
    stale.parts![1].mesh = { verts: [[0, 0], [1, 1], [2, 2], [3, 3]], uvs: [[0, 0], [0, 0], [0, 0], [0, 0]], tris: [] };
    stale.parts![1].skinIndices = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    stale.parts![1].skinWeights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    normalizeRig2D(stale);
    expect(warn).toHaveBeenCalledTimes(2); // one per bad PART (a and b), not one per bad vertex
    expect(String(warn.mock.calls[1][0])).toContain('4 vertex weight(s)');
  });
});

describe('reparentBone', () => {
  it('preserves the joint world position under the new parent', () => {
    // root(0,0) → mid(local 0,10 = world 0,10) → tip(local 0,20 = world 0,30).
    const r = reparentBone(rig(), 2, 0); // tip → child of root
    expect(r.bones![2].parent).toBe(0);
    const { rootLocal } = deriveBindMatrices(r.bones!.map((b) => ({ parent: b.parent!, x: b.x!, y: b.y!, rot: b.rot! })));
    expect(rootLocal[2].e).toBeCloseTo(0, 5); // world origin unchanged
    expect(rootLocal[2].f).toBeCloseTo(30, 5);
  });

  it('rejects a cycle (parenting a bone under its own descendant)', () => {
    const before = rig();
    const r = reparentBone(before, 0, 2); // root under tip — would cycle
    expect(r).toBe(before); // unchanged
  });
});
