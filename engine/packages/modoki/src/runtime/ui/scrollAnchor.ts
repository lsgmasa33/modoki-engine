/** scrollAnchor — hold a scroll box's CONTENT still when its content SIZE changes.
 *
 *  ## The defect this exists for (#531)
 *
 *  A scrolling column whose child count changes moves every row under the player's finger, and
 *  on a purchase surface that is a real-money bug: Court's store hid its "Done" button while a
 *  purchase was in flight (`storeUi.ts`'s `showClose`), the box's content shrank by the button
 *  plus the gap, the browser CLAMPED `scrollTop` to the new maximum — and when the purchase was
 *  cancelled and the button came back, nothing put the offset back. Measured on the authored
 *  shelf at 375x667: `scrollTop` 303 -> 251, every row 52 px lower, permanently. The next tap at
 *  the same screen point started a purchase for the row ABOVE the one the player was looking at.
 *
 *  ⚠️ **This is WebKit-only, which is why it survived review and every test.** Chromium and
 *  Firefox implement scroll anchoring (`overflow-anchor`) and silently put the offset back;
 *  WebKit has never shipped it, so the shipped iOS WKWebView is the one engine that cannot
 *  self-correct — and the Electron editor is the one that always does. A repro on the owner's
 *  phone and a clean bill of health in the editor were both true at the same time.
 *
 *  ## What it does
 *
 *  The same thing Chromium's anchoring does, owned by us so it happens on every engine: remember
 *  WHICH child is at the box's leading edge and how far past it we are scrolled, then restore
 *  that relationship whenever the content geometry changes. Anchoring to a child rather than to
 *  the raw offset is what makes it right in both directions — content removed BELOW the viewport
 *  must leave the view where it is (restoring a number happens to do that too), while content
 *  removed ABOVE it must pull the view up with it (restoring a number would move the rows).
 *
 *  ## Where it does NOT apply, and why that is not a gap
 *
 *  ⚠️ **A box we cannot anchor keeps the BROWSER's anchoring.** We only set `overflow-anchor:
 *  none` on a box with two or more flow children, because that is exactly the condition under
 *  which this file can do anything at all. The case that forces the rule is `UIEntries`: a
 *  virtualized view spawns every pooled row under a single `__uiEntriesContent` wrapper
 *  (`entriesSystem.ts`), so `flowChildren` sees ONE child whose `offsetTop` is always 0, and
 *  anchoring to it silently degrades into "restore the raw number" — the very failure this file
 *  exists to prevent. Disabling the browser's mechanism there would have taken a working
 *  Chromium behaviour away and replaced it with an inert one: a REGRESSION on Court's
 *  `LevelScroll` and `DailyScroll`, shipped, in the name of a fix. So the property is owned
 *  here, at runtime, and re-decided whenever the child list changes — never stamped
 *  unconditionally in `UINode`.
 *
 *  ## Why the arithmetic is out here and not in the effect
 *
 *  jsdom reports every box as 0x0 and implements no ResizeObserver, so a test that mounted the
 *  component would assert the mock. The DECISIONS are therefore pure functions over plain
 *  numbers, unit-tested directly; the hook below is the thin, untestable DOM wiring that feeds
 *  them, and it is verified live against the real editor instead.
 */
import React from 'react';

/** One child's extent along the scrolled axis, in the scroll box's own content coordinates. */
export interface AnchorBox {
  /** `offsetTop` / `offsetLeft` — distance from the content's leading edge. */
  start: number;
  /** `offsetHeight` / `offsetWidth`. */
  size: number;
}

/** What we remember between one layout and the next. */
export interface ScrollAnchor {
  /** Index of the anchored child among the box's direct children. */
  index: number;
  /** How far the anchor's leading edge sits BEYOND the viewport's — `start - scrollOffset`.
   *  Negative while the anchor is scrolled partly out of view, which is the normal case. */
  gap: number;
}

