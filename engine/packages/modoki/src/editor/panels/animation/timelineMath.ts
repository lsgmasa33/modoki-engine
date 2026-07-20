/** Pure timeline coordinate math for the Animation Editor (time↔px, frame snapping).
 *  Kept separate so the Dopesheet/Curves views share one source of truth + it's testable. */

/** Height of a single property/track row (left list + timeline must match). */
export const ROW_H = 22;
/** Height of the time-ruler header above the timeline tracks. */
export const RULER_H = 22;
/** Left gutter inside the timeline track area (so t=0 isn't flush to the edge). */
export const TRACK_PAD_LEFT = 8;

export interface TimelineView {
  /** Pixel x of `viewStart` within the timeline track area. */
  originX: number;
  /** Pixels per second. */
  pxPerSec: number;
  /** Time (seconds) shown at `originX` — the left edge of the visible window.
   *  Omitted / 0 means the window starts at t=0 (the unzoomed default). */
  viewStart?: number;
}

export function timeToX(t: number, view: TimelineView): number {
  return view.originX + (t - (view.viewStart ?? 0)) * view.pxPerSec;
}

export function xToTime(x: number, view: TimelineView): number {
  return (view.viewStart ?? 0) + (x - view.originX) / view.pxPerSec;
}

// ── Viewport (shared zoom/pan across the Dopesheet + Curves views) ──
//
// The horizontal viewport is expressed WIDTH-INDEPENDENTLY as `{ zoom, viewStart }`
// so it can be shared between the two views (which measure their own width) and
// survive a view switch: zoom = 1 ALWAYS means "fit the whole clip to the panel
// width" regardless of the current width, and `viewStart` (seconds) is the left
// edge. pxPerSec is then `fitPxPerSec(width) * zoom`. Mirrors SceneView's input
// convention (wheel = zoom toward cursor, right-drag = pan) but implemented as a
// coordinate transform (above) rather than a CSS `scale()`, so keyframe glyphs,
// text, and tangent handles stay a constant on-screen size at any zoom.

export interface Viewport {
  /** Horizontal zoom multiplier. 1 = fit-to-width; clamped to [1, MAX_TIMELINE_ZOOM]. */
  zoom: number;
  /** Left-edge time in seconds. Forced to 0 when zoom === 1. */
  viewStart: number;
}

export const DEFAULT_VIEWPORT: Viewport = { zoom: 1, viewStart: 0 };
export const MAX_TIMELINE_ZOOM = 400;

/** Pixels-per-second at zoom 1 (the whole clip fit into the track area). */
export function fitPxPerSec(width: number, duration: number): number {
  return Math.max(1, (width - TRACK_PAD_LEFT * 2) / Math.max(0.001, duration));
}

/** The visible time span (seconds) for a given pxPerSec + width. */
export function visibleSpan(pxPerSec: number, width: number): number {
  return (width - TRACK_PAD_LEFT * 2) / pxPerSec;
}

/** Clamp a proposed left-edge time so the window stays within [0, duration]. */
export function clampViewStart(viewStart: number, pxPerSec: number, width: number, duration: number): number {
  const maxStart = Math.max(0, duration - visibleSpan(pxPerSec, width));
  return Math.max(0, Math.min(maxStart, viewStart));
}

/** Build the concrete `TimelineView` (originX/pxPerSec/viewStart) for a viewport,
 *  re-clamping `viewStart` to the current width/duration (so a width shrink or a
 *  duration edit can't strand the window past the end). */
export function resolveView(vp: Viewport, width: number, duration: number): TimelineView {
  const pxPerSec = fitPxPerSec(width, duration) * vp.zoom;
  return { originX: TRACK_PAD_LEFT, pxPerSec, viewStart: clampViewStart(vp.viewStart, pxPerSec, width, duration) };
}

/** Wheel-zoom about a cursor position (local px). Keeps the time under the cursor
 *  fixed (SceneView convention); `deltaY < 0` (scroll up) zooms in. Returns the new
 *  viewport. Snaps back to `viewStart = 0` when fully zoomed out (zoom === 1). */
