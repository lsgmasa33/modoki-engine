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
import { NO_BEHAVIOR_REQUEST, NO_SCROLL_REQUEST, type UIScrollBehavior } from '../traits/UIScrollView';

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
  // ROW has a perfectly usable Y stride, so it armed a request on an axis that does not scroll,
  // where `scrollTo({top})` with no `left` cancels an in-flight smooth scroll on the other axis.
  // (`0` is a REAL request for entry 0, not "no request" — but it is CLEARABLE: `clearScrollRequest`
  // has cleared both axes unconditionally since #768, so the harm is the cancellation, not a stuck
  // field.) Court's selector escaped it only by coincidence — `countY: 1` makes `visibleY` 1, and
  // the old stride recovery returned 0 below 2 — the kind of accident that stops being true later,
  // and did: the recovery is gone (#1010).
  const wantsX = sv.axis !== 'y';
  const wantsY = sv.axis !== 'x';
  const countX = Math.floor((en.countX as number) ?? 0);
  const countY = Math.floor((en.countY as number) ?? 0);
  const strideY = wantsY && countY > 0 ? usableStride(en.strideY, sv.viewportHeight as number) : 0;
  const strideX = wantsX && countX > 0 ? usableStride(en.strideX, sv.viewportWidth as number) : 0;
  // ⚠️ LIVE scroll, on purpose, and it must stay that way — see `currentEntryIndex`'s banner.
  // "Snap to whichever entry you are nearest" is a question about where the view IS; a pending
  // request is where it is GOING, and honouring one here would make a snap re-issue a jump the
  // viewer has already been carried most of the way through.
  //
  // ⚠️ **Clamped to `count - 1`, the same as `scrollByEntry`** — this is the sibling half of
  // #1010's close-out F3, and it was missed on the first pass because the sweep looked for the
  // LIVE read and stopped there. The live read was never the defect; the unbounded ROUNDING was.
  // `Math.round(scroll / stride)` rounds UP past the last entry whenever the viewport is shorter
  // than one entry: measured on a `countY: 1` view with a 600px entry in a 300px viewport at
  // `scrollY: 400`, this armed entry 1 and converted it to `scrollToY: 600` against a maximum
  // reachable scroll of 300 — carrying a viewer who asked to snap to the BOTTOM of a view with one
  // entry in it. Unlike stepping, a single entry is a legitimate snap target, so this CLAMPS
  // rather than refusing: `count: 1` snaps to entry 0.
  const y = strideY > 0 ? Math.min(countY - 1, Math.max(0, Math.round((sv.scrollY as number) / strideY))) : NO_ENTRY_REQUEST;
  const x = strideX > 0 ? Math.min(countX - 1, Math.max(0, Math.round((sv.scrollX as number) / strideX))) : NO_ENTRY_REQUEST;
  // ⚠️ **Both axes gated out is not a snap.** This used to fall through to `scrollToEntry(guid, {})`
  // — which writes `NO_ENTRY_REQUEST` to both fields and returns `true`, so a snap on a view it
  // could not answer for reported success AND wiped whatever was in flight. Reachable through the
  // new `count > 0` gate: `entriesSystem` publishes a stride regardless of count, so a view with
  // `countY: 0` has a usable stride and no entries.
  if (x === NO_ENTRY_REQUEST && y === NO_ENTRY_REQUEST) return false;
  return scrollToEntry(viewGuid, {
    x: x === NO_ENTRY_REQUEST ? undefined : x,
    y: y === NO_ENTRY_REQUEST ? undefined : y,
  }, opts);
}

