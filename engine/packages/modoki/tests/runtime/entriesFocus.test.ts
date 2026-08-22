/** entriesFocus — the pure half of "focus follows the ENTRY, not the slot" (#319).
 *
 *  Every rule here is testable with no world and no pool: the path derivation is pure over a
 *  child index plus a stepId lookup, and the re-target choice is pure over a list of resident
 *  entries. The system integration (capture before a re-drive, re-point after one) is in
 *  entriesSystem.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  describeMemberPath, resolveMemberPathSegs, pickRetargetEntry,
} from '../../src/runtime/ui/entriesFocus';

type Index = Map<number, { id: number; name: string }[]>;

/** Two structurally identical prefab instances, rooted at 100 and 200:
 *
 *      root
 *        Grid                       stepId 1
 *          Cell  Cell  Cell         stepId 2, 3, 4   <- three siblings sharing ONE name
 *            Num                    stepId 5         (under the MIDDLE Cell)
 *        Label                      stepId 6
 *
 *  `stepId` is `PrefabInstance.parentLocalId || localId` — authored, identical across every
 *  instance of the prefab, and unique among siblings by construction. */
const STEP: Record<number, number> = {};
function twoSlots(): Index {
  const ix: Index = new Map();
  const build = (root: number) => {
    const grid = root + 1, label = root + 2;
    const c0 = root + 10, c1 = root + 11, c2 = root + 12, num = root + 20;
    ix.set(root, [{ id: grid, name: 'Grid' }, { id: label, name: 'Label' }]);
    ix.set(grid, [{ id: c0, name: 'Cell' }, { id: c1, name: 'Cell' }, { id: c2, name: 'Cell' }]);
    ix.set(c1, [{ id: num, name: 'Num' }]);
    STEP[grid] = 1; STEP[c0] = 2; STEP[c1] = 3; STEP[c2] = 4; STEP[num] = 5; STEP[label] = 6;
  };
  build(100);
  build(200);
  return ix;
}
const stepIdOf = (id: number) => STEP[id] ?? 0;
/** The same index with the whole world's iteration order shuffled — which is what koota's
 *  swap-pop on `releaseEntity` really does to `world.entities` when an unrelated view releases
 *  its pool. A correct path must be indifferent to it. */
function shuffledSiblings(ix: Index): Index {
  const out: Index = new Map();
  for (const [k, v] of ix) out.set(k, [...v].reverse());
  return out;
}

describe('entriesFocus — deriving a member path', () => {
  it('describes an empty chain as an empty path (the target IS the entry root)', () => {
    expect(describeMemberPath(twoSlots(), stepIdOf, 100, [])).toEqual([]);
  });

  it('keys each step by stepId, so same-named siblings stay distinguishable', () => {
    // NOT resolveMemberPathIn: that walker calls an ambiguous segment an ERROR by design, which
    // is right for an AUTHORED resolver key and wrong for a path DERIVED from an entity that
    // provably exists. `level-tile.prefab.json` carries three entities named `Num`.
    const segs = describeMemberPath(twoSlots(), stepIdOf, 100, [101, 111]);   // the MIDDLE Cell
    expect(segs).toEqual([
      { stepId: 1, name: 'Grid', ordinal: 0 },
      { stepId: 3, name: 'Cell', ordinal: 0 },
    ]);
  });

  it('walks several levels, through the ambiguous name and out the other side', () => {
    expect(describeMemberPath(twoSlots(), stepIdOf, 100, [101, 111, 120])).toEqual([
      { stepId: 1, name: 'Grid', ordinal: 0 },
      { stepId: 3, name: 'Cell', ordinal: 0 },
      { stepId: 5, name: 'Num', ordinal: 0 },
    ]);
  });

  it('returns null rather than a partial path when a link is not a child of the one above', () => {
    // 211 is the OTHER slot's Cell — a corrupt chain, not a deep path.
    expect(describeMemberPath(twoSlots(), stepIdOf, 100, [101, 211])).toBeNull();
    expect(describeMemberPath(twoSlots(), stepIdOf, 999, [101])).toBeNull();
  });

  it('falls back to name + ordinal only for entities with NO PrefabInstance', () => {
    const ix = twoSlots();
    const keyless = () => 0;
    expect(describeMemberPath(ix, keyless, 101, [111])).toEqual([{ stepId: 0, name: 'Cell', ordinal: 1 }]);
    expect(describeMemberPath(ix, keyless, 101, [112])).toEqual([{ stepId: 0, name: 'Cell', ordinal: 2 }]);
  });
});

