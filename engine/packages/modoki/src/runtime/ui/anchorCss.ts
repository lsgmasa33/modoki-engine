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
// STRETCH_X/STRETCH_Y come from anchorLayout so the two paths cannot disagree on WHICH
// modes stretch — that membership now decides offset semantics, not just pivot.
import { STRETCH_X, STRETCH_Y, type AnchorData } from './anchorLayout';

export type AnchorCssData = AnchorData & { zIndex?: number };

/** Compose a UIElement's tilt onto whatever transform the anchor already wrote (#234).
 *
 *  Must run AFTER `applyAnchorStyle`, and appends rather than assigns: the anchor's pivot
 *  `translate()` is what POSITIONS the element, so replacing it would move the element instead of
 *  turning it. Two elements' worth of bugs live in that one word.
 *
 *  **`transform-origin` follows the anchor pivot**, so the point of the element that sits on the
 *  anchor point is the point a tilt leaves alone. Without it a top-left-anchored element would
 *  swing off its own anchor as the angle changed — which reads as a broken anchor, not as a tilt.
 *  A STRETCHED axis has both edges pinned and ignores the pivot (see `applyAnchorStyle`), so its
 *  origin stays at the centre; an element with no anchor at all is in flow layout and likewise
 *  rotates about its centre.
 *
 *  A zero angle writes NOTHING — not `rotate(0deg)`, not an origin. Every element that predates
 *  this field must emit byte-identical CSS, and a stray transform would hand it a stacking context
 *  it never had (see the trait's warning). */
export function applyRotationStyle(style: CSSProperties, degrees: number, a?: AnchorCssData): void {
  if (!degrees) return;
  if (a) {
    const ox = STRETCH_X.includes(a.anchor) ? 50 : a.pivotX * 100;
    const oy = STRETCH_Y.includes(a.anchor) ? 50 : a.pivotY * 100;
    style.transformOrigin = `${ox}% ${oy}%`;
  }
  style.transform = style.transform ? `${style.transform} rotate(${degrees}deg)` : `rotate(${degrees}deg)`;
}

/** The CSS expression for ONE safe-area edge: the editor's simulated inset if a device
 *  preview set it, otherwise the real `env()`.
 *
 *  `env(safe-area-inset-*)` resolves to **0** on every desktop browser, so the editor
 *  structurally could not show a notched-phone layout — which is not a cosmetic gap: it
 *  is why a previous safe-area fix shipped unverified and had to be reverted (#271/#272).
 *  The editor's device frame publishes `--ui-sa-*` from the preset
 *  (`editor/scene/devicePresets.ts` → `safeAreaCssVars`) and the cascade applies it to
 *  everything inside that preview.
 *
 *  The var is UNSET in every shipped build, so the fallback is what runs on device. That
 *  is deliberate: no `isEditor` branch reaches the runtime, and the two paths cannot drift
 *  because there is only one expression. It also stays LIVE — both a var and `env()`
 *  re-resolve on orientation change with no runtime code. */
function safeAreaInset(edge: 'top' | 'bottom' | 'left' | 'right'): string {
  return `var(--ui-sa-${edge}, env(safe-area-inset-${edge}))`;
}

/** Mutate `style` in place with the absolute-positioning CSS for anchor `a`.
 *  (Mirrors anchorLayout.resolveAnchorRect — keep them in sync; parity-tested.) */
