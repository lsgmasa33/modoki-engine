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
