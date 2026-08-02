/** canvas2DSizing — bounded retry for the initial canvas measurement (F10), plus the pure
 *  backing-size computation Canvas2DMount applies on every measure.
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

import { clampBufferSize, type WebSizing } from './webCanvasSizing';

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

export interface BackingSizeInput {
  /** Container box in CSS px (getBoundingClientRect — already includes any CSS-transform zoom). */
  rectWidth: number;
  rectHeight: number;
  /** window.devicePixelRatio (used when `resolution` is 0). */
  devicePixelRatio: number;
  /** `pixi.resolution` — >0 PINS the backing multiplier, 0 = auto (use devicePixelRatio). */
  resolution: number;
  /** `pixi.pixelRatioCap` — upper bound on the AUTO devicePixelRatio ratio only (issue #55).
   *  A pinned `resolution` above is NEVER capped — capping an explicit pin would make the pin
   *  a lie. Omitted, or **0 / negative**, = uncapped (so existing callers are unchanged, and
   *  the 0 a human types by analogy with `resolution`'s "0 = auto" can't zero the buffer).
   *  Unlike the `web` sizeMode clamp below, this applies to every 2D surface, editor viewports
   *  included — no opt-in flag, matching `three.pixelRatioCap`'s unconditional application. */
  pixelRatioCap?: number;
  /** The project's `rendering.web`, or null for a surface that must ignore sizeMode
   *  (the editor SceneView viewport — it sizes itself and is not the shipped game). */
  web: WebSizing | null;
  /** Uniform cap on the LONGER axis (GPU max-texture guard). Default 8192. */
  maxBacking?: number;
}

/** Compute a Canvas2D slot's backing (drawing-buffer) size from its measured CSS box.
 *
 *  rect → × devicePixelRatio, capped at `pixelRatioCap` on the auto path only (or the
 *  pinned `resolution`, never capped) → optional `max` sizeMode clamp
 *  (device px, so it survives a retina display — see webCanvasSizing.ts) → a uniform
 *  longer-axis cap so an EXTREME editor zoom can't exceed the GPU max-texture size (a Pixi
 *  Application fails to allocate above it; 8192 is safe on desktop GPUs and above any
 *  realistic runtime/GameView backing (dpr × screen), so only extreme zoom bites). The cap
 *  scales BOTH axes by the same factor — a per-axis clamp would stretch the canvas. Pure
 *  (no DOM), so it unit-tests without a browser. */
export function computeBackingSize(input: BackingSizeInput): { w: number; h: number } {
  // Zero guard FIRST — LOAD-BEARING. retrySizeUntilMeasured treats a 0×0 measure as "not
  // yet laid out" and keeps retrying; clampBufferSize floors at 1×1, so clamping a 0×0 box
  // here would return 1×1 and look "measured", permanently defeating the F10 retry.
  if (input.rectWidth <= 0 || input.rectHeight <= 0) return { w: 0, h: 0 };

  // A pinned resolution is an explicit "I want exactly N" — never capped. Only the
  // devicePixelRatio auto-fallback is subject to pixelRatioCap (issue #55).
  // A cap of 0 or less means UNCAPPED, not "ratio 0". This is not defensive padding:
  // `resolution` — the field directly above this one in Project Settings — uses 0 for
  // "auto", so 0 is the value a human actually types here, and nothing validates
  // numeric config (#39). Taken literally it yields a 0×0 backing, which the zero guard
  // above hands to retrySizeUntilMeasured as "not laid out yet" — an endless per-frame
  // retry that then blames a display:none ancestor. A negative cap yields a NEGATIVE
  // backing. Neither is ever what someone meant by a cap.
  const cap = input.pixelRatioCap !== undefined && input.pixelRatioCap > 0
    ? input.pixelRatioCap
    : Infinity;
  const ratio = input.resolution > 0
    ? input.resolution
    : Math.min(input.devicePixelRatio || 1, cap);
  // rect is post-CSS-transform, so it already includes the editor zoom → backing = rect ×
  // ratio is 1:1 with device pixels (crisp at any zoom).
  let w = input.rectWidth * ratio;
  let h = input.rectHeight * ratio;

  if (input.web) {
    ({ width: w, height: h } = clampBufferSize(w, h, input.web));
  }

  const maxBacking = input.maxBacking ?? 8192;
  const longest = Math.max(w, h);
  if (longest > maxBacking) {
    const k = maxBacking / longest;
    w *= k;
    h *= k;
  }

  return { w: Math.round(w), h: Math.round(h) };
}
