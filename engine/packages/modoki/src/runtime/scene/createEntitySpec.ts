/** The ONE vocabulary check for a `create-entity` spec, shared by both ops that accept one — the
 *  editor's undoable op (`agentEditorOps.ts`) and the device's live twin (`liveLifecycle.ts`) (#1070).
 *
 *  ⚠️ **It RETURNS the refusal as data; it never throws.** The two ops speak different transports:
 *  the editor relay carries a §5 code only when the op throws `OpRefusal`, and the device relay
 *  flattens ANY throw into an `Error: <msg>` string sentinel, so its refusals are returned
 *  `{ok:false, error, options}` bodies. A runtime THROW served neither — the light/preset checks
 *  used to throw from the spec builders, which reached the editor agent as a generic
 *  `REFUSED_BY_OP` with no `options`, and escaped `createEntityLive`'s own `{ok:false, options}`
 *  convention on the device. `OpRefusal` cannot live here either: it is `app/debug`, above
 *  `runtime/` (docs/mcp-tool-conventions.md §5). So this decides, and each op adapts the answer to
 *  its own transport once.
 *
 *  It also owns the per-kind DEFAULTS (`mesh` → sphere, `shape` → square, `light` → point, `preset`
 *  → view), for the reason the editor op's comment gave when they moved out of the MCP tool: a
 *  default in one caller leaves every other caller — the curl API, a test, the device — reaching
 *  a builder with `undefined`.
 *
 *  Membership is each table's OWN predicate (`isLightKind`, `isUiPreset`, `isCreateEntityKind`,
 *  the derived name lists), which the builders' programming-error backstops use too — one check
 *  per table, not a second copy of it. */

import { PRIMITIVE_NAMES } from '../loaders/primitives';
import { PRIMITIVE_SPRITE_NAMES } from '../loaders/sceneValidation';
import {
  CREATE_ENTITY_KINDS, LIGHT_KINDS, isCreateEntityKind, isLightKind, type CreateEntitySpec,
} from './entityCreateSpecs';
import { UI_PRESET_NAMES, isUiPreset } from '../ui/uiAuthoring';

export type CreateEntitySpecResolution =
  | { ok: true; spec: CreateEntitySpec }
  | { ok: false; error: string; options: string[] };

interface VocabularyField {
  key: string;
  fallback: string;
  noun: string;
  options: readonly string[];
  valid: (value: string) => boolean;
  hint?: string;
}

/** The kinds whose spec carries a name from a finite vocabulary. A kind absent here has none. */
const VOCABULARY_FIELDS: Partial<Record<CreateEntitySpec['kind'], VocabularyField>> = {
  primitive: { key: 'mesh', fallback: 'sphere', noun: 'primitive mesh', options: PRIMITIVE_NAMES, valid: (v) => PRIMITIVE_NAMES.includes(v) },
  '2d': {
    key: 'shape', fallback: 'square', noun: '2D shape', options: PRIMITIVE_SPRITE_NAMES,
    valid: (v) => (PRIMITIVE_SPRITE_NAMES as readonly string[]).includes(v),
    hint: ' For an image sprite, create the entity then set Renderable2D.sprite to a texture GUID.',
  },
  light: { key: 'light', fallback: 'point', noun: 'light kind', options: LIGHT_KINDS, valid: isLightKind },
  ui: { key: 'preset', fallback: 'view', noun: 'UI preset', options: UI_PRESET_NAMES, valid: isUiPreset },
};

const shown = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : String(JSON.stringify(value)));

/** Apply the kind's default and check every vocabulary field. The input is not mutated — a caller's
 *  payload object is not the op's to rewrite. */
export function resolveCreateEntitySpec(raw: object): CreateEntitySpecResolution {
  const spec = { ...raw } as Record<string, unknown>;
  const kind = spec.kind;
  if (typeof kind !== 'string' || !isCreateEntityKind(kind)) {
    return { ok: false, error: `unknown entity kind ${shown(kind)} — nothing was created.`, options: [...CREATE_ENTITY_KINDS] };
  }
  const field = VOCABULARY_FIELDS[kind];
  if (field) {
    if (!spec[field.key]) spec[field.key] = field.fallback;
    const value = spec[field.key];
    if (typeof value !== 'string' || !field.valid(value)) {
      return { ok: false, error: `unknown ${field.noun} ${shown(value)} — nothing was created.${field.hint ?? ''}`, options: [...field.options] };
    }
  }
  return { ok: true, spec: spec as CreateEntitySpec };
}
