/** safeArea — the measured safe-area insets, in logical px, for GAME CODE.
 *
 *  The UI layer clears the notch and home indicator declaratively (`UIAnchor.safeArea`,
 *  see anchorCss), and for most chrome that is the whole story. This exists for the case
 *  it cannot cover: a game whose own LAYOUT ARITHMETIC has to account for the inset —
 *  a bottom band reserved for an ad, a board fitted into what is left, a value derived
 *  from where a bar ends up. Court reserves 9.1% of the screen for a banner and derives
 *  the button row's position and the narration band's height from it; if the ad must
 *  render above the home indicator, that reserve grows by the inset and three numbers
 *  move with it. No CSS expression can hand a game those pixels.
 *
 *  ⚠️ **MEASURED, not computed** — and it has to be, because there are two sources of
 *  truth and only the browser knows which is live. On device the inset comes from
 *  `env(safe-area-inset-*)`; in an editor device preview it comes from the `--ui-sa-*`
 *  vars the preview publishes (`editor/scene/devicePresets.ts`), because `env()` is 0 on
 *  a desktop browser. A probe element inside the UI root resolves whichever applies
 *  through the normal cascade, so this returns the simulated inset in the editor and the
 *  real one on the phone, with no branch and no way for the two to disagree.
 *
 *  The probe must live INSIDE the UI root for that to work: `--ui-sa-*` is set on the
 *  preview container, so a probe on `document.body` would sit outside the cascade and
 *  read a confident, wrong 0 in every editor preview.
 *
 *  Returns zeros before the UI layer has mounted (a headless test, a game with no UI, a
 *  system running before first paint). Zero is the honest answer there — it is what a
 *  device with no notch reports — and it degrades to the pre-safe-area behaviour rather
 *  than to something arbitrary. */

import { rawNow } from '../core/clock';

export interface SafeAreaInsets {
  /** Logical px. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** The same inset as a PERCENTAGE of the UI root's box — the space `%` lengths and anchor
   *  offsets resolve in.
   *
   *  ⚠️ **Use these, not `px / yourOwnMeasurement * 100`.** That division is a trap and it caught
   *  the first version of Court's banner lift: a game measuring its own host with
   *  `getBoundingClientRect` gets a POST-transform rect, and the editor's device preview renders at
   *  logical size under a `transform: scale()`. The px inset is in PRE-transform space, so mixing
   *  the two produced a 6.09% lift where 3.73% was correct — right on the phone, wrong in the
   *  editor, which is the worst way for it to be wrong. These are measured against the root's
   *  layout box in the same pass, so both numbers are always in one space. */
  topPct: number;
  rightPct: number;
  bottomPct: number;
  leftPct: number;
}

const ZERO: SafeAreaInsets = {
  top: 0, right: 0, bottom: 0, left: 0,
  topPct: 0, rightPct: 0, bottomPct: 0, leftPct: 0,
};

let insets: SafeAreaInsets = { ...ZERO };
/** The UI root to re-measure from, remembered so a READ can refresh itself. */
let root: HTMLElement | null = null;
let lastMeasuredAt = -Infinity;
/** Set while a deferred re-measure (below) is queued, so a burst of calls inside one throttle
 *  window schedules exactly one `requestAnimationFrame`, not one per call. */
let refreshQueued = false;
/** The queued frame's id, so `resetSafeAreaInsets` can cancel a real in-flight callback rather
 *  than merely clearing the flag that gates scheduling a NEW one — found in review (#579
 *  follow-up): a reset with a refresh in flight otherwise left `refreshQueued` stuck `true`
 *  (suppressing every future refresh) and left a stray callback able to run against whatever
 *  the NEXT test/session registers. */
let refreshFrameId: ReturnType<typeof requestAnimationFrame> | null = null;

/** How stale a cached inset may get, ms. Small enough that a bar hiding is invisible to
 *  the eye, large enough that a per-frame caller pays one forced style read every ~15
 *  frames instead of 60. */