/**
 * Move by whole ENTRIES from wherever the view currently sits.
 *
 * What a pager's wheel/keyboard handling wants, and what a caller cannot compute itself:
 * `UIEntries.firstX` is the first POOLED entry, which overscan puts an entry BEFORE the visible
 * one (legitimately -1 at the start of a list).
 *
 * ⚠️ **NOT the same arithmetic `snapToNearest` does, and the difference is the point** (#1010).
 * This counts from the most recent REQUEST (`currentEntryIndex`); `snapToNearest` counts from the
 * live position. Stepping from live scroll is what makes two quick notches move one entry — see
 * `currentEntryIndex`'s banner for the two-stage hand-off and the glide it still does not cover.
 *
 * Returns false when the view has no usable window yet, rather than requesting entry 0 — a caller
 * asking to move ONE would otherwise teleport to the top the first time it fires.
 *
 * ⚠️ **`false` is not "you are at the end".** It means "this call armed nothing", and it covers
 * three states: no usable window YET (the prefab is still uncached, or the viewport is 0), fewer
 * than two entries on the stepped axis, and a step the clamp absorbed. A caller greying an arrow
 * out on `false` would grey it during scene load, while the view is merely not ready. Nothing in
 * the engine answers "already at the end" today — that needs the content extent
 * (`docs/ui-system.md` § scroll views).
 */
export function scrollByEntry(
  viewGuid: string,
  by: { x?: number; y?: number },
  opts: { behavior?: UIScrollBehavior } = {},
): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  // Not `Record<string, number>`: `axis` is a string, and reading it through a number-typed
  // record silently compares as one — the same widening `snapToNearest` above already carries.
  const sv = v.entity.get(v.svMeta.trait) as Record<string, number | string>;
  const en = v.entity.get(v.enMeta.trait) as Record<string, number>;
  // ⚠️ **TWO gates, because the recovery this replaced was quietly doing both** (#1010, and its
  // close-out F2 — the first attempt claimed the axis gate alone replaced it, and that was wrong).
  // The old stride was RECOVERED as `viewport / (visible - 1)`, which returns 0 below `visible: 2`
  // — and `visible` is bounded by the entry COUNT, so it refused two different things at once:
  //   ① a step on an axis the view does not scroll   -> the `axis` test
  //   ② a step on an axis with fewer than two entries -> the `count` test
  // Reading the system's published stride removes both accidents (120 is a real stride on a
  // one-row view), so each has to be stated.
  //
  // ⚠️ **What ② is worth. Two earlier versions of this paragraph each described a harm that another
  // half of the same commit had already made impossible** — so state the case that still stands,
  // and note where it does NOT bite. It does NOT bite when the view sits exactly on its one entry:
  // `stepTo` clamps to `count - 1 = 0`, the absorbed-step test below returns `false`, and removing
  // this gate changes nothing. It bites when the single entry is TALLER than its viewport, because
  // then a live offset inside that entry rounds to a non-zero index: at `strideY: 600` with
  // `scrollY: 300`, `currentEntryIndex` returns `round(0.5) = 1`, `stepTo(1, 1, 1)` is `0`, and
  // `1 !== 0` reads as a MOVE. Without ② the step returns `true` and arms entry 0 — yanking a
  // viewer who is reading the bottom of that entry back to its top, latching `wheelBusy` for
  // 140 ms and driving a `markUIDirty()` rebuild for a step that cannot go anywhere.
  //
  // ⚠️ That is a narrow shape, and it is the ONLY one that distinguishes this gate, so the test
  // for it has to build exactly that view. The first one did not — it used a short entry, where
  // `fromY` is 0 and the predicate below covers the case — and passed with the gate deleted.
  //
  // Without ① the request lands on an axis that does not scroll at all, where `scrollTo({top})`
  // with no `left` cancels an in-flight smooth scroll on the OTHER axis (the failure
  // `clearScrollRequest`'s banner records; the request itself is clearable since #768, so this is
  // about the cancellation, not about a stuck field).
  const countX = Math.floor((en.countX as number) ?? 0);
  const countY = Math.floor((en.countY as number) ?? 0);
  const strideX = sv.axis !== 'y' && countX > 1 ? usableStride(en.strideX, sv.viewportWidth as number) : 0;
  const strideY = sv.axis !== 'x' && countY > 1 ? usableStride(en.strideY, sv.viewportHeight as number) : 0;
  const wantX = Number.isFinite(by.x) && (by.x as number) !== 0;
  const wantY = Number.isFinite(by.y) && (by.y as number) !== 0;
  const fromX = wantX && strideX > 0
    ? currentEntryIndex(en.scrollToEntryX, sv.scrollToX as number, sv.scrollX as number, strideX) : 0;
  const fromY = wantY && strideY > 0
    ? currentEntryIndex(en.scrollToEntryY, sv.scrollToY as number, sv.scrollY as number, strideY) : 0;
  const toX = stepTo(fromX, by.x as number, countX);
  const toY = stepTo(fromY, by.y as number, countY);
  // ⚠️ **A step the clamp absorbed is NOT a move, and must not report one** (close-out §2d, F4).
  // At the end of a list `+1` clamps back to where it started; arming that anyway asks the view to
  // scroll to the entry it is already on, which costs a `markUIDirty()` projection rebuild and —
  // through `UINode`'s wheel handler — latches `wheelBusy` for `WHEEL_GESTURE_GAP_MS`, swallowing
  // the NEXT notch too. Returning `true` there is also the exact complaint #1010's body makes
  // about this function ("a caller gets no signal that nothing moved"), so endorsing it while
  // fixing that issue would have been the wrong half of the same lesson.
  const canX = wantX && strideX > 0 && toX !== fromX;
  const canY = wantY && strideY > 0 && toY !== fromY;
  if (!canX && !canY) return false;
  return scrollToEntry(viewGuid, {
    // ⚠️ Only the axis actually being moved is requested. Passing the other as a number would
    // arm a real request on an axis the view may not scroll — `0` is a request for entry 0, not
    // "no request" — which is the trap `scrollToEntry`'s own banner records.
    //
    // ⚠️ **But "not requested" must not mean "destroyed".** `scrollToEntry` writes BOTH fields on
    // every call, mapping `undefined` to `NO_ENTRY_REQUEST` — so on an `axis: 'both'` view a step
    // that moves Y used to wipe a request already in flight on X, and the view simply never went
    // where it had been sent. `keep` passes a pending request straight back through, which is a
    // no-op write for that axis instead of a clear. (This got sharper with the absorbed-step
    // predicate above: an axis can now be un-armed because its step hit the clamp, not only
    // because the caller left it out.) Only ever passes a value that is already >= 0, so it
    // cannot invent the entry-0 request the banner above warns about.
    x: canX ? toX : keep(en.scrollToEntryX),
    y: canY ? toY : keep(en.scrollToEntryY),
  }, opts);
}

