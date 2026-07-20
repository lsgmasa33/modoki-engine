/** canvas2DSizing — bounded retry for the initial canvas measurement (F10).
 *
 *  Canvas2DMount measures its container once on mount and resizes the pooled canvas to
 *  match. If `getBoundingClientRect()` returns 0×0 at that instant — common mid-layout or
 *  during an enter transition — the pool slot stays 1×1 and `renderAll` skips it (treats
 *  ≤1px as "not yet sized"), leaving a blank canvas. A `ResizeObserver` eventually
 *  corrects a box that later becomes non-zero, but: (a) there's a blank window until it
 *  fires, and (b) it never fires for an element whose box is ALWAYS zero (a `display:none`
 *  / detached ancestor) — silently no-rendering 2D content with no signal to the dev.
 *
 *  This helper measures, and if unsized, retries each animation frame until the element
 *  has a real box (apply size, done) or `maxFrames` is exhausted (warn once — a persistent
 *  0×0 means a hidden/detached ancestor). Kept pure + dependency-injected so it unit-tests
 *  without a DOM. */

export interface SizeRetryDeps {
  /** Measure the target's current pixel size (DPR-scaled). */
  measure: () => { w: number; h: number };
  /** Apply a valid (>0) measured size — e.g. pool.resize + markScene2DDirty. */
  applySize: (w: number, h: number) => void;
  /** Schedule a callback for the next frame; returns a cancel handle (requestAnimationFrame). */
  scheduleFrame: (cb: () => void) => number;
  /** Cancel a scheduled frame (cancelAnimationFrame). */
  cancelFrame: (handle: number) => void;
  /** Invoked once if the element is still 0×0 after `maxFrames` retries. */
  warn: (frames: number) => void;
  /** Max retry frames before giving up + warning. Default 120 (~2s at 60fps). */
  maxFrames?: number;
}

/** Measure now; retry per frame while the box is 0×0, up to maxFrames, then warn once.
 *  Returns a cancel function — call it on unmount to stop any pending retry. */
export function retrySizeUntilMeasured(deps: SizeRetryDeps): () => void {
  const max = deps.maxFrames ?? 120;
  let handle: number | null = null;
  let cancelled = false;
  let frames = 0;

  const attempt = () => {
    if (cancelled) return;
    const { w, h } = deps.measure();
    if (w > 0 && h > 0) {
      deps.applySize(w, h);   // got a real box → size it, stop retrying
      return;
    }
    frames++;
    if (frames >= max) {
      deps.warn(frames);      // gave up — persistent 0×0 (hidden/detached ancestor)
      return;
    }
    handle = deps.scheduleFrame(attempt);
  };

  attempt();

  return () => {
    cancelled = true;
    if (handle !== null) { deps.cancelFrame(handle); handle = null; }
  };
}
