/** Pure clip-edit transforms — copy/paste placement + collision avoidance, break/unify. */

import { describe, it, expect } from 'vitest';
import { extractKeyBlock, planPaste, applyBreakUnify, applyValueNudge, applyKeyPatch, planAddedTracks } from '../../src/editor/animation/clipEdits';
import { groupSelection, upsertKey } from '../../src/editor/animation/recording';
import { evalTrackValue } from '../../src/runtime/animation/curveEval';
import { deriveTangentFromHandle } from '../../src/editor/panels/animation/tangentMath';
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

  it("re-derives the nudged key's own 'auto' tangent AND its neighbors'", () => {
    // Bake the track through upsertKey so every key starts with a correct 'auto' tangent.
    let keys: Keyframe[] = [];
    for (const [t, v] of [[0, 0], [0.3, 1], [0.6, 2]] as const) keys = upsertKey(keys, t, v);
    const tracks = [track('y', keys)];
    // Nudge the MIDDLE key. key[1]'s own slope is (v2-v0)/(t2-t0) — unchanged by its own
    // value — but key[0]'s and key[2]'s slopes both read key[1].v, so both must move.
    const out = applyValueNudge(tracks, groupSelection(['0:1']), 0.5);
    const k = out[0].keys;
    expect(k[0].outTangent).toBeCloseTo((k[1].v - k[0].v) / (k[1].t - k[0].t), 9);
    expect(k[1].outTangent).toBeCloseTo((k[2].v - k[0].v) / (k[2].t - k[0].t), 9);
    expect(k[2].outTangent).toBeCloseTo((k[2].v - k[1].v) / (k[2].t - k[1].t), 9);
    // The stale values are what the pre-fix nudge left behind — assert they are gone.
    expect(k[0].outTangent).not.toBeCloseTo(tracks[0].keys[0].outTangent, 6);
    expect(k[2].outTangent).not.toBeCloseTo(tracks[0].keys[2].outTangent, 6);
  });

  it("leaves a 'constant' key stepped and a 'free' key's hand-edited handles alone", () => {
    const tracks = [track('y', [
      key(0, 0, { tangentMode: 'constant', outTangent: Infinity, broken: true }),
      key(0.3, 1, { tangentMode: 'free', inTangent: 7, outTangent: -7, broken: true }),
      key(0.6, 2, { tangentMode: 'auto' }),
    ])];
    const k = applyValueNudge(tracks, groupSelection(['0:1']), 0.5)[0].keys;
    expect(k[0].outTangent).toBe(Infinity);   // constant stays stepped
    expect(k[1].inTangent).toBe(7);           // free keeps its handles
    expect(k[1].outTangent).toBe(-7);
    expect(k[2].outTangent).toBeCloseTo((k[2].v - k[1].v) / (k[2].t - k[1].t), 9); // auto re-derives
  });
});

