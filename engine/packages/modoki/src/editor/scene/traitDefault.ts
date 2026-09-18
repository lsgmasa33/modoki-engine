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

/** The two Inspector hints the write rule reads — structural, so this module stays import-free.
 *  `entityId` is read for truthiness only (the real hint is an `{onMissing}` object). */
export interface PersistFieldHint { runtimeOnly?: boolean; entityId?: unknown }

/** Would a serializer WRITE this field's value? — the rule both writers apply per key, and the
 *  rule the committed-scene guard (`sceneFormatCanonical.test.ts`, #1412) checks files against. One
 *  definition, so a guard cannot pass a serializer whose rule moved.
 *
 *  NOT `isPersistentTraitField` (runtime/core/ecs/traitSchema.ts), which asks whether a field NAME
 *  belongs to the trait's key set at all (the LOAD side). This asks whether a VALUE is emitted. Its
 *  `runtimeOnly` test is the same one-liner as `isRuntimeOnlyField` there, restated because this
 *  module must stay import-free (see the header).
 *
 *  - a `runtimeOnly` field is never written (recomputed each frame; persisting it churns the file);
 *  - a SoA scalar still holding its schema default is omitted (the loader refills it from the
 *    same schema, and omitting keeps defaults live — see `serialize.ts`'s loop);
 *  - …except an `entityId` field, which is always written: a default reference is a value, and
 *    the guid-ify pass rewrites it in place, so skipping it would only move it to the end. */
export function isFieldWritten(
  value: unknown,
  schema: Record<string, unknown> | null,
  key: string,
  hint: PersistFieldHint | undefined,
): boolean {
  if (hint?.runtimeOnly) return false;
  if (schema && !hint?.entityId && isTraitDefault(value, schema[key])) return false;
  return true;
}

/** The ORDER a serializer writes a SoA trait's keys in: its schema's, i.e. the object passed to
 *  koota's `trait({...})`. Its own export so the committed-scene guard reads the order from here
 *  rather than restating `Object.keys(schema)` — a restated rule would pass a writer that moved. */
export function traitKeyOrder(schema: Record<string, unknown>): string[] {
  return Object.keys(schema);
}

/** The keys a serializer writes for one trait, in the ORDER it writes them. A SoA trait's order
 *  is its schema's (`Object.keys(schema)` — the object passed to koota's `trait({...})`); an AoS
 *  trait has no declared keys, so it falls back to the live value's own order, which only a
 *  running world can know. Shared by `serializeScene` (scene entities) and `prefab.ts`'s
 *  `compactAddedTraitData` (prefab-instance `added[]` children), which must agree. */
export function writtenTraitKeys(
  schema: Record<string, unknown> | null,
  data: Record<string, unknown>,
  fields: Record<string, PersistFieldHint | undefined>,
): string[] {
  const keys = schema ? traitKeyOrder(schema).filter((k) => k in data) : Object.keys(data);
  return keys.filter((key) => isFieldWritten(data[key], schema, key, fields[key]));
}