/**
 * Which child owns the viewport's leading edge, and by how much we are past it.
 *
 * The anchor is the first child still on screen — the first whose trailing edge is past the
 * scroll offset. Anchoring to the first *fully* visible child instead would jump the view
 * whenever the row straddling the edge was the one that changed, which is the common case for a
 * list that grows a row.
 *
 * Returns `null` when there is nothing to anchor to (no children, or every child is above the
 * offset — a box scrolled past all its content, which only happens mid-collapse). The caller
 * then falls back to remembering the raw offset, which is strictly better than nothing.
 */
export function pickAnchor(children: readonly AnchorBox[], scrollOffset: number): ScrollAnchor | null {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.start + child.size > scrollOffset) return { index: i, gap: child.start - scrollOffset };
  }
  return null;
}

/** A child we could anchor to, paired with where it sat when we last looked. */
export interface AnchorCandidate<T> {
  child: T;
  start: number;
}

/**
 * Which remembered child to restore against, given which ones survived.
 *
 * ⚠️ **The anchored child is often the one that vanished**, which is why a single anchor is not
 * enough: Court's shelf drops up to three rows the instant a purchase is granted, and if the row
 * at the edge is among them, an implementation holding only that row falls back to the raw
 * offset — restoring the NUMBER instead of the content, i.e. the very thing #531 is. We keep
 * every flow child from the anchor DOWNWARD and hold the first that survived.
 *
 * Returns `null` only when the whole tail is gone, and then the raw offset is the honest answer.
 */
export function pickRestoreTarget<T>(
  candidates: readonly AnchorCandidate<T>[],
  isAlive: (child: T) => boolean,
): AnchorCandidate<T> | null {
  for (const candidate of candidates) if (isAlive(candidate.child)) return candidate;
  return null;
}

/**
 * Where the box must be scrolled to put the target back where it was.
 *
 * Clamped to the box's live range, because the restore can legitimately outrun the content: the
 * shrink that clamped us in the first place has not necessarily been undone yet, and asking for
 * an offset past the end would be silently clamped by the browser anyway — doing it here means
 * the caller can compare its own request against what it will get.
 */
export function restoredOffset(anchorStart: number, gap: number, maxOffset: number): number {
  return Math.max(0, Math.min(maxOffset, anchorStart - gap));
}

/** Sub-pixel moves are noise from fractional layout, not a scroll anybody asked for. */
const EPSILON = 0.5;

/** Is this offset far enough from where we are to be worth writing? */
export function shouldApply(current: number, wanted: number): boolean {
  return Math.abs(current - wanted) >= EPSILON;
}

/**
 * Is this `scroll` event the player moving the box, or a consequence of the content changing
 * under it?
 *
 * ⚠️ **This predicate is the whole implementation.** Re-anchoring on the wrong event throws
 * away the offset we exist to hold, and the box ends up exactly where #531 left it — the
 * original bug wearing our code as a hat. Two different impostors have to be turned away:
 *
 * ① **The browser's CLAMP.** When the content shrinks below the current offset the browser
 *   pins the offset to the new maximum and fires `scroll`. Timing cannot tell us this happened:
 *   the clamp's event was measured arriving BOTH before and after the `ResizeObserver` callback
 *   for the same mutation, so neither ordering may be assumed. (The first cut of this file
 *   assumed one and restored nothing.) We ask about GEOMETRY instead: an event that arrives
 *   while the content is a different size from the one we anchored against is a consequence of
 *   that resize, and the pending restore is the thing entitled to act on it.
 *
 * ② **The echo of our own write.** A `scroll` event is delivered a frame after the offset
 *   moves, long after any "I am applying" flag would have been cleared, so we compare VALUES:
 *   whatever the browser settled on after our write — clamped or not — is what `applied` holds,
 *   and an event reporting that exact offset is ours coming back to us.
 *
 * ⚠️ A `false` here must never be permanent — see `scheduleResync` in the hook. A content change
 * no observer can see (a GRANDCHILD overflowing its row changes `scrollHeight` without resizing
 * any direct child) would otherwise leave `contentSize` disagreeing forever, and this predicate
 * would reject every scroll the player ever made again.
 */
