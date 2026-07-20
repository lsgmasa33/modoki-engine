/** Active-part view helpers for the Skin editor (Phase 8c). A v1 rig behaves as a single
 *  implicit part (top-level fields); a v2 rig exposes parts[idx]; writes target the right
 *  place. Pure — no DOM. */

import { describe, it, expect } from 'vitest';
import { activePartOf, withActivePart, partCount, partsOf, clampPart, ensurePartsArray, addPart, removePart, movePart, renamePart, setPartVisible } from '../../src/editor/panels/skinParts';
import type { Rig2DFile } from '../../src/runtime/loaders/rig2dCache';

const v1: Rig2DFile = { sprite: 'tex', bones: [], mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] }, skinIndices: [0], skinWeights: [1] };
const v2: Rig2DFile = {
  bones: [],
  parts: [
    { name: 'a', sprite: 'sa', mesh: { verts: [[1, 1]] }, skinIndices: [0], skinWeights: [1] },
    { name: 'b', sprite: 'sb', mesh: { verts: [[2, 2]] }, skinIndices: [1], skinWeights: [1] },
  ],
};

describe('skinParts', () => {
  it('counts parts (v1 = 1, v2 = N)', () => {
    expect(partCount(v1)).toBe(1);
    expect(partCount(v2)).toBe(2);
    expect(partsOf(v2).map((p) => p.name)).toEqual(['a', 'b']);
    expect(partsOf(v1)[0].name).toBe('main');
  });

  it('reads the active part (v1 top-level, v2 indexed, clamped)', () => {
    expect(activePartOf(v1, 0).sprite).toBe('tex');
    expect(activePartOf(v2, 0).sprite).toBe('sa');
    expect(activePartOf(v2, 1).sprite).toBe('sb');
    expect(activePartOf(v2, 9).sprite).toBe('sb'); // clamped to last
    expect(clampPart(v2, 9)).toBe(1);
  });

  it('writes to the active part without touching the others', () => {
    const w = withActivePart(v2, 1, { sprite: 'sX' });
    expect(w.parts![1].sprite).toBe('sX');
    expect(w.parts![0].sprite).toBe('sa'); // part 0 untouched
    expect(w.parts![1].mesh).toEqual(v2.parts![1].mesh); // other fields preserved
    // v1 writes the top-level.
    expect(withActivePart(v1, 0, { sprite: 'sY' }).sprite).toBe('sY');
  });

  describe('structural edits', () => {
    it('ensurePartsArray converts v1 → one-part v2 (top-level fields moved into parts[0])', () => {
      const d = ensurePartsArray(v1);
      expect(d.parts).toHaveLength(1);
      expect(d.parts![0]).toMatchObject({ name: 'main', sprite: 'tex' });
      expect(d.sprite).toBeUndefined(); // top-level stripped
      expect(ensurePartsArray(v2)).toBe(v2); // v2 unchanged (same ref)
    });

    it('addPart appends a new empty part (front-most) + returns its index; converts v1', () => {
      const { def, index } = addPart(v1);
      expect(def.parts).toHaveLength(2);
      expect(index).toBe(1);
      expect(def.parts![1].order).toBe(1); // order = array index (drawn in front)
    });

    it('removePart drops a part + reindexes order; keeps at least one', () => {
      const d = removePart(v2, 0);
      expect(d.parts!.map((p) => p.name)).toEqual(['b']);
      expect(d.parts![0].order).toBe(0);
      expect(removePart(v1, 0).parts).toHaveLength(1); // never empties
    });

    it('movePart swaps draw order', () => {
      const d = movePart(v2, 0, 1); // move 'a' front
      expect(d.parts!.map((p) => p.name)).toEqual(['b', 'a']);
      expect(d.parts!.map((p) => p.order)).toEqual([0, 1]);
      expect(movePart(v2, 0, -1)).toEqual(ensurePartsArray(v2)); // clamped at edge (no-op)
    });

    it('rename + visibility target one part', () => {
      expect(renamePart(v2, 1, 'B!').parts![1].name).toBe('B!');
      expect(setPartVisible(v2, 0, false).parts![0].visible).toBe(false);
      expect(setPartVisible(v2, 0, false).parts![1].visible).toBeUndefined();
    });
  });
});