export function zoomViewport(vp: Viewport, cursorLocalX: number, deltaY: number, width: number, duration: number): Viewport {
  const fit = fitPxPerSec(width, duration);
  const oldPx = fit * vp.zoom;
  const cursorTime = (vp.zoom === 1 ? 0 : vp.viewStart) + (cursorLocalX - TRACK_PAD_LEFT) / oldPx;
  const factor = deltaY < 0 ? 1.1 : 1 / 1.1;
  const zoom = Math.min(Math.max(vp.zoom * factor, 1), MAX_TIMELINE_ZOOM);
  if (zoom === 1) return { zoom: 1, viewStart: 0 };
  const newPx = fit * zoom;
  const viewStart = clampViewStart(cursorTime - (cursorLocalX - TRACK_PAD_LEFT) / newPx, newPx, width, duration);
  return { zoom, viewStart };
}

/** Pan by a pixel delta from a drag. `baseViewStart` is the left edge captured at
 *  drag start; positive `dxPx` (drag right) moves content right → earlier viewStart. */
export function panViewport(vp: Viewport, baseViewStart: number, dxPx: number, width: number, duration: number): Viewport {
  const px = fitPxPerSec(width, duration) * vp.zoom;
  return { ...vp, viewStart: clampViewStart(baseViewStart - dxPx / px, px, width, duration) };
}

/** Snap a time to the nearest frame given the clip frame rate. */
export function snapToFrame(t: number, frameRate: number): number {
  if (frameRate <= 0) return t;
  return Math.round(t * frameRate) / frameRate;
}

/** Smallest gap (seconds) kept between a key and its neighbors when clamping a
 *  dragged/edited time, so keys stay strictly ordered without collapsing. */
export const KEY_TIME_EPS = 1e-4;

/** Clamp a proposed time for `keys[i]` to strictly between its neighbors (or the
 *  [0, max] bounds at the ends). Single source of truth for key drag/edit time
 *  clamping — keeps the Curves drag and the numeric frame field consistent. */
export function clampKeyTime(keys: { t: number }[], i: number, t: number, max = Number.POSITIVE_INFINITY): number {
  const lo = keys[i - 1] ? keys[i - 1].t + KEY_TIME_EPS : 0;
  const hi = keys[i + 1] ? keys[i + 1].t - KEY_TIME_EPS : max;
  return Math.max(lo, Math.min(hi, t));
}

export function timeToFrame(t: number, frameRate: number): number {
  return Math.round(t * frameRate);
}

export function frameToTime(frame: number, frameRate: number): number {
  return frameRate > 0 ? frame / frameRate : 0;
}

/** Choose a "nice" tick interval (in seconds) so labels are ~`minPx` apart. */
export function chooseTickInterval(pxPerSec: number, minPx = 64): number {
  const targetSec = minPx / pxPerSec;
  const candidates = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  for (const c of candidates) if (c >= targetSec) return c;
  return candidates[candidates.length - 1];
}

/** Generate ruler tick times at the chosen interval. When a visible window
 *  [`startT`, `endT`] is given (a zoomed/panned view), ticks are limited to it —
 *  otherwise the whole clip [0, duration] is used. Limiting to the window keeps the
 *  tick count bounded no matter how far the timeline is zoomed in. */
export function rulerTicks(duration: number, pxPerSec: number, minPx = 64, startT = 0, endT = duration): number[] {
  const step = chooseTickInterval(pxPerSec, minPx);
  const ticks: number[] = [];
  const lo = Math.max(0, startT);
  const hi = Math.min(duration, endT);
  // Index-based (n*step) instead of accumulating += step, so float error doesn't
  // drift the final tick in/out of range over a long duration.
  for (let n = Math.floor(lo / step); n * step <= hi + 1e-6; n++) {
    const t = Math.round(n * step * 1000) / 1000;
    if (t >= lo - 1e-6) ticks.push(t);
  }
  return ticks;
}
