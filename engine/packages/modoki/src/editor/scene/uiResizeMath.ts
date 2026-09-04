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
export interface BoxEdges { left: number; right: number; top: number; bottom: number }

/** The %-denominator box for a containing block, derived from the parent's measured
 *  PADDING box (e.g. `clientWidth`/`clientHeight`, which are already border-excluded)
 *  and its own padding.
 *
 *  CSS resolves a child's `width`/`height` percentage against its containing block
 *  (CSS 2.1 §10.2, "percentages refer to width of containing block") — which for a
 *  normal-flow child is the parent's CONTENT box, but for an absolutely positioned one
 *  is the nearest positioned ancestor's PADDING edge (§10.1 item 4.b, the definition of
 *  "containing block" — NOT §10.3.7, which is only the width constraint equation). That
 *  same padding box is what the `left`/`right` (§10.3.7) and `top`/`bottom` (§10.6.4)
 *  offset percentages of an anchored element resolve against; those exist only in the
 *  anchored case. ⚠️ §10.6.4 is the VERTICAL section — it does not cover `left`/`right`,
 *  and an earlier revision of this comment cited it as if it did. One number (the parent's padding-box
 *  width/height) is not both boxes — this returns the one the CALLER's element actually
 *  resolves against, so it must be chosen by whether THAT element (not the parent) is
 *  anchored. (#651) */
export function containingBlockSize(paddingBox: Size, padding: BoxEdges, mode: 'content' | 'padding'): Size {
  const shrinkW = mode === 'content' ? padding.left + padding.right : 0;
  const shrinkH = mode === 'content' ? padding.top + padding.bottom : 0;
  return {
    width: Math.max(0, paddingBox.width - shrinkW),
    height: Math.max(0, paddingBox.height - shrinkH),
  };
}

/** Inset a parent's BORDER-box rect to its PADDING box: the origin shifts in by the
 *  border widths, and the size is the already-measured padding-box size (e.g.
 *  `clientWidth`/`clientHeight`, border-excluded) rather than `borderRect.width/height
 *  - border` — so a scrollbar gutter (which also shrinks `clientWidth`) is accounted
 *  for the same way `containingBlockSize`'s caller measures it.
 *
 *  This is the box `UIResizeOverlay`'s anchor-reference diamond must be drawn against
 *  for an anchored child: `containingBlockSize(..., 'padding')` is the %-denominator
 *  an anchored entity's drag resolves against (#651), and the diamond marks the point
 *  that math is relative to — drawing it from the border box instead points it at a
 *  spot the drag math never uses whenever the parent has padding or a border. */
export function paddingBoxRect(borderRect: Rect, border: BoxEdges, paddingSize: Size): Rect {
  return {
    left: borderRect.left + border.left,
    top: borderRect.top + border.top,
    width: paddingSize.width,
    height: paddingSize.height,
  };
}

