/** What a pointer-down means in the Skin Editor's Weights mode (#287), and how a stroke's
 *  pointer samples become paint centers (#392).
 *
 *  Extracted from `SkinCanvas.tsx` because these are DECISIONs, and the repo's rule is that a
 *  panel's decisions live in a plain module beside it where a test can reach them
 *  (docs/editor.md § Panels) — mounting SkinCanvas in jsdom would assert a canvas mock.
 *
 *  The behaviour it encodes: a press on a bone JOINT while the brush is active used to
 *  resolve immediately to "select this bone" and `return`, which silently ate any stroke
 *  that happened to start over a joint. That is a surprise mid-drag for a human, and for an
 *  agent it was fatal rather than merely annoying — `skin:bone:N` joints are the only handles
 *  SkinCanvas registers, so `drag_handle` could not produce a stroke AT ALL. The press is now
 *  UNDECIDED until the pointer either travels (→ paint) or lifts (→ select). */
import { sweepSegment } from '../../runtime/core/segmentSweep';

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

/** Fraction of the brush radius used as the sweep step. Borrowed as a conservative default
 *  from `games/wordweave`'s `DEFAULT_SWEEP_STEP` (#386) — that value is measured against a
 *  DIFFERENT geometry (a fraction of grid cell PITCH, against a discrete hit-circle dead
 *  band) and its measurement does not transfer here, where the brush is a continuous
 *  smoothstep disc and the failure mode is coverage smoothness, not a missed hit-test. 0.25
 *  is unmeasured for THIS geometry — it gives 4 stamps per radius (8 per diameter), which is
 *  comfortably conservative, not a pinned cliff. */
export const PAINT_SWEEP_STEP_FRACTION = 0.25;

/** Texture-space paint centers for one pointer move, INTERPOLATED so a fast stroke can't
 *  tunnel between brush stamps (#392): `paintAt` stamps a disc at each center, and nothing
 *  upstream retained the intermediate positions before this. `prev` is the last point actually
 *  painted (`null` only if a stroke could open without ever painting once, which today it
 *  cannot — the press point always paints immediately). The returned list ends exactly at `to`
 *  and excludes `prev` itself, which was already painted when it was sampled. */
export function paintStrokeCenters(
  prev: { x: number; y: number } | null,
  to: { x: number; y: number },
  radius: number,
): Array<{ x: number; y: number }> {
  return sweepSegment(prev, to, { step: Math.max(1e-6, radius * PAINT_SWEEP_STEP_FRACTION) });
}

/** The in-progress stroke's own bookkeeping: only the last point actually painted. Opaque to
 *  the caller — advance it through {@link advancePaintStroke} rather than reading `last`
 *  directly, so every call site (SkinCanvas has three: immediate-paint on pointerdown, the
 *  promoted-park branch, and plain onPointerMove) advances it the SAME way. */
export interface PaintStrokeState {
  readonly last: { x: number; y: number };
}

/** Advance an in-progress stroke by one sample: the swept centers to paint THIS move, and
 *  the state to carry into the next one. `state` is `null` to open a stroke — the whole
 *  return is then just `[to]`, the press point.
 *
 *  This exists (rather than leaving `paintStrokeCenters` + a bare `{x,y}` ref at each call
 *  site) so the multi-sample CHAINING is one tested seam instead of three independently
 *  hand-wired ones — a caller that stops calling this reintroduces #392 in a way `git diff`
 *  makes obvious (a deleted call to a named function), rather than three quietly-diverged
 *  inline ref updates. */
export function advancePaintStroke(
  state: PaintStrokeState | null,
  to: { x: number; y: number },
  radius: number,
): { centers: Array<{ x: number; y: number }>; state: PaintStrokeState } {
  return { centers: paintStrokeCenters(state?.last ?? null, to, radius), state: { last: to } };
}
