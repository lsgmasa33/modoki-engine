/** autoFitText — pure-function tests for the shrink-only auto-fit decision (#614).
 *
 *  Pure-function only, no DOM mounting: jsdom reports every rect as 0x0, so a test that mounted
 *  `UINode` to assert this would assert the mock, not the behaviour (see the issue, and the repo
 *  rule in docs/editor.md § Panels). The DOM measurement side (`UINode.tsx`'s `AutoFitText`) is
 *  exercised live in the editor, not here. */

import { describe, it, expect } from 'vitest';
import {
  fitFontSizePx, refineFontSizePx, resolveMinPx, DEFAULT_AUTOFIT_MIN_RATIO,
  MAX_FIT_PASSES, FIT_EPSILON_PX,
} from '../../src/runtime/ui/autoFitText';

describe('fitFontSizePx', () => {
  it('negative control: text that already fits is unchanged', () => {
    // Without this case, a function that ALWAYS shrinks would still pass every other test below.
    const result = fitFontSizePx({ authoredPx: 24, naturalPx: 100, availablePx: 200, minPx: 12 });
    expect(result).toEqual({ fontSizePx: 24, fits: true, shrunk: false });
  });

  it('shrinks by exactly the width ratio when 20% too wide', () => {
    const authoredPx = 24;
    const naturalPx = 120; // 20% wider than availablePx
    const availablePx = 100;
    const result = fitFontSizePx({ authoredPx, naturalPx, availablePx, minPx: 1 });
    expect(result.shrunk).toBe(true);
    expect(result.fits).toBe(true);
    expect(result.fontSizePx).toBeCloseTo(authoredPx * availablePx / naturalPx, 10);
    expect(result.fontSizePx).toBeCloseTo(20, 10);
  });

  it('clamps at the floor when far too wide, and fits is false', () => {
    const result = fitFontSizePx({ authoredPx: 24, naturalPx: 1000, availablePx: 100, minPx: 10 });
    expect(result.shrunk).toBe(true);
    expect(result.fits).toBe(false);
    expect(result.fontSizePx).toBe(10); // exactly minPx
  });

  it('shrink-only: an availablePx far larger than naturalPx never increases the size', () => {
    const result = fitFontSizePx({ authoredPx: 24, naturalPx: 50, availablePx: 5000, minPx: 12 });
    expect(result).toEqual({ fontSizePx: 24, fits: true, shrunk: false });
  });

  it('epsilon: sub-pixel overflow within FIT_EPSILON_PX does not shrink', () => {
    const result = fitFontSizePx({ authoredPx: 24, naturalPx: 100.3, availablePx: 100, minPx: 1 });
    expect(result).toEqual({ fontSizePx: 24, fits: true, shrunk: false });
  });

  describe('non-measurable inputs never guess: {fontSizePx: authoredPx, fits: true, shrunk: false}', () => {
    // authoredPx stays a realistic, valid measurement (jsdom reports 0x0 rects, so authoredPx
    // is exactly the case that stays sane while naturalPx/availablePx go bad) — this is what
    // proves the guard never INTRODUCES a NaN via a 0/0 or x/Infinity division; it does not
    // claim a caller passing a garbage authoredPx gets a non-garbage answer back (GIGO, covered
    // separately below).
    const cases: Array<[string, { authoredPx: number; naturalPx: number; availablePx: number; minPx: number }]> = [
      ['naturalPx <= 0', { authoredPx: 24, naturalPx: 0, availablePx: 100, minPx: 10 }],
      ['availablePx <= 0', { authoredPx: 24, naturalPx: 120, availablePx: 0, minPx: 10 }],
      ['naturalPx Infinity', { authoredPx: 24, naturalPx: Infinity, availablePx: 100, minPx: 10 }],
      ['naturalPx NaN', { authoredPx: 24, naturalPx: NaN, availablePx: 100, minPx: 10 }],
      ['availablePx NaN', { authoredPx: 24, naturalPx: 120, availablePx: NaN, minPx: 10 }],
      ['availablePx Infinity', { authoredPx: 24, naturalPx: 120, availablePx: Infinity, minPx: 10 }],
    ];
    for (const [label, input] of cases) {
      it(label, () => {
        const result = fitFontSizePx(input);
        expect(result).toEqual({ fontSizePx: 24, fits: true, shrunk: false });
        expect(Number.isNaN(result.fontSizePx)).toBe(false);
      });
    }
  });

  it('a garbage authoredPx (<=0, NaN) is passed through unchanged rather than guessed at', () => {
    for (const authoredPx of [0, -24, NaN]) {
      const result = fitFontSizePx({ authoredPx, naturalPx: 120, availablePx: 100, minPx: 10 });
      expect(result.shrunk).toBe(false);
      expect(result.fits).toBe(true);
      expect(result.fontSizePx).toBe(authoredPx); // toBe uses Object.is, so NaN === NaN here
    }
  });
});