const REFRESH_MS = 250;

/** How many self-refreshes a registration/resume signal arms. #592: the Android bar-hide this
 *  refresh exists for (#273) settles once, a beat after the signal — not continuously for the
 *  rest of the session — so polling past that settle point is pure ongoing cost (a forced
 *  synchronous layout, see `getSafeAreaInsets`'s own doc) for zero remaining benefit. 20 matches
 *  the ceiling the old 5s/`REFRESH_MS` window imposed — but **that equivalence holds only for a
 *  PER-FRAME reader**, and even then the old window in fact reached 19, not a clean 20: its first
 *  refresh could only land at t+256ms (a 60fps reader crosses the 250ms throttle a frame late),
 *  leaving room for 19 more inside the remaining span, not 20. A reader slower than once-a-frame
 *  used to be bounded by its OWN cadence rather than the window, and #600 changes that — measured
 *  forced-layouts-per-signal, pre-fix → post-fix: 60fps reader 19 → 20 (near enough unchanged),
 *  1Hz reader 4 → 20, 0.5Hz reader 2 → 20. See the ⚠️ below for why spending more for a slow
 *  reader is the intended trade, not a regression.
 *
 *  ⚠️ **This budget does NOT touch the RATE bound**, which is separate and unchanged: `rawNow() -
 *  lastMeasuredAt > REFRESH_MS` (`getSafeAreaInsets`, below) plus the one-in-flight
 *  `refreshQueued` guard still cap this at ONE forced layout per 250ms, however the caller drives
 *  it — that is the bound #579 cares about (the WebKit touch-scroll compositor stall it measured
 *  live), and nothing here loosens it.
 *
 *  ⚠️ **The COUNT is preserved for a per-frame reader; the SPAN is not, and that is the
 *  deliberate trade.** The old window also confined those measurements to 5 seconds. A budget
 *  does not: a consumer reading once a second rather than once a frame now spends its full 20
 *  over ~20s instead of the 4 the old window's own 5s span let it reach (measured above), and one
 *  suppressing reads entirely (Court's gesture gate, #600) can spend its first long after the
 *  signal. That is the whole point — the poll has to outlast a suppressed period to catch up at
 *  the end of one — and it stays bounded either way, because the cost that matters is the number
 *  of forced layouts, not the wall-clock span they are spread across.
 *
 *  ⚠️ **That trade is not free, and the one place it is known to cost something is tracked as
 *  #606**: the old window guaranteed the poll was SILENT by wall-clock T after the signal
 *  whatever the consumer did, and that is what kept a forced layout out of a scroll starting long
 *  after mount. Court's gate reopens on `touchend` while WebKit is still decelerating a momentum
 *  scroll, so up to 6 of these can now land in that ~1.5s (measured; 0 before). Whether that
 *  actually stalls the compositor the way #579's finger-down profile did is UNMEASURED — do not
 *  "fix" it from analysis, see #606 for the device measurement that would settle it.
 *
 *  On SIZING this number: if a device turns up where
 *  the transition lands later, widen this rather than removing the bound — the fallback is a
 *  stuck stale value (#273 again, see `getSafeAreaInsets`'s doc), not a crash, so too small a
 *  budget is a correctness bug to fix with a bigger number, not a reason to give up on bounding
 *  it. */
const POLL_REFRESH_BUDGET = 20;

