/** entriesLayout — the window arithmetic behind `UIEntries`.
 *
 *  Pure, and deliberately so: this is where the design's correctness actually lives, and a
 *  pure module is the only part of a scroll view that can be pinned without a browser.
 *
 *  The offset is carried on the content child's LEADING/TRAILING padding rather than by
 *  positioning entries absolutely. The property that buys: entry *i* always sits at
 *  `i * stride` **regardless of `first`**, so recycling never shifts content under a moving
 *  finger — verified on device (Galaxy A23, 2026-08-21) across every configuration tested.
 */

/** One axis of the window. */
export interface AxisWindow {
  /** Index of the first pooled entry on this axis. */
  first: number;
  /** Entries the viewport can show, including the one straddling its edge. */
  visible: number;
  /** Pooled entries on this axis (`visible + 2 x overscan`, clamped to the data). */
  pooled: number;
  /** Entries actually rendered — fewer than `pooled` at the very end of the data. */
  rendered: number;
  /** Leading padding in px (top / left). */
  padLeading: number;
  /** Trailing padding in px (bottom / right). */
  padTrailing: number;
}

export const EMPTY_WINDOW: AxisWindow = {
  first: 0, visible: 0, pooled: 0, rendered: 0, padLeading: 0, padTrailing: 0,
};

/** One authored length resolved to px, on one axis, against one viewport extent. Shared by both
 *  the view's own authored value and the prefab-root fallback below so the two axes cannot
 *  resolve `%` two different ways — that drift IS the bug this function's caller once had. */
function lengthToPx(value: number, unit: 'px' | '%', viewport: number): number {
  return unit === '%' ? (viewport * value) / 100 : Math.max(0, value);
}

/** Resolve an authored entry size to px.
 *
 *  - `%` resolves against the viewport — this is how a one-at-a-time pager is expressed (100%).
 *  - **`0` means "read it from the prefab"**, so a fixed-size entry is not a second copy of a
 *    number the prefab root's own `UIElement` already states (the single-source-of-truth rule:
 *    a resize should be a one-place edit). The prefab's value carries its OWN unit
 *    (`fromPrefabUnit`) and resolves against the very same viewport axis as the view's own
 *    authored value — a `%`-sized prefab root is not pinned to its raw number in px.
 */
export function resolveEntrySize(
  authored: number, unit: 'px' | '%', viewport: number,
  fromPrefab: number, fromPrefabUnit: 'px' | '%',
): number {
  if (authored === 0) return Math.max(0, lengthToPx(fromPrefab, fromPrefabUnit, viewport));
  return lengthToPx(authored, unit, viewport);
}

/** Raise the authored overscan to cover how far the scroll actually travelled since the last
 *  pool update.
 *
 *  ⚠️ **A fixed overscan does not work, and this is measured rather than reasoned.** On a
 *  Galaxy A23 (2026-08-21) a hard fling traversed up to **4.56 entries between two pool
 *  updates**, and a blank appears exactly when that traversal exceeds overscan: `overscan: 1`
 *  blanked 12/1787 frames (worst shortfall 2 entries) and `overscan: 3` blanked 74/605 (worst
 *  shortfall 4). Only `overscan: 6` against a 4.56-entry traversal came back clean.
 *
 *  `entriesTravelled` is measured between consecutive pool updates, so it folds in DROPPED
 *  FRAMES as well as velocity. That is the right quantity — it is the distance the pool has to
 *  cover either way — but it is not a velocity number and must not be quoted as one.
 *
 *  ⚠️ **`cap` is not optional prudence — without it a JUMP blows the pool up to the whole data
 *  set.** A teleport (a programmatic `scrollToEntry`, a scrollbar drag, a fresh view opened
 *  deep in the list) reports thousands of entries of "travel", and an uncapped raise pools every
 *  one of them. Measured live in the editor 2026-08-21: jumping `scrollTop` across a 5,000-entry
 *  list grew the pool from 9 entities to **5,000**, with 10,001 DOM nodes under the view — the
 *  exact cost this feature exists to avoid, arrived at by the feature itself.
 *
 *  A jump is also the case that NEEDS no overscan: the window relocates wholesale rather than
 *  continuing in a direction, so there is nothing to pre-cover. Capping at roughly a viewport's
 *  worth keeps the fling case (measured at 4.56 entries) fully covered while bounding the pool
 *  at a few screens no matter what the scroll does.
 */
export function effectiveOverscan(authoredFloor: number, entriesTravelled: number, cap = Infinity): number {
  const floor = Math.max(0, Math.floor(authoredFloor));
  const ceiling = Number.isFinite(cap) ? Math.max(floor, Math.floor(cap)) : Infinity;
  if (!Number.isFinite(entriesTravelled) || entriesTravelled <= 0) return floor;
  return Math.min(ceiling, Math.max(floor, Math.ceil(entriesTravelled)));
}