/** Decompose a CSS `transform` computed-style string into its OWN per-axis scale factor,
 *  independent of any rotation composed into the same transform (#651 B2 follow-up's
 *  regression: `ancestorScaleRatio`, since removed, recovered the second transform's scale as
 *  a ratio of two `getBoundingClientRect()` boxes — correct only when nothing in the chain is
 *  rotated, because `getBoundingClientRect()` on a rotated element returns its axis-aligned
 *  BOUNDING box, which is larger than the element itself, so `screenSize / layoutSize` stopped
 *  being a scale factor the moment rotation entered the picture. Measured: parent 200×150,
 *  `scale: 1`, frame 0.5 — at `rotation: 15` the old ratio came out 1.160/1.311 for what should
 *  be exactly 1/1).
 *
 *  A 2D CSS transform matrix `matrix(a, b, c, d, e, f)` is the coefficient matrix
 *  `[[a, c], [b, d]]` — column 1 is where the X basis vector lands, column 2 is where the Y
 *  basis vector lands. Rotation is length-preserving, so it only changes a column's
 *  DIRECTION; `hypot` of a column recovers exactly the LENGTH (scale) that axis was stretched
 *  by, whatever direction rotation pointed it in: `scaleX = hypot(a, b)`,
 *  `scaleY = hypot(c, d)`. This is exact for any composition of rotate + POSITIVE scale in
 *  either order, which is what `applyRotationStyle` (anchorCss.ts) emits for every scale this
 *  is normally fed. `matrix3d(...)` (16 values, the same column-major layout one dimension up)
 *  uses the first three entries of its first two columns: `scaleX = hypot(m11, m12, m13)`,
 *  `scaleY = hypot(m21, m22, m23)` — unreached today (nothing in the UI stack emits a 3D
 *  transform) and, if it ever is, only correct for an AFFINE matrix: `hypot` of a column
 *  recovers a basis vector's LENGTH under any affine map, but a `perspective(...)` term makes
 *  the mapping non-affine (columns no longer stay orthogonal-length-preserving under rotation),
 *  and this returns the WRONG scale there — measured: `perspective(200px) rotateY(40deg)` gives
 *  `hypot` = 1.000 where the true width ratio is 0.786.
 *
 *  ⚠️ **Not exact for a NEGATIVE scale** — `hypot` is always non-negative, so `scale(-1, 1)`
 *  (`matrix(-1,0,0,1,0,0)`) recovers `{x: 1, y: 1}`, silently dropping the mirror. Not a
 *  regression (the `getBoundingClientRect()`-ratio approach this replaced also lost the sign —
 *  a box's on-screen size is the same whichever way it's mirrored), but not "exact" either.
 *  `UIElement.scale`'s Inspector metadata (`registerTraits.ts`) has no `min`, so `scale: -1` is
 *  authorable today; this function has no way to see the flip if an author uses it.
 *
 *  `'none'`, an empty string, or anything this can't parse is the identity, `{x:1, y:1}` — the
 *  fallback for a transform this was never meant to model, not just for the two named cases. */
export function decomposeScale(transform: string): { x: number; y: number } {
  const IDENTITY = { x: 1, y: 1 };
  if (!transform || transform === 'none') return IDENTITY;
  const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
  if (matrix) {
    const v = matrix[1].split(',').map(Number);
    if (v.length === 6 && v.every(Number.isFinite)) return { x: Math.hypot(v[0], v[1]), y: Math.hypot(v[2], v[3]) };
    return IDENTITY;
  }
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (matrix3d) {
    const v = matrix3d[1].split(',').map(Number);
    if (v.length === 16 && v.every(Number.isFinite)) return { x: Math.hypot(v[0], v[1], v[2]), y: Math.hypot(v[4], v[5], v[6]) };
    return IDENTITY;
  }
  return IDENTITY;
}

/** Compound a chain of ancestor transforms (each decomposed via `decomposeScale`) into the ONE
 *  per-axis factor `computeResize`/`computeMoveOffsets` need: the true on-screen scale every
 *  ancestor between an element and the preview frame adds on top of the frame's own (the
 *  frame's `transform: scale(uiScale)` is divided out separately, by `toLogicalDelta`'s
 *  `scaleX`/`scaleY` — the caller's DOM walk excludes the frame itself, so its transform never
 *  reaches this function). Multiplication order doesn't matter — scale factors commute — so the
 *  caller may pass the chain in either direction.
 *
 *  Exactly **1** when every transform in the chain is `'none'` (or the chain is empty) —
 *  including when an ancestor carries a pure `rotate()` with no `scale()` — which is the
 *  property that keeps every unscaled/unrotated case byte-identical to before this function
 *  existed. It is also exact — not merely non-regressing — for a scaled AND rotated ancestor,
 *  unlike the rect-ratio approach it replaces (`decomposeScale`'s doc comment).
 *
 *  A degenerate 0 — `UIElement.scale: 0` is a legitimate authored value (a pop-in clip's first
 *  keyframe, anchorCss.ts's own doc comment) — falls back to 1 rather than propagate a zero:
 *  `computeResize`'s `%` branch would silently zero its own denominator and turn a drag into a
 *  no-op, exactly where the pre-ancestor-scale code (no correction at all) used to work. */
