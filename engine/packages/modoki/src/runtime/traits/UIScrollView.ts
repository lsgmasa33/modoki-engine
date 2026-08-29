import { trait } from 'koota';

/** UIScrollView — a scrolling box, and the ECS surface for where it is scrolled to.
 *
 *  Opt-in beside `UIElement` (the same shape `UIToggle`, `UIFocusable` and `Canvas2D`
 *  already use). It is useful ON ITS OWN, with ordinary authored children and no
 *  recycling — which is why it is a separate trait from `UIEntries`: a short scroll box
 *  wants a scroll POSITION without wanting a pool.
 *
 *  Until #250 the engine had no scroll surface at all: `UIElement.overflow:'scroll'` mapped
 *  to CSS `auto` in `UINode` and nothing else existed, so game code could not read
 *  `scrollTop` and a game-local recycler was not even writable.
 *
 *  ## ⚠️ The read-back must NOT mark the UI tree dirty
 *
 *  `UINode`'s scroll handler writes `scrollX`/`scrollY` here on every DOM scroll event —
 *  at fling frequency — and deliberately does **not** call `markUIDirty()`. This is the
 *  opposite of how every other UI write in the engine behaves, and it is what keeps
 *  scrolling free: a scroll frame that does not move the entry window costs nothing at all.
 *  A consumer that needs to react (`UIEntries`) is a SYSTEM that reads these fields and
 *  dirties only what it actually changed.
 *
 *  Writing these through a helper that dirties (e.g. `writeTraitField`) would rebuild the
 *  whole UI tree on every scroll event and hand the feature its own stutter — measured as
 *  the mechanism to avoid before any of this was built.
 *
 *  ## Motion is CSS for now, and the vocabulary matches the backend
 *
 *  `snap`/`snapStop`/`overscroll` map to `scroll-snap-align` + `scroll-snap-type`,
 *  `scroll-snap-stop`, and `overscroll-behavior`. There is deliberately NO `deceleration`,
 *  `elasticity` or fling-velocity curve: CSS cannot honour them, and an authored field that
 *  moves nothing is a lie with a tooltip.
 *
 *  ⚠️ **The owned-physics backend is DECLINED, not pending** (owner, 2026-08-21). The plan
 *  shipped CSS first precisely so the question could be answered by feel rather than by
 *  argument; the owner scrolled the real Android build on a Galaxy S22 and judged it good. So
 *  those fields are not "coming" — reopen the question only if a concrete case needs a motion
 *  CSS genuinely cannot express, and say which. See docs/todo.md § Declined.
 *
 *  ## Pool sizing lives on `UIEntries`, but the floor is stated here because it is geometry
 *
 *  A viewport `n` entries tall shows `n + 1` of them at any partial scroll offset — one entry
 *  always straddles the edge. So `visible = ceil(viewport / entrySize) + 1` is the floor for
 *  smooth scrolling and is required even at `overscan: 0` (owner, 2026-08-21). `overscan` is a
 *  SEPARATE term covering how far the scroll travels between two pool updates. Merging them is
 *  how the `+1` gets tuned away and a one-entry gap reappears at every non-integer offset.
 *
 *  ⚠️ **`snapStop:'always'` CONSTRAINS a fling; it does not cap it at one entry.** Measured
 *  on a Galaxy A23 (2026-08-21): one hard fling advanced 11 entries at `'normal'` and 3 at
 *  `'always'`, and a slow drag advanced exactly 1. The cap turned out to be the POOL's
 *  extent — a browser can only stop at snap points that EXIST in the DOM, and recycling is
 *  what removes the further ones. So do not size a pool to buy a feel promise; the owner's
 *  call (2026-08-21) is that the free behaviour is the wanted one.
 */
