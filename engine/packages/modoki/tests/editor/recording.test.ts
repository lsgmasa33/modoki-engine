/** Animation record-mode pure helpers — path resolution, key upsert, value encode. */

import { describe, it, expect } from 'vitest';
import {
  relativeEntityPath, upsertKey, encodeValue, findTrack, moveKeysInTime, type AttrNode,
  trackKey, parseKeyId, groupSelection, selRefsFromIds, resolveKeySelection, nextKeyTime,
  remapSelectionAfterRemoval, reorderPermutation, remapSelectionAfterReorder, remapSelectionAfterDelete,
  formatTrackField,
} from '../../src/editor/animation/recording';
import type { AnimationTrack, Keyframe } from '../../src/runtime/animation/types';

function nodes(list: AttrNode[]): Map<number, AttrNode> {
  return new Map(list.map((n) => [n.id, n]));
}

describe('relativeEntityPath', () => {
  // root(1) → body(2) → hand(3); sibling head(4) under root
  const byId = nodes([
    { id: 1, name: 'root', parentId: 0 },
    { id: 2, name: 'body', parentId: 1 },
    { id: 3, name: 'hand', parentId: 2 },
    { id: 4, name: 'head', parentId: 1 },
    { id: 9, name: 'orphan', parentId: 0 },
  ]);

  it('returns "" for the root itself', () => expect(relativeEntityPath(1, 1, byId)).toBe(''));
  it('builds a nested path', () => expect(relativeEntityPath(1, 3, byId)).toBe('body/hand'));
  it('builds a one-level path', () => expect(relativeEntityPath(1, 4, byId)).toBe('head'));
  it('returns null for a non-descendant', () => expect(relativeEntityPath(1, 9, byId)).toBeNull());
  it('returns null when target is above root', () => expect(relativeEntityPath(2, 1, byId)).toBeNull());
});

describe('encodeValue', () => {
  it('coerces by type', () => {
    expect(encodeValue('boolean', true)).toBe(1);
    expect(encodeValue('boolean', false)).toBe(0);
    expect(encodeValue('color', 0x804020)).toBe(0x804020);
    expect(encodeValue('number', 3.5)).toBe(3.5);
  });

  it('encodes an enum string to its option index', () => {
    const opts = ['fitW', 'fitH', 'fill'];
    expect(encodeValue('enum', 'fitH', opts)).toBe(1);
    expect(encodeValue('enum', 'fill', opts)).toBe(2);
    // Unknown value / missing option list → 0, never NaN.
    expect(encodeValue('enum', 'nope', opts)).toBe(0);
    expect(encodeValue('enum', 'fitH')).toBe(0);
  });

  it('parses a color STRING to a packed int (and malformed → 0, never NaN)', () => {
    expect(encodeValue('color', '#804020')).toBe(0x804020);
    expect(encodeValue('color', '804020')).toBe(0x804020);
    expect(encodeValue('color', 'not-a-color')).toBe(0); // NaN guarded
    expect(encodeValue('color', undefined)).toBe(0);
  });

  it('enum with a numeric value and no options falls through to the number', () => {
    expect(encodeValue('enum', 2)).toBe(2);
  });
});

