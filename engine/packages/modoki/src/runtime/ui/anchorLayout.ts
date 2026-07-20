/** anchorLayout — shared anchor positioning logic for computing pixel rects.
 *  Used by SceneView's computeCanvas2DRect and any code that needs to resolve
 *  UIAnchor positions to pixel coordinates within a viewport. */

export interface AnchorData {
  anchor: string;
  top: number; topUnit: string;
  right: number; rightUnit: string;
  bottom: number; bottomUnit: string;
  left: number; leftUnit: string;
  pivotX: number; pivotY: number;
}

/** Resolve a length (value + unit) to LOGICAL pixels. THE shared resolver for every
 *  pixel-space path (anchor offsets, Canvas2D sizing, SceneView).
 *   - `%`              → percent of `axisTotal` (the length's own axis)
 *   - `vw`/`vh`        → percent of the viewport width/height
 *   - `vmin`/`vmax`    → percent of the smaller/larger viewport axis
 *   - anything else    → treated as `px`
 *  vmin/vmax are computed from the LOGICAL device viewport (`vpW`/`vpH`) so they
 *  stay device-resolution-aware in both GameView and SceneView. Mirrors `cssVal`
 *  (UINode.tsx) and the anchor CSS emitter (anchorCss.ts) — keep all three in sync. */
export function resolveLengthPx(
  value: number, unit: string | undefined,
  axisTotal: number, vpW: number, vpH: number,
): number {
  if (!value) return 0;
  switch (unit) {
    case '%':    return axisTotal * value / 100;
    case 'vw':   return vpW * value / 100;
    case 'vh':   return vpH * value / 100;
    case 'vmin': return Math.min(vpW, vpH) * value / 100;
    case 'vmax': return Math.max(vpW, vpH) * value / 100;
    default:     return value; // px
  }
}

/** Resolve a UIAnchor to a pixel rect within a viewport of size vpW×vpH.
 *  @param w Element width in pixels
 *  @param h Element height in pixels
 *  @param vpW Viewport width
 *  @param vpH Viewport height
 *  @param anchor Anchor data (from UIAnchor trait) */
export function resolveAnchorRect(
  w: number, h: number,
  vpW: number, vpH: number,
  anchor: AnchorData,
): { x: number; y: number; w: number; h: number } {
  let x = 0, y = 0, rw = w, rh = h;

  // % resolves against the offset's own axis (vpW for left/right, vpH for top/bottom);
  // viewport units (vw/vh/vmin/vmax) resolve against the viewport via resolveLengthPx.
  const resolveVal = (v: number, unit: string, total: number) =>
    resolveLengthPx(v, unit, total, vpW, vpH);

  // Pivot (0,0) = element's top-left at the anchor point.
  // Each anchor mode places the top-left at the anchor reference point.
  // Matches UINode.tsx which uses top/left CSS for all modes.

  switch (anchor.anchor) {
    case 'stretch':
      x = 0; y = 0; rw = vpW; rh = vpH; break;
    case 'center':
      x = vpW / 2; y = vpH / 2; break;
    case 'top':
      x = vpW / 2; y = 0; break;
    case 'bottom':
      x = vpW / 2; y = vpH; break;
    case 'left':
      x = 0; y = vpH / 2; break;
    case 'right':
      x = vpW; y = vpH / 2; break;
    case 'top-left':
      x = 0; y = 0; break;
    case 'top-right':
      x = vpW; y = 0; break;
    case 'bottom-left':
      x = 0; y = vpH; break;
    case 'bottom-right':
      x = vpW; y = vpH; break;
    case 'top-stretch':
      x = 0; y = 0; rw = vpW; break;
    case 'bottom-stretch':
      x = 0; y = vpH; rw = vpW; break;
    case 'left-stretch':
      x = 0; y = 0; rh = vpH; break;
    case 'right-stretch':
      x = vpW; y = 0; rh = vpH; break;
    case 'h-stretch':
      x = 0; y = vpH / 2; rw = vpW; break;
    case 'v-stretch':
      x = vpW / 2; y = 0; rh = vpH; break;
  }

  // Apply offsets (top/left add, right/bottom subtract)
  if (anchor.top) y += resolveVal(anchor.top, anchor.topUnit, vpH);
  if (anchor.left) x += resolveVal(anchor.left, anchor.leftUnit, vpW);
  if (anchor.right) x -= resolveVal(anchor.right, anchor.rightUnit, vpW);
  if (anchor.bottom) y -= resolveVal(anchor.bottom, anchor.bottomUnit, vpH);

  // Pivot: translate(-pivotX%, -pivotY%) shifts from the anchor point.
  // Stretched axes ignore pivot (both edges pinned).
  const stretchX = ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'].includes(anchor.anchor);
  const stretchY = ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'].includes(anchor.anchor);
  if (!stretchX) x -= anchor.pivotX * rw;
  if (!stretchY) y -= anchor.pivotY * rh;

  return { x, y, w: rw, h: rh };
}
