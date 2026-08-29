/** scrollApi — the programmatic half of a scroll view: go to an entry, snap to the nearest one.
 *
 *  Requests are written in ENTRY coordinates onto `UIEntries` and converted to px by
 *  `entriesSystem`, which already resolves entry size (the `%`-of-viewport case and the
 *  `0` = "read it from the prefab" case). A px-based API would duplicate that resolution and
 *  drift from it — and a caller usually knows which ENTRY it wants, not which pixel.
 *
 *  ## Motion vocabulary matches the backend
 *
 *  `behavior` is `'instant' | 'smooth'`, both genuinely wired to the browser's own `scrollTo`
 *  and both verified on a real tap (2026-08-21): `instant` lands in one frame, `smooth` eases
 *  over 86 frames. There is deliberately no `duration`/`easing`: smooth duration is UA-defined
 *  and untunable, and an authored field that moves nothing is a lie with a tooltip. The owned
 *  backend that would have made them tunable is DECLINED — see UIScrollView's banner.
 *
 *  OMITTING `behavior` is not the same as passing `'instant'`: the request then moves the way the
 *  view's AUTHORED `UIScrollView.scrollBehavior` says. That default used to be overwritten by
 *  every request (#409) — see `scrollToEntry`'s ⚠️.
 */
import { getTraitByName } from '../core/ecs/traitRegistry';
import { getCurrentWorld, findEntityByGuid } from '../core/ecs/world';
import { NO_BEHAVIOR_REQUEST, type UIScrollBehavior } from '../traits/UIScrollView';

/** Sentinel shared with the trait defaults: "no request pending". */
export const NO_ENTRY_REQUEST = -1;

function viewOf(viewGuid: string) {
  const enMeta = getTraitByName('UIEntries');
  const svMeta = getTraitByName('UIScrollView');
  if (!enMeta || !svMeta || !viewGuid) return null;
  const world = getCurrentWorld();
  if (!world) return null;
  const entity = findEntityByGuid(viewGuid, world);
  if (!entity || !entity.has(enMeta.trait) || !entity.has(svMeta.trait)) return null;
  return { entity, enMeta, svMeta };
}

/** Scroll so entry (x, y) sits at the view's leading edge.
 *
 *  Either axis may be omitted — a vertical list only ever wants `y`, and requesting an axis the
 *  view does not scroll would fight the browser's own clamping. Returns false when the guid
 *  names no scroll view, rather than failing silently.
 */
export function scrollToEntry(
  viewGuid: string,
  at: { x?: number; y?: number },
  opts: { behavior?: UIScrollBehavior } = {},
): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  const en = v.entity.get(v.enMeta.trait) as Record<string, unknown>;
  v.entity.set(v.enMeta.trait, {
    ...en,
    scrollToEntryX: Number.isFinite(at.x) ? Math.max(0, Math.floor(at.x as number)) : NO_ENTRY_REQUEST,
    scrollToEntryY: Number.isFinite(at.y) ? Math.max(0, Math.floor(at.y as number)) : NO_ENTRY_REQUEST,
  });
  // ⚠️ The per-request behaviour goes on `scrollToBehavior`, NEVER on the authored
  // `scrollBehavior` (#409). Storing it there meant one request with no `behavior` — which
  // defaulted to `'instant'` — permanently overwrote an author's `'smooth'`, and the next save
  // baked the overwrite into the scene as authored data. `''` clears any previous override, so a
  // request that names no behaviour moves the way the AUTHOR said it should.
  const sv = v.entity.get(v.svMeta.trait) as Record<string, unknown>;
  const behavior = opts.behavior ?? NO_BEHAVIOR_REQUEST;
  if (sv.scrollToBehavior !== behavior) v.entity.set(v.svMeta.trait, { ...sv, scrollToBehavior: behavior });
  return true;
}

/** Snap to whichever entry the view is currently nearest.
 *
 *  Reads the LIVE window the system published (`firstX`/`firstY`) rather than recomputing from
 *  `scrollX`/`scrollY`: the system already did that arithmetic this frame, and re-deriving it
 *  here would be a second implementation of the same rounding to keep in sync.
 *
 *  ⚠️ `firstX`/`firstY` are the window ORIGIN, which sits `overscan` entries BEFORE the first
 *  visible one. The entry the viewer is actually looking at is the one at the scroll offset, so
 *  this asks for that, not for the pool's leading edge.
 */