describe('upsertKey', () => {
  const k = (t: number, v: number): Keyframe => ({ t, v, inTangent: 0, outTangent: 0 });

  it('inserts a new key in sorted order', () => {
    const keys = upsertKey([k(0, 0), k(1, 10)], 0.5, 5);
    expect(keys.map((x) => x.t)).toEqual([0, 0.5, 1]);
    expect(keys[1].v).toBe(5);
  });

  it('updates an existing key at the same time (no duplicate)', () => {
    const keys = upsertKey([k(0, 0), k(1, 10)], 1, 99);
    expect(keys.length).toBe(2);
    expect(keys[1].v).toBe(99);
  });

  it('does not mutate the input array', () => {
    const orig = [k(0, 0)];
    const out = upsertKey(orig, 1, 5);
    expect(orig.length).toBe(1);
    expect(out.length).toBe(2);
  });

  it('new keys default to auto tangents (smoothed from neighbors)', () => {
    const keys = upsertKey([k(0, 0), k(1, 10)], 0.5, 20);
    expect(keys[1].tangentMode).toBe('auto');
    // auto slope through neighbors (0,0)→(1,10) = 10, regardless of the peak value.
    expect(keys[1].inTangent).toBeCloseTo(10);
    expect(keys[1].outTangent).toBeCloseTo(10);
  });

  it("preserves a neighbor's explicit tangent mode instead of flattening to auto", () => {
    // A 'constant' (stepped) key must stay stepped when an adjacent key is keyed.
    const constKey: Keyframe = { t: 0, v: 0, inTangent: 0, outTangent: Infinity, tangentMode: 'constant' };
    const out = upsertKey([constKey, k(1, 10)], 0.5, 5);
    const stepped = out.find((x) => x.t === 0)!;
    expect(stepped.tangentMode).toBe('constant');
    expect(Number.isFinite(stepped.outTangent)).toBe(false); // still STEPPED
  });

  it("re-fits a linear neighbor's secant when an adjacent key value changes", () => {
    const linear: Keyframe = { t: 1, v: 10, inTangent: 0, outTangent: 0, tangentMode: 'linear' };
    // Update the t=0 key value 0→4; the linear key at t=1 should re-fit its in-secant.
    const out = upsertKey([k(0, 0), linear, k(2, 20)], 0, 4);
    const lin = out.find((x) => x.t === 1)!;
    expect(lin.tangentMode).toBe('linear');
    expect(lin.inTangent).toBeCloseTo((10 - 4) / 1); // secant to the moved (0,4) neighbor
  });
});

describe('findTrack', () => {
  const tracks: AnimationTrack[] = [
    { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [] },
    { path: 'body', trait: 'Transform', field: 'rx', type: 'number', keys: [] },
  ];
  it('matches on path+trait+field', () => {
    expect(findTrack(tracks, 'body', 'Transform', 'rx')).toBe(tracks[1]);
    expect(findTrack(tracks, '', 'Transform', 'y')).toBeUndefined();
  });
});