export function isIntentfulScroll(
  offset: number,
  applied: number | null,
  contentSize: number,
  anchoredContentSize: number,
): boolean {
  if (applied !== null && Math.abs(offset - applied) < EPSILON) return false;
  return contentSize === anchoredContentSize;
}

/** Which axis a box scrolls on, and how to read that axis off the DOM. */
interface Axis {
  offset: (el: HTMLElement) => number;
  setOffset: (el: HTMLElement, v: number) => void;
  max: (el: HTMLElement) => number;
  /** The SCROLLABLE extent, which is what tells a resize apart from a scroll. */
  content: (el: HTMLElement) => number;
  box: (el: HTMLElement) => AnchorBox;
}

const VERTICAL: Axis = {
  offset: (el) => el.scrollTop,
  setOffset: (el, v) => { el.scrollTop = v; },
  max: (el) => Math.max(0, el.scrollHeight - el.clientHeight),
  content: (el) => el.scrollHeight,
  box: (el) => ({ start: el.offsetTop, size: el.offsetHeight }),
};

const HORIZONTAL: Axis = {
  offset: (el) => el.scrollLeft,
  setOffset: (el, v) => { el.scrollLeft = v; },
  max: (el) => Math.max(0, el.scrollWidth - el.clientWidth),
  content: (el) => el.scrollWidth,
  box: (el) => ({ start: el.offsetLeft, size: el.offsetWidth }),
};

/**
 * The children an anchor may be chosen from: the ones actually laid out in the flow.
 *
 * ⚠️ **An out-of-flow child is a trap that LOOKS like it works.** A panel with a nine-slice
 * background renders that background as an absolutely-positioned first child spanning the whole
 * content — `start: 0`, `size:` the full scroll height — so it matches at every offset and wins
 * the anchor every time. Anchoring to it is not an error anybody would see: `start` never moves,
 * so the restore degrades silently into "put the raw number back", which is right for content
 * removed BELOW the viewport and wrong for content removed above it. This was measured, not
 * imagined: the first cut anchored on Court's panel background at index 0 in every case.
 *
 * ⚠️ Called only when the child list CHANGES, never per scroll event — `getComputedStyle` forces
 * a style flush, and `useScrollView` states the constraint this must not break (#251): a scroll
 * frame that does not move the entry window costs a field write and nothing more.
 */
function flowChildren(el: HTMLElement): HTMLElement[] {
  return (Array.from(el.children) as HTMLElement[]).filter((c) => {
    const pos = getComputedStyle(c).position;
    return pos !== 'absolute' && pos !== 'fixed';
  });
}

/**
 * Keep `el`'s content still across content-size changes, on whichever axes it scrolls.
 *
 * `enabled` is `UIElement.overflow === 'scroll'` — the same one field that decides whether the
 * element scrolls at all, so this cannot act on a box the author never made scrollable.
 *
 * ⚠️ **Takes the ELEMENT, not a ref.** A ref object has stable identity, so an effect keyed on
 * one never re-runs when the element behind it appears: `UINode` calls this before its own
 * `isVisible` early return, and `uiTreeStore` keeps a per-element hide IN the tree — the
 * component stays mounted and renders null. A box authored hidden and later shown would have run
 * this effect once against `null` and stayed unanchored for the rest of the session, with
 * nothing to see. Passing the element makes React re-run the effect the moment it exists.
 *
 * ⚠️ **Observing the container alone is not enough, and that is the trap here.** A column with a
 * `maxHeight` it has already reached does not change its own border box when a child is removed
 * — Court's panel stayed 585 px tall while its content went 888 -> 836 — so a `ResizeObserver`
 * on the box would never fire for the one case this exists for. We watch the CHILDREN (a child
 * appearing, vanishing, or changing height) as well as the box, and re-sync that set whenever
 * the child list changes.
 *
 * ⚠️ **Anchors are held as ELEMENTS, never as indices.** An index is a reference that silently
 * retargets: rows removed above the viewport — Court's shelf drops up to three the moment a
 * purchase is granted — shift every later child down one slot, so index `k` would come back
 * describing a DIFFERENT row and the restore would confidently move the view to the wrong place.
 * That is the same class of defect as the bug being fixed, so it may not be reintroduced for the
 * sake of a tidier data structure.
 */