/** Pass an in-flight entry request back through unchanged, or `undefined` when there is none. */
function keep(pending: number): number | undefined {
  return pending >= 0 ? pending : undefined;
}

/** One step from `from`, clamped to the entries that actually exist.
 *
 *  ⚠️ **The UPPER clamp is not decoration, and it became load-bearing the moment stepping started
 *  counting from the request** (#1010 close-out F3). The old code re-read live scroll every time,
 *  so repeated steps at the end of a list kept computing the same index and could not run away.
 *  Counting from the request removes that accident too: five in-frame steps on a ten-entry list
 *  walked the request to entry 10 — one past the end — and `consumeEntryRequest` converted it to a
 *  px offset equal to the whole content height, twice the maximum scroll. Measured by review.
 *
 *  The lower clamp is the older half and is unchanged: `-1` at entry 0 stays at 0.
 *
 *  ⚠️ **`count - 1` is the last entry that EXISTS, which is not the same as the furthest the view
 *  can scroll**, and the difference matters for a list rather than a pager. With `count: 10`,
 *  `stride: 120` and a 600px viewport the maximum scroll is 600px — entry 5 at the leading edge,
 *  with entries 6-9 visible below it — so a step can still ask for entry 9 and get a `scrollToY`
 *  the DOM will clamp. That is harmless (the browser clamps, and `first` is separately bounded by
 *  `count - pooled`), but do not read this clamp as "a step cannot ask for somewhere the view
 *  cannot go". Bounding by the reachable maximum instead would need the content extent, which
 *  this module deliberately does not compute — that is `entriesSystem`'s. */
function stepTo(from: number, by: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, from + by));
}

