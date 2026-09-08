/** autoFitText — the pure shrink-only auto-fit decision for `UIElement.autoFitText` (#614).
 *
 *  Why: Court's `ConflictLocalButton` wraps "Keep this device" onto two lines while its twin
 *  "Use the cloud" sits on one — both authored identically (`width: 72%`, `fontSize: 2.4vh`).
 *  `UIElement` had no shrink-to-fit lever, and the workarounds are all wrong: a hardcoded
 *  smaller `fontSize` is the shadowing-constant failure the root CLAUDE.md warns about (it must
 *  be re-tuned per device width); `maxLines: 1` clips ("Keep this dev…"); shortening the string
 *  collides with localisation. So this is a real engine capability, authored on the trait.
 *
 *  **Shrink-only**: this never grows a label past its authored `fontSize` — it only reduces the
 *  effective size, and only when the single-line text would otherwise overflow its box, down to
 *  a floor. Below the floor, the existing `maxLines`/`textOverflow` behaviour takes over
 *  unchanged — auto-fit is the shrink-FIRST step, never a replacement for that fallback.
 *
 *  Pure and exported so it is unit-testable without mounting anything (jsdom reports every rect
 *  as 0x0, so a DOM-mounted test would assert the mock, not the behaviour — see the DOM wiring
 *  in `UINode.tsx`'s `AutoFitText` for where the real measurement happens).
 *
 *  **`fitFontSizePx` is only a first ESTIMATE, never a final answer** (#614 follow-up). It models
 *  width as PROPORTIONAL to font size, which is exact only when the width function passes through
 *  the origin — true for glyph outlines alone, false the moment a size-INDEPENDENT term exists: a
 *  px `letterSpacing`, px word-spacing, a text-stroke, an inline child with px padding. Measured
 *  live on `games/text_demo`'s "UI TEXT ANIMATION" (17 chars, 42px, 3px `letterSpacing`, a
 *  319.59px box): `fitFontSizePx` predicted 30.03px would fit, but 30.03px still measures 336.06px
 *  wide (17px x 3px letterSpacing is most of the 54.46px intercept a linear-through-the-origin
 *  model cannot represent) — a 16.8px overflow that reached a live check because the previous e2e
 *  fixture happened to carry no `letterSpacing` (intercept 0, where the proportional model IS
 *  exact). So a caller MUST verify the estimate against a real re-measurement at the candidate
 *  size and refine from there — see `refineFontSizePx` below and the fit loop in `UINode.tsx`. */

/** Sub-pixel rounding must never shrink text that already fits. Exported so `UINode.tsx` can use
 *  the SAME tolerance when it turns a final MEASURED width into the `fits` decision — a second,
 *  hand-copied `0.5` there would be the shadowing-constant drift CLAUDE.md warns about. */
export const FIT_EPSILON_PX = 0.5;

/**
 * The floor `fontSizeMin: 0` resolves to when no explicit floor is authored — half the authored
 * size. This is a no-scene FALLBACK, not a feel knob: the authored `fontSizeMin` is the knob: an
 * author who wants a different floor sets it on the trait, and this constant only covers the
 * case where nobody did.
 */
export const DEFAULT_AUTOFIT_MIN_RATIO = 0.5;

export interface FitFontSizeInput {
  /** Computed px of the authored `fontSize`, whatever unit it was written in. */
  authoredPx: number;
  /** Measured single-line (nowrap) text width at `authoredPx`. */
  naturalPx: number;
  /** Content-box width the text must fit into. */
  availablePx: number;
  /** The resolved floor, already clamped to <= authoredPx. */
  minPx: number;
}

export interface FitFontSizeResult {
  fontSizePx: number;
  /** True when the text fits on one line at `fontSizePx` — false when the floor stopped the
   *  shrink short and the text still does not fit at `minPx`. */
  fits: boolean;
  /** True when `fontSizePx` differs from `authoredPx` (a real shrink happened). */
  shrunk: boolean;
}

/** The shrink-only auto-fit FIRST ESTIMATE. See the module header for the invariant, and for why
 *  this is a proportional model (`wanted = authoredPx * availablePx / naturalPx`) that OVER-
 *  estimates the fitting size whenever the width function has a non-zero intercept — this alone is
 *  never a safe final answer; callers must refine it against a real measurement (`refineFontSizePx`). */
