/** SkinEditor's pure geometry/coercion helpers (#105 Phase 4 probe).
 *
 *  These were already at module scope and already pure — they simply had no tests,
 *  because nothing imported them. So this needed an `export` and a test file, NOT a
 *  refactor: zero behaviour risk, unlike the control-flow re-expression Phase 2's
 *  seams required.
 *
 *  All three are DEFENSIVE functions — they exist to survive malformed input (an
 *  empty mesh, a hand-edited `.rig2d.json`), and every one of those guards was
 *  unexercised. A wrong fallback here does not throw; it silently produces a mesh
 *  of the wrong size or a bone parented to the wrong index. */

import { describe, it, expect } from 'vitest';
import { meshBounds, centerOf } from '../../src/editor/panels/SkinEditor';
// THE one copy, in the runtime — the layer that owns the `.rig2d.json` format.
// There were FOUR (#128): SkinEditor's, SkinCanvas's, skinPrefab's, and this one.
import { coerceRigBones } from '../../src/runtime/skinning/rig2dTypes';

describe('meshBounds', () => {
  it('measures width/height from the vertex extent', () => {
    const b = meshBounds([[0, 0], [10, 4], [2, 2]]);
    expect(b.width).toBe(10);
    expect(b.height).toBe(4);
  });

  it('expresses the pivot as the ORIGIN\'s position within the bounds', () => {
    // Not the centre — the pivot is where texture-space (0,0) falls, as a
    // fraction. A mesh spanning -5..5 puts the origin at the middle.
    const b = meshBounds([[-5, -5], [5, 5]]);
    expect(b.pivotX).toBeCloseTo(0.5);
    expect(b.pivotY).toBeCloseTo(0.5);
  });

  it('puts the pivot at 0 when the mesh starts at the origin', () => {
    const b = meshBounds([[0, 0], [8, 8]]);
    expect(b.pivotX).toBe(0);
    expect(b.pivotY).toBe(0);
  });

  it('allows a pivot OUTSIDE 0..1 when the origin is off the mesh', () => {
    // Clamping would be wrong: a mesh entirely right of the origin genuinely has
    // its pivot to the left of itself, and Re-tessellate depends on that.
    const b = meshBounds([[10, 10], [20, 20]]);
    expect(b.pivotX).toBe(-1);
    expect(b.pivotY).toBe(-1);
  });

  it('falls back to a 64x64 centred box for an EMPTY mesh instead of Infinity', () => {
    // Without the isFinite guard this returns -Infinity extents and NaN pivots,
    // which would be written into the rig as a silently broken mesh.
    expect(meshBounds([])).toEqual({ width: 64, height: 64, pivotX: 0.5, pivotY: 0.5 });
  });

  it('guards a zero-extent mesh against divide-by-zero', () => {
    // A single vertex, or a perfectly vertical/horizontal line: extent 0 would
    // make the pivot NaN.
    const single = meshBounds([[3, 3]]);
    expect(single.width).toBe(1);
    expect(single.height).toBe(1);
    expect(Number.isNaN(single.pivotX)).toBe(false);

    const line = meshBounds([[0, 0], [0, 10]]);
    expect(line.width).toBe(1);
    expect(line.height).toBe(10);
  });

  it('handles negative-only meshes', () => {
    const b = meshBounds([[-20, -20], [-10, -10]]);
    expect(b.width).toBe(10);
    expect(b.pivotX).toBe(2);
  });
});

describe('centerOf', () => {
  it('is the bounding-box centre, not the vertex average', () => {
    // Three verts clustered left + one far right: the bbox centre is 5, the mean
    // is 1.25. Placement-preserving ops depend on the bbox.
    expect(centerOf([[0, 0], [0, 0], [0, 0], [10, 0]])).toEqual({ x: 5, y: 0 });
  });

  it('handles negative coordinates', () => {
    expect(centerOf([[-10, -4], [10, 4]])).toEqual({ x: 0, y: 0 });
  });

  it('returns the origin for an empty list rather than NaN', () => {
    expect(centerOf([])).toEqual({ x: 0, y: 0 });
  });

  it('returns the point itself for a single vertex', () => {
    expect(centerOf([[7, -3]])).toEqual({ x: 7, y: -3 });
  });
});

