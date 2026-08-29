/** scrollViewDom — the DOM half of `UIScrollView`: CSS mapping, the no-dirty scroll
 *  read-back, and one-shot `scrollTo*` requests.
 *
 *  Lives in a `.ts` beside `UINode.tsx` rather than inside it, per the repo's rule that a
 *  panel/component holds JSX while its DECISIONS live in a plain module that a unit test can
 *  import.
 */
import { getCurrentWorld, findEntityByGuid } from '../core/ecs/world';
import { markUIDirty } from '../core/uiDirty';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { NO_SCROLL_REQUEST, NO_BEHAVIOR_REQUEST } from '../traits/UIScrollView';

export interface ScrollViewNodeData {
  axis: string; snap: string; snapStop: string; overscroll: string; scrollbar: string;
  scrollToX: number; scrollToY: number; scrollToBehavior: string; scrollBehavior: string;
}

/** CSS for the scroll BOX itself. `UIElement.overflow` is a separate authored field and is
 *  applied by UINode; this only adds what the scroll view owns, so an element that is a scroll
 *  view but was never given `overflow:'scroll'` still does not scroll — which is deliberate:
 *  two fields, one visible consequence, and the one the author already knows wins. */
export function scrollViewStyle(s: ScrollViewNodeData): Record<string, string> {
  const css: Record<string, string> = {};
  css.overscrollBehavior = s.overscroll === 'auto' ? 'auto' : s.overscroll;
  // `scrollbar-width: none` is the standards property (Chromium 121+, Safari 18.2+); older
  // WebKit uses overlay scrollbars, which steal no space, so there is nothing to hide there.
  // Do NOT attempt `::-webkit-scrollbar` — these are inline styles and cannot carry a
  // pseudo-element.
  if (s.scrollbar === 'hidden') css.scrollbarWidth = 'none';
  if (s.snap !== 'none') {
    css.scrollSnapType = (s.axis === 'both' ? 'both' : s.axis === 'x' ? 'x' : 'y') + ' mandatory';
  }
  // ⚠️ **The CROSS axis is pinned, or `axis` is decoration.** `UIElement.overflow: 'scroll'` is a
  // both-axes CSS property, so a single-axis view scrolled the other way too — and on any platform
  // with CLASSIC scrollbars (desktop web, the Electron editor) that shows a second scrollbar which
  // then STEALS cross-axis space from the content box. Measured in Court's level selector
  // (2026-08-21): a 31.6vh page inside a 31.6vh box came back 203px against the grid's 218px,
  // because a 15.34px vertical scrollbar had appeared on an `axis: 'x'` view — so the 5-across grid
  // hung 15px outside its own page. The engine's window arithmetic only tracks the scrolling axis
  // as well, so an off-axis scroll moves content it cannot account for.
  //
  // This does NOT contradict "the author's `overflow` wins" above: that rule is about whether the
  // box scrolls AT ALL, which is still the author's call. `axis` is this trait's own field, and
  // saying which axis is the only thing it can mean.
  if (s.axis === 'x') css.overflowY = 'hidden';
  else if (s.axis === 'y') css.overflowX = 'hidden';
  return css;
}

/** CSS for one snap TARGET (an entry). Separate from the box's style because the two live on
 *  different elements, and because `scroll-snap-stop` is a property of the target, not the box. */
export function scrollSnapChildStyle(s: ScrollViewNodeData): Record<string, string> {
  if (s.snap === 'none') return {};
  return { scrollSnapAlign: s.snap, scrollSnapStop: s.snapStop };
}

/** Raw trait write — NO `markUIDirty`.
 *
 *  ⚠️ This is the whole point of the design and is the opposite of every other UI write in the
 *  engine. `entity.set` bypasses the `addDirtyListener(markUIDirty)` hook that `writeTraitField`
 *  goes through (the same bypass hot per-frame game code already relies on), so a scroll event
 *  costs a field write and nothing else. Route this through a dirtying helper and the feature
 *  rebuilds the entire UI tree at fling frequency — the stutter mechanism #251 predicted.
 */
export function writeScrollState(guid: string, state: Partial<{
  scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number; contentWidth: number; contentHeight: number;
}>): boolean {
  const meta = getTraitByName('UIScrollView');
  if (!meta || !guid) return false;
  const world = getCurrentWorld();
  if (!world) return false;
  const entity = findEntityByGuid(guid, world);
  if (!entity || !entity.has(meta.trait)) return false;
  const cur = entity.get(meta.trait) as Record<string, unknown>;
  // Diff before writing: a scroll event that lands on the same rounded pixel is common at the
  // ends of a fling, and a no-op write still costs an archetype touch.
  let changed = false;
  for (const k in state) if (cur[k] !== (state as Record<string, unknown>)[k]) { changed = true; break; }
  if (!changed) return false;
  entity.set(meta.trait, { ...cur, ...state });
  return true;
}

