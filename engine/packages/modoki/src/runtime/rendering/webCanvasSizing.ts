/** webCanvasSizing — pure geometry for the shipped web build's `rendering.web.sizeMode`.
 *
 *  Applies ONLY to the standalone/shipped web game's layer container (App.tsx
 *  `.game-wrapper`) — NOT the editor viewport (which sizes itself / uses device
 *  presets). Three modes (see project-config `rendering.web`):
 *   - `free`  → the container fills the viewport; renderers use the full buffer.
 *   - `fixed` → the container is letterboxed to the width×height ASPECT, centred,
 *               with bars around it; renderers fill that (smaller) container.
 *   - `max`   → the container fills the viewport, but each renderer's DRAWING
 *               BUFFER is clamped to at most width×height (CSS still fills, so a
 *               4K display renders at ≤ width×height and upscales — saves fill-rate).
 *
 *  Kept pure (no DOM) so it's unit-testable; callers apply the returned numbers. */

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
 *  preserved). `free`/`fixed` pass through unchanged (their CSS size already IS the
 *  render size). Returned dims are what to pass to `renderer.setSize(w, h, false)`. */
export function clampBufferSize(
  cssWidth: number,
  cssHeight: number,
  web: WebSizing,
): { width: number; height: number } {
  if (web.sizeMode !== 'max' || web.width <= 0 || web.height <= 0) {
    return { width: cssWidth, height: cssHeight };
  }
  const scale = Math.min(1, web.width / cssWidth, web.height / cssHeight);
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}
