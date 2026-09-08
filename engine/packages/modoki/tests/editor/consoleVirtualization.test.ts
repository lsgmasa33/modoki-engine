/** computeVisibleRange — Console log-list virtualization math.
 *  Rows are uniform-height, so the visible window + spacer heights are a simple
 *  multiply with a fixed overscan above/below. */

import { describe, it, expect } from 'vitest';
import { computeVisibleRange, clampScrollTop, maxScrollTop, findGapMarkerIndex } from '../../src/editor/panels/consoleVirtualization';

const ROW = 21;

describe('computeVisibleRange', () => {
  it('renders from the top with overscan when scrolled to 0', () => {
    const r = computeVisibleRange(0, 210, 100, ROW); // 10 rows fit
    expect(r.startIdx).toBe(0); // clamped (can't overscan below 0)
    expect(r.endIdx).toBe(12);  // 10 visible + 2 overscan
    expect(r.topSpacer).toBe(0);
    expect(r.bottomSpacer).toBe((100 - 12) * ROW);
  });

  it('applies 2-row overscan above and below when scrolled into the middle', () => {
    const scrollTop = 50 * ROW; // row 50 at the top edge
    const r = computeVisibleRange(scrollTop, 210, 100, ROW);
    expect(r.startIdx).toBe(48); // 50 - 2 overscan
    expect(r.endIdx).toBe(62);   // ceil((scrollTop+210)/ROW) + 2 = 60 + 2
    expect(r.topSpacer).toBe(48 * ROW);
    expect(r.bottomSpacer).toBe((100 - 62) * ROW);
  });

  it('clamps endIdx to totalRows and zeroes the bottom spacer at the end', () => {
    const scrollTop = 95 * ROW;
    const r = computeVisibleRange(scrollTop, 210, 100, ROW);
    expect(r.endIdx).toBe(100); // clamped to totalRows
    expect(r.bottomSpacer).toBe(0);
    expect(r.startIdx).toBe(93);
  });

  it('top + visible + bottom spacer always equals the full scroll height', () => {
    const total = 250;
    for (const scrollTop of [0, 137, 1000, 4999, total * ROW]) {
      const r = computeVisibleRange(scrollTop, 300, total, ROW);
      const visibleHeight = (r.endIdx - r.startIdx) * ROW;
      expect(r.topSpacer + visibleHeight + r.bottomSpacer).toBe(total * ROW);
    }
  });

  it('handles an empty list', () => {
    const r = computeVisibleRange(0, 300, 0, ROW);
    expect(r).toEqual({ startIdx: 0, endIdx: 0, topSpacer: 0, bottomSpacer: 0 });
  });
});

describe('clampScrollTop (panels F3 — stale scroll after clear/filter)', () => {
  it('leaves a valid scrollTop unchanged', () => {
    // 100 rows × 21 = 2100 content, 300 viewport → max scroll 1800.
    expect(clampScrollTop(1000, 300, 100, ROW)).toBe(1000);
    expect(clampScrollTop(1800, 300, 100, ROW)).toBe(1800);
  });

  it('clamps a stale scrollTop down to the new (shrunk) content height', () => {
    // Was scrolled to 1800 with 100 rows; a filter drops the set to 5 rows.
    // New content = 5 × 21 = 105 < 300 viewport → everything fits, max scroll 0.
    expect(clampScrollTop(1800, 300, 5, ROW)).toBe(0);
  });

  it('clamps to 0 when the list is cleared to empty', () => {
    expect(clampScrollTop(1800, 300, 0, ROW)).toBe(0);
  });

  it('clamps to the exact max when content still overflows the viewport', () => {
    // 50 rows × 21 = 1050 content, 300 viewport → max scroll 750.
    expect(maxScrollTop(300, 50, ROW)).toBe(750);
    expect(clampScrollTop(1800, 300, 50, ROW)).toBe(750);
  });

  it('never returns a negative offset', () => {
    expect(clampScrollTop(-50, 300, 100, ROW)).toBe(0);
  });

  it('a clamped scrollTop never windows past the end (no blank list)', () => {
    // The regression: stale scrollTop + shrunk totalRows used to leave startIdx
    // near totalRows and an empty visible slice. After clamping, startIdx is in range.
    const clamped = clampScrollTop(1800, 300, 5, ROW);
    const r = computeVisibleRange(clamped, 300, 5, ROW);
    expect(r.startIdx).toBe(0);
    expect(r.endIdx).toBe(5); // all 5 rows visible, nothing stranded
  });
});

describe('findGapMarkerIndex (F2/F7 — the pinned/tail gap-disclosure marker)', () => {
  const mk = (ids: number[]) => ids.map((id) => ({ id }));

  it('finds the seam: the index of the first entry past the pinned/tail boundary', () => {
    const logs = mk([1, 2, 3, 4, 5, 6, 7, 8]);
    // bootPrefixCount 5 -> the pair straddling the seam is id 5 (index 4) / id 6 (index 5).
    expect(findGapMarkerIndex(logs, 5, 3)).toBe(5);
  });

  it('shows no marker when nothing has ever been dropped', () => {
    const logs = mk([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(findGapMarkerIndex(logs, 5, 0)).toBe(-1);
  });

  it('shows no marker when a filter hides every row on the TAIL side (only pinned-side rows survive)', () => {
    const logs = mk([1, 2, 3]); // nothing with id > bootPrefixCount survived the filter
    expect(findGapMarkerIndex(logs, 5, 3)).toBe(-1);
  });

  it('shows no marker when a filter hides every row on the PINNED side — "every pinned row is filtered out"', () => {
    const logs = mk([6, 7, 8]); // nothing with id <= bootPrefixCount survived the filter
    expect(findGapMarkerIndex(logs, 5, 3)).toBe(-1);
  });

  it('the post-Clear case (Console.tsx F6 comment): a Clear that advanced the watermark past the ' +
    'ENTIRE pinned prefix leaves no pinned-side survivor to pair with, so a NEW gap opened in the ' +
    'tail AFTER the clear goes unmarked — a documented coverage gap, not a bug in this function', () => {
    // capacity 1000 / bootPrefix 128, log 2000, Clear, log 2000 more: the panel shows seq
    // 3129-4000 with dropped climbing past 1128, but every surviving id is already > bootPrefixCount
    // — there is no pinned-side survivor left anywhere in the list to pair with.
    const logs = mk([3129, 3130, 3131, 4000]);
    expect(findGapMarkerIndex(logs, 128, 1128)).toBe(-1);
  });
});