/**
 * Clear a consumed `scrollTo*` request back to the sentinel. Same no-dirty write.
 *
 * ⚠️ **Clears BOTH axes, and it must — it used to take the VIEW's axis and clear only that one.**
 * `pendingScrollTo` builds ONE `Element.scrollTo` call carrying whatever is set on either axis, so
 * both are consumed together and clearing one is not "clearing what was applied". The failure that
 * exposed it (Court's level selector, 2026-08-21): the game asked for `{x: page, y: 0}` on an
 * `axis: 'x'` view — `y: 0` is a REAL request for row 0, which converted to `scrollToY: 0` and
 * could then never be cleared, because the view's axis is `'x'`. `pendingScrollTo` therefore
 * returned a request on EVERY subsequent rebuild, and each one fired `scrollTo({top: 0})` with no
 * `left`: per spec that keeps the CURRENT left, so it cancelled the in-flight smooth scroll ~20 ms
 * in and re-targeted it to where it had got to — about 0. The arrows moved nothing, the trait read
 * a clean `scrollToX: -1`, and every unit test stayed green.
 *
 * `scrollToEntry`'s own banner already says to omit the axis a view does not scroll. That rule is
 * right and Court now follows it — but a rule whose violation is UNRECOVERABLE and silent is a
 * trap, so the clear no longer depends on the caller having got it right.
 */
export function clearScrollRequest(guid: string, appliedBehavior?: string): void {
  const meta = getTraitByName('UIScrollView');
  if (!meta || !guid) return;
  const world = getCurrentWorld();
  if (!world) return;
  const entity = findEntityByGuid(guid, world);
  if (!entity || !entity.has(meta.trait)) return;
  const cur = entity.get(meta.trait) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (cur.scrollToX !== NO_SCROLL_REQUEST) patch.scrollToX = NO_SCROLL_REQUEST;
  if (cur.scrollToY !== NO_SCROLL_REQUEST) patch.scrollToY = NO_SCROLL_REQUEST;
  // The per-request behaviour is part of the request, so it is consumed with it — otherwise a
  // single 'smooth' request would keep steering every later one that named no behaviour, which is
  // the AUTHORED default's job (#409).
  //
  // ⚠️ Cleared only when the LIVE value is still the one that was applied, which the caller passes
  // in. The decision to clear is made from the projection SNAPSHOT, but this reads the trait live,
  // and the two can disagree: a new `scrollToEntry` writes `scrollToBehavior` IMMEDIATELY, while
  // its `scrollToX/Y` arrive a frame later via `entriesSystem`. So a request arming 'smooth'
  // between the tree rebuild and React flushing the previous request's effect would have had its
  // behaviour wiped by that effect and silently fallen back to the authored default. The `-1`
  // sentinels above need no such guard — a new request never writes them.
  const behaviorMatches = appliedBehavior === undefined || cur.scrollToBehavior === appliedBehavior;
  if (behaviorMatches && cur.scrollToBehavior !== NO_BEHAVIOR_REQUEST) patch.scrollToBehavior = NO_BEHAVIOR_REQUEST;
  if (Object.keys(patch).length === 0) return;
  entity.set(meta.trait, { ...cur, ...patch });
  // ⚠️ This one DOES dirty, unlike its siblings in this file, and the asymmetry is the point.
  //
  // `UINode`'s one-shot effect is keyed on the request VALUES, so a second request for the SAME
  // offset only re-fires if the tree observed the `-1` in between. A raw clear never reaches the
  // tree, and the stale value then compares equal — the request is swallowed, silently.
  //
  // The declarative `ui.scrollTo` path hides this: `bindings.ts` dirties after applying a
  // binding, so the tree happens to see the cleared value before the system converts the next
  // request. A game calling `scrollToEntry()` directly has no such binding and gets no such
  // rescue — so "re-request the same offset" would work from a button and not from code, which
  // is exactly the kind of difference nobody would think to test.
  //
  // Cost is one tree rebuild per CONSUMED request, and a request is user- or game-initiated,
  // never per-frame. The scroll READ-BACK above must stay dirty-free; this is not that.
  markUIDirty();
}

