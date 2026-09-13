/**
 * Where a slicer drag puts the edge it moves (#1176): the Sprite Editor's slice resize handles
 * and the Nine-Slice Editor's border guides.
 *
 * THE RULE: the edge moves by how far the pointer moved SINCE THE PRESS, on that handle's own
 * axes only, clamped to the sheet. Both editors used to set the edge to the pointer's absolute
 * position instead, which went wrong three ways (all measured live on `catvader_1`, 252×392):
 *  - A side handle also moved the axis it does not own. Its fixed point was the opposite
 *    side's MIDPOINT, so an `e` drag set the height from the pointer's y: +20 px right gave
 *    `{y:195, w:280, h:1}`.
 *  - The edge jumped to the pointer on the first move. A press anywhere inside the grab
 *    tolerance moved it, and the error only ever pointed one way. A far-edge handle is
 *    published 0.72 px inside its canvas (`clampHandleToOwner`), and `MouseEvent.clientY` is
 *    an integer, floored. Both bias toward the top-left, so a purely horizontal `se` drag shaved
 *    3 source px off a bottom-row slice's height.
 *  - The drag ended on mouseleave, so an edge could not be overshot onto the sheet boundary.
 *    That half is `dragPointerCapture.ts`.
 * Carrying the press offset makes all of it irrelevant: a drag that did not move on an axis
 * cannot change that axis, whatever the press or the quantisation was.
 */

import type { SpriteRect } from '../../runtime/loaders/spriteSheet';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface Point { x: number; y: number }
export interface Sheet { w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** One axis of a resize, as whole-px `[start, length]`: the dragged edge moves by `delta` and is
 *  clamped to `[0, size]`; the other edge stays put. Dragging past the fixed edge flips the span
 *  rather than going negative. The two EDGES are rounded, not the start and the length: rounding
 *  those separately sends both up at an exact k+0.5, so a `w` drag to 240.5 on a slice ending at
 *  504 gave `{x:241, w:264}`, moving the fixed edge to 505 (close-out review, #1176). A span that
 *  collapses keeps 1 px on the DRAGGED side of the fixed edge, so the fixed edge only moves when
 *  that 1 px would leave the sheet (a `w` drag onto 504 gives `{x:503, w:1}`, not `{x:504, w:1}`). */
function resizeSpan(start: number, len: number, movesFar: boolean, delta: number, size: number): [number, number] {
  const fixed = movesFar ? start : start + len;
  const edge = clamp((movesFar ? start + len : start) + delta, 0, size);
  let lo = Math.round(Math.min(fixed, edge)), hi = Math.round(Math.max(fixed, edge));
  if (hi - lo < 1) {
    if (movesFar) { lo = Math.min(fixed, size - 1); hi = lo + 1; }
    else { hi = Math.max(fixed, 1); lo = hi - 1; }
  }
  return [lo, hi - lo];
}

/** The rect a resize drag produces: `rect` as it was at the press, `press` and `pointer` in image
 *  px (unclamped; a captured drag reports positions past the canvas). Whole px, at least 1 px on
 *  each side, as every stored slice rect is; the start rect is normalised the same way first,
 *  because the numeric X/Y/W/H fields store whatever `parseFloat` gives (a typed `10.5`, or `0`). */
export function resizeSliceRect(rect: SpriteRect, handle: Handle, press: Point, pointer: Point, sheet: Sheet): SpriteRect {
  let x = Math.round(rect.x), y = Math.round(rect.y), w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  if (handle.includes('e') || handle.includes('w')) [x, w] = resizeSpan(x, w, handle.includes('e'), pointer.x - press.x, sheet.w);
  if (handle.includes('n') || handle.includes('s')) [y, h] = resizeSpan(y, h, handle.includes('s'), pointer.y - press.y, sheet.h);
  return { x, y, w, h };
}

export type GuideEdge = 'l' | 'r' | 't' | 'b';
export interface NineSliceInsets { l: number; r: number; t: number; b: number }

/** The insets after dragging one guide: `start` is the insets at the press, `press`/`pointer` the
 *  pointer's image-space coordinate on that guide's axis (x for l/r, y for t/b). The guide keeps
 *  at least one source px between itself and the opposite guide, as the numeric fields do. */
export function dragNineSliceGuide(start: NineSliceInsets, edge: GuideEdge, press: number, pointer: number, sheet: Sheet): NineSliceInsets {
  const delta = pointer - press;
  switch (edge) {
    case 'l': return { ...start, l: clamp(Math.round(start.l + delta), 0, sheet.w - start.r - 1) };
    case 'r': return { ...start, r: clamp(Math.round(start.r - delta), 0, sheet.w - start.l - 1) };
    case 't': return { ...start, t: clamp(Math.round(start.t + delta), 0, sheet.h - start.b - 1) };
    case 'b': return { ...start, b: clamp(Math.round(start.b - delta), 0, sheet.h - start.t - 1) };
  }
}
