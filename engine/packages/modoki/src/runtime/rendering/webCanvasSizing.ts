/** webCanvasSizing — pure geometry for the shipped web build's `rendering.web.sizeMode`.
 *
 *  Applies ONLY to the standalone/shipped web game's layer container (App.tsx
 *  `.game-wrapper`) — NOT the editor viewport (which sizes itself / uses device
 *  presets). Three modes (see project-config `rendering.web`):
 *   - `free`  → the container fills the viewport; renderers use the full buffer.
 *   - `fixed` → the container is letterboxed to the width×height ASPECT, centred,
 *               with bars around it; renderers fill that (smaller) container.
 *   - `max`   → the container fills the viewport, but each renderer's DRAWING
 *               BUFFER is clamped to at most width×height AFTER devicePixelRatio —
 *               so `max: 1920×1080` means a literal ≤1920×1080 buffer on EVERY
 *               device, retina included (CSS still fills, so the clamped buffer
 *               upscales — saves fill-rate on a 4K/retina display). Applies to the
 *               3D layer (makeWebGPURenderer's FIRST buffer, then Scene3D's
 *               ResizeObserver) and the 2D layer (Canvas2DMount), opt-in per
 *               surface so the editor viewports are excluded.
 *
 *  Kept pure (no DOM) so it's unit-testable; callers apply the returned numbers.
 *  `computeContainerBox` is App.tsx-only (the shipped shell's letterbox container). */

export interface WebSizing {
  sizeMode: 'free' | 'fixed' | 'max';
  width: number;
  height: number;
}

export interface ContainerBox {
  /** CSS pixel size for the layer container. */
  cssWidth: number;
  cssHeight: number;
  /** True when the container is smaller than the viewport (letterbox bars show). */
  letterboxed: boolean;
}

/** Container CSS size for a viewport. `fixed` fits the width×height aspect inside
 *  the viewport (contain); `free`/`max` fill it. Never upscales past the viewport. */
export function computeContainerBox(
  viewportW: number,
  viewportH: number,
  web: WebSizing,
): ContainerBox {
  if (web.sizeMode !== 'fixed' || web.width <= 0 || web.height <= 0) {
    return { cssWidth: viewportW, cssHeight: viewportH, letterboxed: false };
  }
  const scale = Math.min(viewportW / web.width, viewportH / web.height);
  const cssWidth = Math.round(web.width * scale);
  const cssHeight = Math.round(web.height * scale);
  return {
    cssWidth,
    cssHeight,
    letterboxed: cssWidth < viewportW - 0.5 || cssHeight < viewportH - 0.5,
  };
}

/** Clamp a renderer drawing-buffer size for `max` mode (≤ width×height, aspect
 *  preserved). Takes the DEVICE-PIXEL buffer the renderer would otherwise use
 *  (i.e. already multiplied by devicePixelRatio / resolution) and returns the
 *  clamped buffer — NOT CSS pixels, so the clamp survives a retina display
 *  instead of being re-multiplied by DPR after the fact. `free`/`fixed` pass
 *  through unchanged (their buffer size is already correct). */
export function clampBufferSize(
  bufferWidth: number,
  bufferHeight: number,
  web: WebSizing,
): { width: number; height: number } {
  if (web.sizeMode !== 'max' || web.width <= 0 || web.height <= 0) {
    return { width: bufferWidth, height: bufferHeight };
  }
  const scale = Math.min(1, web.width / bufferWidth, web.height / bufferHeight);
  return {
    width: Math.max(1, Math.round(bufferWidth * scale)),
    height: Math.max(1, Math.round(bufferHeight * scale)),
  };
}

/** The UNCLAMPED base pixel ratio for the 3D layer: devicePixelRatio, bounded by
 *  `three.pixelRatioCap`. Shared by the two places that must agree on it — the renderer's
 *  first buffer (`makeWebGPURenderer`) and every later resize (`Scene3D`'s ResizeObserver);
 *  see clampPixelRatio below for why a stale ratio must never be read back off the renderer.
 *
 *  A cap of 0 or less means UNCAPPED, not "ratio 0" — the same rule `canvas2DSizing` applies
 *  to `pixi.pixelRatioCap`, and for the same reason: nothing validates numeric config (#39),
 *  and a literal 0 ratio yields a 0×0 drawing buffer (a blank canvas), which no one has ever
 *  meant by a cap. A non-positive devicePixelRatio (jsdom, a detached window) falls back to 1. */
export function basePixelRatio(devicePixelRatio: number, cap: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return cap > 0 ? Math.min(dpr, cap) : dpr;
}

/** The renderer pixel ratio that lands a three.js canvas on the `max`-clamped buffer.
 *
 *  three computes `canvas.width = floor(cssWidth × pixelRatio)`, so the 3D layer cannot
 *  clamp by shrinking the CSS size it passes to `setSize` — that value gets re-multiplied
 *  by the ratio, which is exactly why `max` was a no-op on every retina display (#38).
 *  Scaling the RATIO instead reaches the same clamped buffer through three's own math.
 *
 *  `basePixelRatio` must be recomputed by the caller each time (`min(devicePixelRatio,
 *  three.pixelRatioCap)`), never read back off the renderer. Not because it would
 *  ratchet — re-applying to an already-clamped ratio is idempotent, since a buffer
 *  sitting exactly ON the cap clamps to itself — but because a stale clamped ratio
 *  cannot RECOVER: after the container shrinks and grows again the buffer stays at the
 *  smaller ratio and silently under-renders. Both properties are pinned by tests.
 *
 *  Returns `basePixelRatio` unchanged for `free`/`fixed`, so the caller's setSize path is
 *  byte-for-byte what it was before the clamp existed. The 2D twin of this is
 *  `canvas2DSizing.computeBackingSize`, which can size its buffer directly and so needs
 *  no ratio detour. */
export function clampPixelRatio(
  cssWidth: number,
  cssHeight: number,
  basePixelRatio: number,
  web: WebSizing,
): number {
  const deviceW = cssWidth * basePixelRatio;
  const deviceH = cssHeight * basePixelRatio;
  if (deviceW <= 0 || deviceH <= 0) return basePixelRatio;
  const buf = clampBufferSize(deviceW, deviceH, web);
  return basePixelRatio * Math.min(1, buf.width / deviceW);
}
