/** Pure resize/anchor math for `UIResizeOverlay` (editor-gizmos F-resize).
 *
 *  Extracted from the overlay component so the drag→size / drag→anchor-offset
 *  arithmetic is unit-testable without a DOM. The component keeps the DOM-coupled
 *  parts (reading getBoundingClientRect, ECS read/write, pointer capture); these
 *  functions take already-resolved logical deltas + start values and return the
 *  trait patch to write. All values are in logical (game) units; `%` results round
 *  to 0.1, `px` results round to whole pixels and clamp resizes at 0 — matching the
 *  original inline behavior byte-for-byte. */

export interface Size { width: number; height: number }
export interface Rect { left: number; top: number; width: number; height: number }

/** Convert an on-screen DOM rect into the UI preview frame's INTERNAL logical coords
 *  (the space the selection overlay renders in). The frame is CSS-scaled by
 *  uiScale = frame.width / deviceLogicalWidth, so dividing the measured offset+size by
 *  that real frame scale recovers logical points.
 *
 *  This is the exact math behind UIResizeOverlay's selection box. Two regressions
 *  lived here: (1) dividing by the editor's `viewZoom` (which does NOT scale the UI
 *  preview) collapsed the box whenever a device preset letterboxed the frame; and
 *  (2) measuring against a stale device width broke it after a device switch. Both
 *  reduce to "use the CURRENT frame.width / deviceLogicalWidth", which this guards. */
export function frameToLogicalRect(el: Rect, frame: Rect, deviceLogicalWidth: number): Rect {
  const z = frame.width > 0 && deviceLogicalWidth > 0 ? frame.width / deviceLogicalWidth : 1;
  return {
    left: (el.left - frame.left) / z,
    top: (el.top - frame.top) / z,
    width: el.width / z,
    height: el.height / z,
  };
}

/** Anchor reference point as a fraction of the parent rect — (0,0)=top-left,
 *  (1,1)=bottom-right. */
export function anchorRefPoint(anchor: string): { fx: number; fy: number } {
  switch (anchor) {
    case 'top-left': return { fx: 0, fy: 0 };
    case 'top': return { fx: 0.5, fy: 0 };
    case 'top-right': return { fx: 1, fy: 0 };
    case 'left': return { fx: 0, fy: 0.5 };
    case 'center': return { fx: 0.5, fy: 0.5 };
    case 'right': return { fx: 1, fy: 0.5 };
    case 'bottom-left': return { fx: 0, fy: 1 };
    case 'bottom': return { fx: 0.5, fy: 1 };
    case 'bottom-right': return { fx: 1, fy: 1 };
    case 'top-stretch': return { fx: 0.5, fy: 0 };
    case 'bottom-stretch': return { fx: 0.5, fy: 1 };
    case 'left-stretch': return { fx: 0, fy: 0.5 };
    case 'right-stretch': return { fx: 1, fy: 0.5 };
    case 'h-stretch': return { fx: 0.5, fy: 0.5 };
    case 'v-stretch': return { fx: 0.5, fy: 0.5 };
    default: return { fx: 0, fy: 0 }; // stretch
  }
}

/** Which axes can be repositioned for a given anchor mode (a stretched axis is
 *  pinned to both edges → not free to move). */
export function anchorDragAxes(anchor: string): { h: boolean; v: boolean } {
  switch (anchor) {
    case 'stretch': return { h: false, v: false };
    case 'top-stretch': case 'bottom-stretch': case 'h-stretch':
      return { h: false, v: true };
    case 'left-stretch': case 'right-stretch': case 'v-stretch':
      return { h: true, v: false };
    default: return { h: true, v: true };
  }
}

const RIGHT_ANCHORS = ['right', 'top-right', 'bottom-right', 'right-stretch'];
const BOTTOM_ANCHORS = ['bottom', 'bottom-left', 'bottom-right', 'bottom-stretch'];

/** Whether the horizontal offset for this anchor is expressed from the RIGHT edge
 *  (so dragging right DECREASES the stored value). */
export function usesRightOffset(anchor: string): boolean { return RIGHT_ANCHORS.includes(anchor); }
/** Whether the vertical offset for this anchor is expressed from the BOTTOM edge. */
export function usesBottomOffset(anchor: string): boolean { return BOTTOM_ANCHORS.includes(anchor); }

