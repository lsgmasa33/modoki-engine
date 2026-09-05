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
 *
 *  **#665 — `viewportWidth` used to be raw `clientWidth`, and CSSOM rounds `clientWidth` to the
 *  nearest integer.** A `UIEntries` pager entry authored `entryWidth: 100%` resolves to 100% of
 *  that ROUNDED number, so a viewport whose true width is (say) 434.1px reports `clientWidth: 434`
 *  while the box actually painted is 0.1px wider — leaving a sliver of the NEXT card visible at
 *  rest. The optional `precise` parameter is how the caller supplies the true fractional width
 *  (via `readPreciseBoxSize`) so this can correct for that.
 *
 *  `viewportWidth`/`viewportHeight` are `Math.ceil(precise.width/height)` when `precise` is given,
 *  raw `clientWidth`/`clientHeight` otherwise. Ceiling — not the fractional value itself — is the
 *  fix, for three reasons that all follow from keeping every quantity an INTEGER:
 *  - `entryWidth: 100%` resolves to the same integer as `viewportWidth`, so `entryW ===
 *    viewportWidth` exactly, which is the invariant `round(scrollX / viewportWidth)` page indexing
 *    depends on (`games/wordweave/tests/sceneChrome.test.ts` guards it; wordweave's
 *    `dictionaryPagerIndex` and Court's level select both derive pages that way).
 *  - Page k then sits at `k * ceil`, an integer offset — one Chrome can actually rest on.
 *  - `ceil >= trueWidth`, so card k covers the whole visible box and no neighbour can ever peek
 *    through. The accepted cost: up to ~1px of the CURRENT card is clipped at its right/bottom
 *    edge instead of leaving a sliver of the NEXT one visible — that is the trade the owner chose.
 *    When the true width is already an integer, `ceil` is a no-op: no clipping, no sliver.
 *
 *  ⚠️ **A FRACTIONAL `viewportWidth` was tried first and reverted** — it made the symptom WORSE.
 *  Chrome parks this scroller's resting offset on integer CSS pixels regardless of what
 *  `scrollTo({left})` was asked for: `scrollTo({left: 598.1875})` came to rest at exactly `598`,
 *  and page 3's `scrollTo({left: 897.28125})` landed at `897`. A fractional stride therefore misses
 *  every offset the view can actually rest on, so instead of one constant 0.109px sliver of the
 *  NEXT card, each page showed a 0.19–0.28px sliver of the PREVIOUS one. Do not reintroduce a
 *  fractional `viewportWidth` — that measurement is why this function ceils instead.
 *
 *  This function does NOT call `readPreciseBoxSize` itself — the caller decides when to pay for a
 *  `getComputedStyle` read, because `readScrollMeasurement` runs on every `scroll` event (cheap by
 *  design — see `writeScrollState`'s no-dirty write above) while the precise box only needs
 *  refreshing on RESIZE.
 */
export function readScrollMeasurement(
  el: ScrollMeasurementSource,
  precise?: { width: number; height: number } | null,
): {
  scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number;
  contentWidth: number; contentHeight: number;
} | null {
  if (!(el.clientWidth > 0) && !(el.clientHeight > 0)) return null;
  return {
    scrollX: Math.round(el.scrollLeft), scrollY: Math.round(el.scrollTop),
    viewportWidth: precise ? Math.ceil(precise.width) : el.clientWidth,
    viewportHeight: precise ? Math.ceil(precise.height) : el.clientHeight,
    contentWidth: el.scrollWidth, contentHeight: el.scrollHeight,
  };
}

/** The fractional equivalent of `clientWidth`/`clientHeight` (#665), read via `getComputedStyle`
 *  instead of the integer-rounded `clientWidth`/`clientHeight`.
 *
 *  ⚠️ **`UINode.tsx` sets `boxSizing: 'border-box'` on every UI node, and for a border-box element
 *  Chrome's resolved `cs.width` is the BORDER-box width — it already includes padding and borders,
 *  and it does NOT subtract the scrollbar gutter.** The old formula (`cs.width + paddingLeft +
 *  paddingRight`) assumed `cs.width` was the content box, which is backwards for this renderer and
 *  double-counts padding. Measured in real Chromium (authored `width: 434.109px`, target
 *  `clientWidth: 434`):
 *
 *  | case                                   | `cs.width` | `clientWidth` | old formula |
 *  |-----------------------------------------|-----------:|--------------:|------------:|
 *  | border-box, no padding                  |    434.094 |            434 |   434.094 ✓ |
 *  | border-box + `padding: 0 12px`          |    434.094 |            434 |   458.094 ✗ |
 *  | border-box + padding + borders          |    434.094 |            426 |   458.094 ✗ |
 *  | content-box + padding                   |    434.094 |            458 |   458.094 ✓ |
 *
 *  So under `border-box`, padding must NOT be added back, and both the border widths and the
 *  scrollbar gutter (`offsetWidth - clientWidth`, minus the borders already counted) must be
 *  subtracted instead. The `content-box` branch is kept only because `boxSizing` is itself an
 *  authorable `UIElement` field — nothing in this renderer sets it, but nothing stops a game from
 *  authoring it. **Invariant: `|result - clientWidth| < 1` in every case** — this function exists
 *  only to recover the fractional residue `clientWidth` rounds away, never to disagree with it.
 *
 *  ⚠️ **Call `getComputedStyle` on its OWNER, never as a detached reference.** `const f =
 *  view.getComputedStyle; f(el)` throws `Illegal invocation` in real Chrome — `getComputedStyle` is
 *  not callable off its `Window` receiver — but jsdom does NOT reproduce that restriction, so a
 *  detached call stays green in unit tests and only breaks in a real browser. Always invoke it as
 *  `view.getComputedStyle(el)`.
 *
 *  Returns `null` when the result is unusable so the caller can fall back to `clientWidth`/
 *  `clientHeight`: no `getComputedStyle` available at all, any parsed length is `NaN` (jsdom
 *  returns `''` for an unset computed length, which parses to `NaN`), or both dimensions are
 *  `<= 0`.
 */
export function readPreciseBoxSize(el: Element): { width: number; height: number } | null {
  const view = el.ownerDocument?.defaultView
    ?? (typeof getComputedStyle !== 'undefined' ? globalThis : undefined);
  if (!view || typeof view.getComputedStyle !== 'function') return null;
  const cs = view.getComputedStyle(el);
  const num = (v: string) => parseFloat(v);
  const htmlEl = el as HTMLElement;
  const bl = num(cs.borderLeftWidth), br = num(cs.borderRightWidth);
  const bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
  const gutterX = htmlEl.clientWidth ? htmlEl.offsetWidth - htmlEl.clientWidth - bl - br : 0;
  const gutterY = htmlEl.clientHeight ? htmlEl.offsetHeight - htmlEl.clientHeight - bt - bb : 0;
  const width = (cs.boxSizing === 'border-box'
    ? num(cs.width) - bl - br
    : num(cs.width) + num(cs.paddingLeft) + num(cs.paddingRight)) - gutterX;
  const height = (cs.boxSizing === 'border-box'
    ? num(cs.height) - bt - bb
    : num(cs.height) + num(cs.paddingTop) + num(cs.paddingBottom)) - gutterY;
  if (Number.isNaN(width) || Number.isNaN(height)) return null;
  if (!(width > 0) && !(height > 0)) return null;
  return { width, height };
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
