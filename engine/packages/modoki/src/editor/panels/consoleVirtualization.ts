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

/** F2/F7 (#626/#633 adversarial review): where to insert the gap-disclosure row into a FILTERED
 *  log list — the index of the first entry past the pinned/tail seam, or `-1` when no marker
 *  should be shown at all. Extracted out of `Console.tsx` (a panel's DECISIONS belong in a plain
 *  `.ts` module beside it, per `docs/editor.md` § Panels) so this seam-finding logic is covered by
 *  `npm run verify` — nothing imports the panel itself except a `data-ui-id` pin, so a regression
 *  here was previously invisible to the automated gate.
 *
 *  `logs` must carry stable, ascending `id`s (the ring's own `seq`), already filtered to whatever
 *  the panel's level/text filter currently shows. The seam is the adjacent PAIR straddling
 *  `id === bootPrefixCount` — `logs[i-1].id <= bootPrefixCount` immediately followed by
 *  `logs[i].id > bootPrefixCount` — never an absolute position, because a filter (or a Clear) can
 *  remove entries from either side without moving where the real seam sits.
 *
 *  Returns `-1` in three cases, and callers must not distinguish them (all three mean "don't draw a
 *  marker"): `dropped <= 0` (nothing was ever evicted); the filtered list has no pinned-side
 *  survivor, no tail-side survivor, or neither adjacent to the other (the seam isn't VISIBLE in
 *  this filtered view — mirrors `ConsoleTab.tsx`'s identical guard); and — the one callers must
 *  read this comment to know about — **after a Clear that has advanced the watermark past the
 *  entire pinned prefix**. `clearEditorLogs()`/`clearConsoleEntries()` advance a per-consumer
 *  watermark, not `bootPrefixCount` itself, so once every surviving row's `id` is already greater
 *  than `bootPrefixCount`, there is no pinned-side survivor left to pair with — this function
 *  correctly returns `-1`, but that is a COVERAGE GAP, not a resolved one: lines logged AFTER that
 *  Clear can still be silently missing a NEW gap (the ring can go on evicting its tail forever) with
 *  `dropped > 0` and the toolbar's `n/total` counter reading perfectly healthy. `Console.tsx`'s own
 *  doc comment on `displayRows` states this limitation; `ConsoleTab.tsx` has the identical gap and
 *  it is a deliberate PARITY choice between the two, not a bug either owes a fix today. */
export function findGapMarkerIndex(
  logs: { id: number }[],
  bootPrefixCount: number,
  dropped: number,
): number {
  if (dropped <= 0) return -1;
  const idx = logs.findIndex((e, i) =>
    i > 0 && logs[i - 1].id <= bootPrefixCount && e.id > bootPrefixCount);
  return idx > 0 ? idx : -1;
}
