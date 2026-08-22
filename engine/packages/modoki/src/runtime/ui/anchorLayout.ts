/** anchorLayout — shared anchor positioning logic for computing pixel rects.
 *  Used by SceneView's computeCanvas2DRect and any code that needs to resolve
 *  UIAnchor positions to pixel coordinates within a viewport. */

import type { AnchorMode } from '../traits/UIAnchor';

/** Which anchor modes pin BOTH edges of an axis. Load-bearing beyond pivot: on a
 *  stretched axis an offset INSETS its own edge (the box shrinks) rather than shifting
 *  the box, so membership here decides layout semantics, not just whether pivot
 *  applies. Exported and consumed by anchorCss.ts so the CSS and pixel paths cannot
 *  drift on WHICH modes stretch — the two disagreeing is the whole failure class this
 *  pair of modules keeps re-learning. */
// `readonly string[]`, not `as const`: it blocks mutation of a shared exported array
// while keeping `.includes(someString)` legal (a literal tuple would reject it).
export const STRETCH_X: readonly string[] = ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'];
export const STRETCH_Y: readonly string[] = ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'];

/** Is an authored `UIElement.width`/`height` INERT on this anchor? A stretched axis is
 *  sized by its two offsets, so both layout paths overwrite the authored value
 *  (`applyAnchorStyle` clears the CSS size, `resolveAnchorRect` overwrites the pixel
 *  extent) — the field is stored and displayed but can never take effect. The axes are
 *  independent: a `top-stretch` element has an inert width but a perfectly live height.
 *  Shared by the Inspector (which greys the field out and explains why) and the scene
 *  validator (which warns about an authored value that can never apply), so the two
 *  cannot disagree with the layout about what is inert. */
export function isSizeInert(anchor: string, axis: 'width' | 'height'): boolean {
  return (axis === 'width' ? STRETCH_X : STRETCH_Y).includes(anchor);
}

export interface AnchorData {
  /** Narrowed to the trait's own union, not `string`: neither this module's switch nor
   *  anchorCss's has a `default`, so an unrecognised mode falls through BOTH and yields
   *  `position: absolute` with no edges set — silently unpositioned. A union makes that
   *  a compile error instead. Same silent-failure family as the stretched-offset bug. */
  anchor: AnchorMode;
  top: number; topUnit: string;
  right: number; rightUnit: string;
  bottom: number; bottomUnit: string;
  left: number; leftUnit: string;
  pivotX: number; pivotY: number;
  /** Opt in to clearing the notch / home indicator. Lives here rather than only on the
   *  CSS side so the PIXEL path can gate on the same field — the two must agree about
   *  which elements move, not just about where an un-inset one goes. Optional because
   *  most callers build this from a trait where it is already resolved; note the TRAIT
   *  defaults to true, so an absent field in a scene JSON means ON. */
  safeArea?: boolean;
}

/** Safe-area insets in logical px, for the pixel path. The CSS path gets the same four
 *  numbers from `var(--ui-sa-*, env(safe-area-inset-*))` — this is the measured twin, and
 *  the editor feeds it from the selected device preset so gizmos and the overlay land on
 *  the element the browser actually drew. */
export interface SafeAreaPx { top: number; right: number; bottom: number; left: number; }

export const ZERO_INSETS: SafeAreaPx = { top: 0, right: 0, bottom: 0, left: 0 };

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
  insets: SafeAreaPx = ZERO_INSETS,
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

  const stretchX = STRETCH_X.includes(anchor.anchor);
  const stretchY = STRETCH_Y.includes(anchor.anchor);

  // Apply offsets. The semantics differ per axis, and that difference is the whole
  // point: on a NON-stretched axis the anchor is a single POINT, so an offset SHIFTS
  // the box (a far-edge offset subtracts from that same point, pushing inward). On a
  // STRETCHED axis BOTH edges are pinned, so each offset INSETS ITS OWN edge and the
  // box SHRINKS — which is what makes `left` + `right` read as side margins instead
  // of cancelling out. Mirrors applyAnchorStyle's left/right ↔ style.left/style.right
  // split (anchorCss.ts); parity-tested.
  if (anchor.top) {
    const v = resolveVal(anchor.top, anchor.topUnit, vpH);
    y += v; if (stretchY) rh -= v;
  }
  if (anchor.left) {
    const v = resolveVal(anchor.left, anchor.leftUnit, vpW);
    x += v; if (stretchX) rw -= v;
  }
  if (anchor.right) {
    const v = resolveVal(anchor.right, anchor.rightUnit, vpW);
    if (stretchX) rw -= v; else x -= v;
  }
  if (anchor.bottom) {
    const v = resolveVal(anchor.bottom, anchor.bottomUnit, vpH);
    if (stretchY) rh -= v; else y -= v;
  }

  // Safe area on a POINT anchor moves the anchor point inward; the box keeps its size.
  // Mirrors applyAnchorStyle's offset arm (anchorCss.ts) — including the exclusivity: a
  // stretched anchor takes the inset as PADDING instead, which insets its children
  // without moving its own rect, so there is nothing for this path to apply. Runs AFTER
  // the authored offsets so it composes with them rather than replacing them, and BEFORE
  // pivot so the inset shifts the anchor point, not the already-pivoted box.
  if (anchor.safeArea && !stretchX && !stretchY) {
    const m = anchor.anchor;
    if (m.startsWith('top')) y += insets.top;
    else if (m.startsWith('bottom')) y -= insets.bottom;
    if (m.includes('left')) x += insets.left;
    else if (m.includes('right')) x -= insets.right;
  }

  // Pivot: translate(-pivotX%, -pivotY%) shifts from the anchor point.
  // Stretched axes ignore pivot (both edges pinned).
  if (!stretchX) x -= anchor.pivotX * rw;
  if (!stretchY) y -= anchor.pivotY * rh;

  return { x, y, w: rw, h: rh };
}