// The Curves-view key drag and the Inspector's numeric Value/Frame fields — the THIRD writer
// of a key's t/v, and the one the original tangent-staleness report never reached.
describe('applyKeyPatch', () => {
  const baked = (): Keyframe[] => {
    let ks: Keyframe[] = [];
    for (const [t, v] of [[0, 0], [0.2, 1], [0.4, 4]] as const) ks = upsertKey(ks, t, v);
    return ks;
  };

  it("re-derives the patched key's neighbours when the patch moves its VALUE", () => {
    const before = baked();
    const k = applyKeyPatch(before, 1, { v: 5 });
    expect(k[1].v).toBe(5);
    expect(k[0].outTangent).toBeCloseTo((k[1].v - k[0].v) / (k[1].t - k[0].t), 9);
    expect(k[2].outTangent).toBeCloseTo((k[2].v - k[1].v) / (k[2].t - k[1].t), 9);
    expect(k[0].outTangent).not.toBeCloseTo(before[0].outTangent, 6);
    expect(k[2].outTangent).not.toBeCloseTo(before[2].outTangent, 6);
  });

  it('re-derives when the patch moves its TIME, and clamps between the neighbours', () => {
    const before = baked();
    const k = applyKeyPatch(before, 1, { t: 99 }); // way past its right neighbour
    expect(k[1].t).toBeLessThan(k[2].t);           // clamped — index order preserved
    expect(k[1].t).toBeGreaterThan(k[0].t);
    expect(k[0].outTangent).toBeCloseTo((k[1].v - k[0].v) / (k[1].t - k[0].t), 9);
    expect(k[0].outTangent).not.toBeCloseTo(before[0].outTangent, 6);
  });

  it('does NOT recompute a tangent-handle drag away (the patch that AUTHORS a tangent)', () => {
    // A Curves tangent-handle drag sends {inTangent, outTangent, inWeight/outWeight} — and
    // may send no t/v at all. Re-deriving on it would erase the drag on the frame it happened.
    const k = applyKeyPatch(baked(), 1, { outTangent: 42, inTangent: 42, outWeight: 0.3 });
    expect(k[1].outTangent).toBe(42);
    expect(k[1].inTangent).toBe(42);
    // Even a patch that moves the key AND sets a tangent keeps the authored tangent.
    const k2 = applyKeyPatch(baked(), 1, { v: 5, outTangent: 7 });
    expect(k2[1].v).toBe(5);
    expect(k2[1].outTangent).toBe(7);
  });

  it('leaves the input array untouched and ignores an out-of-range index', () => {
    const before = baked();
    const snapshot = JSON.stringify(before);
    applyKeyPatch(before, 1, { v: 5 });
    expect(JSON.stringify(before)).toBe(snapshot); // no in-place mutation of the caller's keys
    expect(applyKeyPatch(before, 9, { v: 5 })).toBe(before);
    expect(applyKeyPatch(before, -1, { v: 5 })).toBe(before);
  });
});

// The behaviour the freeSmooth mode exists for, end to end through the real editor path:
// hand-shape a tangent, then edit a NEIGHBOUR, and the hand shape must survive.
describe('a hand-shaped tangent survives a neighbour edit', () => {
  const baked = (): Keyframe[] => {
    let ks: Keyframe[] = [];
    for (const [t, v] of [[0, 0], [0.2, 1], [0.4, 4]] as const) ks = upsertKey(ks, t, v);
    return ks;
  };

  it("a unified handle drag (freeSmooth) is NOT recomputed when a neighbour moves", () => {
    // 1. Drag key[1]'s out handle — the patch a CurvesView tangent drag sends.
    const dragged = applyKeyPatch(baked(), 1, deriveTangentFromHandle(baked()[1], 'out', 0.3, 3, 0.2, true));
    const shaped = dragged[1].outTangent;
    expect(dragged[1].tangentMode).toBe('freeSmooth');
    expect(dragged[1].broken).toBe(false);
    // 2. Now move a NEIGHBOUR. Every derived key around it re-derives; key[1] must not.
    const after = applyKeyPatch(dragged, 2, { v: 99 });
    expect(after[1].outTangent).toBe(shaped);
    expect(after[1].inTangent).toBe(dragged[1].inTangent);
    expect(after[2].outTangent).not.toBeCloseTo(dragged[2].outTangent, 6); // the neighbour DID re-derive
  });

  it("the same drag left as 'auto' would have been recomputed away — the pre-fix behaviour", () => {
    const dragged = applyKeyPatch(baked(), 1, { inTangent: 42, outTangent: 42, tangentMode: 'auto' });
    const after = applyKeyPatch(dragged, 2, { v: 99 });
    expect(after[1].outTangent).not.toBe(42); // 'auto' re-derives, so the hand shape is gone
  });

  it('a broken drag survives too, and keeps its handles independent', () => {
    const dragged = applyKeyPatch(baked(), 1, deriveTangentFromHandle(baked()[1], 'out', 0.3, 3, 0.2, false));
    expect(dragged[1].tangentMode).toBe('free');
    const shaped = dragged[1].outTangent;
    const after = applyKeyPatch(dragged, 0, { v: -5 });
    expect(after[1].outTangent).toBe(shaped);
    expect(after[1].broken).toBe(true);
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
