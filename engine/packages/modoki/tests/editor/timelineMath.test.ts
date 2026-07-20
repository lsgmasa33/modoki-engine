/** Timeline coordinate math — frame snapping, key-time clamping, ruler ticks. */

import { describe, it, expect } from 'vitest';
import {
  snapToFrame, clampKeyTime, KEY_TIME_EPS, rulerTicks,
  timeToX, xToTime, TRACK_PAD_LEFT, fitPxPerSec, clampViewStart, resolveView,
  zoomViewport, panViewport, DEFAULT_VIEWPORT, MAX_TIMELINE_ZOOM,
  chooseTickInterval, frameToTime, timeToFrame, visibleSpan,
} from '../../src/editor/panels/animation/timelineMath';

describe('snapToFrame', () => {
  it('snaps to the nearest frame', () => {
    expect(snapToFrame(0.123, 60)).toBeCloseTo(7 / 60); // frame 7.38 → 7
    expect(snapToFrame(0.5, 30)).toBeCloseTo(0.5);
  });
  it('passes through when frameRate <= 0', () => {
    expect(snapToFrame(0.123, 0)).toBe(0.123);
  });
});

describe('clampKeyTime', () => {
  const keys = [{ t: 0 }, { t: 0.5 }, { t: 1 }];

  it('clamps strictly between neighbors', () => {
    // Middle key cannot pass either neighbor (minus the epsilon gap).
    expect(clampKeyTime(keys, 1, 9)).toBeCloseTo(1 - KEY_TIME_EPS);
    expect(clampKeyTime(keys, 1, -9)).toBeCloseTo(0 + KEY_TIME_EPS);
    expect(clampKeyTime(keys, 1, 0.4)).toBeCloseTo(0.4); // inside → unchanged
  });

  it('clamps the first key to >= 0', () => {
    expect(clampKeyTime(keys, 0, -3)).toBe(0);
  });

  it('lets the last key go to the provided max (default Infinity)', () => {
    expect(clampKeyTime(keys, 2, 5)).toBe(5);          // no upper bound
    expect(clampKeyTime(keys, 2, 5, 2)).toBe(2);       // bounded by max
  });
});

describe('rulerTicks', () => {
  it('covers [0, duration] without drifting past the end (index-based)', () => {
    const ticks = rulerTicks(1, 640); // pxPerSec 640 → 0.1s step
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(1);
    // No float drift: every tick is a clean multiple of the step.
    for (const t of ticks) expect(Math.round(t * 10) / 10).toBeCloseTo(t);
  });

  it('limits ticks to a visible window when given one (zoomed view)', () => {
    // Window [0.4, 0.6] at a fine step — no tick below 0.4 or above 0.6.
    const ticks = rulerTicks(1, 640, 64, 0.4, 0.6);
    expect(ticks[0]).toBeGreaterThanOrEqual(0.4 - 1e-6);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(0.6 + 1e-6);
    expect(ticks.length).toBeGreaterThan(0);
  });
});

describe('tick interval + frame/time conversions', () => {
  it('chooseTickInterval picks the smallest candidate whose px width >= minPx', () => {
    // pxPerSec 640, minPx 64 → targetSec 0.1 → smallest candidate >= 0.1 is 0.1.
    expect(chooseTickInterval(640, 64)).toBe(0.1);
    // pxPerSec 6400 → targetSec 0.01 → 0.01.
    expect(chooseTickInterval(6400, 64)).toBe(0.01);
  });
  it('chooseTickInterval clamps to the largest candidate at extreme zoom-out', () => {
    // Tiny pxPerSec → targetSec huge → no candidate >= it → return the largest (60).
    expect(chooseTickInterval(0.001, 64)).toBe(60);
  });
  it('frameToTime returns 0 when frameRate <= 0', () => {
    expect(frameToTime(30, 0)).toBe(0);
    expect(frameToTime(30, 60)).toBeCloseTo(0.5, 6);
  });
  it('timeToFrame rounds to the nearest frame', () => {
    expect(timeToFrame(0.126, 60)).toBe(8); // 7.56 → 8
  });
  it('visibleSpan is the track-area width in seconds', () => {
    // width 808, pad 8 each side → 792px / 198px per s = 4s.
    expect(visibleSpan(198, 808)).toBeCloseTo(4, 6);
  });
});

describe('timeToX / xToTime with viewStart', () => {
  it('offsets by viewStart and round-trips', () => {
    const view = { originX: 8, pxPerSec: 100, viewStart: 0.5 };
    // t = viewStart sits at originX; t = viewStart + 1s is 100px right.
    expect(timeToX(0.5, view)).toBeCloseTo(8);
    expect(timeToX(1.5, view)).toBeCloseTo(108);
    expect(xToTime(108, view)).toBeCloseTo(1.5);
  });
  it('treats a missing viewStart as 0 (backwards compatible)', () => {
    const view = { originX: TRACK_PAD_LEFT, pxPerSec: 10 };
    expect(xToTime(TRACK_PAD_LEFT + 50, view)).toBeCloseTo(5);
  });
});

describe('viewport zoom / pan', () => {
  const W = 808, D = 4; // fit: (808-16)/4 = 198 px/s at zoom 1

  it('fitPxPerSec fits the clip into the track area', () => {
    expect(fitPxPerSec(W, D)).toBeCloseTo(198);
  });

  it('clampViewStart keeps the window within [0, duration]', () => {
    const px = fitPxPerSec(W, D) * 2; // zoomed 2× → visible span = D/2 = 2s
    expect(clampViewStart(-1, px, W, D)).toBe(0);
    expect(clampViewStart(99, px, W, D)).toBeCloseTo(2); // maxStart = 4 - 2
  });

  it('zoom in keeps the time under the cursor fixed', () => {
    const cursorX = TRACK_PAD_LEFT + 396; // halfway → t = 2s at zoom 1
    const before = xToTime(cursorX, resolveView(DEFAULT_VIEWPORT, W, D));
    const vp = zoomViewport(DEFAULT_VIEWPORT, cursorX, -1, W, D); // scroll up = zoom in
    expect(vp.zoom).toBeCloseTo(1.1);
    const after = xToTime(cursorX, resolveView(vp, W, D));
    expect(after).toBeCloseTo(before, 4);
  });

  it('zoom clamps to [1, MAX] and snaps back to viewStart 0 at zoom 1', () => {
    let vp = { zoom: 1.05, viewStart: 1 };
    vp = zoomViewport(vp, TRACK_PAD_LEFT + 100, 1, W, D); // zoom out
    expect(vp.zoom).toBe(1);
    expect(vp.viewStart).toBe(0);
    // Cannot exceed MAX.
    let hi = { zoom: MAX_TIMELINE_ZOOM, viewStart: 0 };
    hi = zoomViewport(hi, TRACK_PAD_LEFT + 100, -1, W, D);
    expect(hi.zoom).toBe(MAX_TIMELINE_ZOOM);
  });

  it('pan shifts viewStart opposite the drag and clamps', () => {
    const zoomed = { zoom: 2, viewStart: 1 };
    const px = fitPxPerSec(W, D) * 2;
    // Drag right by px/s worth → viewStart decreases by 1s, clamped at 0.
    const panned = panViewport(zoomed, 1, px, W, D);
    expect(panned.viewStart).toBe(0);
    // Drag left pushes toward the end, clamped at maxStart (2s).
    const panned2 = panViewport(zoomed, 1, -px * 10, W, D);
    expect(panned2.viewStart).toBeCloseTo(2);
  });
});
