/** Pure clip-edit transforms — copy/paste placement + collision avoidance, break/unify. */

import { describe, it, expect } from 'vitest';
import { extractKeyBlock, planPaste, applyBreakUnify, applyValueNudge, planAddedTracks } from '../../src/editor/animation/clipEdits';
import { groupSelection, upsertKey } from '../../src/editor/animation/recording';
import { evalTrackValue } from '../../src/runtime/animation/curveEval';
import type { AnimationClipDef, AnimationTrack, Keyframe } from '../../src/runtime/animation/types';

const FR = 60;
const key = (t: number, v: number, extra?: Partial<Keyframe>): Keyframe => ({ t, v, inTangent: 0, outTangent: 0, ...extra });
const track = (field: string, keys: Keyframe[], path = ''): AnimationTrack => ({ path, trait: 'Transform', field, type: 'number', keys });
const clip = (tracks: AnimationTrack[], duration = 3): AnimationClipDef => ({ id: 'x', name: 'c', duration, frameRate: FR, loop: true, tracks });
const frames = (t: AnimationTrack) => t.keys.map((k) => Math.round(k.t * FR)).sort((a, b) => a - b);

describe('extractKeyBlock', () => {
  it('normalizes copied times to the earliest key and records span/srcEnd', () => {
    const c = clip([track('x', [key(0, 0), key(0.1, 1), key(0.2, 2), key(0.5, 5)])]);
    const cb = extractKeyBlock(c, groupSelection(['0:1', '0:2']))!; // keys at 0.1, 0.2
    expect(cb.srcEnd).toBeCloseTo(0.2, 6);
    expect(cb.span).toBeCloseTo(0.1, 6);
    expect(cb.tracks[0].key).toBe('|Transform|x');
    expect(cb.tracks[0].keys.map((k) => +k.t.toFixed(4))).toEqual([0, 0.1]); // relative to minT
    expect(cb.tracks[0].keys.map((k) => k.v)).toEqual([1, 2]);
  });

  it('returns null for an empty selection', () => {
    const c = clip([track('x', [key(0, 0)])]);
    expect(extractKeyBlock(c, groupSelection([]))).toBeNull();
  });
});

describe('planPaste', () => {
  it('places a single-key copy minGap+margin frames after srcEnd, and selects it', () => {
    const c = clip([track('x', [key(0, 0), key(0.1, 1)])]);
    const cb = extractKeyBlock(c, groupSelection(['0:1']))!; // key at frame 6, span 0
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    // gapFrames = max(0,5)+8 = 13 → base frame 6+13 = 19.
    expect(frames(plan.tracks[0])).toEqual([0, 6, 19]);
    expect(plan.selection).toEqual(['0:2']); // pasted key is index 2
  });

  it('steps forward past an existing key at the target frame (collision avoidance)', () => {
    const c = clip([track('x', [key(0, 0), key(6 / FR, 1), key(19 / FR, 9)])]);
    const cb = extractKeyBlock(c, groupSelection(['0:1']))!; // copy frame-6 key
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    // base 19 collides with existing frame 19 → steps to 20; existing 19 untouched.
    expect(frames(plan.tracks[0])).toEqual([0, 6, 19, 20]);
    expect(plan.tracks[0].keys.find((k) => Math.round(k.t * FR) === 19)!.v).toBe(9); // existing kept
  });

  it('grows the clip duration when the paste runs past the end', () => {
    const c = clip([track('x', [key(0, 0), key(0.2, 2)])], 0.2);
    const cb = extractKeyBlock(c, groupSelection(['0:1']))!; // key at frame 12, srcEnd 0.2
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    // base frame 12+13 = 25 → 25/60 > 0.2, so duration grows to fit.
    expect(plan.duration).toBeCloseTo(25 / FR, 6);
  });

  it('carries the copied easing onto the pasted key (not re-derived to auto)', () => {
    const c = clip([track('x', [key(0, 0), key(0.1, 1, { inTangent: 5, outTangent: 7, broken: true, tangentMode: 'free' })])]);
    const cb = extractKeyBlock(c, groupSelection(['0:1']))!;
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    const pasted = plan.tracks[0].keys[plan.tracks[0].keys.length - 1];
    expect(pasted.inTangent).toBe(5);
    expect(pasted.outTangent).toBe(7);
    expect(pasted.broken).toBe(true);
  });

  it('is additive: pasting a key does NOT re-smooth an existing key and shift the pose before it', () => {
    // Auto keys at frames 0,10,20 with distinct values. Copying the last key (frame 20)
    // and pasting after it used to re-derive the frame-20 key's 'auto' tangent (it gained
    // a right-neighbor), altering the [10,20] segment — so the pose at frame 15 jumped and
    // a bone visibly moved. Paste must leave every pre-existing key (and the curve before
    // the paste) untouched.
    const c = clip([track('rz', [key(0, 0), key(10 / FR, 0.5), key(20 / FR, -0.3)])]);
    const before15 = evalTrackValue(c.tracks[0], 15 / FR);
    const before20Out = c.tracks[0].keys[2].outTangent;
    const cb = extractKeyBlock(c, groupSelection(['0:2']))!; // copy the frame-20 key
    const plan = planPaste(c, cb, { minGapFrames: 3, gapMarginFrames: 2 });

    const out = plan.tracks[0];
    expect(frames(out)).toEqual([0, 10, 20, 25]); // pasted after, original frames intact
    expect(out.keys[2].outTangent).toBe(before20Out); // existing key's tangent preserved (not re-smoothed)
    expect(evalTrackValue(out, 15 / FR)).toBeCloseTo(before15, 9); // pose before the paste is unchanged
  });

  it('collides per-track independently and selects one key per copied track', () => {
    const c = clip([
      track('x', [key(0, 0), key(0.1, 1)]),
      track('y', [key(0, 0), key(0.1, 1)], 'b'),
    ]);
    const cb = extractKeyBlock(c, groupSelection(['0:1', '1:1']))!;
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    expect(plan.selection.length).toBe(2);
    expect(frames(plan.tracks[0])).toEqual([0, 6, 19]);
    expect(frames(plan.tracks[1])).toEqual([0, 6, 19]);
  });

  it('terminates (no hang) when every candidate frame is occupied', () => {
    // Fill frames 0..30 densely, then paste — the maxIter guard must stop the loop.
    const keys = Array.from({ length: 31 }, (_, f) => key(f / FR, f));
    const c = clip([track('x', keys)], 0.5);
    const cb = extractKeyBlock(c, groupSelection(['0:5']))!;
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    expect(plan.tracks[0].keys.length).toBeGreaterThan(0); // did not throw / hang
  });
});

