/** SkinCanvas's pure skinning math (#105 Phase 4).
 *
 *  Linear-blend skinning, the weight heatmap ramp, and the part-visibility rule —
 *  all already pure and at module scope, all previously unexported and therefore
 *  untested. This is the cheapest category in the plan: an `export` and a test
 *  file, no refactor and so no behaviour risk.
 *
 *  Worth testing rather than trusting: a skinning bug does not throw. It renders a
 *  mesh that is subtly wrong — a limb that drifts, or a vertex that collapses to
 *  the origin — which is exactly the class this repo cannot verify by looking. */

import { describe, it, expect } from 'vitest';
import {
  weightGray, computeSkinMats, deformMesh, posedOrigins, visiblePartViews,
  type NamedBone, type Pose,
} from '../../src/editor/panels/SkinCanvas';
import { bboxCenter } from '../../src/editor/panels/skinParts';
import { identity2D, type Mat2D } from '../../src/runtime/skinning/rig2dMath';

const bone = (name: string, over: Partial<NamedBone> = {}): NamedBone =>
  ({ name, parent: -1, x: 0, y: 0, rot: 0, ...over }) as NamedBone;

describe('weightGray — the heatmap ramp', () => {
  it('keeps TRUE zero black', () => {
    expect(weightGray(0)).toBe(0);
  });

  it('lifts any nonzero weight clear of black, so a tiny influence is visible', () => {
    // The point of the floor: a 0.001 weight still deforms the mesh, so it must
    // not be indistinguishable from "not weighted at all".
    const tiny = weightGray(0.001);
    expect(tiny).toBeGreaterThanOrEqual(70);
    expect(weightGray(0.02)).toBeGreaterThan(tiny);
  });

  it('treats an epsilon-small weight as zero', () => {
    expect(weightGray(1e-5)).toBe(0);
    expect(weightGray(1e-4)).toBe(0);
  });

  it('reaches full white at weight 1', () => {
    expect(weightGray(1)).toBe(255);
  });

  it('clamps out-of-range weights instead of producing invalid channel values', () => {
    expect(weightGray(2)).toBe(255);
    expect(weightGray(-1)).toBe(0);
  });

  it('is monotonic across the range', () => {
    const xs = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    const ys = xs.map(weightGray);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });
});

describe('computeSkinMats', () => {
  it('returns null for an EMPTY pose — bind pose needs no matrices', () => {
    // deformMesh keys off this null to pass verts straight through, so returning
    // identities instead would silently cost a full transform per vertex.
    expect(computeSkinMats([bone('root')], {})).toBeNull();
  });

  it('returns null when there are no bones', () => {
    expect(computeSkinMats([], { 0: { x: 1, y: 1, rot: 0 } })).toBeNull();
  });

  it('produces one matrix per bone for a real pose', () => {
    const bones = [bone('root'), bone('child', { parent: 0, x: 10 })];
    const mats = computeSkinMats(bones, { 1: { x: 10, y: 5, rot: 0 } });
    expect(mats).not.toBeNull();
    expect(mats!).toHaveLength(2);
  });

  it('is IDENTITY-equivalent for a pose that matches the bind pose', () => {
    // Posing a bone to exactly where it already is must not move anything.
    const bones = [bone('root', { x: 3, y: 4, rot: 0.5 })];
    const mats = computeSkinMats(bones, { 0: { x: 3, y: 4, rot: 0.5 } })!;
    const p = deformMesh([[10, 20]], mats, [0, 0, 0, 0], [1, 0, 0, 0]);
    expect(p[0][0]).toBeCloseTo(10, 6);
    expect(p[0][1]).toBeCloseTo(20, 6);
  });
});

