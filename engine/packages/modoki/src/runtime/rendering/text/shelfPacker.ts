/** Pure multi-page shelf packer for the dynamic font atlas. Separated from
 *  {@link DynamicFontProvider} (which owns the canvases + WASM gen) so the packing
 *  geometry — row wrap, page spill, the page cap — is headless-testable with no DOM.
 *
 *  Top-origin cells, left→right within a row, top→bottom in rows. A cell that
 *  overflows the row width wraps to a new row; a row that overflows the page height
 *  spills to the NEXT page; past `maxPages` the pack is full and returns null. A
 *  `gap` gutter follows every cell (both axes) so an OFFSET atlas sample (drop shadow /
 *  wide glow) can't bleed into a neighbour — see the CELL_GAP note in the provider. */

export interface ShelfState {
  /** Current page being filled. */
  page: number;
  /** Pen position (px) within the current page. */
  penX: number;
  penY: number;
  /** Tallest cell in the current row (px) — the row's vertical advance. */
  rowH: number;
  /** Every page up to the cap is exhausted. */
  full: boolean;
}

export interface ShelfCell {
  page: number;
  x: number;
  y: number;
}

export function newShelfState(): ShelfState {
  return { page: 0, penX: 0, penY: 0, rowH: 0, full: false };
}

/** Allocate a `w×h` cell, MUTATING `s`. Returns its page + top-left px, or null once
 *  every page up to `maxPages` is exhausted (sets `s.full`). A single cell is assumed
 *  to fit a fresh `atlasSize²` page (cells ≪ page). */
export function shelfAlloc(
  s: ShelfState, w: number, h: number, atlasSize: number, gap: number, maxPages: number,
): ShelfCell | null {
  if (s.full) return null;
  if (s.penX + w > atlasSize) { s.penX = 0; s.penY += s.rowH + gap; s.rowH = 0; } // wrap row
  if (s.penY + h > atlasSize) {
    // Page's rows exhausted → spill to the next page.
    if (s.page + 1 >= maxPages) { s.full = true; return null; }
    s.page++; s.penX = 0; s.penY = 0; s.rowH = 0;
  }
  const x = s.penX, y = s.penY, page = s.page;
  s.penX += w + gap; // gutter after the cell (horizontal); rowH + gap gives the vertical gutter on wrap
  s.rowH = Math.max(s.rowH, h);
  return { page, x, y };
}
