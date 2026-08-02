/** What a trait PERSISTS — decided by its koota schema, never by `meta.fields`.
 *
 *  `meta.fields` is the INSPECTOR-RENDERING list: a field is in it because the
 *  generic Inspector renderer should draw a row for it. A field can persist and
 *  still be absent from it — `Animator.clips`/`clip` (a custom Inspector section,
 *  AnimatorClipsSection, owns them), `EntityAttributes.editorFolder` (the
 *  Hierarchy folder tag, no Inspector row at all). Using `field in meta.fields`
 *  as "does this field persist" therefore DROPS real data, and did: a load→save
 *  silently deleted a populated `Animator.clips` override from
 *  `skinned-test.json`. `serializeScene` has always enumerated the schema; the
 *  two prefab-override paths did not, which is why only overrides lost data.
 *
 *  SoA traits (`trait({...})`) expose a plain-object `schema` whose keys ARE the
 *  persistent fields. AoS traits (`trait(() => ({...}))`) expose `schema` as a
 *  function/undefined — there is no key list to check, so every field is allowed
 *  through and the live object's own keys are the truth (AnimationLibrary's
 *  `animSets`/`boneMaps`, SkinnedMeshRenderer's `materials`, UIAction's
 *  `onClickSet`). */

import type { Trait } from 'koota';
import type { TraitMeta } from './traitRegistry';

/** The SoA schema object, or `null` for an AoS trait (no declared key set). */
export function soaSchema(meta: Pick<TraitMeta, 'trait'>): Record<string, unknown> | null {
  const schema = (meta.trait as { schema?: unknown }).schema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null;
}

/** Resolve a trait field from an AUTHORED bag (e.g. a raw scene/prefab JSON `traits.X`
 *  object), falling back to the trait's koota schema default when the field is absent.
 *
 *  Exists because `serializeScene` OMITS a field from the file when it equals its trait
 *  default (`isTraitDefault`, editor/scene/serialize.ts) — so a raw-JSON test that reads
 *  `parsed.traits.Canvas2D.referenceWidth` directly is only correct BY ACCIDENT: it works
 *  today because the authored value happens to differ from the default, but breaks the
 *  moment it doesn't (a future save omits the field, and the raw read silently becomes
 *  `undefined`, e.g. feeding a ratio and yielding `NaN`). Route that class of read through
 *  here instead, so it stays correct whether or not the file happens to spell the field out.
 *
 *  Deliberately takes the actual koota `Trait` object (imported the same way every game
 *  test already imports `Canvas2D`/`UIElement`/etc.), NOT a registry lookup by name — the
 *  schema default lives on the trait object itself (set at `trait({...})` definition time)
 *  and has no dependency on `registerTrait`/the editor-facing registry, which a headless
 *  game test typically never populates.
 *
 *  Throws — never silently returns `undefined` — when the trait has no SoA schema (an AoS
 *  trait, or a malformed mock) or the field isn't one of its declared keys: either means the
 *  caller asked for a default that doesn't exist, which is exactly the "looks fine today,
 *  NaN tomorrow" failure mode this helper is here to close off. */
export function traitFieldOrDefault<T>(
  trait: Trait,
  bag: Record<string, unknown> | undefined,
  field: string,
): T {
  const authored = bag?.[field];
  if (authored !== undefined) return authored as T;
  const schema = (trait as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object' || !Object.prototype.hasOwnProperty.call(schema, field)) {
    throw new Error(
      `traitFieldOrDefault: field "${field}" not found on trait schema (trait has no schema, or field is misspelled)`,
    );
  }
  return (schema as Record<string, unknown>)[field] as T;
}

/** True when `field` is one the trait actually persists.
 *
 *  An AoS trait accepts any field (no declared key set). A SoA trait accepts
 *  exactly its OWN schema keys — so a genuinely renamed/retired scalar is still
 *  ignored, which is what the old `meta.fields` guard was reaching for.
 *
 *  `hasOwnProperty`, not `in`: these keys come from a FILE, and `in` walks the
 *  prototype chain, so a scene naming a field `toString`/`constructor` would sail
 *  through (the old `field in meta.fields` guard had exactly that hole). It also
 *  keeps the check allocation-free — this runs per field, per trait, per instance
 *  member on every load and every save. */
export function isPersistentTraitField(meta: Pick<TraitMeta, 'trait'>, field: string): boolean {
  const schema = soaSchema(meta);
  return schema === null || Object.prototype.hasOwnProperty.call(schema, field);
}

/** True for a pure runtime read-back field (`runtimeOnly` in the Inspector
 *  metadata) — live state that must never be written to a scene/prefab file.
 *  Mirrors the skip `serializeScene` applies, so override capture writes the
 *  same field set a plain serialize would. A field with no Inspector metadata
 *  is NOT runtime-only; absence from `meta.fields` says nothing about lifetime. */
export function isRuntimeOnlyField(meta: Pick<TraitMeta, 'fields'>, field: string): boolean {
  return !!(meta.fields as Record<string, { runtimeOnly?: boolean } | undefined>)[field]?.runtimeOnly;
}