describe('entriesFocus — resolving a derived path into another slot', () => {
  it('lands on the SAME member of a different instance', () => {
    const ix = twoSlots();
    const segs = describeMemberPath(ix, stepIdOf, 100, [101, 111])!;
    expect(resolveMemberPathSegs(ix, stepIdOf, 200, segs)).toBe(211);   // slot 2's middle Cell
  });

  it('round-trips a deep path through the same-named siblings', () => {
    const ix = twoSlots();
    const deep = describeMemberPath(ix, stepIdOf, 100, [101, 111, 120])!;
    expect(resolveMemberPathSegs(ix, stepIdOf, 100, deep)).toBe(120);
    expect(resolveMemberPathSegs(ix, stepIdOf, 200, deep)).toBe(220);   // the other slot's Num
  });

  it('is INDIFFERENT to sibling order — the whole reason a stepId beats an ordinal', () => {
    // koota's releaseEntity swap-pops the dense array `buildChildIndex` iterates, so destroying
    // entities anywhere in the scene can reorder one live instance's siblings relative to
    // another's. An ordinal counted against that order would silently name a different member.
    const ix = twoSlots();
    const segs = describeMemberPath(ix, stepIdOf, 100, [101, 111, 120])!;
    expect(resolveMemberPathSegs(shuffledSiblings(ix), stepIdOf, 200, segs)).toBe(220);
  });

  it('returns 0 on a miss instead of guessing a member', () => {
    const ix = twoSlots();
    expect(resolveMemberPathSegs(ix, stepIdOf, 200, [{ stepId: 99, name: 'Nope', ordinal: 0 }])).toBe(0);
    expect(resolveMemberPathSegs(ix, stepIdOf, 200, [
      { stepId: 1, name: 'Grid', ordinal: 0 }, { stepId: 77, name: 'Cell', ordinal: 0 },
    ])).toBe(0);
  });
});

describe('entriesFocus — which resident entry gets the focus', () => {
  const strip = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ x: 0, y: from + i, rootId: 1000 + from + i }));

  it('prefers the exact entry — the common case, a window that merely shifted', () => {
    expect(pickRetargetEntry({ x: 0, y: 12 }, strip(9, 17))!.rootId).toBe(1012);
  });

  it('CLAMPS to the leading edge when the entry has left the pool', () => {
    // The owner's call (2026-08-22): clearing focus reads as a dropped input on a gamepad, and
    // autofocus would then land at the list's lowest focusOrder rather than where the player was.
    expect(pickRetargetEntry({ x: 0, y: 3 }, strip(40, 48))!.y).toBe(40);    // flung forwards
    expect(pickRetargetEntry({ x: 0, y: 900 }, strip(40, 48))!.y).toBe(48);  // flung backwards
  });

  it('clamps each axis independently on a 2-D grid window', () => {
    const grid: { x: number; y: number; rootId: number }[] = [];
    for (let y = 5; y <= 7; y++) for (let x = 2; x <= 4; x++) grid.push({ x, y, rootId: y * 10 + x });
    // x is still inside the window, y has run off the bottom.
    expect(pickRetargetEntry({ x: 3, y: 40 }, grid)).toEqual({ x: 3, y: 7, rootId: 73 });
  });

  it('falls back to nearest when the clamped PAIR is not itself resident', () => {
    const ragged = [{ x: 0, y: 0, rootId: 1 }, { x: 5, y: 5, rootId: 2 }];
    expect(pickRetargetEntry({ x: 5, y: 0 }, ragged)!.rootId).toBe(1);
  });

  it('returns null when nothing is resident, so the caller leaves focus alone', () => {
    expect(pickRetargetEntry({ x: 0, y: 3 }, [])).toBeNull();
  });
});