export function useScrollAnchoring(enabled: boolean, el: HTMLDivElement | null): void {
  React.useEffect(() => {
    if (!el || !enabled) return;
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    const axes: Axis[] = [VERTICAL, HORIZONTAL];
    // Per axis: the anchor and every flow child after it (each with the position it held when we
    // looked), the raw offset to fall back on when the whole tail is gone, the geometry that
    // anchor was stated against, and the last offset we wrote (so its echo is not mistaken for
    // the player).
    const held = axes.map(() => ({
      candidates: [] as AnchorCandidate<HTMLElement>[],
      rawOffset: 0,
      contentSize: -1,
      applied: null as number | null,
    }));

    // The flow-children list, recomputed only when the child list changes. Cached because
    // `flowChildren` forces a style flush per child and `remember` runs on every scroll event.
    let flow: HTMLElement[] = [];
    let alive = new Set<HTMLElement>();
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;

    // ⚠️ **A real touch/drag in progress must never be fought.** `restore()` writes `scrollTop`
    // directly (#531's whole point), and the observers that trigger it fire from CONTENT changes —
    // a row mounting/unmounting (`syncStoreChrome` toggles `UIElement.isVisible` on Court's store
    // rows every frame the modal is open, in response to an async price fetch answering or a
    // purchase changing ownership) has no relationship to whether the player's finger is on the
    // glass *right now*. A restore landing mid-gesture competes with the browser's own live touch
    // tracking for the same `scrollTop`, which is what "I dragged down and it snapped back on
    // release" actually is (#579) — not a resize bug, a TIMING collision between this file's own
    // fix for #531 and an unrelated live gesture. Deferring the write until the gesture ends keeps
    // #531's guarantee (content-shift correction still happens) without ever contending with a scroll
    // the user is actively performing.
    //
    // ⚠️ **`touchstart`/`touchend`, NOT `pointerdown`/`pointerup`, for the TOUCH case — this is not
    // a style choice.** Once this box lets the browser scroll it natively (which it must — this is
    // a real `overflow:'scroll'` box, unlike the game canvas, which sets `touch-action:'none'` and
    // is why `pointerSource.ts`'s OWN doc can call `pointercancel` "rarely hit" THERE), the browser
    // reclaims the touch as a pan almost immediately and fires `pointercancel` — ending the POINTER
    // gesture within the first few px, while the player's finger is still very much down and the
    // drag/momentum that actually races `restore()` is still to come. Tracking via Pointer Events
    // here would disarm itself about one frame into every real touch scroll (found in review, #579
    // close-out — a jsdom probe driving `pointerdown` then `pointercancel` mid-drag reproduced the
    // exact "snaps back" symptom with the gesture guard nominally still on). Touch Events have no
    // such reclaim-cancellation: `touchmove`/`touchend` keep firing for the physical touch
    // regardless of who is driving the scroll, as long as the listener is passive (it is) — so
    // `touchend` genuinely means "the finger lifted", the moment the bug report describes ("as soon
    // as I let it go"). Pointer Events are kept as the SECONDARY path, for mouse/pen — input kinds
    // that are never reclaimed this way, and the only kind `modoki_drag`'s synthetic gestures (used
    // to verify this file live, in the Electron editor, from an agent session) can produce — with
    // `pointerType === 'touch'` explicitly excluded so it can never re-arm the very race this guards
    // against on a REAL touch device that also happens to dispatch a stray pointer event.
    let gestureActive = false;
    let pendingRestore = false;
    let gestureSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    // A missing end event (app backgrounded mid-touch, or any other event this file did not
    // anticipate) must not wedge `gestureActive` true FOREVER — that would silently bring #531 back
    // for the rest of the session, the exact "a false answer here must never be permanent" shape
    // `scheduleResync` already guards against a few lines down. No real scroll gesture runs
    // anywhere near this long; it exists only as a backstop.
    const GESTURE_SAFETY_MS = 5000;
    const onGestureStart = () => {
      gestureActive = true;
      if (gestureSafetyTimer !== null) clearTimeout(gestureSafetyTimer);
      gestureSafetyTimer = setTimeout(onGestureEnd, GESTURE_SAFETY_MS);
    };
    const onGestureEnd = () => {
      if (gestureSafetyTimer !== null) { clearTimeout(gestureSafetyTimer); gestureSafetyTimer = null; }
      if (!gestureActive) return;
      gestureActive = false;
      if (pendingRestore) { pendingRestore = false; restore(); }
    };
    const onPointerGestureStart = (e: PointerEvent) => { if (e.pointerType !== 'touch') onGestureStart(); };
    const onPointerGestureEnd = (e: PointerEvent) => { if (e.pointerType !== 'touch') onGestureEnd(); };
    // `touchstart`/`pointerdown` on the element itself (only a press that starts HERE begins a
    // gesture on this box); the end events on `window` — the release can land off-element once a
    // real drag is under way, and pointer capture is not assumed.
    el.addEventListener('touchstart', onGestureStart, { passive: true });
    window.addEventListener('touchend', onGestureEnd, { passive: true });
    window.addEventListener('touchcancel', onGestureEnd, { passive: true });
    el.addEventListener('pointerdown', onPointerGestureStart, { passive: true });
    window.addEventListener('pointerup', onPointerGestureEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerGestureEnd, { passive: true });

    // ⚠️ Reads each child's box ONCE. The obvious spelling measures the whole list for
    // `pickAnchor` and then measures the tail again to record it — 2N layout reads per axis on
    // every scroll event, against `useScrollView`'s stated #251 constraint that a scroll frame
    // costs a field write and nothing more.
    const snapshot = (axis: Axis, offset: number): AnchorCandidate<HTMLElement>[] => {
      const boxes = flow.map((c) => axis.box(c));
      const picked = pickAnchor(boxes, offset);
      if (!picked) return [];
      const out: AnchorCandidate<HTMLElement>[] = [];
      for (let i = picked.index; i < flow.length; i += 1) out.push({ child: flow[i], start: boxes[i].start });
      return out;
    };

    const syncFlow = () => {
      flow = flowChildren(el);
      alive = new Set(flow);
      // ⚠️ We own `overflow-anchor` ONLY where we can actually anchor — see this file's header.
      // A single flow child means there is nothing whose position can differ from the raw
      // offset, so our restore would degrade to putting the number back while the browser's
      // working mechanism is off: a regression, not a fix.
      //
      // ⚠️ This count is a SAFETY NET, not the `UIEntries` test. A virtualized view can have two
      // flow children the moment somebody authors a header beside the pooled-row wrapper, and it
      // would pass this check while still being unanchorable. That case is excluded upstream, by
      // TRAIT — `UINode` gates the whole hook on `!node.isEntriesView`. Do not re-derive it here
      // from the child count.
      el.style.overflowAnchor = flow.length >= 2 ? 'none' : '';
    };

    /**
     * Recover from a content change that no observer could see.
     *
     * ⚠️ **Without this, one invisible resize disables anchoring for the rest of the session.**
     * `ResizeObserver` watches this box and its DIRECT children; `MutationObserver` watches this
     * box's direct child list. A GRANDCHILD that overflows its row — a badge, a tooltip,
     * ordinary nested flex authoring — changes `scrollHeight` without resizing any of them, so
     * `restore` never runs and `contentSize` stays disagreeing forever. `isIntentfulScroll`
     * would then reject every scroll the player made from that moment on, freezing the anchor at
     * a stale position that the next real resize would snap back to.
     *
     * A TASK, not a rAF: animation-frame callbacks run BEFORE resize observations are delivered,
     * so a rAF would re-baseline ahead of the restore it is meant to defer to. A timeout runs
     * after rendering, by which point a real observer-driven restore has already re-baselined
     * and this finds nothing to do.
     *
     * ⚠️ **Must decline to run while a restore is DEFERRED behind a live gesture (`pendingRestore`),
     * or it destroys the very state the deferred restore needs (#579 close-out).** The deferred
     * `restore()` reads `state.candidates`/`rawOffset` as they stood at the moment of the content
     * change — the pre-mutation anchor — to compute where to put the box back. Every native
     * `scroll` event the browser fires WHILE that restore is pending disagrees with the still-stale
     * `state.contentSize` (nothing has updated it, on purpose), so `remember()`'s `isIntentfulScroll`
     * check fails and calls straight back in here — and this function used to happily rebaseline
     * onto the CURRENT (already-drifted) position on every one of them, so by the time the gesture
     * ends and the deferred `restore()` finally runs, `wanted` computes to wherever the box already
     * sits and `shouldApply` is false: a correction that was deferred, not merely delayed, silently
     * became a correction that never happens — reproduced by a jsdom probe (10 rows removed to 9
     * mid-gesture with one intervening `scroll` event: `scrollTop` settled at 305, not the correct
     * 240, i.e. #531's own symptom, WITH the gesture guard nominally engaged). Declining here simply
     * leaves the stale baseline in place until the pending `restore()` runs and sets it properly.
     */
    const scheduleResync = () => {
      if (resyncTimer !== null || pendingRestore) return;
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (pendingRestore) return;   // armed while this was queued — the pending restore owns it now
        axes.forEach((axis, i) => {
          const state = held[i];
          if (axis.max(el) <= 0) return;
          if (axis.content(el) === state.contentSize) return;   // a restore already healed it
          state.rawOffset = axis.offset(el);
          state.contentSize = axis.content(el);
          state.candidates = snapshot(axis, state.rawOffset);
        });
      }, 0);
    };

    // ⚠️ **The child-geometry read itself must not run inside the `scroll` callback.** `snapshot`
    // reads `offsetTop`/`offsetHeight` on every flow child (Court's shelf: up to 6), and doing that
    // synchronously from a native `scroll` listener is a documented WebKit/WKWebView stall: a
    // forced-layout read from inside the browser's own scroll-event dispatch can make the
    // compositor stop delivering further scroll updates for the gesture, independent of any
    // `requestAnimationFrame`/main-thread stall — both were checked live on an iPhone 8 and came
    // back clean DURING the freeze (an empty rAF frame-gap log, zero `scrollTop` writes), so the
    // stall was upstream of anything this file's own timing could see. Measured live: a touch-drag
    // moved for ~100-150ms then stopped responding to further `touchmove` until the finger lifted.
    // Deferring the read to `requestAnimationFrame` — after the browser's own layout pass for the
    // frame, not inside its scroll dispatch — is the standard fix for this class of stall.
    //
    // Coalescing to one flush per axis per frame is a free side effect, not the point: `remember`
    // still runs, and still classifies every `scroll` event synchronously (an offset/content-size
    // read on `el` itself, not its children — the same cost `useScrollView`'s own `push` already
    // pays every scroll event without issue). Only the PER-CHILD read moves. The flush always reads
    // `state.rawOffset` as it stands at flush time, not a value captured when the frame was
    // requested, so a flush landing after several more `scroll` events computes candidates for the
    // CURRENT position — but "computes for" is not "is available to `restore()` by".
    //
    // ⚠️ **`restore()` MUST flush a pending snapshot before reading `state.candidates` — found in
    // review, reproduced with a probe.** `restore()` is driven by the `MutationObserver` below,
    // which delivers as a MICROTASK, strictly before the next `requestAnimationFrame` — so a
    // content change landing between a `scroll` event and this file's own deferred flush reaches
    // `restore()` while `state.candidates` still describes the PREVIOUS scroll position, not the
    // one `state.rawOffset` was just updated to. That is #531's own jump wearing this fix's hat:
    // removing a row entirely below the viewport moved the box by a full row height in the probe,
    // for no reason but flush timing. `restore()` (below) flushes synchronously first — the read
    // stays out of the `scroll` dispatch (the actual fix), and `restore()` never sees a candidate
    // list older than the `rawOffset` it is being asked to restore against.
    let snapshotFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    const snapshotDue = axes.map(() => false);
    const flushSnapshots = () => {
      if (snapshotFrame !== null) { cancelAnimationFrame(snapshotFrame); snapshotFrame = null; }
      axes.forEach((axis, i) => {
        if (!snapshotDue[i]) return;
        snapshotDue[i] = false;
        held[i].candidates = snapshot(axis, held[i].rawOffset);
      });
    };

    const remember = () => {
      let needsFrame = false;
      axes.forEach((axis, i) => {
        const state = held[i];
        if (axis.max(el) <= 0) return;        // this axis does not scroll; nothing to hold
        const offset = axis.offset(el);
        const content = axis.content(el);
        if (!isIntentfulScroll(offset, state.applied, content, state.contentSize)) {
          state.applied = null;
          scheduleResync();                   // a clamp or our echo — but never permanently
          return;
        }
        state.applied = null;
        state.rawOffset = offset;
        state.contentSize = content;
        snapshotDue[i] = true;
        needsFrame = true;
      });
      if (needsFrame && snapshotFrame === null) snapshotFrame = requestAnimationFrame(flushSnapshots);
    };

    const restore = () => {
      // A pending deferred snapshot describes `state.rawOffset` as of the LAST scroll event, but
      // `state.candidates` only catches up once the flush runs — and `restore` can be reached (via
      // the MutationObserver below, a microtask) before that rAF fires. Flush first, always: see
      // `flushSnapshots`'s own comment for the reproduced defect this guards.
      flushSnapshots();
      axes.forEach((axis, i) => {
        const state = held[i];
        const max = axis.max(el);
        if (max <= 0) { state.contentSize = axis.content(el); return; }
        const kept = pickRestoreTarget(state.candidates, (c) => alive.has(c));
        const wanted = kept
          ? restoredOffset(axis.box(kept.child).start, kept.start - state.rawOffset, max)
          : Math.max(0, Math.min(max, state.rawOffset));
        if (shouldApply(axis.offset(el), wanted)) axis.setOffset(el, wanted);
        // ⚠️ Record `applied` even when nothing needed moving, and read it BACK off the element
        // rather than storing `wanted`. Both halves are load-bearing: the browser may have
        // clamped our write, and it is the SETTLED value whose echo arrives as a `scroll` event
        // whose ordering against this callback is not fixed. Marking it unconditionally is what
        // makes the outcome the same either way.
        state.applied = axis.offset(el);
        state.contentSize = axis.content(el);
      });
    };

    // The gesture guard above wraps both observers here, not inside `restore()` itself — `restore()`
    // also runs synchronously from `syncFlow`'s callers below (the initial seed) where no gesture can
    // possibly be live, and gating it there would need the same check anyway for no benefit.
    const restoreUnlessGesturing = () => {
      if (gestureActive) { pendingRestore = true; return; }
      restore();
    };
    const ro = new ResizeObserver(restoreUnlessGesturing);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    const mo = new MutationObserver(() => { syncFlow(); observeAll(); restoreUnlessGesturing(); });

    // Seed the geometry BEFORE the first remember, or the very first scroll event would look
    // like a resize (contentSize starting at a value nothing measured) and be ignored.
    syncFlow();
    held.forEach((state, i) => { state.contentSize = axes[i].content(el); });
    remember();
    observeAll();
    mo.observe(el, { childList: true });
    el.addEventListener('scroll', remember, { passive: true });
    return () => {
      el.removeEventListener('scroll', remember);
      el.removeEventListener('touchstart', onGestureStart);
      window.removeEventListener('touchend', onGestureEnd);
      window.removeEventListener('touchcancel', onGestureEnd);
      el.removeEventListener('pointerdown', onPointerGestureStart);
      window.removeEventListener('pointerup', onPointerGestureEnd);
      window.removeEventListener('pointercancel', onPointerGestureEnd);
      ro.disconnect();
      mo.disconnect();
      if (resyncTimer !== null) clearTimeout(resyncTimer);
      if (gestureSafetyTimer !== null) clearTimeout(gestureSafetyTimer);
      if (snapshotFrame !== null) cancelAnimationFrame(snapshotFrame);
      el.style.overflowAnchor = '';
    };
  }, [el, enabled]);
}