/** How many self-refreshes remain before the poll stops scheduling itself. Set (not
 *  incremented) by every EXTERNAL registration — `measureSafeAreaInsets` (mount, a resize, a
 *  scene swap's fresh root) and a `visibilitychange` resume — the moments the bar-hide can
 *  occur. Past zero the cached value is still returned (see `getSafeAreaInsets`); it simply
 *  stops re-measuring on its own until the next such signal.
 *
 *  ⚠️ **The self-refresh's OWN re-measure must NOT re-arm this, or the budget never runs out**
 *  (found in review, #592, and this reasoning applies verbatim to a count): the deferred rAF
 *  callback below used to call the same `measureSafeAreaInsets` a real registration calls,
 *  which re-armed the budget on every refresh and made it top up forever — the exact bug #592
 *  was written to fix, reintroduced by the fix. `applyMeasurement` (below) is the measurement
 *  with no arming, used by both the public entry point (which arms first) and the self-refresh
 *  (which must not).
 *
 *  ⚠️ **This is a COUNT, not a deadline, and that distinction is #600.** A wall-clock window is
 *  spent by TIME passing, whether or not anything was measured — so a consumer that stops
 *  reading for a while has its window burned down for free. Court's `boardSafeAreaInsets()`
 *  (`games/court/runtime/systems.ts`) deliberately skips the accessor for the whole duration of
 *  a live touch gesture (#579 follow-up); under the old `pollArmedUntil` deadline, a gesture
 *  starting near a resume/mount and outlasting the window burned the entire window on ZERO
 *  reads, so the catch-up read at the end of the gesture landed past a deadline that had already
 *  passed and scheduled nothing — the stale value then stuck until the next mount/resize/resume.
 *  A budget is spent by MEASUREMENTS instead, so a suppressed reader arrives at the end of its
 *  gesture with the budget still intact and its next read catches up normally. */
let refreshesLeft = 0;

/** Set once the `visibilitychange` listener (below) has been added, so a burst of
 *  registrations wires it at most once per module instance. */
let visibilityListenerWired = false;

/** #592: platform-agnostic on purpose, matching this file's existing no-Capacitor-dependency
 *  design (see the file header) — `document.visibilitychange` already answers "resumed" on
 *  every shell this runs in (a browser tab, and a Capacitor WebView backgrounding/foregrounding
 *  pauses/resumes the same way) without threading `App.addListener('resume', ...)` through an
 *  otherwise L0 module.
 *
 *  Wired LAZILY from `measureSafeAreaInsets`'s first real registration, not at module import
 *  time — `domGestureTracking.ts`'s header warns against exactly the alternative ("an
 *  unconditional `addEventListener` at import time would fire in every embedding context that
 *  imports this module, wanted or not"). `resetSafeAreaInsets` removes it, for the same
 *  test-isolation reason it tears down every other piece of this module's state; the
 *  `import.meta.hot.dispose` below (mirroring `editor/store/canvas2DDirty.ts`'s own HMR
 *  cleanup, and already an established pattern in shipped `runtime/**` code — see
 *  `rendering/postfx/PostFXStack.ts`) is what actually stops a Vite HMR re-evaluation of this
 *  module from leaving the OLD instance's listener on `document` forever (found in review,
 *  #592 follow-up: lazy wiring alone only changes WHEN the first listener is added, not
 *  whether an old one survives a hot reload). Stripped by Vite in a production build, so this
 *  is a dev-only no-op there, never a runtime dependency. */
function wireVisibilityResume(): void {
  if (visibilityListenerWired) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityListenerWired = true;
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshesLeft = POLL_REFRESH_BUDGET;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => { resetSafeAreaInsets(); });
}

