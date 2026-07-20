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

import { getAllTraits } from '../ecs/traitRegistry';
import type { FieldType } from '../ecs/traitRegistry';
import type { SceneSchema } from './sceneValidation';

type FieldEntry = { type?: FieldType; options?: string[] };

function inferType(value: unknown): FieldType | undefined {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return undefined; // object/array/null → known field, not type-checked
}

export function buildSceneSchema(): SceneSchema {
  const traits: SceneSchema['traits'] = {};
  for (const meta of getAllTraits()) {
    const fields: Record<string, FieldEntry> = {};

    // 1. Every field in the koota schema (the serialized field set). SoA traits
    //    (`trait({...})`) expose `.schema` as the object; AoS traits
    //    (`trait(() => ({...}))`) expose it as a FACTORY — call it to get the
    //    default object, so AoS fields (AnimationLibrary.animSets/boneMaps,
    //    SkinnedMeshRenderer.materials) are KNOWN to the validator and don't
    //    false-flag as 'unknown field'. Matches what serialize.ts writes.
    let koota = (meta.trait as { schema?: Record<string, unknown> | (() => Record<string, unknown>) }).schema;
    if (typeof koota === 'function') {
      try { koota = (koota as () => Record<string, unknown>)(); }
      catch { koota = undefined; }
    }
    if (koota && typeof koota === 'object') {
      for (const [name, def] of Object.entries(koota)) {
        fields[name] = { type: inferType(def) };
      }
    }

    // 2. Overlay Inspector hints (more precise type: color/enum + options).
    for (const [name, hint] of Object.entries(meta.fields)) {
      fields[name] = hint.options ? { type: hint.type, options: hint.options } : { type: hint.type };
    }

    traits[meta.name] = { category: meta.category, fields };
  }
  return { traits };
}
