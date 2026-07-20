/** Weight painting — pure per-vertex weight adjustment. Verifies the "add" semantics,
 *  the <=4 influence cap + renormalization, brush falloff/masking, and the heatmap field. */

import { describe, it, expect } from 'vitest';
import { paintWeights, boneWeightField, dominantBoneField } from '../../src/runtime/skinning/rig2dWeightPaint';

// Two verts, each fully bound to bone 0.
const base = {
  verts: [[0, 0], [100, 0]] as number[][],
  skinIndices: [0, 0, 0, 0, 0, 0, 0, 0],
  skinWeights: [1, 0, 0, 0, 1, 0, 0, 0],
};

const weightOfBone = (idx: number[], w: number[], v: number, bone: number) => {
  let s = 0;
  for (let i = 0; i < 4; i++) if (idx[v * 4 + i] === bone) s += w[v * 4 + i];
  return s;
};

describe('paintWeights', () => {
  it('paints bone 1 into the vertex under the brush, leaving the far vertex untouched', () => {
    const r = paintWeights({ ...base, boneIndex: 1, center: [0, 0], radius: 40, strength: 1 });
    // Vertex 0 (at brush center) now fully bone 1; vertex 1 (100px away) unchanged.
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 1)).toBeCloseTo(1, 5);
    expect(weightOfBone(r.skinIndices, r.skinWeights, 1, 0)).toBeCloseTo(1, 5);
    expect(weightOfBone(r.skinIndices, r.skinWeights, 1, 1)).toBe(0);
  });

  it('each vertex still sums to 1 after painting', () => {
    const r = paintWeights({ ...base, boneIndex: 2, center: [0, 0], radius: 200, strength: 0.5 });
    for (let v = 0; v < 2; v++) {
      const s = r.skinWeights[v * 4] + r.skinWeights[v * 4 + 1] + r.skinWeights[v * 4 + 2] + r.skinWeights[v * 4 + 3];
      expect(s).toBeCloseTo(1, 5);
    }
  });

  it('partial strength blends toward the target without fully replacing', () => {
    const r = paintWeights({ ...base, boneIndex: 1, center: [0, 0], radius: 40, strength: 0.5 });
    const w1 = weightOfBone(r.skinIndices, r.skinWeights, 0, 1);
    expect(w1).toBeGreaterThan(0);
    expect(w1).toBeLessThan(1);
    expect(w1).toBeCloseTo(0.5, 5); // wt' = 0 + (1-0)*0.5
  });

  it('smooth falloff paints the center more than the edge', () => {
    const verts = [[0, 0], [30, 0]]; // center + near-edge (radius 40)
    const r = paintWeights({
      verts, skinIndices: base.skinIndices, skinWeights: base.skinWeights,
      boneIndex: 1, center: [0, 0], radius: 40, strength: 1, falloff: 'smooth',
    });
    const cen = weightOfBone(r.skinIndices, r.skinWeights, 0, 1);
    const edge = weightOfBone(r.skinIndices, r.skinWeights, 1, 1);
    expect(cen).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
  });

  it('caps at 4 influences, evicting the smallest', () => {
    // A vertex already has 4 bones; paint a 5th → smallest dropped, sum stays 1.
    const r = paintWeights({
      verts: [[0, 0]],
      skinIndices: [0, 1, 2, 3],
      skinWeights: [0.4, 0.3, 0.2, 0.1],
      boneIndex: 4, center: [0, 0], radius: 10, strength: 1,
    });
    const s = r.skinWeights[0] + r.skinWeights[1] + r.skinWeights[2] + r.skinWeights[3];
    expect(s).toBeCloseTo(1, 5);
    // Strength 1 makes bone 4 dominant; the smallest original (bone 3) is evicted.
    expect(new Set(r.skinIndices).has(3)).toBe(false);
    expect(new Set(r.skinIndices).has(4)).toBe(true);
  });

  it('subtract mode (eraser) shrinks the target bone and grows the others', () => {
    // A vertex split 50/50 between bone 0 and bone 1; erase bone 1 fully.
    const r = paintWeights({
      verts: [[0, 0]], skinIndices: [0, 1, 0, 0], skinWeights: [0.5, 0.5, 0, 0],
      boneIndex: 1, center: [0, 0], radius: 10, strength: 1, mode: 'subtract',
    });
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 1)).toBeCloseTo(0, 5); // erased
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 0)).toBeCloseTo(1, 5); // grew to fill
  });

  it('erasing a SOLE-influence vertex hands the weight to the nearest other bone', () => {
    // Vertex at (0,0) fully bone 1; nearest OTHER bone is 2 (dist 50 < bone 0 dist 100).
    const r = paintWeights({
      verts: [[0, 0]], skinIndices: [1, 0, 0, 0], skinWeights: [1, 0, 0, 0],
      boneIndex: 1, center: [0, 0], radius: 10, strength: 1, mode: 'subtract',
      bonePositions: [[0, -100], [0, 0], [0, 50]],
    });
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 1)).toBeCloseTo(0, 5); // erased
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 2)).toBeCloseTo(1, 5); // → nearest other
  });

  it('set mode blends the target bone toward the given weight (not toward 1)', () => {
    // Vertex fully bone 0; SET bone 1 to 0.3 → bone 1 = 0.3, bone 0 fills the rest.
    const r = paintWeights({
      verts: [[0, 0]], skinIndices: [0, 0, 0, 0], skinWeights: [1, 0, 0, 0],
      boneIndex: 1, center: [0, 0], radius: 10, strength: 0.3, falloff: 'constant', mode: 'set',
    });
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 1)).toBeCloseTo(0.3, 5);
    expect(weightOfBone(r.skinIndices, r.skinWeights, 0, 0)).toBeCloseTo(0.7, 5);
  });

  it('does not mutate the input arrays', () => {
    const idx = base.skinIndices.slice(), w = base.skinWeights.slice();
    paintWeights({ ...base, skinIndices: idx, skinWeights: w, boneIndex: 1, center: [0, 0], radius: 40, strength: 1 });
    expect(idx).toEqual(base.skinIndices);
    expect(w).toEqual(base.skinWeights);
  });
});

describe('boneWeightField', () => {
  it('extracts a single bone per-vertex weight for a heatmap', () => {
    const field = boneWeightField([0, 1, 0, 0, 1, 0, 0, 0], [0.6, 0.4, 0, 0, 1, 0, 0, 0], 1, 2);
    expect(field[0]).toBeCloseTo(0.4, 5);
    expect(field[1]).toBeCloseTo(1, 5);
  });
});

describe('dominantBoneField', () => {
  it('picks each vertex highest-weight bone index', () => {
    const idx = [2, 0, 1, 3, 5, 4, 0, 0];
    const w = [0.6, 0.3, 0.1, 0, 0.7, 0.3, 0, 0];
    expect(dominantBoneField(idx, w, 2)).toEqual([2, 5]);
  });
});