/** Structural shape of the DOM properties `readScrollMeasurement` reads — not `HTMLElement`, so a
 *  plain object can stand in for the element in a test with no DOM. */
export interface ScrollMeasurementSource {
  clientWidth: number; clientHeight: number;
  scrollLeft: number; scrollTop: number;
  scrollWidth: number; scrollHeight: number;
}

/** ⚠️ **Refuse to RECORD a measurement from an element that generates no box (#413).** The trait
 *  holds ONE measurement, keyed by guid, but the editor mounts `UIRenderer` TWICE — once in
 *  GameView, once in SceneView's UI-mode preview — so one entity has two DOM elements and two
 *  ResizeObservers writing the same slot. `UIRenderer` already knows this: `consumePendingActivation`
 *  is idempotent "so two mounted UIRenderers activate once" — the scroll measurement never got that
 *  treatment.
 *
 *  The element sitting inside a hidden editor dock tab measures 0×0 and overwrote the visible one's
 *  real 434. With `entryWidth` authored in `%`, a zero viewport makes every entry zero-wide, the
 *  window empty and the pool zero-slot — so the view renders blank while the prefab is cached and
 *  the source registered, i.e. with every existing diagnostic silent.
 *
 *  A zero-extent view can display no entries either way, so declining the write costs nothing; the
 *  cost of ACCEPTING it is losing the only good measurement. Returns `null` (rather than a partial
 *  measurement) when the element generates no box, so the caller has one thing to check.
 *
 *  Two facts replace the old "known limitation" paragraph, which was both wrong and incomplete:
 *
 *  - The "both trees visible at different DEVICE sizes" case that paragraph warned about **cannot
 *    occur**: `SceneView.tsx:2323` sizes its preview frame from `gameViewSize`, which only
 *    GameView's effects write (`engine/app/editor/agentEditorOps.ts:142`). Both mounts render the
 *    same logical device size by construction — a measured 434 vs 435 is scrollbar/rounding, not a
 *    device gap.
 *  - The residual hazard is a **MIXED** measurement, not two viewports, and it is pre-existing
 *    rather than introduced here: the returned object also carries `scrollX`/`scrollY` from
 *    whichever element fired it. With both trees visible, the SceneView mount sits at
 *    `scrollLeft: 0` while the player has scrolled GameView to page N; any resize on the SceneView
 *    side (a device-preset change, a splitter drag) fires its RO, now passes this guard, and writes
 *    `scrollX: 0` beside a real viewport — so `driveEntriesFromScroll` re-plans the window at page 0
 *    while the GameView DOM is still at page N. Far enough out, that lands outside the pooled band
 *    and the view IS blank. Scoping the measurement to one owning tree is the real fix; this guard
 *    does not attempt it.
 *
 *  Caveat: jsdom reports `clientWidth: 0` for everything, so a future jsdom test of the entries DOM
 *  path records no viewport at all — assert against `readScrollMeasurement` directly rather than
 *  through a mounted node.
 */
export function readScrollMeasurement(el: ScrollMeasurementSource): {
  scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number;
  contentWidth: number; contentHeight: number;
} | null {
  if (!(el.clientWidth > 0) && !(el.clientHeight > 0)) return null;
  return {
    scrollX: Math.round(el.scrollLeft), scrollY: Math.round(el.scrollTop),
    viewportWidth: el.clientWidth, viewportHeight: el.clientHeight,
    contentWidth: el.scrollWidth, contentHeight: el.scrollHeight,
  };
}

/** What a pending request means for `Element.scrollTo`, or null when nothing is pending.
 *  Pure, so the request semantics (the -1 sentinel, per-axis independence) are unit-testable
 *  without a DOM. */
export function pendingScrollTo(s: ScrollViewNodeData): { left?: number; top?: number; behavior: ScrollBehavior } | null {
  const hasX = s.scrollToX !== NO_SCROLL_REQUEST;
  const hasY = s.scrollToY !== NO_SCROLL_REQUEST;
  if (!hasX && !hasY) return null;
  // Per-request override first, authored default second (#409). `''` is "no override" — the
  // request field is transient and `runtimeOnly`, `scrollBehavior` is the author's, and the two
  // used to be the SAME field, which is how a request destroyed an authored 'smooth'.
  const motion = s.scrollToBehavior || s.scrollBehavior;
  const out: { left?: number; top?: number; behavior: ScrollBehavior } = {
    behavior: motion === 'smooth' ? 'smooth' : 'instant',
  };
  if (hasX) out.left = s.scrollToX;
  if (hasY) out.top = s.scrollToY;
  return out;
}
