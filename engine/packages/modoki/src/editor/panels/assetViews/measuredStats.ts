/** Inspector arithmetic over stats that may not exist on this machine (#1305).
 *
 *  The size/triangle figures the asset Inspectors show are peeled into the gitignored
 *  `.meta.local.json` (`plugins/meta-sidecar.ts` § LOCAL_KEYS), so a machine that has never
 *  re-derived them holds no value at all — not a zero. Both totals used to spell
 *  `(xs ?? []).reduce((a, b) => a + (b ?? 0), 0)`, which turns "I don't know" into a confident
 *  **0 B**: across 216 of this repo's 282 committed texture blocks, and per-LOD as `0 tri · 0 B`.
 *
 *  A blank row is honest about not knowing; a zero is the Inspector reporting a measurement it does
 *  not have. Extracted here rather than inlined because it is a DECISION shared by two panels, and
 *  `docs/editor.md` § Panels puts a panel's decisions in a plain `.ts` beside it so they can be
 *  tested without mounting the component.
 *
 *  ⚠️ **A genuine zero and an absent value are different answers** and this is the whole point:
 *  `sumMeasured([0])` is `0` (a real, measured, empty variant), while `sumMeasured([])` and
 *  `sumMeasured([undefined])` are `undefined`. Anything that collapses those two — a `|| undefined`
 *  on the result, a falsy check at the call site — puts the defect straight back. */

/** Total of the values that were actually measured, or `undefined` when none of them were.
 *
 *  Partial data sums what is there: a model whose LOD1 size is missing still reports a total for
 *  the LODs it does know, because the alternative (all-or-nothing) hides more than it protects. The
 *  per-row rendering is what shows which individual entries are unknown. */
export function sumMeasured(values: ReadonlyArray<number | undefined> | undefined): number | undefined {
  if (!values) return undefined;
  let total: number | undefined;
  for (const v of values) {
    if (v === undefined) continue;
    total = (total ?? 0) + v;
  }
  return total;
}
