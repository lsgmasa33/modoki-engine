/** Is a trait field still holding its schema default? — the single predicate deciding whether a
 *  field is WRITTEN to disk or omitted.
 *
 *  A LEAF module on purpose. It is pure (`Object.is` plus two typeof checks, no imports), and TWO
 *  serializers have to agree on it: `serialize.ts` for a top-level entity, and `prefab.ts`'s
 *  `snapshotAddedTraits` for a prefab-instance `added` child. Importing it from `serialize.ts`
 *  dragged that module's whole graph (`onWorldSwap` and friends) into `prefab.ts` and broke seven
 *  unrelated tests whose world mock had no reason to know about it — and keeping a second copy
 *  would drift, which is the bug this predicate is being shared to fix. So: one implementation,
 *  no dependencies. Re-exported from `serialize.ts`, which was its home, so no importer changes. */

/** True when a live field value is indistinguishable from its trait's schema default,
 *  and therefore safe to OMIT from the scene file (the loader re-derives it).
 *
 *  Deliberately SCALAR-ONLY. A non-scalar default (array/object) in a koota SoA schema
 *  is a single shared instance handed to every entity, so "equal to the default" is
 *  neither cheap nor safe to decide: a deep compare would omit a live array that merely
 *  happens to match today, and identity compare would omit one the entity is actually
 *  ALIASING. Either way the file would stop recording a real value. Non-scalars are
 *  always written — the diff cost is small (few traits have them) and the semantics stay
 *  obvious. Same reasoning excludes AoS traits wholesale at the call site: their schema
 *  is a *function*, so there is no default to compare against at all.
 *
 *  `Object.is` (not `===`) so `NaN` matches its own default and `-0` does NOT collapse
 *  into `0` — a signed zero is a different authored value in a direction/velocity field.
 *
 *  Exported for unit testing. */
export function isTraitDefault(value: unknown, def: unknown): boolean {
  if (def !== null && (typeof def === 'object' || typeof def === 'function')) return false;
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) return false;
  return Object.is(value, def);
}
