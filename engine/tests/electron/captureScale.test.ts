/** Unit: `fitToMaxSide` — the capture downscale ratio.
 *
 *  This number is the bridge between what an agent SEES (image px) and where it can
 *  CLICK (CSS px). `captureViewport` used to compute it, apply it, and throw it away, so
 *  an agent measuring a button in a 1568px-wide JPEG of a 1600px-wide window was off by
 *  ~2% with no way to know. Now it is returned — and pinned here. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { fitToMaxSide, captureViewport } from '../../electron/rendererOps';

vi.mock('../../plugins/backend/tempFiles', () => ({ pruneOldTempFiles: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual.default, writeFileSync: vi.fn() } };
});

/** A window whose capturePage() yields an image of the given CSS size. `resize` records
 *  what it was asked for and reports that as the new size — i.e. it stands in for the
 *  ENCODER, which is what `captureViewport` deliberately trusts over its own arithmetic. */
function fakeWindow(cssWidth: number, cssHeight: number) {
  const resize = vi.fn();
  const makeImage = (w: number, h: number): Record<string, unknown> => ({
    getSize: () => ({ width: w, height: h }),
    toJPEG: () => Buffer.from(''),
    resize: (o: { width: number; height: number }) => { resize(o); return makeImage(o.width, o.height); },
  });
  const win = { webContents: { capturePage: vi.fn(async () => makeImage(cssWidth, cssHeight)) } };
  return { win: win as unknown as BrowserWindow, resize };
}

describe('fitToMaxSide', () => {
  it('passes a window smaller than the cap through untouched, at scale 1', () => {
    expect(fitToMaxSide(1200, 800, 1568)).toEqual({ width: 1200, height: 800, scale: 1 });
  });

  it('leaves a window exactly at the cap alone (boundary is inclusive)', () => {
    expect(fitToMaxSide(1568, 900, 1568)).toEqual({ width: 1568, height: 900, scale: 1 });
  });

  it('downscales by the LONGEST side, preserving aspect', () => {
    // The real case: a 1600×968 editor window under the default 1568 cap.
    const fit = fitToMaxSide(1600, 968, 1568);
    expect(fit.width).toBe(1568);
    expect(fit.height).toBe(949); // round(968 * 1568/1600) = round(948.6)
    expect(fit.scale).toBeCloseTo(0.98, 5);
    // Aspect preserved to within the rounding of one pixel.
    expect(fit.width / fit.height).toBeCloseTo(1600 / 968, 2);
  });

  it('uses HEIGHT as the longest side for a portrait window', () => {
    const fit = fitToMaxSide(500, 2000, 1000);
    expect(fit).toEqual({ width: 250, height: 1000, scale: 0.5 });
  });

  it('the scale is the number that converts an image pixel back to a CSS pixel', () => {
    // NOT `(cssX * scale) / scale === cssX` — that is an algebraic identity that holds for
    // any scale, including a buggy 1. Pin the scale to the value the geometry demands, then
    // show the naive "just use the image pixel" is off by enough to miss a 14px kebab.
    const cssX = 769;
    const { scale } = fitToMaxSide(1600, 968, 1568);
    expect(scale).toBeCloseTo(1568 / 1600, 6);
    expect(cssX * scale).toBeCloseTo(753.62, 2); // where that button appears in the image
    expect(Math.abs(cssX * scale - cssX)).toBeGreaterThan(14);
  });

  it('never returns a zero dimension for an extreme aspect ratio', () => {
    // A 2000×1 sliver: the height rounds to 0 px, and NativeImage.resize on a
    // zero dimension yields an empty image. Clamp to 1.
    expect(fitToMaxSide(2000, 1, 100)).toMatchObject({ width: 100, height: 1 });
    expect(fitToMaxSide(1, 2000, 100)).toMatchObject({ width: 1, height: 100 });
  });
});

describe('captureViewport', () => {
  // fitToMaxSide being right is worthless if captureViewport doesn't report it. These
  // drive the real function against a fake NativeImage — otherwise dropping cssWidth/
  // cssHeight/scale from the result ships green, which is the whole Phase 3 deliverable.
  beforeEach(() => { vi.clearAllMocks(); });

  it('reports the CSS size it captured and the scale it downscaled by', async () => {
    const { win, resize } = fakeWindow(1600, 968); // the real editor window
    const res = await captureViewport(win);
    expect(res).toMatchObject({ width: 1568, height: 949, cssWidth: 1600, cssHeight: 968 });
    expect(res.scale).toBeCloseTo(0.98, 4);
    expect(resize).toHaveBeenCalledWith(expect.objectContaining({ width: 1568, height: 949 }));
    expect(res.path).toMatch(/modoki-capture-.*\.jpg$/);
  });

  it('scale is derived from the ENCODER\'s final width, not from the raw fit ratio', async () => {
    // These two only diverge when the LONGEST side is the height: then the emitted width
    // is round(cssWidth * scale), and dividing THAT by cssWidth is not the raw fit.scale.
    // The quantized ratio is the correct one — it is what actually maps an image pixel
    // in the file on disk back to a CSS pixel you can tap.
    const { win } = fakeWindow(999, 2000);
    const fit = fitToMaxSide(999, 2000, 100);
    expect(fit).toMatchObject({ width: 50, height: 100 }); // round(999*0.05) = 50
    expect(fit.scale).toBe(0.05);

    const res = await captureViewport(win, { maxSide: 100 });
    expect(res.scale).toBe(50 / 999); // 0.050050…, the emitted-width ratio
    expect(res.scale).not.toBe(fit.scale); // …NOT the raw 0.05
    // The difference is real: at the far edge of the image it is a whole pixel.
    expect(Math.abs(50 / res.scale - 50 / fit.scale)).toBeGreaterThan(0.9);
  });

  it('does not resize at all when the window already fits, and reports scale 1', async () => {
    const { win, resize } = fakeWindow(1200, 800);
    const res = await captureViewport(win);
    expect(resize).not.toHaveBeenCalled();
    expect(res).toMatchObject({ width: 1200, height: 800, cssWidth: 1200, cssHeight: 800, scale: 1 });
  });

  it('survives a zero-width capture (window minimised) instead of dividing by zero', async () => {
    const { win } = fakeWindow(0, 0);
    const res = await captureViewport(win);
    expect(res.scale).toBe(1);
    expect(Number.isNaN(res.scale)).toBe(false);
  });

  it('honours an explicit maxSide, so an agent can capture at full CSS resolution', async () => {
    const { win, resize } = fakeWindow(1600, 968);
    const res = await captureViewport(win, { maxSide: 4000 });
    expect(resize).not.toHaveBeenCalled();
    expect(res).toMatchObject({ width: 1600, cssWidth: 1600, scale: 1 });
  });
});