export function accumulateAncestorScale(transforms: string[]): { x: number; y: number } {
  let x = 1;
  let y = 1;
  for (const t of transforms) {
    const s = decomposeScale(t);
    x *= s.x;
    y *= s.y;
  }
  return { x: x > 0 ? x : 1, y: y > 0 ? y : 1 };
}

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
 *  Mirrors resolveLengthPx (anchorLayout.ts) inverted.
 *
 *  `ancestorScale` (#651 B2 second follow-up): `delta` (`dx`/`dy`) arrives in FRAME-logical px —
 *  only the preview frame's own `transform: scale(uiScale)` has been divided out
 *  (`toLogicalDelta`). Any SECOND transform an ancestor carries (`UIElement.scale !== 1`,
 *  `accumulateAncestorScale`) inflates `delta` by that same factor again, on top of the frame's. The
 *  `%` case does NOT need this: its denominator (`parentAxis`, from `parentComputedSize` in
 *  `UIResizeOverlay`) is built in that SAME inflated space, so the ratio already cancels the
 *  ancestor factor — dividing here too would cancel it TWICE. Every other unit's denominator
 *  (`parentAxis` unused; `viewport` is the true device-logical size, never inflated) has nothing
 *  to cancel against, so `delta` itself must be brought back to true logical px first. Defaults
 *  to 1 so every pre-existing (unscaled-ancestor) call site is unchanged. */
function deltaToUnit(delta: number, unit: string, parentAxis: number, viewport: Size, ancestorScale: number = 1): number {
  if (unit === '%') return parentAxis > 0 ? (delta / parentAxis) * 100 : 0;
  const layoutDelta = ancestorScale > 0 ? delta / ancestorScale : delta;
  const pct = (total: number) => (total > 0 ? (layoutDelta / total) * 100 : 0);
  switch (unit) {
    case 'vw':   return pct(viewport.width);
    case 'vh':   return pct(viewport.height);
    case 'vmin': return pct(Math.min(viewport.width, viewport.height));
    case 'vmax': return pct(Math.max(viewport.width, viewport.height));
    default:     return layoutDelta; // px
  }
}

const NO_VIEWPORT: Size = { width: 0, height: 0 };

/** Compute the UIAnchor offset patch for a move-handle drag. `handle` is one of
 *  `move-x` / `move-y` / `move-free`; `dx`/`dy` are logical deltas; `parent` is the
 *  parent's logical size (for `%` units). Returns only the offset fields that the
 *  anchor mode + handle actually drive.
 *
 *  `ancestorScaleX`/`ancestorScaleY` (#651 B2 second follow-up): the SECOND transform's scale
 *  (`accumulateAncestorScale`), axis-paired to the delta it corrects — X for `dx`/left/right, Y for
 *  `dy`/top/bottom — passed through to `deltaToUnit` for every unit except `%` (see its doc
 *  comment). Both default to 1, so an unscaled ancestor is byte-identical to before. */
export function computeMoveOffsets(
  handle: string,
  start: MoveAnchorStart,
  dx: number,
  dy: number,
  parent: Size,
  viewport: Size = NO_VIEWPORT,
  ancestorScaleX: number = 1,
  ancestorScaleY: number = 1,
): { top?: number; left?: number; right?: number; bottom?: number } {
  const moveH = handle === 'move-x' || handle === 'move-free';
  const moveV = handle === 'move-y' || handle === 'move-free';
  const update: { top?: number; left?: number; right?: number; bottom?: number } = {};

  if (moveH) {
    if (usesRightOffset(start.anchor)) {
      // Right offset: dragging right = decrease right value (away from the right edge).
      update.right = roundU(start.right - deltaToUnit(dx, start.rightUnit, parent.width, viewport, ancestorScaleX), start.rightUnit);
    } else {
      update.left = roundU(start.left + deltaToUnit(dx, start.leftUnit, parent.width, viewport, ancestorScaleX), start.leftUnit);
    }
  }

  if (moveV) {
    if (usesBottomOffset(start.anchor)) {
      update.bottom = roundU(start.bottom - deltaToUnit(dy, start.bottomUnit, parent.height, viewport, ancestorScaleY), start.bottomUnit);
    } else {
      update.top = roundU(start.top + deltaToUnit(dy, start.topUnit, parent.height, viewport, ancestorScaleY), start.topUnit);
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
 *  the `%` math. Width/height clamp at 0.
 *
 *  `ancestorScaleX`/`ancestorScaleY` (#651 B2 second follow-up): `dx`/`dy` (and `computed`,
 *  which `UIResizeOverlay` deliberately measures into this SAME inflated space to keep the `%`
 *  base-fallback consistent) live in frame-logical px, inflated by any SECOND transform an
 *  ancestor carries on top of the frame's own (`accumulateAncestorScale`). The `%` branch cancels
 *  that factor against `parent` (built in the same inflated space) and must NOT divide it out
 *  again; the `px`/viewport-unit branches have no such denominator, so `deltaToUnit` — and the
 *  `px` branch directly — divide it out of `dx`/`dy` here. The `px` branch's AUTO-SIZE base
 *  (`baseW`/`baseH` falling back to `computed.width`/`height` below) needs the SAME un-inflating:
 *  `computed` is in ancestor-inflated space same as `dx`/`dy` are, so an auto-sized `px` element
 *  under a scaled ancestor must divide that fallback by the ancestor scale too, or it double-counts
 *  the ancestor factor into the written value (measured: auto-sized element, layout width 100,
 *  ancestor scale 2, a 40px drag wrote 220 instead of 120 before this was added). The non-`px`
 *  branch's own auto-size fallback needs no separate handling — it routes through `deltaToUnit`
 *  (via `computed.width`/`height` as that function's `delta` argument), which already un-inflates
 *  it. Both default to 1: an unscaled ancestor computes byte-identical to before. */
export function computeResize(
  handle: string,
  start: ResizeStartValues,
  computed: Size,
  parent: Size,
  dx: number,
  dy: number,
  viewport: Size = NO_VIEWPORT,
  ancestorScaleX: number = 1,
  ancestorScaleY: number = 1,
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
  // start from 0 and derive the base from the measured size below. `computed` lives in
  // ancestor-inflated space (same as `dx`/`dy`) — un-inflate it here too, or the px branch
  // below (which adds an un-inflated `layoutDx` to this base) double-counts the ancestor
  // scale into the written value (#651 B2 — the auto-sized px base: 100 auto-sized under ancestor scale 2 read as
  // 200 here, then +20 layout px wrote 220 instead of the correct 120).
  const baseW = start.width || (isPxUnit(start.widthUnit) ? computed.width / (ancestorScaleX > 0 ? ancestorScaleX : 1) : 0);
  const baseH = start.height || (isPxUnit(start.heightUnit) ? computed.height / (ancestorScaleY > 0 ? ancestorScaleY : 1) : 0);

  const update: { width?: number; height?: number } = {};

  if (affectsWidth) {
    if (isPxUnit(start.widthUnit)) {
      const layoutDx = ancestorScaleX > 0 ? dx / ancestorScaleX : dx;
      update.width = Math.max(0, Math.round(baseW + layoutDx * widthSign));
    } else {
      const delta = deltaToUnit(dx * widthSign, start.widthUnit, parent.width, viewport, ancestorScaleX);
      const base = baseW || deltaToUnit(computed.width, start.widthUnit, parent.width, viewport, ancestorScaleX);
      update.width = Math.max(0, round1(base + delta));
    }
  }

  if (affectsHeight) {
    if (isPxUnit(start.heightUnit)) {
      const layoutDy = ancestorScaleY > 0 ? dy / ancestorScaleY : dy;
      update.height = Math.max(0, Math.round(baseH + layoutDy * heightSign));
    } else {
      const delta = deltaToUnit(dy * heightSign, start.heightUnit, parent.height, viewport, ancestorScaleY);
      const base = baseH || deltaToUnit(computed.height, start.heightUnit, parent.height, viewport, ancestorScaleY);
      update.height = Math.max(0, round1(base + delta));
    }
  }

  return update;
}
