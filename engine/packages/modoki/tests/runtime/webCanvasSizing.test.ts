import { describe, it, expect } from 'vitest';
import { computeContainerBox, clampBufferSize, clampPixelRatio, basePixelRatio, type WebSizing } from '../../src/runtime/rendering/webCanvasSizing';

const web = (o: Partial<WebSizing>): WebSizing => ({ sizeMode: 'free', width: 1280, height: 720, ...o });

describe('computeContainerBox', () => {
  it('free fills the viewport, no letterbox', () => {
    expect(computeContainerBox(1920, 1080, web({ sizeMode: 'free' })))
      .toEqual({ cssWidth: 1920, cssHeight: 1080, letterboxed: false });
  });

  it('max fills the viewport at the container level (buffer clamped elsewhere)', () => {
    expect(computeContainerBox(1920, 1080, web({ sizeMode: 'max' })))
      .toEqual({ cssWidth: 1920, cssHeight: 1080, letterboxed: false });
  });

  it('fixed letterboxes vertically when viewport is wider than target aspect', () => {
    // 16:9 target (1280x720) into a 21:9-ish 2100x900 viewport → limited by height.
    const box = computeContainerBox(2100, 900, web({ sizeMode: 'fixed' }));
    expect(box.cssHeight).toBe(900);
    expect(box.cssWidth).toBe(1600); // 1280 * (900/720)
    expect(box.letterboxed).toBe(true);
  });

  it('fixed letterboxes horizontally when viewport is taller than target aspect', () => {
    const box = computeContainerBox(640, 900, web({ sizeMode: 'fixed', width: 1280, height: 720 }));
    expect(box.cssWidth).toBe(640);
    expect(box.cssHeight).toBe(360); // 720 * (640/1280)
    expect(box.letterboxed).toBe(true);
  });

  it('fixed with a viewport exactly matching the aspect is not letterboxed', () => {
    const box = computeContainerBox(1280, 720, web({ sizeMode: 'fixed' }));
    expect(box).toEqual({ cssWidth: 1280, cssHeight: 720, letterboxed: false });
  });

  it('fixed with zero target dims falls back to free', () => {
    expect(computeContainerBox(800, 600, web({ sizeMode: 'fixed', width: 0, height: 0 })))
      .toEqual({ cssWidth: 800, cssHeight: 600, letterboxed: false });
  });

  it('fixed with only ONE dim cleared still falls back to free (not a divide-by-zero box)', () => {
    // Reachable from the UI: the Width/Height number fields can be emptied to 0
    // independently. Either alone must take the same escape hatch — computing with a 0
    // would give scale 0 (a zero-size container) or Infinity.
    for (const dims of [{ width: 0, height: 720 }, { width: 1280, height: 0 }, { width: -1, height: 720 }]) {
      expect(computeContainerBox(800, 600, web({ sizeMode: 'fixed', ...dims })))
        .toEqual({ cssWidth: 800, cssHeight: 600, letterboxed: false });
    }
  });

  it('fits a PORTRAIT target into a landscape viewport — the shipped games/sling case', () => {
    // Pins the numbers measured live on the real sling web build (viewport 1664×1174,
    // target 1080×1920): height-limited, bars either side, aspect within a pixel of 9:16.
    const box = computeContainerBox(1664, 1174, web({ sizeMode: 'fixed', width: 1080, height: 1920 }));
    expect(box).toEqual({ cssWidth: 660, cssHeight: 1174, letterboxed: true });
    expect(box.cssWidth / box.cssHeight).toBeCloseTo(1080 / 1920, 3);
  });

  it('never returns a box larger than the viewport (a 1px overflow would add a scrollbar)', () => {
    for (const [vw, vh] of [[1664, 1174], [1000, 1000], [321, 777], [1920, 1080], [100, 100]]) {
      for (const target of [{ width: 1080, height: 1920 }, { width: 1280, height: 720 }, { width: 100, height: 100 }]) {
        const box = computeContainerBox(vw, vh, web({ sizeMode: 'fixed', ...target }));
        expect(box.cssWidth).toBeLessThanOrEqual(vw);
        expect(box.cssHeight).toBeLessThanOrEqual(vh);
      }
    }
  });
});

