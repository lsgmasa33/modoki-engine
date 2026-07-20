/** shelfPacker — the multi-page allocation the dynamic font atlas spills glyph cells
 *  through. Row wrap, page spill on vertical overflow, the gutter between cells, and
 *  the page cap. Pure, so no canvas/WASM needed. */

import { describe, it, expect } from 'vitest';
import { newShelfState, shelfAlloc } from '../../src/runtime/rendering/text/shelfPacker';

const SIZE = 100;
const GAP = 10;

describe('shelfPacker', () => {
  it('places cells left→right with a gutter, all on page 0', () => {
    const s = newShelfState();
    const a = shelfAlloc(s, 20, 20, SIZE, GAP, 8);
    const b = shelfAlloc(s, 20, 20, SIZE, GAP, 8);
    expect(a).toEqual({ page: 0, x: 0, y: 0 });
    expect(b).toEqual({ page: 0, x: 30, y: 0 }); // 20 cell + 10 gap
  });

  it('wraps to a new row (rowH + gap) when a cell overflows the width', () => {
    const s = newShelfState();
    shelfAlloc(s, 40, 30, SIZE, GAP, 8); // x0..40
    shelfAlloc(s, 40, 20, SIZE, GAP, 8); // x50..90
    const c = shelfAlloc(s, 40, 20, SIZE, GAP, 8); // 100 > width → wrap
    expect(c).toEqual({ page: 0, x: 0, y: 40 }); // rowH 30 + gap 10
  });

  it('spills onto the next page when a row overflows the height', () => {
    const s = newShelfState();
    // Fill rows down page 0: each row is 40 tall (+10 gap) → rows at y=0,50; y=100 overflows.
    shelfAlloc(s, 90, 40, SIZE, GAP, 8); // row0 y0, then width full
    shelfAlloc(s, 90, 40, SIZE, GAP, 8); // wraps to row1 y50
    const third = shelfAlloc(s, 90, 40, SIZE, GAP, 8); // row2 y100 > height → page 1
    expect(third).toEqual({ page: 1, x: 0, y: 0 });
    expect(s.page).toBe(1);
  });

  it('returns null (and marks full) once every page up to maxPages is exhausted', () => {
    const s = newShelfState();
    const MAX = 2;
    // A cell that fills a whole page height in one row, forcing a page spill each time.
    shelfAlloc(s, 90, 90, SIZE, GAP, MAX); // page 0
    const p1 = shelfAlloc(s, 90, 90, SIZE, GAP, MAX); // page 1
    expect(p1?.page).toBe(1);
    const overflow = shelfAlloc(s, 90, 90, SIZE, GAP, MAX); // would need page 2 → capped
    expect(overflow).toBeNull();
    expect(s.full).toBe(true);
    // Stays full for subsequent allocs.
    expect(shelfAlloc(s, 10, 10, SIZE, GAP, MAX)).toBeNull();
  });
});