/** Read the current insets, re-measuring if the cache has gone stale.
 *
 *  ⚠️ **The refresh is not belt-and-braces — a resize alone MISSES the common Android
 *  case, and this cost a real bug.** With `setDecorFitsSystemWindows(false)` the window
 *  keeps its size when the system bars hide, so ONLY the insets change and no
 *  ResizeObserver fires. Court's immersive mode hides the bars a beat after first paint,
 *  so the value captured at mount (bottom 48px, the nav bar) never refreshed: measured on
 *  a Galaxy A23 where the live inset was 0 while the game was still laying out against
 *  48. It lifted the ad band off the bottom edge AND shortened the paper (the same number
 *  feeds `designToHostPct`'s vertical span), which read as two unrelated bugs.
 *
 *  There is no event to listen for — `env()` changing fires nothing — so the read
 *  refreshes itself on a throttle rather than waiting to be told. `rawNow` is the
 *  sanctioned clock wrapper (`runtime/core/clock.ts`), so a manual clock in a headless
 *  test still controls it and the determinism guard stays satisfied.
 *
 *  ⚠️ **The re-measure is DEFERRED one `requestAnimationFrame`, not run inline.**
 *  `measureSafeAreaInsets` appends a probe and reads its computed style — a forced
 *  synchronous layout, by construction (WebKit/browsers flush ALL pending layout before
 *  answering a geometry/style query, not just this element's). Running that inline from
 *  whichever per-frame caller happened to cross the 250ms mark meant it landed wherever
 *  a caller's OWN pending DOM write had left layout dirty — device-profiled on an iPhone
 *  8 (#579 follow-up): a Safari Timeline recording showed exactly this call forcing a
 *  layout every ~250-300ms, continuously, including mid-drag on a scrolling list, where
 *  it visibly stalled WebKit's native touch-scroll compositor on old/weak hardware. A
 *  rAF callback runs AFTER the browser's own layout pass for the frame, so the flush this
 *  forces is one the browser was about to do anyway rather than one pulled forward.
 *
 *  ⚠️ This is a TIMING change, not a memoization/signature gate — every call still reads
 *  through to a value that self-refreshes with no external trigger (the #273 property this
 *  file exists for), just up to one frame later than before. It cannot reintroduce the
 *  class of bug `syncPageAndButtons` (Court, `systems.ts`) warns about, where a cached
 *  SIGNATURE survived a scene reload and matched against already-reset authored state: there
 *  is no signature here, nothing is skipped, and the caller's own per-frame cadence is what
 *  still drives every read — this only moves WHEN the expensive part of one particular read
 *  runs, never whether the read happens.
 *
 *  ⚠️ **The self-refresh is BOUNDED to a refresh BUDGET armed by a registration/resume, not
 *  indefinite (#592).** The case it exists for (#273's Android bar-hide) settles once, shortly
 *  after mount or a resume from background — not continuously for the rest of a play session —
 *  so polling forever after that point is ongoing forced-layout cost for zero remaining benefit
 *  (measured: 3-4x/sec continuously, stalling the iPhone 8's touch-scroll compositor, #579
 *  follow-up). Once `refreshesLeft` reaches zero this returns the last-measured value without
 *  scheduling another refresh; an external `measureSafeAreaInsets` registration and a
 *  `visibilitychange` resume both re-arm the budget. **#600: a COUNT rather than a deadline is
 *  the point** — a consumer that stops reading for a while (Court's `boardSafeAreaInsets()`
 *  skips this accessor for a whole touch gesture) spends nothing while it is not reading, so
 *  its catch-up read still finds budget left however long the gesture ran, instead of arriving
 *  after a wall-clock window that closed unspent. **The refresh below must re-measure through
 *  `applyMeasurement`, not `measureSafeAreaInsets`** — the public entry point re-arms the
 *  budget, and calling it from here would make every self-refresh top up its own budget, so the
 *  poll would never actually stop (the bug this section exists to prevent, caught in review). */