// clampBufferSize's inputs are DEVICE-PIXEL buffer sizes (already DPR/resolution-multiplied),
// NOT CSS pixels — the caller (Scene3D / canvas2DSizing.computeBackingSize) does that
// multiplication before calling in. The math itself is unchanged; only the unit these
// numbers represent changed (#38 — clamping CSS px alone was a no-op on a retina display,
// since three/Pixi re-multiply by DPR after the clamp).
describe('clampBufferSize', () => {
  it('free passes through unchanged', () => {
    expect(clampBufferSize(1920, 1080, web({ sizeMode: 'free' }))).toEqual({ width: 1920, height: 1080 });
  });

  it('fixed passes through unchanged (its buffer size is already the render size)', () => {
    expect(clampBufferSize(1600, 900, web({ sizeMode: 'fixed' }))).toEqual({ width: 1600, height: 900 });
  });

  it('max clamps a larger buffer down to the target, aspect preserved', () => {
    // 2560x1440 device-px buffer, cap 1280x720 → scale 0.5.
    expect(clampBufferSize(2560, 1440, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 1280, height: 720 });
  });

  it('max does not upscale a buffer already under the cap', () => {
    expect(clampBufferSize(800, 600, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 800, height: 600 });
  });

  it('max shrinks BOTH axes when only one exceeds the cap — aspect is preserved, not clamped per-axis', () => {
    // 2560×400 device-px buffer under a 1280×720 cap: width is 2× over, height is well
    // under. Scaling uniformly by 0.5 takes the height to 200 even though 400 already fit.
    // That is correct — a per-axis clamp would squash the image — so pin it against a "fix".
    expect(clampBufferSize(2560, 400, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 1280, height: 200 });
  });

  it('max never returns a zero dimension for an unmeasured (0×0) canvas', () => {
    // A canvas measured before layout is 0×0; passing 0 to renderer.setSize is a
    // WebGPU/WebGL error, so the floor of 1 is load-bearing, not cosmetic.
    expect(clampBufferSize(0, 0, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 1, height: 1 });
    const thin = clampBufferSize(2560, 0, web({ sizeMode: 'max', width: 1280, height: 720 }));
    expect(thin.width).toBeGreaterThanOrEqual(1);
    expect(thin.height).toBeGreaterThanOrEqual(1);
  });

  it('max with zero target dims passes through (same escape hatch as fixed)', () => {
    expect(clampBufferSize(2560, 1440, web({ sizeMode: 'max', width: 0, height: 720 })))
      .toEqual({ width: 2560, height: 1440 });
  });
});

/** clampPixelRatio is how the 3D layer reaches the `max` buffer: three computes
 *  canvas.width = floor(cssW × pixelRatio), so the clamp has to ride on the RATIO —
 *  shrinking the CSS size instead is what made `max` a no-op on retina (#38). */