describe('moveKeysInTime', () => {
  const k = (t: number, v: number): Keyframe => ({ t, v, inTangent: 0, outTangent: 0 });
  // one track, keys at frames 0,6,12,18 (60fps → 0, .1, .2, .3s)
  const tracks = (): AnimationTrack[] => [
    { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [k(0, 0), k(0.1, 1), k(0.2, 2), k(0.3, 3)] },
  ];
  const FR = 60, DUR = 1;

  it('shifts the whole group by a frame-snapped delta, preserving spacing', () => {
    // Select the middle two (0.1, 0.2); grab the 0.1 key, drag it toward 0.18.
    const sel = [{ ti: 0, t0: 0.1 }, { ti: 0, t0: 0.2 }];
    const r = moveKeysInTime(tracks(), sel, 0.1, 0.183, FR, DUR);
    expect(r.delta).toBeCloseTo(0.0833, 3); // snapped to frame 11 → 0.1833 - 0.1
    const ts = r.tracks[0].keys.map((x) => +x.t.toFixed(4));
    expect(ts).toEqual([0, 0.1833, 0.2833, 0.3]); // 0.1→0.1833, 0.2→0.2833; spacing 0.1 kept
  });

  it('clamps the delta so no selected key passes 0 (group stays in range)', () => {
    const sel = [{ ti: 0, t0: 0.1 }, { ti: 0, t0: 0.2 }];
    const r = moveKeysInTime(tracks(), sel, 0.1, -5, FR, DUR); // drag far left
    expect(r.delta).toBeCloseTo(-0.1, 6);                       // limited by min t0 = 0.1
    // 0.1→0.0 lands on the existing 0.0 key → dedup merges (moved key wins), 0.2→0.1.
    expect(r.tracks[0].keys.map((x) => +x.t.toFixed(4))).toEqual([0, 0.1, 0.3]); // (A2)
    expect(r.selected).toEqual(['0:0', '0:1']);                 // the two moved keys
  });

  it('dedups when a moved key lands exactly on an unselected key (A2 — no duplicate times)', () => {
    // Select only 0.1; nudge it +0.1 so it lands exactly on the existing 0.2 key.
    const r = moveKeysInTime(tracks(), [{ ti: 0, t0: 0.1 }], 0.1, 0.2, FR, DUR);
    // No two keys share a time: 0.1 merges onto 0.2 (moved key wins), leaving 3 keys.
    expect(r.tracks[0].keys.map((x) => +x.t.toFixed(4))).toEqual([0, 0.2, 0.3]);
    expect(r.tracks[0].keys[1].v).toBe(1); // the moved key's value (was v=1 at 0.1), not 2
    expect(r.selected).toEqual(['0:1']);   // the surviving moved key
  });

  it('clamps the delta so no selected key passes the duration', () => {
    const sel = [{ ti: 0, t0: 0.2 }, { ti: 0, t0: 0.3 }];
    const r = moveKeysInTime(tracks(), sel, 0.3, 99, FR, DUR); // drag far right
    expect(r.delta).toBeCloseTo(0.7, 6);                        // limited by max t0 = 0.3 → 1.0
    expect(r.tracks[0].keys.map((x) => +x.t.toFixed(4))).toEqual([0, 0.1, 0.9, 1]); // 0.1 unselected, stays
  });

  it('remaps selection ids to new sorted indices when keys cross an unselected key', () => {
    // Select only key at 0.1 (index 1); drag it past 0.2 to ~0.25 → it sorts after.
    const r = moveKeysInTime(tracks(), [{ ti: 0, t0: 0.1 }], 0.1, 0.25, FR, DUR);
    expect(r.tracks[0].keys.map((x) => +x.t.toFixed(4))).toEqual([0, 0.2, 0.25, 0.3]);
    expect(r.selected).toEqual(['0:2']); // the moved key is now at index 2, not 1
  });

  it('moves keys across multiple tracks by the same delta', () => {
    const t2: AnimationTrack[] = [
      ...tracks(),
      { path: 'b', trait: 'Transform', field: 'y', type: 'number', keys: [k(0.1, 9), k(0.5, 9)] },
    ];
    const sel = [{ ti: 0, t0: 0.1 }, { ti: 1, t0: 0.1 }];
    const r = moveKeysInTime(t2, sel, 0.1, 0.15, FR, DUR); // +0.05, no collision
    expect(r.delta).toBeCloseTo(0.05, 6);
    expect(r.tracks[0].keys[1].t).toBeCloseTo(0.15, 6); // track 0's 0.1 → 0.15
    expect(r.tracks[1].keys[0].t).toBeCloseTo(0.15, 6); // track 1's 0.1 → 0.15
    expect(new Set(r.selected)).toEqual(new Set(['0:1', '1:0']));
  });

  it('returns the input unchanged for an empty selection', () => {
    const base = tracks();
    const r = moveKeysInTime(base, [], 0, 0.5, FR, DUR);
    expect(r.tracks).toBe(base);
    expect(r.selected).toEqual([]);
  });
});

describe('formatTrackField', () => {
  it('collapses a MaterialInstance override source path to "override N"', () => {
    expect(formatTrackField('MaterialInstance', 'overrides.0.source.value')).toBe('override 0');
    expect(formatTrackField('MaterialInstance', 'overrides.12.source.value')).toBe('override 12');
  });
  it('passes a non-matching MaterialInstance field through unchanged', () => {
    expect(formatTrackField('MaterialInstance', 'opacity')).toBe('opacity');
  });
  it('passes non-MaterialInstance traits through unchanged', () => {
    expect(formatTrackField('Transform', 'rz')).toBe('rz');
  });
});

