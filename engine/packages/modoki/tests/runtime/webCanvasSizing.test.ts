import { describe, it, expect } from 'vitest';
import { computeContainerBox, clampBufferSize, type WebSizing } from '../../src/runtime/rendering/webCanvasSizing';

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
});

describe('clampBufferSize', () => {
  it('free passes through unchanged', () => {
    expect(clampBufferSize(1920, 1080, web({ sizeMode: 'free' }))).toEqual({ width: 1920, height: 1080 });
  });

  it('fixed passes through unchanged (its CSS size is the render size)', () => {
    expect(clampBufferSize(1600, 900, web({ sizeMode: 'fixed' }))).toEqual({ width: 1600, height: 900 });
  });

  it('max clamps a larger buffer down to the target, aspect preserved', () => {
    // 2560x1440 css, cap 1280x720 → scale 0.5.
    expect(clampBufferSize(2560, 1440, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 1280, height: 720 });
  });

  it('max does not upscale a buffer already under the cap', () => {
    expect(clampBufferSize(800, 600, web({ sizeMode: 'max', width: 1280, height: 720 })))
      .toEqual({ width: 800, height: 600 });
  });
});
