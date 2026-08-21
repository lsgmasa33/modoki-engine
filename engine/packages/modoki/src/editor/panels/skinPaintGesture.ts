/** What a pointer-down means in the Skin Editor's Weights mode (#287).
 *
 *  Extracted from `SkinCanvas.tsx` because it is a DECISION, and the repo's rule is that a
 *  panel's decisions live in a plain module beside it where a test can reach them
 *  (docs/editor.md § Panels) — mounting SkinCanvas in jsdom would assert a canvas mock.
 *
 *  The behaviour it encodes: a press on a bone JOINT while the brush is active used to
 *  resolve immediately to "select this bone" and `return`, which silently ate any stroke
 *  that happened to start over a joint. That is a surprise mid-drag for a human, and for an
 *  agent it was fatal rather than merely annoying — `skin:bone:N` joints are the only handles
 *  SkinCanvas registers, so `drag_handle` could not produce a stroke AT ALL. The press is now
 *  UNDECIDED until the pointer either travels (→ paint) or lifts (→ select). */

/** Manhattan CSS-px travel that promotes a parked joint press into a stroke. CSS px, not
 *  texture units, so the threshold does not change as the user zooms the canvas. */
export const PAINT_DRAG_SLOP = 3;

export type PaintPressIntent =
  /** Undecided: a click selects `jointHit`, a drag paints `selBone`. */
  | 'park'
  /** Resolve now as a bone selection — no stroke was ever possible. */
  | 'select'
  /** Open a stroke immediately: empty space with a bone selected. */
  | 'paint'
  /** Nothing to act on — empty space with no bone selected. */
  | 'ignore';

/** Classify a pointer-down in Weights mode.
 *
 *  `selBone < 0` on a joint is deliberately NOT parked: with no bone selected there is
 *  nothing to paint, so the press can only ever have meant "select", and parking a gesture
 *  that cannot promote would just delay the selection by a pointer-up. It also keeps
 *  `paintAt`'s closed-over `selBone` honest — it would still read -1 on the promoting frame.
 *
 *  The Transform sub-tool never paints, so a joint press there is always a plain selection. */
export function paintPressIntent(args: { paintSubTool: string; jointHit: number; selBone: number }): PaintPressIntent {
  const { paintSubTool, jointHit, selBone } = args;
  if (jointHit >= 0) {
    return paintSubTool === 'paint' && selBone >= 0 ? 'park' : 'select';
  }
  // Empty space. Only the brush strokes — the Transform sub-tool poses a bone and never
  // paints. That combination cannot reach here today (SkinCanvas's gizmo branch intercepts a
  // Transform press whenever a bone is selected), but this is a pure function and a caller
  // should not have to know that to use it correctly.
  return paintSubTool === 'paint' && selBone >= 0 ? 'paint' : 'ignore';
}

/** Has a parked press travelled far enough to become a stroke rather than a click? */
export function promotesToStroke(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) >= PAINT_DRAG_SLOP;
}