export interface AxisInput {
  /** Current scroll offset on this axis, px. */
  scroll: number;
  /** Viewport extent on this axis, px. */
  viewport: number;
  /** One entry's extent on this axis, px. */
  entrySize: number;
  /** Gap between entries on this axis, px. */
  gap: number;
  /** How many entries the data has on this axis. */
  count: number;
  /** Overscan per edge — pass `effectiveOverscan(...)`, not the raw authored floor. */
  overscan: number;
}

/** Compute one axis of the window.
 *
 *  `visible` carries the **`+1` floor**: at any partial scroll offset one entry straddles the
 *  viewport edge, so a viewport `n` entries tall shows `n + 1` of them. That term is GEOMETRY
 *  and is required even at `overscan: 0`; `overscan` is a separate term covering LATENCY.
 *  Merging the two is how the `+1` gets tuned away and a one-entry gap reappears at every
 *  non-integer offset (owner, 2026-08-21).
 */
export function computeAxisWindow(a: AxisInput): AxisWindow {
  const count = Math.max(0, Math.floor(a.count));
  const stride = a.entrySize + a.gap;
  // A zero/negative stride would divide by zero and produce an infinite pool. An entry with no
  // size is an authoring error, not something to render badly.
  if (count === 0 || stride <= 0) return EMPTY_WINDOW;

  const visible = Math.min(count, Math.ceil(Math.max(0, a.viewport) / stride) + 1);
  const overscan = Math.max(0, Math.floor(a.overscan));
  const pooled = Math.min(count, visible + overscan * 2);

  const rawFirst = Math.floor(Math.max(0, a.scroll) / stride) - overscan;
  const first = Math.min(Math.max(0, rawFirst), Math.max(0, count - pooled));
  const rendered = Math.min(pooled, count - first);

  // padLeading + rendered extent + padTrailing == count*stride - gap, so scrollHeight (and
  // therefore the scrollbar and every CSS snap point) lands exactly where the design assumes.
  // The rendered extent already includes its own internal gaps via flex `gap`, which is why
  // the trailing term is a clean multiple of stride.
  const padLeading = first * stride;
  const padTrailing = Math.max(0, (count - first - rendered) * stride);

  return { first, visible, pooled, rendered, padLeading, padTrailing };
}

/** Total scrollable extent on one axis, px — `count` entries with `count - 1` gaps. */
export function contentExtent(count: number, entrySize: number, gap: number): number {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return 0;
  return n * entrySize + (n - 1) * gap;
}

/** Which pool SLOT shows a given entry index, and the inverse.
 *
 *  Slots are assigned in data order from `first`, NOT modulo the pool. Modulo assignment is the
 *  usual ring-buffer trick and is wrong here: child order comes from `EntityAttributes.sortOrder`
 *  and a wrapped ring would need the sortOrder rewritten anyway, so ordering by data index keeps
 *  one rule instead of two. */
export function slotForIndex(index: number, first: number, pooled: number): number {
  const slot = index - first;
  return slot >= 0 && slot < pooled ? slot : -1;
}
export function indexForSlot(slot: number, first: number): number {
  return first + slot;
}

/** One pooled slot's assignment for this frame. */
export interface SlotPlan {
  slot: number;
  x: number;
  y: number;
  /** `y * countX + x` — the flat data index. */
  index: number;
  /** False → this slot is PARKED: past the end of the data, and must read as destroyed to
   *  Percept/Enact rather than merely hidden. */
  live: boolean;
}

/** Assign every pooled slot to a data coordinate, in reading order.
 *
 *  Slots are ordered so that slot 0 is the top-left of the pooled window and slot index rises
 *  across then down — the same order the DOM children sit in, which is what lets `sortOrder`
 *  be written as a plain counter instead of a second mapping to keep in sync.
 *
 *  A pool is sized for the window, so it routinely over-covers at the end of the data (the last
 *  page of a grid is rarely full). Those slots come back `live: false` rather than being
 *  omitted, because the caller must still PARK them — dropping them from the list is how a
 *  stale entry stays on screen showing the previous page's content.
 */
export function planSlots(xw: AxisWindow, yw: AxisWindow, countX: number, countY: number): SlotPlan[] {
  const out: SlotPlan[] = [];
  const cx = Math.max(0, Math.floor(countX));
  const cy = Math.max(0, Math.floor(countY));
  let slot = 0;
  for (let row = 0; row < yw.pooled; row++) {
    for (let col = 0; col < xw.pooled; col++) {
      const x = xw.first + col;
      const y = yw.first + row;
      const live = x < cx && y < cy;
      out.push({ slot, x, y, index: live ? y * cx + x : -1, live });
      slot++;
    }
  }
  return out;
}