export function snapToNearest(viewGuid: string, opts: { behavior?: UIScrollBehavior } = {}): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  // Not `Record<string, number>`: `axis` is a string, and reading it through a number-typed record
  // silently compares as one — the compiler catches it, which is how this cast got widened.
  const sv = v.entity.get(v.svMeta.trait) as Record<string, number | string>;
  const en = v.entity.get(v.enMeta.trait) as Record<string, number>;
  // ⚠️ **Gated on the view's AXIS, not only on whether a stride could be computed.** This used to
  // ask both axes whenever both had a usable stride — and an `axis: 'x'` view with more than one
  // ROW has a perfectly usable Y stride, so it armed a request on an axis that does not scroll.
  // `0` is a REAL request for entry 0, not "no request", which is how such a request became
  // unclearable and cancelled every smooth scroll (see `clearScrollRequest`'s banner). Court's
  // selector escaped it only by coincidence — `countY: 1` makes `visibleY` 1, and `entryStride`
  // returns 0 below 2 — which is exactly the kind of accident that stops being true later.
  const wantsX = sv.axis !== 'y';
  const wantsY = sv.axis !== 'x';
  const strideY = wantsY ? entryStride(sv.viewportHeight as number, en.visibleY) : 0;
  const strideX = wantsX ? entryStride(sv.viewportWidth as number, en.visibleX) : 0;
  const y = strideY > 0 ? Math.round((sv.scrollY as number) / strideY) : NO_ENTRY_REQUEST;
  const x = strideX > 0 ? Math.round((sv.scrollX as number) / strideX) : NO_ENTRY_REQUEST;
  return scrollToEntry(viewGuid, {
    x: x === NO_ENTRY_REQUEST ? undefined : x,
    y: y === NO_ENTRY_REQUEST ? undefined : y,
  }, opts);
}

/**
 * Move by whole ENTRIES from wherever the view currently sits.
 *
 * The same "which entry am I on" arithmetic `snapToNearest` does, plus a delta — which is what a
 * pager's wheel/keyboard handling wants, and what a caller cannot compute itself: the engine
 * publishes no resolved entry stride, and `UIEntries.firstX` is the first POOLED entry, which
 * overscan puts an entry BEFORE the visible one (legitimately -1 at the start of a list).
 *
 * Returns false when the view has no usable window yet, rather than requesting entry 0 — a caller
 * asking to move ONE would otherwise teleport to the top the first time it fires.
 */
export function scrollByEntry(
  viewGuid: string,
  by: { x?: number; y?: number },
  opts: { behavior?: UIScrollBehavior } = {},
): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  const sv = v.entity.get(v.svMeta.trait) as Record<string, number>;
  const en = v.entity.get(v.enMeta.trait) as Record<string, number>;
  const strideX = entryStride(sv.viewportWidth, en.visibleX);
  const strideY = entryStride(sv.viewportHeight, en.visibleY);
  const wantX = Number.isFinite(by.x) && (by.x as number) !== 0;
  const wantY = Number.isFinite(by.y) && (by.y as number) !== 0;
  const canX = wantX && strideX > 0;
  const canY = wantY && strideY > 0;
  if (!canX && !canY) return false;
  return scrollToEntry(viewGuid, {
    // ⚠️ Only the axis actually being moved is requested. Passing the other as a number would
    // arm a real request on an axis the view may not scroll — `0` is a request for entry 0, not
    // "no request" — which is the trap `scrollToEntry`'s own banner records.
    x: canX ? Math.max(0, Math.round(sv.scrollX / strideX) + (by.x as number)) : undefined,
    y: canY ? Math.max(0, Math.round(sv.scrollY / strideY) + (by.y as number)) : undefined,
  }, opts);
}

/** Recover one entry's stride from the published window: `visible` counts the straddling entry
 *  too (`ceil(viewport / stride) + 1`), so `visible - 1` is the number of strides the viewport
 *  spans. Returns 0 when the view has no usable window yet — a caller then makes no request
 *  rather than dividing by zero into a bogus one. */
function entryStride(viewport: number, visible: number): number {
  if (!viewport || !visible || visible <= 1) return 0;
  return viewport / (visible - 1);
}
