/** Build a serializable scene-validation schema from the live trait registry.
 *  Browser-only (reads the registry populated at app init). Pushed to the dev
 *  server over the HMR socket so server-side endpoints can validate too, and
 *  used directly by the hot-reload path to warn on a freshly-edited scene.
 *
 *  The authoritative field set is the trait's koota `.schema` (every field
 *  `serialize.ts` writes), NOT just the curated Inspector `meta.fields` — using
 *  the latter alone would false-flag schema fields absent from Inspector hints
 *  (e.g. AoS fields edited by a custom Inspector section: AnimationLibrary's
 *  `animSets`/`boneMaps`, SkinnedMeshRenderer's `materials`).
 *  Field types come from the Inspector hint when present, else are inferred from
 *  the schema default; fields with no confident primitive type are left
 *  untyped (known, but not type-checked). */

import { getAllTraits } from '../core/ecs/traitRegistry';
import type { FieldType } from '../core/ecs/traitRegistry';
import type { SceneSchema } from '../loaders/sceneValidation';

type FieldEntry = { type?: FieldType; options?: string[]; default?: unknown };

/** Scene files OMIT a field still holding its trait default (serialize.ts's
 *  `isTraitDefault`), so a reader of a scene file can no longer tell a missing field's
 *  effective value without knowing the default — hence publishing it here. Scalars only,
 *  matching exactly what omission can apply to: a non-scalar default is a single shared
 *  instance, is never omitted, and would bloat this payload for nothing. */
function scalarDefault(value: unknown): unknown | undefined {
  if (value === null) return null;
  return typeof value === 'object' || typeof value === 'function' ? undefined : value;
}

function inferType(value: unknown): FieldType | undefined {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return undefined; // object/array/null → known field, not type-checked
}

/** Resolve a trait's koota `.schema` to a plain default object. SoA traits
 *  (`trait({...})`) expose `.schema` as the object; AoS traits
 *  (`trait(() => ({...}))`) expose it as a FACTORY — call it to get the default
 *  object, so AoS fields (AnimationLibrary.animSets/boneMaps,
 *  SkinnedMeshRenderer.materials) are visible to callers. Returns undefined for
 *  tags (no schema) or a factory that throws. */
export function resolveKootaSchema(trait: unknown): Record<string, unknown> | undefined {
  let koota = (trait as { schema?: Record<string, unknown> | (() => Record<string, unknown>) })?.schema;
  if (typeof koota === 'function') {
    try { koota = (koota as () => Record<string, unknown>)(); }
    catch { return undefined; }
  }
  return koota && typeof koota === 'object' ? koota : undefined;
}

export function buildSceneSchema(): SceneSchema {
  const traits: SceneSchema['traits'] = {};
  for (const meta of getAllTraits()) {
    const fields: Record<string, FieldEntry> = {};

    // 1. Every field in the koota schema (the serialized field set) — the
    //    authoritative set; `meta.fields` is deliberately a subset.
    const koota = resolveKootaSchema(meta.trait);
    if (koota) {
      for (const [name, def] of Object.entries(koota)) {
        const dflt = scalarDefault(def);
        fields[name] = dflt === undefined ? { type: inferType(def) } : { type: inferType(def), default: dflt };
      }
    }

    // 2. Overlay Inspector hints (more precise type: color/enum + options). Carries
    //    the default forward — the hint has no opinion on it, and dropping it here
    //    would silently blank the default for every field that HAS an Inspector hint
    //    (i.e. most of them).
    for (const [name, hint] of Object.entries(meta.fields)) {
      const dflt = fields[name]?.default;
      fields[name] = {
        type: hint.type,
        ...(hint.options ? { options: hint.options } : {}),
        ...(dflt === undefined ? {} : { default: dflt }),
      };
    }

    traits[meta.name] = { category: meta.category, fields };
  }
  return { traits };
}
