// @vitest-environment jsdom
/** canvas2DAdaptiveWidth — unit tests for the opt-in `Canvas2D.maxReferenceWidth` adaptive-width
 *  feature (#773/#774): a design box may widen from `referenceWidth` up to `maxReferenceWidth` on
 *  a host wider than the design aspect, so a portrait game stops being pillarboxed on a tablet.
 *  Default OFF (maxRefW 0), so every existing project's output must stay byte-identical — that
 *  regression is the case that matters most below. */

import { describe, it, expect } from 'vitest';

import { computeCanvasScale } from '../../src/runtime/rendering/canvas2DScaler';

describe('computeCanvasScale — maxRefW omitted/0/<=refW is a no-op (regression)', () => {
  const refW = 1080, refH = 1920;
  const hosts: Array<[number, number, string]> = [
    [1080, 1920, 'design aspect'],
    [411, 890, 'taller phone (9:19.5)'],
    [633.48, 907.58, 'tablet (#774)'],
    [1376, 1032, 'landscape'],
  ];

  for (const [actualW, actualH, label] of hosts) {
    for (const mode of ['fitW', 'fitH', 'contain', 'cover', 'fill', 'none'] as const) {
      it(`${mode} on ${label} — omitted maxRefW matches explicit 0 and explicit refW`, () => {
        const base = computeCanvasScale(refW, refH, actualW, actualH, mode);
        const explicitZero = computeCanvasScale(refW, refH, actualW, actualH, mode, 0);
        const explicitEqRefW = computeCanvasScale(refW, refH, actualW, actualH, mode, refW);
        const explicitBelowRefW = computeCanvasScale(refW, refH, actualW, actualH, mode, refW - 100);

        expect(base.refW).toBe(refW);
        for (const cs of [explicitZero, explicitEqRefW, explicitBelowRefW]) {
          expect(cs).toEqual(base);
        }
      });
    }
  }
});

describe('computeCanvasScale — adaptive widening', () => {
  const refW = 1080, refH = 1920;

  it('host at exactly the design aspect stays at refW even with maxRefW set', () => {
    // 540x960 is exactly the 1080:1920 aspect, halved.
    const cs = computeCanvasScale(refW, refH, 540, 960, 'contain', 1440);
    expect(cs.refW).toBe(1080);
    expect(cs.offsetX).toBe(0);
  });

  it('a host TALLER than the design aspect never shrinks below refW (lower clamp bound)', () => {
    // A 9:19.5-ish phone (411x890) is taller/narrower than 1080:1920 — the raw
    // refH*(actualW/actualH) formula would come out UNDER refW here, and the box
    // must clamp back up to refW, never shrink past it.
    const cs = computeCanvasScale(refW, refH, 411, 890, 'contain', 1440);
    expect(cs.refW).toBe(1080);
  });

  it("#774's measured tablet host widens toward the cap under 'contain'", () => {
    // Issue #774: refW 1080, refH 1920, host 633.48x907.58, mode 'contain', maxRefW 1440 —
    // the pillarboxed-tablet repro. effectiveRefW = clamp(1920*(633.48/907.58), 1080, 1440) ≈ 1340.14.
    const cs = computeCanvasScale(refW, refH, 633.48, 907.58, 'contain', 1440);
    expect(Math.abs(cs.refW - 1340.14)).toBeLessThan(0.5);
    expect(Math.abs(cs.offsetX)).toBeLessThan(0.01);
  });

  it('landscape host clamps at maxRefW — pillarbox deliberately returns past the cap', () => {
    const cs = computeCanvasScale(refW, refH, 1376, 1032, 'contain', 1440);
    expect(cs.refW).toBe(1440);
    expect(cs.offsetX).toBeGreaterThan(0);
  });
});

describe('computeCanvasScale — degenerate guard still early-returns, now carrying refW/refH', () => {
  it('returns the caller\'s raw refW/refH for a degenerate input', () => {
    const cs = computeCanvasScale(-100, 200, 400, 800, 'fitW', 1440);
    expect(cs.scale).toBe(1);
    expect(cs.refW).toBe(-100);
    expect(cs.refH).toBe(200);
  });

  it('zero actualH still early-returns (guards the aspect division)', () => {
    const cs = computeCanvasScale(1080, 1920, 400, 0, 'contain', 1440);
    expect(cs.scale).toBe(1);
    expect(cs.refW).toBe(1080);
    expect(cs.refH).toBe(1920);
  });
});
