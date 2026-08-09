/** The decisions behind the Font Inspector's variation-axis controls, kept out of the
 *  `.tsx` so they are unit-testable (editor `.ts` carries tests; editor `.tsx` does not).
 *  Both have edge cases that are wrong-by-default and were wrong in the first draft. */

/** Axis bounds as reported by `/api/font-axes` (the font's own `fvar` table). */
export interface AxisBounds { min: number; max: number }

/**
 * Commit a typed draft to an axis value, or `undefined` when there is nothing to commit.
 *
 * The draft exists because clamping every keystroke is unusable: typing "700" into a
 * 100..900 axis clamps "7" up to 100, then "70" to 100, and lands on 900 — the field
 * fights the typist and silently writes a value nobody asked for. So the box stays
 * uncontrolled while focused and clamps ONCE, here, on blur/Enter.
 */
export function commitAxisDraft(draft: string | null, axis: AxisBounds): number | undefined {
  if (draft === null) return undefined;          // never edited
  if (draft.trim() === '') return undefined;     // cleared to empty — keep the old value
  const n = Number(draft);
  if (!Number.isFinite(n)) return undefined;     // "1e", "--", "abc"
  return Math.min(axis.max, Math.max(axis.min, n));
}

/**
 * Apply one axis edit to a `variationAxes` map, returning the next map — or `undefined`
 * when nothing is authored any more.
 *
 * `undefined` (not an empty object) matters: `{}` and absent hash identically in the
 * font cache key, so an empty map is a no-op that nonetheless READS as "an instance was
 * chosen" in the sidecar and in the Inspector. Clearing the last axis must return the
 * font to genuinely-unauthored, which is also the only state that keeps following the
 * font's own default if the file is ever replaced.
 */
export function applyAxisEdit(
  prev: Record<string, number> | undefined,
  tag: string,
  value: number | undefined,
): Record<string, number> | undefined {
  const next = { ...(prev ?? {}) };
  if (value === undefined) delete next[tag];
  else next[tag] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}
