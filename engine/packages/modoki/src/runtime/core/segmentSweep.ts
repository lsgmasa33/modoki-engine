/**
 * Walk a line segment in evenly-spaced steps — the shared fix for tunnelling (#393): any
 * consumer that ACCUMULATES a sequence of discrete hits along a gesture (a paint stroke, a
 * drag-to-spell path, anything where the intermediate positions matter) needs this, because
 * pointer input is sampled once per frame/event and a fast gesture moves more than one step
 * between two samples. Pure, no THREE/ECS — sibling to `curves.ts`.
 *
 * This was hand-rolled three times before landing here (`games/court/runtime/systems.ts`
 * `cellsAlongSegment`, `games/wordweave/runtime/screen.ts` `cellsAlong` for #386, and the Skin
 * editor's weight-paint brush for #392) — see #393. It intentionally does NOT collapse those
 * three: each classifies/dedupes its samples differently (board cells, letter cells, raw paint
 * centers), and `games/wordweave`'s copy stays a copy by construction (zero-engine-import, per
 * the game-portability rule). This module holds only the shared stepping math.
 *
 * ⚠️ **Not on the `@modoki/engine` public surface today** — `runtime/index.ts` does not
 * re-export it, so a `games/**` consumer (which may only reach the engine through that
 * barrel, never a relative path, per the game-portability rule) cannot import this yet. Today
 * it has exactly one consumer, `editor/panels/skinPaintGesture.ts`, which imports it by
 * relative path like any other same-package module. If a future game genuinely needs this
 * (court and wordweave don't — see above), add it to the barrel deliberately then, rather
 * than exporting it now for a consumer that doesn't exist.
 */

export interface SweepOptions {
  /** Sample spacing, in the same units as the points (e.g. a brush radius times a fraction). */
  step: number;
  /** Hard cap on substeps, so a degenerate or huge jump costs a bounded walk rather than an
   *  unbounded one — this runs in interactive input paths. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 512;

/** Every point along the segment `from -> to`, evenly spaced by `step`, always ending exactly
 *  at `to`. `from` is `null` on the first sample of a gesture (or after the pointer left the
 *  surface), where there is no segment to walk and the endpoint is the whole answer. `from`
 *  itself is never re-emitted — the caller already acted on it when it was sampled, so what
 *  comes back is only the NEWLY swept points, in travel order. */
export function sweepSegment(
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  { step, maxSteps = DEFAULT_MAX_STEPS }: SweepOptions,
): Array<{ x: number; y: number }> {
  if (!from) return [to];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // A non-positive step, or one that divides the segment into infinitely many pieces, falls
  // back to the endpoint rather than hanging.
  if (step <= 0 || !Number.isFinite(dist / step)) return [to];
  const steps = Math.min(maxSteps, Math.max(1, Math.ceil(dist / step)));
  const out: Array<{ x: number; y: number }> = [];
  for (let k = 1; k <= steps; k++) {
    out.push(k === steps ? to : { x: from.x + dx * (k / steps), y: from.y + dy * (k / steps) });
  }
  return out;
}