export function fitFontSizePx(o: FitFontSizeInput): FitFontSizeResult {
  const { authoredPx, naturalPx, availablePx } = o;
  // Nothing was measurable — do not guess. This is also what keeps the feature inert under
  // jsdom, where every rect is 0x0: a 0/0 division would otherwise be NaN and blank the label.
  // `Number.isFinite` is load-bearing, not just `> 0` — an `Infinity` operand (a detached/
  // display:none measurement can report it) passes `> 0` but would still divide out to NaN/0.
  if (!Number.isFinite(authoredPx) || authoredPx <= 0
    || !Number.isFinite(naturalPx) || naturalPx <= 0
    || !Number.isFinite(availablePx) || availablePx <= 0) {
    return { fontSizePx: authoredPx, fits: true, shrunk: false };
  }
  if (naturalPx <= availablePx + FIT_EPSILON_PX) {
    return { fontSizePx: authoredPx, fits: true, shrunk: false };
  }
  const wanted = authoredPx * availablePx / naturalPx;
  const fontSizePx = Math.max(o.minPx, Math.min(authoredPx, wanted));
  return { fontSizePx, fits: wanted >= o.minPx, shrunk: true };
}

/** How many times `UINode.tsx`'s fit loop will re-measure-and-refine before accepting whatever it
 *  has. Bounded, not `while(!done)`, because a fit runs synchronously inside `useLayoutEffect` —
 *  an unbounded loop on a pathological width function would block the frame. In practice the
 *  measured `games/text_demo` case above converges in 2 passes; 4 is headroom, not a tuned budget. */
export const MAX_FIT_PASSES = 4;

/**
 * One refinement step: given a font size that was just MEASURED (not merely predicted), decide
 * whether to accept it or try a smaller one. This is what turns `fitFontSizePx`'s one-shot
 * proportional guess into a loop that converges on the REAL width function, whatever shape it is
 * (proportional, affine, or anything monotonic in between) — see the module header for why the
 * guess alone is not trustworthy.
 *
 * Never grows: `nextPx` is always `<= currentPx`. That is load-bearing, not incidental — it means
 * a bad/noisy measurement can only ever make the loop end with text that is too SMALL, never text
 * that overflows. Overflow is the failure mode this whole loop exists to close off.
 */
export function refineFontSizePx(o: {
  /** The size the measurement below was taken AT. */
  currentPx: number;
  /** Measured natural single-line width AT `currentPx`. */
  measuredPx: number;
  /** Content-box width the text must fit into. */
  availablePx: number;
  /** The resolved floor (already clamped to <= authoredPx). */
  minPx: number;
}): { nextPx: number; done: boolean } {
  const { currentPx, measuredPx, availablePx, minPx } = o;
  // Same "never guess" contract as fitFontSizePx: an unmeasurable input returns the size
  // unchanged rather than dividing out to NaN/Infinity.
  if (!Number.isFinite(currentPx) || currentPx <= 0
    || !Number.isFinite(measuredPx) || measuredPx <= 0
    || !Number.isFinite(availablePx) || availablePx <= 0) {
    return { nextPx: currentPx, done: true };
  }
  // Converged: the size we actually measured at fits. This is the ONLY branch that can end the
  // loop on a size that was itself measured to fit — every other `done: true` below ends the loop
  // on a size smaller than what was last measured, by the shrink-only invariant above.
  if (measuredPx <= availablePx + FIT_EPSILON_PX) {
    return { nextPx: currentPx, done: true };
  }
  // Floored: cannot shrink further, whatever the measurement says.
  if (currentPx <= minPx + FIT_EPSILON_PX) {
    return { nextPx: minPx, done: true };
  }
  // Re-estimate proportionally from the CURRENT measurement (not from the original authored
  // size) — this is what corrects for an intercept the first estimate could not see: each pass
  // re-anchors the proportional guess at a point closer to the true (affine, or whatever-shaped)
  // width function, rather than re-deriving the same wrong slope-through-the-origin every time.
  const reestimate = Math.max(minPx, Math.min(currentPx, currentPx * availablePx / measuredPx));
  // Shrink-only, and stop if a pass cannot make meaningful progress — otherwise a width function
  // with its own rounding noise could loop right up to MAX_FIT_PASSES without ever converging
  // cleanly, when the honest answer is "this is as close as re-estimating gets."
  if (currentPx - reestimate < FIT_EPSILON_PX) {
    return { nextPx: reestimate, done: true };
  }
  return { nextPx: reestimate, done: false };
}

/**
 * Resolves `UIElement.fontSizeMin` (authored in `fontSizeUnit`, the same unit as `fontSize`) to
 * a floor in COMPUTED px.
 *
 * The ratio `fontSizeMin / fontSize` is computed in AUTHORED units and then applied to the
 * COMPUTED `authoredPx` — that is what makes a `vh`-authored floor work without a second
 * `getComputedStyle` read: the ratio between two lengths in the same unit is unit-independent,
 * so it survives resolution to px unchanged. This is also why there is deliberately no separate
 * `fontSizeMinUnit` (see `UIElement.ts`) — two units on one pair of fields is a drift trap.
 */
export function resolveMinPx(authoredPx: number, fontSize: number, fontSizeMin: number): number {
  const ratio = fontSizeMin > 0 && fontSize > 0 ? fontSizeMin / fontSize : DEFAULT_AUTOFIT_MIN_RATIO;
  return Math.max(0, Math.min(authoredPx * ratio, authoredPx));
}