export interface MoveAnchorStart {
  anchor: string;
  top: number; topUnit: string;
  left: number; leftUnit: string;
  right: number; rightUnit: string;
  bottom: number; bottomUnit: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const VIEWPORT_UNITS = ['vw', 'vh', 'vmin', 'vmax'];
/** px-based units (no parent/viewport conversion). */
const isPxUnit = (unit: string) => unit !== '%' && !VIEWPORT_UNITS.includes(unit);
/** Round a drag result in its unit: whole px, else 0.1 (matches the original %-path). */
const roundU = (v: number, unit: string) => (isPxUnit(unit) ? Math.round(v) : round1(v));

/** Convert a logical-px delta into the field's unit value.
 *   - `%`            → percent of `parentAxis` (the field's own parent axis)
 *   - `vw/vh/vmin/vmax` → percent of the viewport (device-logical) dimension
 *   - else (px)      → the delta unchanged
 *  Mirrors resolveLengthPx (anchorLayout.ts) inverted. */
function deltaToUnit(delta: number, unit: string, parentAxis: number, viewport: Size): number {
  const pct = (total: number) => (total > 0 ? (delta / total) * 100 : 0);
  switch (unit) {
    case '%':    return pct(parentAxis);
    case 'vw':   return pct(viewport.width);
    case 'vh':   return pct(viewport.height);
    case 'vmin': return pct(Math.min(viewport.width, viewport.height));
    case 'vmax': return pct(Math.max(viewport.width, viewport.height));
    default:     return delta; // px
  }
}

const NO_VIEWPORT: Size = { width: 0, height: 0 };

/** Compute the UIAnchor offset patch for a move-handle drag. `handle` is one of
 *  `move-x` / `move-y` / `move-free`; `dx`/`dy` are logical deltas; `parent` is the
 *  parent's logical size (for `%` units). Returns only the offset fields that the
 *  anchor mode + handle actually drive. */
export function computeMoveOffsets(
  handle: string,
  start: MoveAnchorStart,
  dx: number,
  dy: number,
  parent: Size,
  viewport: Size = NO_VIEWPORT,
): { top?: number; left?: number; right?: number; bottom?: number } {
  const moveH = handle === 'move-x' || handle === 'move-free';
  const moveV = handle === 'move-y' || handle === 'move-free';
  const update: { top?: number; left?: number; right?: number; bottom?: number } = {};

  if (moveH) {
    if (usesRightOffset(start.anchor)) {
      // Right offset: dragging right = decrease right value (away from the right edge).
      update.right = roundU(start.right - deltaToUnit(dx, start.rightUnit, parent.width, viewport), start.rightUnit);
    } else {
      update.left = roundU(start.left + deltaToUnit(dx, start.leftUnit, parent.width, viewport), start.leftUnit);
    }
  }

  if (moveV) {
    if (usesBottomOffset(start.anchor)) {
      update.bottom = roundU(start.bottom - deltaToUnit(dy, start.bottomUnit, parent.height, viewport), start.bottomUnit);
    } else {
      update.top = roundU(start.top + deltaToUnit(dy, start.topUnit, parent.height, viewport), start.topUnit);
    }
  }

  return update;
}

export interface ResizeStartValues {
  width: number; height: number; widthUnit: string; heightUnit: string;
}

/** Compute the UIElement {width?,height?} patch for a resize-handle drag.
 *  `handle` carries edge letters (t/b/l/r); `computed` is the element's measured
 *  size (used as the base for auto-sized 0-width/height elements); `parent` sizes
 *  the `%` math. Width/height clamp at 0. */
export function computeResize(
  handle: string,
  start: ResizeStartValues,
  computed: Size,
  parent: Size,
  dx: number,
  dy: number,
  viewport: Size = NO_VIEWPORT,
): { width?: number; height?: number } {
  // Match ONLY the edge-letter suffix (e.g. 'tl', 't', 'br'), not the whole handle
  // string — otherwise the 'r' in the "resize-" prefix makes every handle look
  // width-affecting, so a diagonal drag on the top/bottom EDGE handle would leak
  // into width (and similarly any handle's left/right detection was always true).
  const edges = handle.slice(handle.lastIndexOf('-') + 1);
  const affectsWidth = edges.includes('l') || edges.includes('r');
  const affectsHeight = edges.includes('t') || edges.includes('b');
  // The L/T edges grow toward the origin → invert the delta sign for those.
  const widthSign = edges.includes('l') ? -1 : 1;
  const heightSign = edges.includes('t') ? -1 : 1;

  // Auto-sized (0) elements: px keeps the measured size as the base; relative units
  // start from 0 and derive the base from the measured size below.
  const baseW = start.width || (isPxUnit(start.widthUnit) ? computed.width : 0);
  const baseH = start.height || (isPxUnit(start.heightUnit) ? computed.height : 0);

  const update: { width?: number; height?: number } = {};

  if (affectsWidth) {
    if (isPxUnit(start.widthUnit)) {
      update.width = Math.max(0, Math.round(baseW + dx * widthSign));
    } else {
      const delta = deltaToUnit(dx * widthSign, start.widthUnit, parent.width, viewport);
      const base = baseW || deltaToUnit(computed.width, start.widthUnit, parent.width, viewport);
      update.width = Math.max(0, round1(base + delta));
    }
  }

  if (affectsHeight) {
    if (isPxUnit(start.heightUnit)) {
      update.height = Math.max(0, Math.round(baseH + dy * heightSign));
    } else {
      const delta = deltaToUnit(dy * heightSign, start.heightUnit, parent.height, viewport);
      const base = baseH || deltaToUnit(computed.height, start.heightUnit, parent.height, viewport);
      update.height = Math.max(0, round1(base + delta));
    }
  }

  return update;
}