describe('applyBreakUnify', () => {
  const base = () => clip([track('x', [key(0, 0), key(0.1, 1), key(0.2, 2)])]).tracks;

  it('breaks all when any selected key is unified', () => {
    const t = applyBreakUnify(base(), groupSelection(['0:1']));
    expect(t[0].keys[1].broken).toBe(true);
    expect(t[0].keys[1].tangentMode).toBe('free');
  });

  it('unifies all when every selected key is broken (→ auto, broken:false)', () => {
    const broken = applyBreakUnify(base(), groupSelection(['0:1']));
    const unified = applyBreakUnify(broken, groupSelection(['0:1']));
    expect(unified[0].keys[1].broken).toBe(false);
    expect(unified[0].keys[1].tangentMode).toBe('auto');
  });

  it('A3: a unified key stays unified through a neighbor recompute (does not revert to broken)', () => {
    const broken = applyBreakUnify(base(), groupSelection(['0:1']));
    const unified = applyBreakUnify(broken, groupSelection(['0:1']));
    // Inserting a neighbor runs reapplyTangent on the unified key via its own mode.
    const after = upsertKey(unified[0].keys, 0.15, 1.5);
    const k = after.find((x) => Math.abs(x.t - 0.1) < 1e-6)!;
    expect(k.broken).toBe(false); // the old { broken:false, tangentMode:'free' } bug flipped this to true
  });
});

describe('applyValueNudge', () => {
  it('adds dv only to selected keys on NUMBER tracks (color/bool/enum untouched)', () => {
    const tracks: AnimationTrack[] = [
      track('x', [key(0, 0), key(0.1, 1), key(0.2, 2)]),
      { path: '', trait: 'Renderable2D', field: 'color', type: 'color', keys: [key(0, 0x112233)] },
    ];
    // Select x[1] and the color key; only the number track shifts.
    const out = applyValueNudge(tracks, groupSelection(['0:1', '1:0']), 0.5);
    expect(out[0].keys.map((k) => k.v)).toEqual([0, 1.5, 2]);
    expect(out[1].keys[0].v).toBe(0x112233); // color track skipped
    expect(out[1]).toBe(tracks[1]); // untouched track returned by reference
  });
});

describe('planAddedTracks', () => {
  const existing: AnimationTrack[] = [track('x', [key(0, 0)])]; // Transform.x already tracked
  const cand = (field: string, type: AnimationTrack['type'] = 'number') => ({ path: '', trait: 'Transform', field, type });

  it('skips already-tracked + within-batch duplicates, seeds at seedTime from readValue', () => {
    const added = planAddedTracks(
      existing,
      [cand('x'), cand('y'), cand('y'), cand('z')], // x already tracked; y duplicated in batch
      0.25,
      (c) => (c.field === 'y' ? 7 : c.field === 'z' ? 9 : 0),
    );
    expect(added.map((a) => a.field)).toEqual(['y', 'z']); // x skipped, y once
    expect(added[0].keys).toHaveLength(1);
    expect(added[0].keys[0].t).toBeCloseTo(0.25, 6);
    expect(added[0].keys[0].v).toBe(7); // seeded from readValue
  });

  it('returns [] when every candidate is already tracked (caller skips the commit)', () => {
    expect(planAddedTracks(existing, [cand('x')], 0, () => 0)).toEqual([]);
  });
});

describe('copy → paste round-trip', () => {
  it('preserves relative spacing, values and easing, lands after the original, and re-selects', () => {
    const c = clip([track('x', [
      key(0, 0),
      key(0.1, 10, { inTangent: 3, outTangent: 3, tangentMode: 'auto' }),
      key(0.2, 20, { inTangent: 5, outTangent: 7, broken: true, tangentMode: 'free' }),
    ])]);
    // Copy the two keys at 0.1 and 0.2, then paste.
    const cb = extractKeyBlock(c, groupSelection(['0:1', '0:2']))!;
    const plan = planPaste(c, cb, { minGapFrames: 5, gapMarginFrames: 8 });
    // Two pasted keys, spacing (0.1s = 6 frames) preserved.
    expect(plan.selection).toHaveLength(2);
    const pasted = plan.selection.map((id) => { const [, ki] = id.split(':').map(Number); return plan.tracks[0].keys[ki]; })
      .sort((a, b) => a.t - b.t);
    expect(Math.round((pasted[1].t - pasted[0].t) * FR)).toBe(6); // spacing kept
    expect(pasted.map((k) => k.v)).toEqual([10, 20]); // values preserved
    expect(pasted[1].broken).toBe(true); // easing carried
    expect(pasted[1].outTangent).toBe(7);
    // Lands strictly after the original block (srcEnd = 0.2 → frame 12).
    expect(Math.round(pasted[0].t * FR)).toBeGreaterThan(12);
  });
});