describe('coerceRigBones — coercing a hand-editable .rig2d.json', () => {
  it('fills every optional field with a default', () => {
    expect(coerceRigBones([{}] as never)).toEqual([{ name: 'bone0', parent: -1, x: 0, y: 0, rot: 0 }]);
  });

  it('names an unnamed bone by its INDEX, so names stay unique', () => {
    const got = coerceRigBones([{}, {}, {}] as never);
    expect(got.map((b) => b.name)).toEqual(['bone0', 'bone1', 'bone2']);
  });

  it('treats an empty-string name as missing', () => {
    expect(coerceRigBones([{ name: '' }] as never)[0].name).toBe('bone0');
  });

  it('keeps a real name', () => {
    expect(coerceRigBones([{ name: 'spine' }] as never)[0].name).toBe('spine');
  });

  it('rejects a NON-INTEGER parent, falling back to root', () => {
    // A float index would silently address the wrong bone in the weight solver.
    expect(coerceRigBones([{ parent: 1.5 }] as never)[0].parent).toBe(-1);
    expect(coerceRigBones([{ parent: '2' }] as never)[0].parent).toBe(-1);
    expect(coerceRigBones([{ parent: null }] as never)[0].parent).toBe(-1);
  });

  it('keeps a valid integer parent, including 0', () => {
    // 0 is a real bone index — a falsy check here would reparent to root.
    expect(coerceRigBones([{ parent: 0 }] as never)[0].parent).toBe(0);
    expect(coerceRigBones([{ parent: 3 }] as never)[0].parent).toBe(3);
  });

  it('preserves zero transform values rather than defaulting them', () => {
    // `?? 0` not `|| 0` — a bone legitimately at x:0 rot:0 must survive.
    expect(coerceRigBones([{ x: 0, y: 0, rot: 0 }] as never)[0]).toMatchObject({ x: 0, y: 0, rot: 0 });
    expect(coerceRigBones([{ x: -5, rot: 1.5 }] as never)[0]).toMatchObject({ x: -5, y: 0, rot: 1.5 });
  });

  it('accepts a missing bone list at all', () => {
    expect(coerceRigBones(undefined as never)).toEqual([]);
  });

  it('survives a `bones` that is present but not an array', () => {
    // `(raw ?? []).map(...)` — the shape the three editor copies had — throws here.
    expect(coerceRigBones({ 0: { name: 'spine' } } as never)).toEqual([]);
    expect(coerceRigBones('spine' as never)).toEqual([]);
  });

  it('survives a null entry INSIDE the bone list', () => {
    expect(coerceRigBones([null, { name: 'spine' }] as never))
      .toEqual([{ name: 'bone0', parent: -1, x: 0, y: 0, rot: 0 }, { name: 'spine', parent: -1, x: 0, y: 0, rot: 0 }]);
  });

  // ── The two the four copies had DRIFTED on (#128) ────────────────────────────
  // Both were invisible for as long as they were, because the editor's tests only
  // ever checked the editor's copy against itself. These assert the format
  // contract, so any future copy that skips them fails here.

  it('coerces a hand-typed STRING coordinate to a number', () => {
    // The file is hand-editable, so `"x": "10"` is reachable. The editor's copies
    // passed it through untouched, which meant skinPrefab could write a STRING into
    // a prefab `Transform` while the runtime saw the number 10.
    const [b] = coerceRigBones([{ x: '10', y: '-2.5', rot: '1' }] as never);
    expect(b).toMatchObject({ x: 10, y: -2.5, rot: 1 });
    expect(typeof b.x).toBe('number');
  });

  it('collapses a non-numeric coordinate to 0 rather than propagating NaN', () => {
    // NaN in a bone transform poisons deriveBindMatrices for the whole chain.
    const [b] = coerceRigBones([{ x: 'abc', y: NaN }] as never);
    expect(b.x).toBe(0);
    expect(Number.isNaN(b.y)).toBe(false);
  });

  it('CARRIES noScale through — the editor copies dropped it', () => {
    // Spine's bone-inherit mode, consumed by skin2DSystem via removeScale2D. A bone
    // that loses it starts inheriting an animated ancestor's scale.
    expect(coerceRigBones([{ name: 'head', noScale: true }] as never)[0].noScale).toBe(true);
  });

  it('omits noScale entirely when it is false or absent, rather than writing false', () => {
    // Keeps a round-tripped rig byte-identical instead of growing `"noScale": false`
    // on every bone.
    expect(coerceRigBones([{}] as never)[0]).not.toHaveProperty('noScale');
    expect(coerceRigBones([{ noScale: false }] as never)[0]).not.toHaveProperty('noScale');
  });
});
