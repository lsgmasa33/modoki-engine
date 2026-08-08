/** Active-part view helpers for the Skin editor (Phase 8c). A v1 rig behaves as a single
 *  implicit part (top-level fields); a v2 rig exposes parts[idx]; writes target the right
 *  place. Pure — no DOM. */

import { describe, it, expect } from 'vitest';
import { activePartOf, withActivePart, partCount, partsOf, clampPart, ensurePartsArray, addPart, removePart, reorderPart, reorderActiveIndex, reorderIsNoop, renamePart, setPartVisible, uvToPosAffine, partAngle, bboxCenter } from '../../src/editor/panels/skinParts';
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


    it('rename + visibility target one part', () => {
      expect(renamePart(v2, 1, 'B!').parts![1].name).toBe('B!');
      expect(setPartVisible(v2, 0, false).parts![0].visible).toBe(false);
      expect(setPartVisible(v2, 0, false).parts![1].visible).toBeUndefined();
    });

    // Fixture: a 5-part def, one part per letter, already in canonical order (order === index).
    const makeParts = (names: string[]): Rig2DFile => ({
      bones: [],
      parts: names.map((name, i) => ({ name, sprite: `s${name}`, mesh: { verts: [[i, i]] }, skinIndices: [0], skinWeights: [1], order: i })),
    });

    describe('reorderPart', () => {
      const def = makeParts(['a', 'b', 'c', 'd', 'e']);

      it('moves forward (from < to)', () => {
        const r = reorderPart(def, 0, 3);
        expect(r.parts!.map((p) => p.name)).toEqual(['b', 'c', 'd', 'a', 'e']);
        expect(r.parts!.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]); // reindexed to array position
      });

      it('moves backward (from > to)', () => {
        const r = reorderPart(def, 3, 0);
        expect(r.parts!.map((p) => p.name)).toEqual(['d', 'a', 'b', 'c', 'e']);
      });

      it('moves adjacent', () => {
        const r = reorderPart(def, 1, 2);
        expect(r.parts!.map((p) => p.name)).toEqual(['a', 'c', 'b', 'd', 'e']);
      });

      it('no-ops: from === to, or either index out of range', () => {
        // toBe (reference equality), not toEqual: a from===to reorder that fell through to the
        // splice path would splice the part out and back in at the same spot, which LOOKS
        // identical under deep-equal — the no-op has to return the same object to be provably
        // a no-op (and to match reorderActiveIndex's untouched active index).
        const unchanged = ensurePartsArray(def); // v2 already has parts -> same ref as `def`
        expect(reorderPart(def, 2, 2)).toBe(unchanged);
        expect(reorderPart(def, -1, 2)).toBe(unchanged);
        expect(reorderPart(def, 2, -1)).toBe(unchanged);
        expect(reorderPart(def, 5, 2)).toBe(unchanged);
        expect(reorderPart(def, 2, 5)).toBe(unchanged);
      });

      it('does not mutate the input def', () => {
        const before = JSON.parse(JSON.stringify(def));
        reorderPart(def, 0, 3);
        expect(def).toEqual(before);
      });
    });

    describe('reorderIsNoop', () => {
      // Exported (not module-private) on purpose: it is the single definition of "this reorder
      // changes nothing", and both reorderPart and reorderActiveIndex read it so they cannot drift.
      // Testing it directly pins that definition rather than inferring it through the pair.
      it('true for an equal or out-of-range index, false for a real move', () => {
        expect(reorderIsNoop(5, 2, 2)).toBe(true);
        expect(reorderIsNoop(5, -1, 2)).toBe(true);
        expect(reorderIsNoop(5, 2, -1)).toBe(true);
        expect(reorderIsNoop(5, 5, 2)).toBe(true);
        expect(reorderIsNoop(5, 2, 5)).toBe(true);
        expect(reorderIsNoop(5, 0, 4)).toBe(false);
      });

      it('every index is a no-op against an empty list', () => {
        expect(reorderIsNoop(0, 0, 0)).toBe(true);
      });
    });

    describe('reorderActiveIndex', () => {
      const N = 5;

      it('active === from -> lands at to', () => {
        expect(reorderActiveIndex(1, 1, 3, N)).toBe(3);
      });

      it('from < active <= to -> shifts back one (closed the gap the move left behind)', () => {
        expect(reorderActiveIndex(2, 1, 3, N)).toBe(1);
      });

      it('to <= active < from -> shifts forward one (pushed aside by the incoming part)', () => {
        expect(reorderActiveIndex(2, 3, 1, N)).toBe(3);
      });

      it('otherwise unchanged', () => {
        expect(reorderActiveIndex(4, 0, 1, N)).toBe(4);
      });

      // -1 is "nothing selected" and is REACHABLE, not hypothetical: `setActiveSkinPart` clamps to
      // >= -1 and the store starts there (editorStore). A reorder must not invent a selection out
      // of it — none of the three shift branches fire for a negative active, which is the behaviour
      // being pinned here rather than an accident to preserve.
      it('no selection (-1) stays no selection through a reorder', () => {
        expect(reorderActiveIndex(-1, 0, 3, N)).toBe(-1);
        expect(reorderActiveIndex(-1, 3, 0, N)).toBe(-1);
      });

      it('no-op agreement with reorderPart: out-of-range or equal from/to leaves active unchanged', () => {
        expect(reorderActiveIndex(2, 2, 2, N)).toBe(2);
        expect(reorderActiveIndex(2, -1, 3, N)).toBe(2);
        expect(reorderActiveIndex(0, 0, -1, N)).toBe(0); // previously returned -1 verbatim; now a no-op
        expect(reorderActiveIndex(2, 5, 3, N)).toBe(2);
        expect(reorderActiveIndex(2, 3, 5, N)).toBe(2);
      });
    });

    it('reorderPart + reorderActiveIndex agree for every (from, to, active) — the part that was at `active` stays selected', () => {
      const def = makeParts(['a', 'b', 'c', 'd', 'e']);
      const N = 5;
      const indices = [-1, 0, 1, 2, 3, 4, 5]; // includes out-of-range extras per the brief
      for (const from of indices) {
        for (const to of indices) {
          for (let active = 0; active < N; active++) {
            const nameBefore = def.parts![active].name;
            const after = reorderPart(def, from, to);
            const na = reorderActiveIndex(active, from, to, N);
            expect(after.parts![na].name).toBe(nameBefore);
          }
        }
      }
    });
  });

  describe('uvToPosAffine', () => {
    it('identity grid -> identity affine', () => {
      const verts = [[0, 0], [1, 0], [0, 1]];
      const uvs = [[0, 0], [1, 0], [0, 1]];
      const a = uvToPosAffine(verts, uvs, [0, 1, 2]);
      expect(a).not.toBeNull();
      expect(a!.m00).toBeCloseTo(1); expect(a!.m01).toBeCloseTo(0);
      expect(a!.m10).toBeCloseTo(0); expect(a!.m11).toBeCloseTo(1);
      expect(a!.tx).toBeCloseTo(0); expect(a!.ty).toBeCloseTo(0);
    });

    it('translated grid -> identity linear part + translation', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      const verts = uvs.map(([x, y]) => [x + 5, y + 3]);
      const a = uvToPosAffine(verts, uvs, [0, 1, 2]);
      expect(a).not.toBeNull();
      expect(a!.m00).toBeCloseTo(1); expect(a!.m01).toBeCloseTo(0);
      expect(a!.m10).toBeCloseTo(0); expect(a!.m11).toBeCloseTo(1);
      expect(a!.tx).toBeCloseTo(5); expect(a!.ty).toBeCloseTo(3);
    });

    it('90-degree-rotated grid -> rotation matrix', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      // verts = R(90ccw) * uvs
      const verts = [[0, 0], [0, 1], [-1, 0]];
      const a = uvToPosAffine(verts, uvs, [0, 1, 2]);
      expect(a).not.toBeNull();
      expect(a!.m00).toBeCloseTo(0); expect(a!.m01).toBeCloseTo(-1);
      expect(a!.m10).toBeCloseTo(1); expect(a!.m11).toBeCloseTo(0);
      expect(a!.tx).toBeCloseTo(0); expect(a!.ty).toBeCloseTo(0);
    });

    it('scaled grid -> scale matrix', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      const verts = uvs.map(([x, y]) => [x * 2, y * 2]);
      const a = uvToPosAffine(verts, uvs, [0, 1, 2]);
      expect(a).not.toBeNull();
      expect(a!.m00).toBeCloseTo(2); expect(a!.m01).toBeCloseTo(0);
      expect(a!.m10).toBeCloseTo(0); expect(a!.m11).toBeCloseTo(2);
      expect(a!.tx).toBeCloseTo(0); expect(a!.ty).toBeCloseTo(0);
    });

    it('null when uvs.length !== verts.length', () => {
      expect(uvToPosAffine([[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 0]], [0, 1, 2])).toBeNull();
    });

    it('null when tris.length < 3', () => {
      expect(uvToPosAffine([[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 0], [0, 1]], [0, 1])).toBeNull();
    });

    it('skips a first triangle with collinear UVs and uses the next usable one', () => {
      // Triangle 0 (indices 0,1,2) has collinear UVs -> degenerate, skipped.
      // Triangle 1 (indices 3,4,5) is a good identity triangle.
      const verts = [[0, 0], [1, 0], [2, 0], [0, 0], [1, 0], [0, 1]];
      const uvs = [[0, 0], [1, 0], [2, 0], [0, 0], [1, 0], [0, 1]];
      const a = uvToPosAffine(verts, uvs, [0, 1, 2, 3, 4, 5]);
      expect(a).not.toBeNull(); // returns the affine from the second triangle, not null
      expect(a!.m00).toBeCloseTo(1); expect(a!.m11).toBeCloseTo(1);
    });

    it('null when no triangle is usable (all collinear)', () => {
      const verts = [[0, 0], [1, 0], [2, 0]];
      const uvs = [[0, 0], [1, 0], [2, 0]];
      expect(uvToPosAffine(verts, uvs, [0, 1, 2])).toBeNull();
    });
  });

  describe('partAngle', () => {
    it('0 for a fresh unrotated grid', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      expect(partAngle(uvs, uvs, [0, 1, 2])).toBeCloseTo(0);
    });

    it('+90 degrees for a CCW-rotated grid', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      const verts = [[0, 0], [0, 1], [-1, 0]];
      expect(partAngle(verts, uvs, [0, 1, 2])).toBeCloseTo(Math.PI / 2);
    });

    it('-90 degrees for a CW-rotated grid', () => {
      const uvs = [[0, 0], [1, 0], [0, 1]];
      const verts = [[0, 0], [0, -1], [1, 0]];
      expect(partAngle(verts, uvs, [0, 1, 2])).toBeCloseTo(-Math.PI / 2);
    });

    it('null when uvToPosAffine returns null', () => {
      expect(partAngle([[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 0], [0, 1]], [0, 1])).toBeNull();
    });
  });

  describe('bboxCenter', () => {
    it('centre of a normal vertex list', () => {
      expect(bboxCenter([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual({ x: 1, y: 1 });
    });

    it('a single vertex is its own centre', () => {
      expect(bboxCenter([[3, 4]])).toEqual({ x: 3, y: 4 });
    });

    // Deliberately null (not {0,0}) for an empty mesh — see bboxCenter's doc comment: SkinCanvas
    // wants null ("no gizmo to place"), SkinEditor applies its own `?? {x:0,y:0}` fallback at the
    // call site rather than have this helper decide for both.
    it('null for an empty vertex list', () => {
      expect(bboxCenter([])).toBeNull();
    });
  });
});
