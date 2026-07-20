/** anchorCss — builds the responsive CSS (top/left/right/bottom/inset/transform +
 *  safe-area padding) for a UIAnchor. This is the DOM/live-render counterpart of
 *  anchorLayout.resolveAnchorRect, which computes the same 16-mode placement as a
 *  pre-measured PIXEL rect for the editor overlay/gizmos.
 *
 *  The two MUST stay in lockstep — they encode identical anchor semantics in two
 *  representations (browser-resolved CSS vs measured pixels). A parity test
 *  (uiAnchorParity.test.ts) feeds the same anchor data to both and asserts the
 *  resolved positions agree, so a fix to one mode that misses the other fails the
 *  build instead of silently mis-positioning UI on device. */

import type { CSSProperties } from 'react';
import type { AnchorData } from './anchorLayout';

export type AnchorCssData = AnchorData & { safeArea?: boolean; zIndex?: number };

const STRETCH_X = ['stretch', 'top-stretch', 'bottom-stretch', 'h-stretch'];
const STRETCH_Y = ['stretch', 'left-stretch', 'right-stretch', 'v-stretch'];

/** Mutate `style` in place with the absolute-positioning CSS for anchor `a`.
 *  (Mirrors anchorLayout.resolveAnchorRect — keep them in sync; parity-tested.) */
export function applyAnchorStyle(style: CSSProperties, a: AnchorCssData): void {
  style.position = 'absolute';
  if (a.zIndex) style.zIndex = a.zIndex;

  // Position the element's top-left at the anchor reference point.
  // All non-stretch modes use top+left so pivot translate(-X%,-Y%) works uniformly.
  switch (a.anchor) {
    case 'stretch': style.inset = 0; style.width = undefined; style.height = undefined; break;
    case 'top-stretch': style.top = 0; style.left = 0; style.right = 0; style.width = undefined; break;
    case 'bottom-stretch': style.top = '100%'; style.left = 0; style.right = 0; style.width = undefined; break;
    case 'left-stretch': style.top = 0; style.left = 0; style.bottom = 0; style.height = undefined; break;
    case 'right-stretch': style.top = 0; style.left = '100%'; style.bottom = 0; style.height = undefined; break;
    case 'top': style.top = 0; style.left = '50%'; break;
    case 'bottom': style.top = '100%'; style.left = '50%'; break;
    case 'left': style.left = 0; style.top = '50%'; break;
    case 'right': style.left = '100%'; style.top = '50%'; break;
    case 'top-left': style.top = 0; style.left = 0; break;
    case 'top-right': style.top = 0; style.left = '100%'; break;
    case 'bottom-left': style.top = '100%'; style.left = 0; break;
    case 'bottom-right': style.top = '100%'; style.left = '100%'; break;
    case 'center': style.top = '50%'; style.left = '50%'; break;
    case 'h-stretch': style.left = 0; style.right = 0; style.top = '50%'; style.width = undefined; break;
    case 'v-stretch': style.top = 0; style.bottom = 0; style.left = '50%'; style.height = undefined; break;
  }

  // Apply offsets as additions to top/left. For anchors that use 50%/100% base
  // values, offsets are combined with calc(). Right/bottom offsets are subtracted
  // (push inward from the far edge).
  // A length TERM (no base), e.g. '12%', '12px', or '12 * var(--ui-vw, 1vw)'.
  // Viewport units resolve via the container-relative CSS vars UIRenderer publishes
  // — mirrors cssVal (UINode.tsx) and resolveLengthPx (anchorLayout.ts); keep in sync.
  const VP_VARS: Record<string, string> = { vw: '--ui-vw', vh: '--ui-vh', vmin: '--ui-vmin', vmax: '--ui-vmax' };
  const term = (v: number, unit: string): string =>
    unit === '%' ? `${v}%`
      : VP_VARS[unit] ? `${v} * var(${VP_VARS[unit]}, 1${unit})`
      : `${v}px`;
  // A bare length (used when there's no base to fold into): a viewport term must be
  // wrapped in calc(); px collapses to the raw number; % stays a string.
  const bare = (v: number, unit: string): string | number =>
    unit === '%' ? `${v}%` : VP_VARS[unit] ? `calc(${term(v, unit)})` : v;
  const fmtAdd = (base: string | number | undefined, v: number, unit: string): string | number => {
    if (!v) return base ?? 0;
    return base ? `calc(${base}${typeof base === 'number' ? 'px' : ''} + ${term(v, unit)})` : bare(v, unit);
  };
  const fmtSub = (base: string | number | undefined, v: number, unit: string): string | number => {
    if (!v) return base ?? 0;
    return base ? `calc(${base}${typeof base === 'number' ? 'px' : ''} - ${term(v, unit)})` : bare(-v, unit);
  };
  if (a.top) style.top = fmtAdd(style.top, a.top, a.topUnit);
  if (a.left) style.left = fmtAdd(style.left, a.left, a.leftUnit);
  if (a.bottom) style.top = fmtSub(style.top, a.bottom, a.bottomUnit);
  if (a.right) style.left = fmtSub(style.left, a.right, a.rightUnit);

  // For anchored (absolute) elements, margin does not affect position — the pivot
  // sits at the anchor point regardless. Margin is only effective in flow layout.
  style.marginTop = undefined;
  style.marginRight = undefined;
  style.marginBottom = undefined;
  style.marginLeft = undefined;

  // Pivot (0,0) = element's top-left sits at the anchor point.
  // Pivot (0.5,0.5) = element's center sits at the anchor point.
  // Stretched axes ignore pivot (both edges pinned).
  const stretchX = STRETCH_X.includes(a.anchor);
  const stretchY = STRETCH_Y.includes(a.anchor);
  const tx = stretchX ? 0 : -a.pivotX * 100;
  const ty = stretchY ? 0 : -a.pivotY * 100;
  if (tx || ty) {
    style.transform = `translate(${tx}%, ${ty}%)`;
  }

  // Safe-area padding is a stretched-CONTAINER concept: the padding insets the
  // element's CHILDREN away from the notch / home-indicator / rounded corners. On a
  // NON-stretched element the same padding just inflates the element itself (a
  // centered button rendered tall on a notched iPhone — the classic footgun), so gate
  // it on stretch. Emit env(safe-area-inset-*) only for the edges the element actually
  // reaches: a stretched axis spans BOTH its edges; a stretch-pinned bar (top-stretch,
  // …) also reaches its pinned edge. env() is a LIVE CSS var, so the browser
  // re-resolves these on orientation change — no runtime code needed. The editor
  // disables the Safe Area checkbox for non-stretch anchors to match this. */
  if (a.safeArea && (stretchX || stretchY)) {
    const fmtPad = (v: string | number | undefined) => typeof v === 'string' ? v : `${v || 0}px`;
    const inset = (edge: 'top' | 'bottom' | 'left' | 'right') =>
      `max(${fmtPad(style[`padding${edge[0].toUpperCase()}${edge.slice(1)}` as 'paddingTop'])}, env(safe-area-inset-${edge}))`;
    if (stretchY || a.anchor.startsWith('top')) style.paddingTop = inset('top');
    if (stretchY || a.anchor.startsWith('bottom')) style.paddingBottom = inset('bottom');
    if (stretchX || a.anchor.includes('left')) style.paddingLeft = inset('left');
    if (stretchX || a.anchor.includes('right')) style.paddingRight = inset('right');
  }
}