describe('track identity + selection-id helpers', () => {
  const k = (t: number): Keyframe => ({ t, v: 0, inTangent: 0, outTangent: 0 });
  const tracks: AnimationTrack[] = [
    { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [k(0), k(0.1), k(0.2)] },
    { path: 'arm', trait: 'Transform', field: 'ry', type: 'number', keys: [k(0), k(0.5)] },
  ];

  it('trackKey composes path|trait|field', () => {
    expect(trackKey({ path: 'arm', trait: 'Transform', field: 'ry' })).toBe('arm|Transform|ry');
    expect(trackKey({ path: '', trait: 'Renderable2D', field: 'color' })).toBe('|Renderable2D|color');
  });

  it('parseKeyId splits "ti:ki" to numbers', () => {
    expect(parseKeyId('3:7')).toEqual([3, 7]);
  });

  it('groupSelection buckets ids by track', () => {
    const g = groupSelection(['0:1', '0:2', '1:0']);
    expect(g.get(0)).toEqual(new Set([1, 2]));
    expect(g.get(1)).toEqual(new Set([0]));
    expect(g.size).toBe(2);
  });

  it('selRefsFromIds resolves original times and skips stale ids', () => {
    const refs = selRefsFromIds(['0:1', '1:1', '9:9'], tracks); // 9:9 out of range
    expect(refs).toEqual([{ ti: 0, t0: 0.1 }, { ti: 1, t0: 0.5 }]);
  });

  it('remapSelectionAfterRemoval drops removed-track ids and shifts survivors down', () => {
    // Remove tracks {1,3} from a 5-track selection.
    const next = remapSelectionAfterRemoval(['0:0', '1:2', '2:0', '3:1', '4:5'], new Set([1, 3]));
    // 0 stays 0; 1 dropped; 2→1 (one removed below); 3 dropped; 4→2 (two removed below).
    expect(next).toEqual(new Set(['0:0', '1:0', '2:5']));
  });

  it('reorderPermutation builds the old→new map for a move (from<to and from>to)', () => {
    // 5 tracks, move index 1 → 3: order becomes [0,2,3,1,4].
    const down = reorderPermutation(5, 1, 3);
    expect([0, 1, 2, 3, 4].map((i) => down.get(i))).toEqual([0, 3, 1, 2, 4]);
    // move index 3 → 1: order becomes [0,3,1,2,4].
    const up = reorderPermutation(5, 3, 1);
    expect([0, 1, 2, 3, 4].map((i) => up.get(i))).toEqual([0, 2, 3, 1, 4]);
  });

  it('remapSelectionAfterReorder follows the permutation', () => {
    const map = reorderPermutation(5, 1, 3); // old 1 → new 3
    expect(remapSelectionAfterReorder(['1:0', '4:2'], map)).toEqual(new Set(['3:0', '4:2']));
  });

  it('remapSelectionAfterDelete drops the deleted key and shifts same-track keys after it', () => {
    const next = remapSelectionAfterDelete(['0:0', '0:2', '0:3', '1:5'], 0, 2);
    // 0:2 deleted; 0:3→0:2; 0:0 unchanged; other track untouched.
    expect(next).toEqual(new Set(['0:0', '0:2', '1:5']));
  });

  it('resolveKeySelection: additive toggles, re-click keeps group, plain click selects one', () => {
    const cur = new Set(['0:1', '0:2']);
    // additive on a member removes it; on a non-member adds it.
    expect(resolveKeySelection(cur, '0:1', true)).toEqual(new Set(['0:2']));
    expect(resolveKeySelection(cur, '0:3', true)).toEqual(new Set(['0:1', '0:2', '0:3']));
    // plain click on an ALREADY-selected key keeps the whole group (same ref → drag works).
    expect(resolveKeySelection(cur, '0:1', false)).toBe(cur);
    // plain click on an unselected key selects only it.
    expect(resolveKeySelection(cur, '0:9', false)).toEqual(new Set(['0:9']));
  });

  it('nextKeyTime finds the next/prev key across tracks, or undefined at the ends', () => {
    // union of times {0, 0.1, 0.2, 0.5} across two tracks.
    expect(nextKeyTime(tracks, 0.05, 1)).toBeCloseTo(0.1, 6);
    expect(nextKeyTime(tracks, 0.1, 1)).toBeCloseTo(0.2, 6); // strictly greater (skips the one on the playhead)
    expect(nextKeyTime(tracks, 0.2, -1)).toBeCloseTo(0.1, 6);
    expect(nextKeyTime(tracks, 0.6, 1)).toBeUndefined(); // nothing after the last
    expect(nextKeyTime(tracks, 0, -1)).toBeUndefined(); // nothing before the first
  });
});