export const UIScrollView = trait({
  /** Which axis scrolls. 'y' is the common case; 'both' is the 2-D grid. */
  axis: 'y' as UIScrollAxis,
  /** Where an entry comes to rest when snapping. 'none' disables snapping entirely. */
  snap: 'none' as UIScrollSnap,
  /** 'always' makes the scroll stop at snap points it passes — see the ⚠️ above for what
   *  that does and does not guarantee once the content is recycled. */
  snapStop: 'normal' as UIScrollSnapStop,
  /** `overscroll-behavior` — governs whether a scroll at the end chains to the parent. */
  overscroll: 'auto' as UIScrollOverscroll,
  /**
   * What a MOUSE WHEEL / trackpad gesture does. Touch is unaffected either way.
   *
   * - `'native'` (default) — the browser scrolls by the raw wheel delta.
   * - `'entry'` — one wheel gesture moves exactly ONE entry, and a gesture is only over once the
   *   wheel has been quiet for a moment.
   *
   * ⚠️ **`'entry'` exists because a multiplier CANNOT work under `snap: mandatory`.** The browser
   * quantises any offset to a whole entry, so shrinking the delta changes nothing; the only thing
   * left to control is how many entries one gesture is allowed to cross. And it does need
   * controlling: a single wheel NOTCH (~100-120px against a 218px page) is under half an entry and
   * snaps back to where it started, while a trackpad swipe emits a rapid stream whose deltas
   * accumulate into hundreds of pixels before the browser resolves them — so one flick crossed
   * several pages. Owner on Court's level selector, 2026-08-22: *"with the mouse wheel, scroll is
   * too sensitive."*
   *
   * Default `'native'` because a long LIST wants the raw delta — capping a 5,000-row strip to one
   * row per gesture would be unusable. This is a PAGER's setting.
   */
  wheel: 'native' as UIScrollWheel,
  /** Whether the platform's classic scrollbar is shown. A classic (non-overlay) scrollbar
   *  STEALS cross-axis space from the content box — measured live in Court's level selector
   *  (2026-08-21): a scroll box authored at 28.6vh (border-box 197.6px) had `clientHeight` 183
   *  after a 15px horizontal scrollbar appeared, clipping the 197.6px-tall 5x5 grid inside it
   *  7px at top and bottom. Mobile (Court's shipping target) uses OVERLAY scrollbars and steals
   *  nothing, so authoring the box 15px taller to compensate would leave a 15px gap on the
   *  platform that actually ships — the author has to be able to say whether this view shows a
   *  scrollbar. Default `'auto'` (platform default) so no existing view changes behaviour. */
  scrollbar: 'auto' as UIScrollScrollbar,

  // ── Engine-written state (read freely; do not write) ──
  scrollX: 0,
  scrollY: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  contentWidth: 0,
  contentHeight: 0,

  // ── Game-written one-shot request, consumed and cleared by the renderer ──
  /** Target scroll offset in px. **-1 means "no request"** — a real offset is never
   *  negative, so -1 is a safe sentinel and avoids a second "isRequested" field that could
   *  disagree with the value. The renderer scrolls, then writes -1 back. */
  scrollToX: -1,
  scrollToY: -1,
  /** Per-request motion override. `''` means "no override" — the request then moves the way the
   *  AUTHORED `scrollBehavior` below says. Cleared alongside the `scrollToX/Y` sentinels.
   *
   *  ⚠️ This field exists because the request used to be stored on `scrollBehavior` itself
   *  (#409). One `scrollToEntry` with no `behavior` defaulted to `'instant'` and overwrote an
   *  authored `'smooth'` for good, and the next save wrote that overwrite out as authored data —
   *  a transient parameter living on a persistent field. Two roles, two fields: **never write a
   *  request onto `scrollBehavior`.** */
  scrollToBehavior: '' as UIScrollBehaviorRequest,

  // ── Authored again (it sits here so the field order committed scenes already carry is kept) ──
  /** How a `scrollTo*` request moves when the request itself names no behaviour. 'smooth' hands
   *  off to the browser, whose duration is UA-defined and NOT tunable — that is a property of the
   *  CSS backend, and the reason no `duration`/`easing` fields exist yet. */
  scrollBehavior: 'instant' as UIScrollBehavior,
});

export type UIScrollAxis = 'x' | 'y' | 'both';
export type UIScrollWheel = 'native' | 'entry';
export type UIScrollSnap = 'none' | 'start' | 'center' | 'end';
export type UIScrollSnapStop = 'normal' | 'always';
export type UIScrollOverscroll = 'auto' | 'contain' | 'none';
export type UIScrollScrollbar = 'auto' | 'hidden';
export type UIScrollBehavior = 'instant' | 'smooth';
/** A per-request behaviour, or `''` for "fall back to the authored `scrollBehavior`". */
export type UIScrollBehaviorRequest = UIScrollBehavior | '';

/** Sentinel for "no scroll request pending" on `scrollToX`/`scrollToY`. */
export const NO_SCROLL_REQUEST = -1;

/** Sentinel for "this request names no behaviour" on `scrollToBehavior` — the authored
 *  `scrollBehavior` is then what moves the view. */
export const NO_BEHAVIOR_REQUEST = '';