describe('deformMesh — linear blend skinning', () => {
  const I: Mat2D = identity2D();

  it('passes verts through UNCHANGED when there are no skin matrices', () => {
    const verts = [[1, 2], [3, 4]];
    expect(deformMesh(verts, null, [], [])).toBe(verts); // same reference, not a copy
  });

  it('leaves a fully-weighted vertex where it is under an identity bone', () => {
    expect(deformMesh([[5, 6]], [I], [0, 0, 0, 0], [1, 0, 0, 0])).toEqual([[5, 6]]);
  });

  it('blends two bones by their weights', () => {
    // Bone 0 identity, bone 1 translated +10 in x; a 50/50 vertex lands halfway.
    const shift: Mat2D = { ...identity2D(), e: 10 };
    const out = deformMesh([[0, 0]], [I, shift], [0, 1, 0, 0], [0.5, 0.5, 0, 0]);
    expect(out[0][0]).toBeCloseTo(5);
    expect(out[0][1]).toBeCloseTo(0);
  });

  it('honours all FOUR influence slots', () => {
    const shift: Mat2D = { ...identity2D(), e: 4 };
    const out = deformMesh([[0, 0]], [I, shift], [0, 1, 1, 1], [0.25, 0.25, 0.25, 0.25]);
    expect(out[0][0]).toBeCloseTo(3); // three quarters shifted by 4
  });

  it('COLLAPSES an unweighted vertex to the origin', () => {
    // Documenting real behaviour rather than asserting it is desirable: a vertex
    // with no influences accumulates nothing and lands at (0,0) instead of staying
    // put. That is what an unrigged vertex looks like on screen — it snaps to the
    // texture origin. Pinned so a future change to this is a deliberate one.
    expect(deformMesh([[9, 9]], [I], [0, 0, 0, 0], [0, 0, 0, 0])).toEqual([[0, 0]]);
  });

  it('skips negative and zero weights rather than subtracting', () => {
    const shift: Mat2D = { ...identity2D(), e: 10 };
    expect(deformMesh([[0, 0]], [I, shift], [1, 0, 0, 0], [1, -5, 0, 0])[0][0]).toBeCloseTo(10);
  });

  it('survives an out-of-range bone index instead of throwing', () => {
    // A hand-edited rig can reference a bone that no longer exists; the vertex
    // must degrade, not crash the canvas.
    expect(() => deformMesh([[1, 1]], [I], [99, 0, 0, 0], [1, 0, 0, 0])).not.toThrow();
  });

  it('returns one output vertex per input vertex', () => {
    const verts = [[0, 0], [1, 1], [2, 2]];
    expect(deformMesh(verts, [I], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).toHaveLength(3);
  });
});

describe('posedOrigins', () => {
  it('is empty for a rig with no bones', () => {
    expect(posedOrigins([], {})).toEqual([]);
  });

  it('reports bind positions when the pose is empty', () => {
    const got = posedOrigins([bone('root', { x: 3, y: 7 })], {});
    expect(got[0].x).toBeCloseTo(3);
    expect(got[0].y).toBeCloseTo(7);
  });

  it('moves only the posed bone', () => {
    const bones = [bone('a', { x: 1, y: 1 }), bone('b', { x: 5, y: 5 })];
    const got = posedOrigins(bones, { 1: { x: 50, y: 50, rot: 0 } });
    expect(got[0].x).toBeCloseTo(1);
    expect(got[1].x).toBeCloseTo(50);
  });
});

describe('visiblePartViews', () => {
  const def = { parts: [{ order: 0 }, { order: 1 }, { order: 2 }] } as never;

  it('shows every part when none are hidden', () => {
    expect(visiblePartViews(def, 0, []).map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('hides a preview-hidden part', () => {
    expect(visiblePartViews(def, 0, [1]).map((p) => p.index)).toEqual([0, 2]);
  });

  it('ALWAYS shows the active part, even when hidden — you cannot author what you cannot see', () => {
    const got = visiblePartViews(def, 1, [0, 1, 2]);
    expect(got.map((p) => p.index)).toEqual([1]);
    expect(got[0].active).toBe(true);
  });

  it('falls back to the index when a part declares no draw order', () => {
    const noOrder = { parts: [{}, {}] } as never;
    expect(visiblePartViews(noOrder, 0, []).map((p) => p.order)).toEqual([0, 1]);
  });

  it('yields ONE implicit part for a v1 or missing rig, not an empty list', () => {
    // By contract (skinParts.partCount): a v1 rig — and a not-yet-loaded one — is a
    // single implicit part. Returning [] here would blank the canvas for every v1
    // rig, so the "empty" case is one part, not none.
    expect(visiblePartViews(null, 0, []).map((p) => p.index)).toEqual([0]);
    expect(visiblePartViews(undefined, 0, []).map((p) => p.index)).toEqual([0]);
    expect(visiblePartViews({} as never, 0, []).map((p) => p.index)).toEqual([0]);
  });

  it('still shows that implicit part when it is the hidden ACTIVE one', () => {
    expect(visiblePartViews(null, 0, [0]).map((p) => p.index)).toEqual([0]);
  });
});

describe('bboxCenter — one copy for both Skin panels', () => {
  // These two had SEPARATE private copies that had already diverged in the empty
  // case (canvas returned null, editor returned {0,0}). Unified here; the
  // divergence now lives at the call sites, deliberately.
  it('is the bounding-box centre', () => {
    expect(bboxCenter([[0, 0], [10, 4]])).toEqual({ x: 5, y: 2 });
  });

  it('returns NULL for an empty mesh — the stricter of the two old behaviours', () => {
    expect(bboxCenter([])).toBeNull();
  });
});