describe('resolveMinPx', () => {
  it('fontSizeMin: 0 resolves to half the authored size (DEFAULT_AUTOFIT_MIN_RATIO)', () => {
    expect(DEFAULT_AUTOFIT_MIN_RATIO).toBe(0.5);
    expect(resolveMinPx(24, 16, 0)).toBe(12);
  });

  it('a vh-authored pair resolves the ratio in authored units, applied to computed px', () => {
    // fontSize: 2.4vh, fontSizeMin: 1.6vh, authoredPx (computed) 24 -> minPx must be 16,
    // proving the floor works without a second getComputedStyle read.
    expect(resolveMinPx(24, 2.4, 1.6)).toBe(16);
  });
});

describe('refineFontSizePx', () => {
  it('non-finite/zero inputs never guess: {nextPx: currentPx, done: true}', () => {
    const cases: Array<[string, { currentPx: number; measuredPx: number; availablePx: number; minPx: number }]> = [
      ['currentPx <= 0', { currentPx: 0, measuredPx: 300, availablePx: 200, minPx: 10 }],
      ['currentPx NaN', { currentPx: NaN, measuredPx: 300, availablePx: 200, minPx: 10 }],
      ['measuredPx <= 0', { currentPx: 20, measuredPx: 0, availablePx: 200, minPx: 10 }],
      ['measuredPx Infinity', { currentPx: 20, measuredPx: Infinity, availablePx: 200, minPx: 10 }],
      ['availablePx <= 0', { currentPx: 20, measuredPx: 300, availablePx: 0, minPx: 10 }],
      ['availablePx NaN', { currentPx: 20, measuredPx: 300, availablePx: NaN, minPx: 10 }],
    ];
    for (const [label, input] of cases) {
      const result = refineFontSizePx(input);
      expect(result, label).toEqual({ nextPx: input.currentPx, done: true });
    }
  });

  it('a floor case where convergence is impossible ends exactly at minPx, done: true', () => {
    // availablePx is tiny — no font size down to the floor makes this fit, so the loop must not
    // spin: it stops the instant currentPx is within FIT_EPSILON_PX of minPx, whatever measuredPx says.
    const result = refineFontSizePx({ currentPx: 21.3, measuredPx: 1000, availablePx: 10, minPx: 21 });
    expect(result).toEqual({ nextPx: 21, done: true });
  });

  it('a pure-proportional width function (intercept 0) converges on the FIRST refine call', () => {
    // width(fs) = 10 * fs exactly — the case fitFontSizePx's proportional model gets EXACTLY
    // right, so the very first measured-at-the-estimate width should already satisfy convergence.
    const k = 10;
    const authoredPx = 40, availablePx = 200, minPx = 10;
    const naturalPx = k * authoredPx; // 400
    const first = fitFontSizePx({ authoredPx, naturalPx, availablePx, minPx });
    expect(first.shrunk).toBe(true);
    expect(first.fontSizePx).toBeCloseTo(20, 10); // 40 * 200 / 400

    const measuredPx = k * first.fontSizePx; // exact width at the estimate
    const refined = refineFontSizePx({ currentPx: first.fontSizePx, measuredPx, availablePx, minPx });
    expect(refined.done).toBe(true);
    expect(refined.nextPx).toBeCloseTo(first.fontSizePx, 10);
  });

  // The real defect, end to end: a width function built from the numbers measured live on
  // games/text_demo's "UI TEXT ANIMATION" (17 chars, 42px, 3px letterSpacing, a 319.59px box) —
  // width = 9.344*fs + 54.46. The 54.46px intercept (mostly 17 * 3px letterSpacing) is exactly
  // what fitFontSizePx's proportional model cannot represent.
  describe('the real games/text_demo case (affine width, non-zero intercept)', () => {
    const AFFINE_SLOPE = 9.344;
    const AFFINE_INTERCEPT = 54.46;
    const affineWidth = (fs: number) => AFFINE_SLOPE * fs + AFFINE_INTERCEPT;

    const authoredPx = 42;
    const availablePx = 319.59;
    const minPx = 21; // the default half-ratio floor
    const naturalPx = affineWidth(authoredPx);

    it('pins the defect: the first estimate (~30.03) still overflows when measured', () => {
      const first = fitFontSizePx({ authoredPx, naturalPx, availablePx, minPx });
      expect(first.shrunk).toBe(true);
      expect(first.fontSizePx).toBeCloseTo(30.03, 1);
      // This is the bug: fitFontSizePx believes 30.03px fits (its own `fits` says so), but the
      // REAL (affine) width at 30.03px is still well past availablePx. Nobody may "simplify" the
      // refine loop away while this assertion holds.
      expect(first.fits).toBe(true);
      const measuredAtFirstEstimate = affineWidth(first.fontSizePx);
      expect(measuredAtFirstEstimate).toBeGreaterThan(availablePx);
      expect(measuredAtFirstEstimate).toBeCloseTo(335.1, 0);
    });

    it('refineFontSizePx converges within MAX_FIT_PASSES to the true (~28.37) fit', () => {
      const first = fitFontSizePx({ authoredPx, naturalPx, availablePx, minPx });
      let currentPx = first.fontSizePx;
      let done = false;
      let passes = 0;
      for (; passes < MAX_FIT_PASSES; passes++) {
        const measuredPx = affineWidth(currentPx);
        const refined = refineFontSizePx({ currentPx, measuredPx, availablePx, minPx });
        currentPx = refined.nextPx;
        done = refined.done;
        if (done) break;
      }
      expect(done).toBe(true);
      expect(passes).toBeLessThan(MAX_FIT_PASSES);
      // Tolerance, not ===: this repo verifies measured/derived numbers with a tolerance band.
      expect(currentPx).toBeCloseTo(28.37, 0);
      expect(Math.abs(currentPx - 28.37)).toBeLessThan(0.6);
      // And the size the loop actually lands on is a genuine fit (within the same epsilon the
      // engine uses everywhere else) — not merely "closer than the first estimate".
      expect(affineWidth(currentPx)).toBeLessThanOrEqual(availablePx + FIT_EPSILON_PX);
    });
  });
});