export function getSafeAreaInsets(): SafeAreaInsets {
  // ⚠️ A DETACHED root must not be measured, and this cleanup runs UNCONDITIONALLY — never
  // gated by the poll budget below (found in review, #592 follow-up). `root.isConnected` is a
  // cheap DOM flag read, not a forced layout, so there is no cost reason to skip it once the
  // budget is spent; skipping it left a detached root (and the whole DOM subtree it drags with
  // it) referenced by this module forever once the budget ran out with no further registration
  // — e.g. a scene swap to a UI-less scene after `POLL_REFRESH_BUDGET` refreshes had already
  // been spent used to release the old root on the very next read; now it wouldn't, without this
  // branch running independently of whether a refresh may also be scheduled.
  //
  // `UIRenderer`'s callback ref returns early on unmount (it has other teardown to skip), so it
  // never hands this module a null — the reference here simply goes stale, still pointing at a
  // removed node. `getComputedStyle` on one answers empty strings and `clientHeight` 0, so
  // measuring it would quietly rewrite every inset to ZERO with no device change. Reachable two
  // ways: in the editor both viewports mount a UIRenderer, so closing the one that registered
  // last detaches this root while the other is still on screen; in a shipped game the tree
  // empties for a beat across a scene swap. Keeping the LAST GOOD value is the right answer
  // either way — a device's insets do not change because some UI unmounted.
  if (root && !root.isConnected) {
    root = null;
  } else if (root && rawNow() - lastMeasuredAt > REFRESH_MS && !refreshQueued && refreshesLeft > 0) {
    refreshQueued = true;
    const target = root;
    refreshFrameId = requestAnimationFrame(() => {
      refreshQueued = false;
      refreshFrameId = null;
      // ⚠️ A NEWER registration may have replaced `root` since this was scheduled (the
      // editor's two-viewport case, above) — found in review (#579 follow-up). An identity
      // check against the captured reference, not a generation counter: the thing that gets
      // replaced here is the root itself, not a version of it (docs/async-lifetime.md's
      // "Identity against a captured reference" row). Without it, a stale `target` that is
      // still connected re-points `root` BACK to itself (undoing the newer registration), and
      // a stale `target` that got disconnected nulls out whatever the newer registration set —
      // both are the same bug: acting on behalf of a registration this callback no longer
      // speaks for.
      if (root !== target) return;
      // ⚠️ `applyMeasurement`, NOT `measureSafeAreaInsets` — see `refreshesLeft`'s own doc
      // (#592). This is the self-refresh re-measuring itself, not a new registration; calling
      // the arming entry point here would top up the poll budget on every refresh and it would
      // never actually run out.
      //
      // The budget is spent HERE, immediately before the forced layout it pays for — not in
      // `applyMeasurement`, which is also the external registration path and must not spend
      // what it is meant to arm. A callback that bails above (stale identity) or below
      // (disconnected target) forced no layout, so it spends nothing; `refreshQueued` already
      // guarantees at most one of these is ever in flight, so this cannot over-spend.
      if (target.isConnected) { refreshesLeft -= 1; applyMeasurement(target); }
      else root = null;
    });
  }
  return insets;
}

/** Measure the insets from `root`'s cascade and cache them. Called by UIRenderer; not
 *  part of the game-facing surface. This is the EXTERNAL registration entry point — a real
 *  mount, resize, or scene-swap fresh root — as opposed to the self-refresh's own re-measure
 *  (`applyMeasurement`, below), which must not be confused with a registration (#592, see
 *  `refreshesLeft`'s doc for why that distinction is load-bearing). */
export function measureSafeAreaInsets(el: HTMLElement | null): void {
  // #592: a real registration re-arms the bounded self-refresh budget (see
  // `POLL_REFRESH_BUDGET`) — this is the "mount" signal alongside `visibilitychange`'s "resume"
  // one. `el === null` (a detach) arms nothing new; there is no root left to poll. Wiring the
  // resume listener here (rather than at module load) means it activates only once something
  // has actually registered a root, not merely because this module was imported.
  if (el) { refreshesLeft = POLL_REFRESH_BUDGET; wireVisibilityResume(); }
  applyMeasurement(el);
}

/** The measurement itself, shared by `measureSafeAreaInsets` (above, which arms the poll
 *  budget first) and the self-refresh's deferred rAF callback (`getSafeAreaInsets`, which
 *  must NOT arm it — see `refreshesLeft`'s doc, #592). Not exported: every external caller
 *  goes through `measureSafeAreaInsets`.
 *
 *  Measures a hidden probe rather than reading the `--ui-sa-*` custom properties
 *  directly, for two reasons: a custom property resolves to the literal token (`"68px"`
 *  or, on device, nothing at all — the var is unset and only the `env()` fallback
 *  applies), and only laying it out as a real length makes the browser resolve the
 *  fallback chain. `padding` also clamps negatives to 0 for free. */
