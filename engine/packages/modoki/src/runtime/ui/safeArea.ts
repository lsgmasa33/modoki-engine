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
 *  runs, never whether the read happens. */
export function getSafeAreaInsets(): SafeAreaInsets {
  if (root && rawNow() - lastMeasuredAt > REFRESH_MS && !refreshQueued) {
    // ⚠️ A DETACHED root must not be measured. `UIRenderer`'s callback ref returns early on
    // unmount (it has other teardown to skip), so it never hands this module a null — the
    // reference here simply goes stale, still pointing at a removed node. `getComputedStyle`
    // on one answers empty strings and `clientHeight` 0, so the refresh would quietly rewrite
    // every inset to ZERO and the layout would jump with no device change.
    //
    // Reachable two ways: in the editor both viewports mount a UIRenderer, so closing the one
    // that registered last detaches this root while the other is still on screen; in a shipped
    // game the tree empties for a beat across a scene swap. Keeping the LAST GOOD value is the
    // right answer either way — a device's insets do not change because some UI unmounted.
    if (root.isConnected) {
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
        if (target.isConnected) measureSafeAreaInsets(target);
        else root = null;
      });
    } else {
      root = null;
    }
  }
  return insets;
}

/** Measure the insets from `root`'s cascade and cache them. Called by UIRenderer; not
 *  part of the game-facing surface.
 *
 *  Measures a hidden probe rather than reading the `--ui-sa-*` custom properties
 *  directly, for two reasons: a custom property resolves to the literal token (`"68px"`
 *  or, on device, nothing at all — the var is unset and only the `env()` fallback
 *  applies), and only laying it out as a real length makes the browser resolve the
 *  fallback chain. `padding` also clamps negatives to 0 for free. */
export function measureSafeAreaInsets(el: HTMLElement | null): void {
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
  // A refresh scheduled by a torn-down session must not fire against whatever registers next —
  // cancel the real callback, not just the flag that gates scheduling a new one (found in
  // review, #579 follow-up).
  if (refreshFrameId !== null) { cancelAnimationFrame(refreshFrameId); refreshFrameId = null; }
  refreshQueued = false;
}