/** Which entry a STEPPING api should count from: the most recent thing the view was ASKED to be
 *  on, falling back to where it actually is.
 *
 *  ⚠️ **Stepping from live scroll is #672's, #768's and #1010's shared defect**, and it is a
 *  timing bug that hides from a test that does not model the hand-off. A request travels in two
 *  stages before the view has moved a pixel, and live scroll lags BOTH of them:
 *
 *  | stage | state | cleared by |
 *  |---|---|---|
 *  | 1. entry-space | `UIEntries.scrollToEntry*` >= 0 | `consumeEntryRequest`, the next system tick |
 *  | 2. px-space | `UIScrollView.scrollTo*` != -1 | `clearScrollRequest`, once `UINode` applies it |
 *
 *  So two steps issued inside one frame both read the same live offset, compute the same "I am on
 *  entry N", and the second overwrites the first with the identical request: two notches, one
 *  entry moved, and `scrollByEntry` returns `true` for the one that did nothing.
 *
 *  Court measured the window on its level selector (2026-09-09): 0 ms deterministic, 30 ms a coin
 *  flip, 60 ms+ clear. ⚠️ **Those numbers are the editor GameView on desktop Chromium and nowhere
 *  else** — no device has been measured — and `games/court/menu.md` flags them as UNRESOLVED
 *  against the ~86-frame smooth-scroll figure two paragraphs down, since the two count different
 *  things (when `scrollLeft` crosses the halfway point, vs how long the animation runs). Quote
 *  them with that qualifier or not at all.
 *
 *  Stage 2 is read in PX and divided by the stride, which is only sound because the stride is now
 *  the system's own published `entrySize + gap` rather than a recovery from the window — dividing
 *  a px request produced by one derivation by a different one rounds wrong at exactly the entry
 *  boundary this function exists to resolve. That is why #1010 published the stride.
 *
 *  ⚠️ **What this deliberately does NOT cover: the glide.** Once `UINode` has issued the DOM
 *  `scrollTo` with `behavior: 'smooth'`, both stages are clear and `scrollX` eases toward the
 *  target over ~86 frames, so a step landing mid-glide still counts from an intermediate position.
 *  Nothing in trait state distinguishes "gliding toward entry N" from "the viewer is dragging",
 *  and inventing that state buys a new staleness bug. `UINode`'s `WHEEL_GESTURE_GAP_MS = 140`
 *  latch covers the only shipping caller — a LATCH, not a guarantee, and the next caller inherits
 *  the gap with no protection. Left open knowingly; see the issue.
 *
 *  ⚠️ **A stage-2 request that the DOM never applies steers every later step, and that is the
 *  intended reading rather than an oversight** (#1010 close-out F4). `clearScrollRequest` runs from
 *  `UINode`'s effect, so a view whose node is not rendering keeps `scrollTo*` set — and a step then
 *  counts from a request the viewer cannot see, even if they have hand-scrolled elsewhere since.
 *  Deliberate: a pending px request WILL be applied when that node next renders, so it is where the
 *  view is going, and counting from anything else would step from a position about to be discarded.
 *  The pathological case — a request that is never applied at all — is a defect in the scroll
 *  view's own lifecycle, not something a stepping API can detect from trait state. Reachability was
 *  not established by review; the arithmetic was (a stale request for entry 3 with the viewer at
 *  entry 20 steps to 4, where the old live-only read gave 21).
 *
 *  ⚠️ `snapToNearest` must NOT use this. It answers "where am I", not "where was I sent". */
function currentEntryIndex(entryReq: number, pxReq: number, live: number, stride: number): number {
  if (entryReq >= 0) return entryReq;                              // stage 1 — already in entries
  if (pxReq !== NO_SCROLL_REQUEST) return Math.round(pxReq / stride); // stage 2 — px, same stride
  return Math.round(live / stride);
}

/** One entry's stride in px, or 0 when the view has no usable window yet — a caller then makes no
 *  request rather than dividing by zero into a bogus one.
 *
 *  Reads `UIEntries.strideX/Y`, which `entriesSystem` publishes from the entry size it actually
 *  resolved (#1010). This used to RECOVER the stride as `viewport / (visible - 1)`, a second
 *  derivation of a number the system already had — see the trait field's banner for why that was
 *  wrong rather than merely redundant. The viewport is still checked: a view laid out to zero on
 *  its scrolling axis has nowhere to put a request, and a px stride resolved from a cached prefab
 *  survives a viewport collapse. */
function usableStride(stride: number | undefined, viewport: number): number {
  if (!viewport || !stride || stride <= 0) return 0;
  return stride;
}