describe('clampPixelRatio', () => {
  it('free returns the base ratio untouched — the pre-clamp setSize path', () => {
    expect(clampPixelRatio(1000, 1000, 2, web({ sizeMode: 'free' }))).toBe(2);
  });

  it('fixed returns the base ratio untouched (its CSS size is already the render size)', () => {
    expect(clampPixelRatio(1000, 1000, 2, web({ sizeMode: 'fixed' }))).toBe(2);
  });

  it('max scales the ratio so the DEVICE buffer lands on the cap', () => {
    // 1000×1000 css × base 2 = a 2000×2000 device buffer; cap 500×500 → scale 0.25.
    // Ratio 0.5 reproduces it through three's own math: floor(1000 × 0.5) = 500.
    expect(clampPixelRatio(1000, 1000, 2, web({ sizeMode: 'max', width: 500, height: 500 }))).toBe(0.5);
    expect(Math.floor(1000 * 0.5)).toBe(500);
  });

  it('max clamps on the BINDING axis, so the other axis stays under the cap', () => {
    // 1000×2000 css × base 1 → 1000×2000 device. Cap 900×900: height binds (900/2000
    // = 0.45 < 900/1000), so the ratio is 0.45 and the width lands at 450, not 900.
    const pr = clampPixelRatio(1000, 2000, 1, web({ sizeMode: 'max', width: 900, height: 900 }));
    expect(pr).toBeCloseTo(0.45, 10);
    expect(Math.floor(1000 * pr)).toBe(450);
    expect(Math.floor(2000 * pr)).toBe(900);
  });

  it('never UPSCALES — a buffer already under the cap keeps the base ratio', () => {
    expect(clampPixelRatio(500, 500, 2, web({ sizeMode: 'max', width: 4000, height: 4000 }))).toBe(2);
  });

  it('converges rather than ratcheting — re-clamping an already-clamped ratio is a no-op', () => {
    // A buffer sitting exactly ON the cap clamps to itself, so repeated resizes at an
    // unchanged container size are stable even if the ratio were fed back in.
    const m = web({ sizeMode: 'max', width: 500, height: 500 });
    const once = clampPixelRatio(1000, 1000, 2, m);
    expect(clampPixelRatio(1000, 1000, 2, m)).toBe(once);
    expect(clampPixelRatio(1000, 1000, once, m)).toBe(once);
  });

  it('but a ratio read back off the renderer cannot RECOVER when the container shrinks', () => {
    // THE reason Scene3D recomputes basePR from devicePixelRatio every resize instead of
    // calling renderer.getPixelRatio(). At 1000×1000 the cap forces the ratio down to 0.5.
    // If the container then shrinks to 500×500, the correct ratio climbs back to 1.0 (the
    // buffer is 500×500 either way) — but a stale 0.5 leaves it at 250×250, a quarter of
    // the pixels, with nothing to signal the loss.
    const m = web({ sizeMode: 'max', width: 500, height: 500 });
    const clamped = clampPixelRatio(1000, 1000, 2, m);
    expect(clamped).toBe(0.5);
    expect(clampPixelRatio(500, 500, 2, m)).toBe(1);          // recomputed base → correct
    expect(clampPixelRatio(500, 500, clamped, m)).toBe(0.5);  // stale base → under-renders
  });

  it('returns the base ratio for a 0-sized container instead of dividing by zero', () => {
    const m = web({ sizeMode: 'max', width: 500, height: 500 });
    expect(clampPixelRatio(0, 600, 2, m)).toBe(2);
    expect(clampPixelRatio(600, 0, 2, m)).toBe(2);
  });
});

/** basePixelRatio is the UNCLAMPED base both 3D sites must agree on — the renderer's first
 *  buffer (makeWebGPURenderer) and Scene3D's ResizeObserver. It exists as one function
 *  precisely so they cannot drift; #56 pinned that they agree, this pins what they agree ON. */
describe('basePixelRatio', () => {
  it('caps devicePixelRatio at the configured cap', () => {
    expect(basePixelRatio(3, 2)).toBe(2);
  });

  it('passes through a dpr already under the cap', () => {
    expect(basePixelRatio(1, 2)).toBe(1);
  });

  /** Same rule as canvas2DSizing's pixelRatioCap, and for the same reason: numeric config is
   *  unvalidated (#39), and a literal ratio of 0 means a 0×0 drawing buffer — a blank canvas,
   *  never what a "cap" was meant to express. */
  it('treats a cap of 0 or less as UNCAPPED, not as ratio 0', () => {
    expect(basePixelRatio(3, 0)).toBe(3);
    expect(basePixelRatio(3, -1)).toBe(3);
  });

  it('falls back to 1 for a non-positive devicePixelRatio (jsdom / detached window)', () => {
    expect(basePixelRatio(0, 2)).toBe(1);
    expect(basePixelRatio(NaN, 2)).toBe(1);
  });
});
