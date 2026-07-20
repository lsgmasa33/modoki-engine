/** Pure virtualization math for the Console log list. Kept React-free so it can
 *  be unit-tested without a DOM. Rows are uniform-height (single line + the full
 *  message/stack live in the detail pane), so offsets are a simple multiply. */

export interface VisibleRange {
  /** First row index to render (inclusive), with a 2-row overscan above. */
  startIdx: number;
  /** One past the last row index to render, with a 2-row overscan below. */
  endIdx: number;
  /** Height of the spacer standing in for rows above the viewport. */
  topSpacer: number;
  /** Height of the spacer standing in for rows below the viewport. */
  bottomSpacer: number;
}

const OVERSCAN = 2;

/** Given the scroll position, viewport height, row count and (uniform) row
 *  height, return which rows to render plus the top/bottom spacer heights. */
export function computeVisibleRange(
  scrollTop: number,
  viewHeight: number,
  totalRows: number,
  rowHeight: number,
): VisibleRange {
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const endIdx = Math.min(totalRows, Math.ceil((scrollTop + viewHeight) / rowHeight) + OVERSCAN);
  return {
    startIdx,
    endIdx,
    topSpacer: startIdx * rowHeight,
    bottomSpacer: Math.max(0, (totalRows - endIdx) * rowHeight),
  };
}

/** Largest valid scrollTop for the current content height — anything past this
 *  would scroll the viewport off the end of the list. */
export function maxScrollTop(viewHeight: number, totalRows: number, rowHeight: number): number {
  return Math.max(0, totalRows * rowHeight - viewHeight);
}

/** Clamp a (possibly stale) scrollTop to the current content height. After a
 *  clear or a filter that shrinks `totalRows`, the old scrollTop can exceed the
 *  new content height; left unclamped, `computeVisibleRange` would window past
 *  the end and render blank rows until the next log lands. Returns the clamped
 *  offset (never above the max, never below 0). */
export function clampScrollTop(
  scrollTop: number,
  viewHeight: number,
  totalRows: number,
  rowHeight: number,
): number {
  return Math.max(0, Math.min(scrollTop, maxScrollTop(viewHeight, totalRows, rowHeight)));
}
