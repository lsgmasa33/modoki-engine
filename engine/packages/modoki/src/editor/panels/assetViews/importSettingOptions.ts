/** Shared helper for the asset inspectors' preset `<select>` controls. Not video-specific
 *  despite starting life in `videoAssetLogic.ts` — every import-settings inspector binds the
 *  same shape of control to the same shape of hand-authorable sidecar. */

/** The preset options a `<select>` should offer, widened to include the value it is actually
 *  bound to. Use this for EVERY numeric preset select in an asset inspector — a select whose
 *  `value` matches no `<option>` silently displays its FIRST option and misreports the
 *  setting. Rule, history and the static guard that enforces it:
 *  docs/editor.md § "The asset Inspector — three rules that have each failed repeatedly".
 *
 *  Returns the SAME array reference when nothing needs adding, so a caller can rely on
 *  identity, and never mutates the shared constant it is handed. */
export function withCurrentValue(options: readonly number[], current: number): readonly number[] {
  if (options.includes(current)) return options;
  return [...options, current].sort((a, b) => a - b);
}