// `UINode.tsx`'s `fit()` used to feed `fitFontSizePx` an `availablePx` (`contentWidthOf`) that
// mixed a TRANSFORM-AWARE `getBoundingClientRect()` (screen px) with TRANSFORM-BLIND computed
// padding/border (layout px), and a `naturalPx`/`measuredPx`/`finalMeasuredPx` that was pure
// screen-px rect. Exact only when no CSS transform sits between the measured element and its
// reference frame (S=1) — the editor's SceneView/GameView preview frame carries `transform:
// scale(uiScale)`, and `applyRotationStyle` (`anchorCss.ts`) emits `scale()`/`rotate()` on ANY
// UIElement with an authored `rotation`/`scale`, so `S != 1` is routine, not exotic.
// `fitFontSizePx` cannot see this itself — it trusts whatever `availablePx`/`naturalPx` it is
// handed — so this exercises the REAL, unmodified function with the numbers the OLD and NEW DOM
// reads produce, to pin the property the fix relies on: the SAME text in the SAME box must shrink
// to the SAME font size whatever the ancestor CSS scale.
describe('fitFontSizePx — scale invariance across a CSS transform ancestor (the mixed-space defect)', () => {
  // Fixture: the live measurement that found the bug (Chromium 151: a 300px-wide flex parent,
  // 20px padding each side, 2px border each side, a 40px "AUTO FIT LABEL" span) — see
  // `contentwidth-probe.mjs` (pre-fix) / `contentwidth-probe-v2.mjs` (post-fix, the shipped
  // locally-derived-scale approach). `S` is the combined CSS transform scale between the parent
  // and its reference frame.
  const authoredPx = 40;
  const minPx = resolveMinPx(authoredPx, authoredPx, 0); // 20 (DEFAULT_AUTOFIT_MIN_RATIO)

  // Pre-fix `contentWidthOf`/`naturalPx`, measured live at each `S`: `S · borderBoxWidth − pad`
  // for `availablePx` (screen-px rect minus layout-px padding/border) and `S · trueNaturalWidth`
  // for `naturalPx` (pure screen-px rect) — border-box 300px, true natural width 316.453px.
  const preFixMeasurementAt: Record<string, { availablePx: number; naturalPx: number }> = {
    'S=1 (untransformed)': { availablePx: 256, naturalPx: 316.453 },
    'S=0.667 (editor docked-panel scale)': { availablePx: 156.1, naturalPx: 211.074 },
    'S=0.3': { availablePx: 46, naturalPx: 94.936 },
    'S=2': { availablePx: 556, naturalPx: 632.906 },
  };

  it('pins the defect: the pre-fix (mixed-space) measurement is NOT scale invariant', () => {
    // At S=1 the mixed formula is (nearly) exact — this is WHY the bug shipped unnoticed: every
    // earlier measurement of this code happened to run in an untransformed frame.
    const atS1 = fitFontSizePx({ authoredPx, ...preFixMeasurementAt['S=1 (untransformed)'], minPx });
    expect(atS1.fontSizePx).toBeCloseTo(32.36, 1);
    expect(atS1.fits).toBe(true);

    // At the editor's typical docked-panel scale, the SAME text in the SAME box shrinks to a
    // VISIBLY smaller size purely because of the frame's zoom — a rendering the true
    // (scale-invariant) fit would never produce. This is the "shrinks too much" violation
    // `UINode.tsx`'s `AutoFitText` docblock says must never happen.
    const at0667 = fitFontSizePx({ authoredPx, ...preFixMeasurementAt['S=0.667 (editor docked-panel scale)'], minPx });
    expect(at0667.fontSizePx).toBeLessThan(atS1.fontSizePx - 2);

    // At S=0.3 it is not just quantitatively wrong, it changes the OUTCOME: the label floors out
    // at `minPx` and is reported as not fitting at all.
    const at03 = fitFontSizePx({ authoredPx, ...preFixMeasurementAt['S=0.3'], minPx });
    expect(at03.fontSizePx).toBe(minPx);
    expect(at03.fits).toBe(false);

    // At S=2 it swings the other way and UNDER-shrinks relative to the true answer — still "safe"
    // by the shrink-only invariant (a missed shrink, never an overflow this function can see), but
    // still wrong, and in the opposite direction from S<1.
    const at2 = fitFontSizePx({ authoredPx, ...preFixMeasurementAt['S=2'], minPx });
    expect(at2.fontSizePx).toBeGreaterThan(atS1.fontSizePx + 2);
  });

  it('the fix: availablePx/naturalPx still scale WITH S, but their RATIO — and so the fit — does not', () => {
    // Post-fix, `contentWidthOf` derives `scale` LOCALLY (`rectWidth / elem.offsetWidth`) and
    // multiplies it onto just the padding/border before subtracting, so `availablePx` stays a
    // sub-pixel SCREEN-px quantity that scales with `S` exactly the way `naturalPx` (the span's
    // own unchanged rect read) already does — `S · trueContent` and `S · trueNatural` — rather
    // than being forced to a constant. It is their RATIO, fed into `fitFontSizePx`, that stops
    // varying with `S` — see `contentwidth-probe-v2.mjs` for the live measurement this pins:
    // avail/natural pairs at S=1/0.667/0.3/2 all reproduce the SAME true ratio (~1.236,
    // `preFixMeasurementAt`'s own S=1 case) to within the same ~0.14% the untransformed baseline
    // already carried, instead of drifting further from it as `S` moves away from 1.
    const postFixMeasurementAtS: Record<string, { availablePx: number; naturalPx: number }> = {
      'S=1': { availablePx: 256, naturalPx: 316.453 },
      'S=0.667': { availablePx: 170.752, naturalPx: 211.074 },
      'S=0.3': { availablePx: 76.8, naturalPx: 94.936 },
      'S=2': { availablePx: 512, naturalPx: 632.906 },
    };
    const results = Object.values(postFixMeasurementAtS).map((m) =>
      fitFontSizePx({ authoredPx, ...m, minPx }),
    );
    for (const r of results) {
      expect(r.shrunk).toBe(true);
      expect(r.fits).toBe(true);
      // ⚠️ This is an ALGEBRAIC property of `fitFontSizePx` itself, not a DOM measurement: every
      // row above is the S=1 pair multiplied by hand by its own `S` (170.752 = 256×0.667,
      // 211.074 = 316.453×0.667, …) — `fitFontSizePx`'s proportional (ratio-based) model is
      // invariant to scaling BOTH inputs by the same positive constant BY CONSTRUCTION, so this
      // still passes even with `contentWidthOf` (the actual DOM-reading fix, UINode.tsx)
      // hand-reverted to the pre-fix mixed-space expression. What it DOES pin: that
      // `fitFontSizePx` has no hidden non-proportional term (e.g. an additive epsilon) that would
      // break that invariance — a real prerequisite for the fix to work, but not the fix itself.
      // The DOM-level guard is `editor-ui-autofit.spec.ts`'s "AutoFitText scale invariance
      // (contentWidthOf, transform-aware fix)" describe block, which measures a REAL browser's
      // committed font size at a forced non-1 `uiScale` and fails if `contentWidthOf` regresses.
      // The tolerance below is for float precision in the hand-derived numbers above, not
      // measurement noise — there IS none here.
      expect(r.fontSizePx).toBeCloseTo(results[0].fontSizePx, 2);
    }
  });
});
