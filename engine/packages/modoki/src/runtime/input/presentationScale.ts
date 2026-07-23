/** Presentation-invariant input scale — the "editor/browser zoom must not change how
 *  the game feels" contract.
 *
 *  Page/UI zoom (the editor's webContents zoom, a browser Cmd+, an OS zoom) rescales the
 *  CSS coordinate system: at zoom factor f the viewport holds 1/f as many CSS px, so the
 *  SAME physical/visual drag spans fewer `clientX` px (measured: innerWidth 2132 → 1480 at
 *  f=1.44). A game that turns a pixel MAGNITUDE into a gameplay value (sling's pull =
 *  `dragPx × pullPerPx`) would silently weaken under zoom. That is a presentation concern
 *  leaking into gameplay, and it must not.
 *
 *  THE CONTRACT (see docs/input.md): the input the game consumes is presented as if the
 *  presentation were at 1:1.
 *    - POSITIONS stay in viewport CSS px — they are ratio-matched to `getBoundingClientRect`
 *      for raycast / hit-testing, which is already zoom-invariant (the ratio cancels f). Do
 *      NOT scale them.
 *    - DISTANCES / DELTAS are magnitudes; multiply a raw CSS-px delta by the presentation
 *      scale below to recover zoom-0-equivalent px. (Applied in the `pointerDrag` accessor.)
 *  A real in-game CAMERA/world zoom is different and is NOT undone here — it changes framing
 *  through the world projection (raycast), which is the correct channel for it.
 *
 *  DETECTION. `window.devicePixelRatio` tracks page zoom EXACTLY — measured live: dpr = 1.0,
 *  1.2, 1.44, 1.728 at editor zoom levels 0..3 (dpr = displayScale × zoomFactor). So the
 *  scale is `devicePixelRatio / baseDpr`, where `baseDpr` is the display's scale at zoom 1.
 *  Reading dpr LIVE means a later zoom change (ctrl+wheel, menu, browser) auto-tracks with no
 *  listener. `baseDpr` defaults to the load-time dpr. The EDITOR calibrates it authoritatively
 *  (main pushes getZoomFactor on mount, on every zoom change, AND on window 'moved' — so a
 *  window dragged to a differently-scaled monitor recalibrates). Guards `typeof window` so it
 *  is inert (scale 1) headless — tests and the determinism harness see raw deltas.
 *
 *  LIMITATION (shipped non-editor builds): there is no calibration path, so `baseDpr` is the
 *  load-time dpr. Correct for the common case (loaded at 100% zoom, fixed display); a game
 *  LOADED already-zoomed bakes that as the 1:1 baseline, and a cross-monitor move can't
 *  recalibrate. Acceptable — shipped web/mobile games are effectively single-display at 100%.
 *
 *  CONTRACT: read a drag MAGNITUDE only via `pointerDrag` (which is scaled), never as a
 *  difference of `pointerPos` reads (raw) — the two spaces diverge under zoom. */

let baseDpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

/** Zoom-invariant scale for input DISTANCES: `rawCssPxDelta × getPresentationScale()` =
 *  zoom-0-equivalent px. Returns 1 headless and at zoom 1. */
export function getPresentationScale(): number {
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  return dpr > 0 && baseDpr > 0 ? dpr / baseDpr : 1;
}

/** Editor-only: calibrate the display baseline from the AUTHORITATIVE page-zoom factor
 *  (`webContents.getZoomFactor()`, pushed by main). Recovers the true display scale
 *  `baseDpr = devicePixelRatio / zoomFactor` even when the editor restored a persisted zoom
 *  before mount. Idempotent — safe to call on mount and on every zoom change (also re-fixes
 *  a window moved to a differently-scaled monitor). */
export function calibratePresentationScale(zoomFactor: number): void {
  if (typeof window === 'undefined' || !(zoomFactor > 0)) return;
  const dpr = window.devicePixelRatio;
  if (dpr > 0) baseDpr = dpr / zoomFactor;
}

/** Test seam: force the baseline directly (bypasses `window`). */
export function __setBaseDprForTest(dpr: number): void { baseDpr = dpr; }
