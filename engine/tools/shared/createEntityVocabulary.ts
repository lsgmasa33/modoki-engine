/** The `create-entity` spec vocabulary, as BOTH MCP servers advertise it (#1216 C-3).
 *
 *  `modoki_create_entity` (flat fields) and `device_create_entity` (a nested `spec`) build the same
 *  entities through the same op, and each used to carry its own idea of the vocabulary: the editor
 *  tool hand-listed the light/preset enums and spelled the mesh names out in prose, and the device
 *  tool took `spec` as `z.record(any)`, so `{kind:'primitive', mseh:'cube'}` passed its schema and
 *  built the default sphere. One declaration here; both tools derive their schema from it.
 *
 *  ⚠️ **A COPY of the runtime tables, and it cannot be an import.** The tables it mirrors are
 *  `CREATE_ENTITY_KINDS`/`LIGHT_KINDS` (`runtime/scene/entityCreateSpecs.ts`), `PRIMITIVE_NAMES`
 *  (`runtime/loaders/primitives.ts`, which imports three), `PRIMITIVE_SPRITE_NAMES`
 *  (`runtime/loaders/sceneValidation.ts`), `UI_PRESET_NAMES` (`runtime/ui/uiAuthoring.ts`) and the
 *  per-kind field in `createEntitySpec.ts`. Neither MCP package imports the engine, so
 *  `tests/tools/vocabularyEnumParity.test.ts` pins every list here to its table — and the op still
 *  refuses by its own tables, so drift costs a zod refusal, never a wrong entity.
 *
 *  Dependency-free, like `inputVocabulary.ts` beside it. */

export const CREATE_ENTITY_KINDS = ['empty', 'primitive', '2d', 'canvas2d', 'ui', 'camera', 'light', 'environment', 'particle'] as const;
export type CreateEntityKind = (typeof CREATE_ENTITY_KINDS)[number];

export const PRIMITIVE_MESHES = ['cube', 'box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule'] as const;
export const SPRITE_SHAPES = ['circle', 'square', 'triangle'] as const;
export const LIGHT_KINDS = ['ambient', 'directional', 'point', 'spot'] as const;
export const UI_PRESETS = ['view', 'text', 'image', 'button', 'input', 'slider'] as const;

/** Each kind's one vocabulary field, its values and its default. A kind absent here takes only `kind`.
 *  ⚠️ `fallback` is for DESCRIPTIONS only: a tool never sends it. The op applies the default, so curl
 *  and both tools build the same entity (#1070 close-out review). */
export const CREATE_ENTITY_FIELDS = {
  primitive: { key: 'mesh', values: PRIMITIVE_MESHES, fallback: 'sphere' },
  '2d': { key: 'shape', values: SPRITE_SHAPES, fallback: 'square' },
  light: { key: 'light', values: LIGHT_KINDS, fallback: 'point' },
  ui: { key: 'preset', values: UI_PRESETS, fallback: 'view' },
} as const satisfies Partial<Record<CreateEntityKind, { key: string; values: readonly string[]; fallback: string }>>;

/** `"cube / box / …"` — the prose form a description needs, derived so it cannot go stale. */
export const vocabularyProse = (values: readonly string[]): string => values.join(' / ');