function applyMeasurement(el: HTMLElement | null): void {
  root = el;
  lastMeasuredAt = rawNow();
  if (!el || typeof getComputedStyle !== 'function') { insets = { ...ZERO }; return; }
  const probe = document.createElement('div');
  // `position: fixed` + zero size keeps the probe out of flow entirely, so it cannot
  // affect the layout it is measuring. `visibility: hidden` (not `display: none`) is
  // required: a display-none element has no computed padding to read.
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;'
    + 'padding-top:var(--ui-sa-top, env(safe-area-inset-top));'
    + 'padding-right:var(--ui-sa-right, env(safe-area-inset-right));'
    + 'padding-bottom:var(--ui-sa-bottom, env(safe-area-inset-bottom));'
    + 'padding-left:var(--ui-sa-left, env(safe-area-inset-left));';
  el.appendChild(probe);
  try {
    const cs = getComputedStyle(probe);
    /** One edge: the simulated var if one is set, else the resolved padding, else 0.
     *
     *  **The var is checked FIRST, and the order is load-bearing.** Both sources give the
     *  same answer wherever both exist — the padding IS `var(--ui-sa-*, env(...))`, so a
     *  set var resolves through it — and the padding alone would look sufficient. It is
     *  not, because of how jsdom degrades: with all four paddings declared it reports
     *  `paddingTop: "0"`, a perfectly PARSEABLE zero, rather than leaving the value
     *  unresolved. A padding-first order therefore reads 0 and never consults the var, so
     *  every editor-simulated inset silently vanished under test while the live path was
     *  fine. (With only ONE padding declared jsdom hands back the raw `var(...)` string
     *  instead, which is what made the first version look correct in isolation.)
     *
     *  The padding branch is the LIVE one on device: a shipped build sets no var, so the
     *  lookup misses and `env(safe-area-inset-*)` resolves through the padding — measured
     *  at top 68 on an iPhone Air. Neither branch is dead code. */
    const edge = (padding: string, varName: string): number => {
      const simulated = parseFloat(cs.getPropertyValue(varName));
      if (Number.isFinite(simulated)) return simulated;
      const resolved = parseFloat(padding);
      return Number.isFinite(resolved) ? resolved : 0;
    };
    const top = edge(cs.paddingTop, '--ui-sa-top');
    const right = edge(cs.paddingRight, '--ui-sa-right');
    const bottom = edge(cs.paddingBottom, '--ui-sa-bottom');
    const left = edge(cs.paddingLeft, '--ui-sa-left');
    // `clientWidth`/`clientHeight` are the LAYOUT box — pre-transform, so this is the logical
    // device size in an editor device preview and the viewport on hardware. Same space as the
    // px insets above, which is the whole point (see the doc on the *Pct fields).
    const w = el.clientWidth || 0;
    const h = el.clientHeight || 0;
    const pct = (v: number, total: number) => (total > 0 ? (v / total) * 100 : 0);
    insets = {
      top, right, bottom, left,
      topPct: pct(top, h),
      rightPct: pct(right, w),
      bottomPct: pct(bottom, h),
      leftPct: pct(left, w),
    };
  } finally {
    probe.remove();
  }
}

/** Reset to zeros — for teardown, and for tests that must not inherit another test's
 *  measurement (the cache is module state, and test files share a module registry). */
export function resetSafeAreaInsets(): void {
  insets = { ...ZERO };
  root = null;
  lastMeasuredAt = -Infinity;
  refreshesLeft = 0;
  // A refresh scheduled by a torn-down session must not fire against whatever registers next —
  // cancel the real callback, not just the flag that gates scheduling a new one (found in
  // review, #579 follow-up).
  if (refreshFrameId !== null) { cancelAnimationFrame(refreshFrameId); refreshFrameId = null; }
  refreshQueued = false;
  // #592: undo `wireVisibilityResume` too, so a fresh test/session re-wires its own listener
  // rather than accumulating one per registration across a shared module registry.
  if (visibilityListenerWired && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  visibilityListenerWired = false;
}