export function applyAnchorStyle(style: CSSProperties, a: AnchorCssData): void {
  style.position = 'absolute';
  if (a.zIndex) style.zIndex = a.zIndex;

  // Position the element's top-left at the anchor reference point.
  // All non-stretch modes use top+left so pivot translate(-X%,-Y%) works uniformly.
  switch (a.anchor) {
    // Four LONGHANDS, deliberately not the `inset: 0` shorthand. The offset block
    // below writes `style.right`/`style.bottom` on a stretched axis, and a shorthand
    // would only be overridden by them via declaration ORDER (React emits style keys
    // in insertion order) — a silent, invisible dependency in the exact code path
    // whose bug was that offsets silently did nothing. Longhands make the 0 an
    // explicit base that fmtAdd composes with, order be damned.
    case 'stretch':
      style.top = 0; style.right = 0; style.bottom = 0; style.left = 0;
      style.width = undefined; style.height = undefined; break;
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

  // Which axes are stretched (both edges pinned) — decides BOTH the offset semantics
  // below and the pivot translate further down.
  const stretchX = STRETCH_X.includes(a.anchor);
  const stretchY = STRETCH_Y.includes(a.anchor);

  // Apply offsets. For anchors that use 50%/100% base values, offsets are combined
  // with calc().
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
  // A NON-stretched axis is anchored at a single POINT, so every offset resolves
  // against that one edge: near-edge offsets add, far-edge offsets SUBTRACT (pushing
  // inward from the far edge) — the box moves, its size is untouched.
  // A STRETCHED axis has BOTH edges pinned, so each offset insets ITS OWN edge
  // (`right` → `style.right`) and the box SHRINKS. Folding `right` back into
  // `style.left` there would make `left: 5%` + `right: 5%` cancel to a full-bleed box
  // instead of the side margins it reads as. Mirrors resolveAnchorRect's rw/rh
  // subtraction (anchorLayout.ts); parity-tested.
  if (a.top) style.top = fmtAdd(style.top, a.top, a.topUnit);
  if (a.left) style.left = fmtAdd(style.left, a.left, a.leftUnit);
  if (a.bottom) {
    if (stretchY) style.bottom = fmtAdd(style.bottom, a.bottom, a.bottomUnit);
    else style.top = fmtSub(style.top, a.bottom, a.bottomUnit);
  }
  if (a.right) {
    if (stretchX) style.right = fmtAdd(style.right, a.right, a.rightUnit);
    else style.left = fmtSub(style.left, a.right, a.rightUnit);
  }

  // For anchored (absolute) elements, margin does not affect position — the pivot
  // sits at the anchor point regardless. Margin is only effective in flow layout.
  style.marginTop = undefined;
  style.marginRight = undefined;
  style.marginBottom = undefined;
  style.marginLeft = undefined;

  // Pivot (0,0) = element's top-left sits at the anchor point.
  // Pivot (0.5,0.5) = element's center sits at the anchor point.
  // Stretched axes ignore pivot (both edges pinned).
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
  // …) also reaches its pinned edge. The inset expression is a LIVE CSS value (see
  // safeAreaInset above), so the browser re-resolves it on orientation change — and in
  // an editor device preview on a preset change — with no runtime code. The editor
  // disables the Safe Area checkbox for non-stretch anchors to match this. */
  //
  // ⚠️ The two arms below are MUTUALLY EXCLUSIVE BY CONSTRUCTION — a stretched anchor
  // takes the padding arm, a point anchor takes the offset arm, and nothing can take
  // both. That is what makes double-insetting unrepresentable rather than merely
  // avoided.
  if (a.safeArea && (stretchX || stretchY)) {
    const fmtPad = (v: string | number | undefined) => typeof v === 'string' ? v : `${v || 0}px`;
    const inset = (edge: 'top' | 'bottom' | 'left' | 'right') =>
      `max(${fmtPad(style[`padding${edge[0].toUpperCase()}${edge.slice(1)}` as 'paddingTop'])}, ${safeAreaInset(edge)})`;
    if (stretchY || a.anchor.startsWith('top')) style.paddingTop = inset('top');
    if (stretchY || a.anchor.startsWith('bottom')) style.paddingBottom = inset('bottom');
    if (stretchX || a.anchor.includes('left')) style.paddingLeft = inset('left');
    if (stretchX || a.anchor.includes('right')) style.paddingRight = inset('right');
  } else if (a.safeArea && a.anchor !== 'center') {
    // A POINT anchor takes the inset as a positional OFFSET: the anchor point moves
    // inward, the box keeps its size.
    //
    // Padding would be wrong here and the reason is worth keeping — it INFLATES the
    // element. A 44pt settings gear anchored top-right on a notched iPhone would render
    // 44 + 62 = 106pt tall, sitting in the same place with its glyph pushed to the
    // bottom: the classic tall-button-on-a-notch bug. That is why the padding arm is
    // stretch-gated. But "padding is wrong" was previously implemented as "nothing at
    // all", so a corner-anchored badge — a coin balance, a settings gear, Court's `?`
    // button — had NO way to clear the camera, and the Inspector greyed the checkbox out
    // to say so. Both halves of that were only half right.
    //
    // Composes with the authored offsets (it runs after them) instead of replacing them,
    // so `top: 4vmin` on a notched phone means "4vmin below the notch", which is what an
    // author who wrote 4vmin meant. `center` reaches no edge and stays a genuine no-op —
    // the one anchor the Inspector still greys the checkbox out for.
    //
    // Only the edges the anchor actually TOUCHES: `top-right` clears the notch and the
    // right edge, and is untouched by the home indicator below it.
    const shift = (base: string | number | undefined, op: '+' | '-', edge: 'top' | 'bottom' | 'left' | 'right'): string => {
      const term = safeAreaInset(edge);
      if (!base || base === '0') return op === '+' ? `calc(${term})` : `calc(-1 * ${term})`;
      const b = typeof base === 'number' ? `${base}px` : base;
      // FLATTEN rather than nest: the authored-offset step may already have produced a
      // `calc(...)`, and `calc(calc(...) - x)` — while valid CSS — is needlessly opaque
      // to anything that has to read these back (the parity oracle among them).
      const inner = b.startsWith('calc(') ? b.slice(5, -1).trim() : b;
      return `calc(${inner} ${op} ${term})`;
    };
    if (a.anchor.startsWith('top')) style.top = shift(style.top, '+', 'top');
    else if (a.anchor.startsWith('bottom')) style.top = shift(style.top, '-', 'bottom');
    if (a.anchor.includes('left')) style.left = shift(style.left, '+', 'left');
    else if (a.anchor.includes('right')) style.left = shift(style.left, '-', 'right');
  }
}
