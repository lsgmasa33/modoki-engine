/** scrollAnchor unit tests — the pure decision functions only (#531).
 *
 *  `useScrollAnchoring` itself is NOT tested here: jsdom reports every box as 0x0 and has no
 *  ResizeObserver, so mounting it would assert the mock (see the header comment in
 *  `scrollAnchor.ts`). These tests cover `pickAnchor`, `pickRestoreTarget`, `restoredOffset`,
 *  `shouldApply` and `isIntentfulScroll` — the pure arithmetic the hook is built on. */

import { describe, it, expect } from 'vitest';
import { pickAnchor, pickRestoreTarget, restoredOffset, shouldApply, isIntentfulScroll, type AnchorBox, type AnchorCandidate } from '../../src/runtime/ui/scrollAnchor';

describe('pickAnchor', () => {
  it('offset 0 picks child 0 with gap 0', () => {
    const children: AnchorBox[] = [{ start: 0, size: 50 }, { start: 50, size: 50 }];
    expect(pickAnchor(children, 0)).toEqual({ index: 0, gap: 0 });
  });

  it('picks the first child whose trailing edge is past the offset', () => {
    const children: AnchorBox[] = [
      { start: 0, size: 50 },   // ends at 50
      { start: 50, size: 50 },  // ends at 100
      { start: 100, size: 50 }, // ends at 150
    ];
    // offset 60 is inside child 1 (50..100)
    expect(pickAnchor(children, 60)).toEqual({ index: 1, gap: -10 });
  });

  it('gap is negative when the anchor straddles the offset', () => {
    const children: AnchorBox[] = [{ start: 0, size: 100 }];
    expect(pickAnchor(children, 40)).toEqual({ index: 0, gap: -40 });
  });

  it('returns null for an empty list', () => {
    expect(pickAnchor([], 0)).toBeNull();
  });

  it('returns null when every child ends at or before the offset', () => {
    const children: AnchorBox[] = [
      { start: 0, size: 50 },   // ends at 50
      { start: 50, size: 50 },  // ends at 100
    ];
    expect(pickAnchor(children, 100)).toBeNull();
  });
});

describe('restoredOffset', () => {
  it('is anchorStart - gap when within range', () => {
    expect(restoredOffset(200, -30, 1000)).toBe(230);
  });

  it('clamps to 0 (clamp-low case)', () => {
    expect(restoredOffset(10, 50, 1000)).toBe(0);
  });

  it('clamps to max (clamp-high case: the shrink has not been undone yet)', () => {
    expect(restoredOffset(500, -10, 300)).toBe(300);
  });

  it('round-trips: picking an anchor and restoring it with an unchanged start returns the original offset', () => {
    const children: AnchorBox[] = [
      { start: 0, size: 50 },
      { start: 50, size: 50 },
      { start: 100, size: 50 },
    ];
    const offset = 60;
    const anchor = pickAnchor(children, offset)!;
    const anchorStart = children[anchor.index].start;
    expect(restoredOffset(anchorStart, anchor.gap, 1000)).toBe(offset);
  });

  it('round-trips with the anchor start reduced by 100 (a row removed above it): result is 100 less', () => {
    const children: AnchorBox[] = [
      { start: 0, size: 200 },
      { start: 200, size: 200 },
      { start: 400, size: 300 },
    ];
    const offset = 250;
    const anchor = pickAnchor(children, offset)!;
    const anchorStart = children[anchor.index].start;
    const shiftedStart = anchorStart - 100;
    expect(restoredOffset(shiftedStart, anchor.gap, 1000)).toBe(offset - 100);
  });
});

describe('shouldApply', () => {
  it('false just below the epsilon', () => {
    expect(shouldApply(100, 100.49)).toBe(false);
    expect(shouldApply(100.49, 100)).toBe(false);
  });

  it('true at the epsilon, in both directions', () => {
    expect(shouldApply(100, 100.5)).toBe(true);
    expect(shouldApply(100.5, 100)).toBe(true);
  });

  it('true well above the epsilon', () => {
    expect(shouldApply(100, 150)).toBe(true);
  });
});

describe('isIntentfulScroll', () => {
  it('false when the offset matches applied within the epsilon (our own write echoing back)', () => {
    expect(isIntentfulScroll(200, 200.2, 500, 500)).toBe(false);
  });

  it('true when applied is far from offset and sizes agree', () => {
    expect(isIntentfulScroll(200, 100, 500, 500)).toBe(true);
  });

  it('false when contentSize differs from anchoredContentSize even when applied is null (a clamp)', () => {
    expect(isIntentfulScroll(200, null, 400, 500)).toBe(false);
  });

  it('true only when sizes agree and it is not an echo', () => {
    expect(isIntentfulScroll(200, null, 500, 500)).toBe(true);
  });
});

describe('pickRestoreTarget', () => {
  // Plain string children — `pickRestoreTarget` is generic and has no DOM dependency, so a real
  // element would only obscure what's under test.
  const candidates: AnchorCandidate<string>[] = [
    { child: 'rowA', start: 0 },
    { child: 'rowB', start: 50 },
    { child: 'rowC', start: 130 },
    { child: 'rowD', start: 200 },
  ];

  it('returns the anchor itself when it survived (the common case)', () => {
    const isAlive = () => true;
    expect(pickRestoreTarget(candidates, isAlive)).toEqual({ child: 'rowA', start: 0 });
  });

  it('anchor died, the next candidate survived: returns that one, with ITS remembered start', () => {
    const isAlive = (c: string) => c !== 'rowA';
    const kept = pickRestoreTarget(candidates, isAlive);
    expect(kept?.child).toBe('rowB');
    expect(kept?.start).toBe(50);
  });

  it('anchor and several after it died: returns the first surviving one further down', () => {
    const isAlive = (c: string) => c === 'rowD';
    const kept = pickRestoreTarget(candidates, isAlive);
    expect(kept?.child).toBe('rowD');
    expect(kept?.start).toBe(200);
  });

  it('the whole tail died: returns null', () => {
    const isAlive = () => false;
    expect(pickRestoreTarget(candidates, isAlive)).toBeNull();
  });

  it('an empty candidate list: returns null', () => {
    expect(pickRestoreTarget([] as AnchorCandidate<string>[], () => true)).toBeNull();
  });

  it('round-trips into restoredOffset: a row removed above the survivor lands the offset 100 less', () => {
    // Snapshot taken while scrolled to rawOffset 250, anchored on rowB (start 50).
    const rawOffset = 250;
    const snapshot: AnchorCandidate<{ id: string }>[] = [
      { child: { id: 'rowB' }, start: 50 },
      { child: { id: 'rowC' }, start: 130 },
    ];
    // rowB is later removed (a row above it went away, not rowB itself, so this models the
    // survivor's CURRENT start having moved: rowC now sits 100px earlier than remembered).
    const isAlive = (c: { id: string }) => c.id === 'rowC';
    const kept = pickRestoreTarget(snapshot, isAlive)!;
    expect(kept.child.id).toBe('rowC');
    const currentStart = kept.start - 100; // the row shifted up 100px since the snapshot
    const gap = kept.start - rawOffset;
    expect(restoredOffset(currentStart, gap, 100_000)).toBe(rawOffset - 100);
  });
});
