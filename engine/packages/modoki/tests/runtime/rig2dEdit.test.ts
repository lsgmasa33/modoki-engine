/** Pure rig bone-list edits — add/remove with parent-index + skin-weight remapping. */

import { describe, it, expect } from 'vitest';
import { addBone, removeBone, reparentBone } from '../../src/runtime/skinning/rig2dEdit';
import { deriveBindMatrices } from '../../src/runtime/skinning/rig2dMath';
import { type Rig2DFile } from '../../src/runtime/loaders/rig2dCache';

// root → mid → tip; one vertex split 0.2/0.3/0.5 across them.
const rig = (): Rig2DFile => ({
  id: 'g', version: 1, sprite: 's',
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
