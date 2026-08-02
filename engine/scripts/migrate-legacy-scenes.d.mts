/** Type sidecar for `migrate-legacy-scenes.mjs` — see that file for the design
 *  rationale. Hand-written because the module is plain JS (a Node CLI driving a
 *  running editor via `fetch`), following the sibling `.d.mts` convention
 *  established by `engine/scripts/ota/schema.d.mts`.
 *
 *  The scene/entity/schema shapes below are deliberately loose (`unknown` fields,
 *  index signatures) — they mirror on-disk scene JSON and the `/api/trait-schema`
 *  payload, both freeform by nature (arbitrary trait names and fields), not a
 *  fixed engine type this script could import. */

/** A scene entity as it appears in scene JSON — legacy (numeric `id`) or current
 *  (GUID-identified). Only the fields this module actually reads/branches on are
 *  named; everything else passes through the index signature untouched. */
export interface LegacySceneEntity {
  id?: number;
  guid?: string;
  name?: string;
  traits?: Record<string, unknown> & { EntityAttributes?: { guid?: string } };
  [key: string]: unknown;
}

/** A whole scene document (legacy or migrated). */
export interface LegacySceneDoc {
  version?: number;
  entities?: LegacySceneEntity[];
  [key: string]: unknown;
}

/** One field's schema entry from `/api/trait-schema` — only `default` is read. */
export interface TraitSchemaField {
  default?: unknown;
  [key: string]: unknown;
}

/** One trait's schema entry from `/api/trait-schema`. */
export interface TraitSchemaEntry {
  fields?: Record<string, TraitSchemaField>;
  [key: string]: unknown;
}

/** The `/api/trait-schema` response shape this script consumes. */
export interface TraitSchemaPayload {
  schemaAvailable?: boolean;
  traits?: Record<string, TraitSchemaEntry>;
  [key: string]: unknown;
}

/** Pair old/new entities by IDENTITY (guid, else `EntityAttributes.guid`, else
 *  `name:<name>`) rather than array position — see the .mjs for why a reorder
 *  must not read as data loss. `byKey` is keyed by the NEW entities' keys. */
export function pairEntities(
  oe: LegacySceneEntity[],
  ne: LegacySceneEntity[],
): { pairable: boolean; byKey: Map<string, LegacySceneEntity>; oKeys: string[]; movedCount: number };

/** Flattens `/api/trait-schema`'s payload to trait → field → scalar default,
 *  dropping fields that declare none. */
export function defaultsByTrait(schema: TraitSchemaPayload | null | undefined): Record<string, Record<string, unknown>>;

/** Accepts a migrated scene only if the save changed nothing but the mechanical
 *  things (version bump, dropped numeric `id`, an entity ref becoming a GUID, a
 *  field omitted because it still held its trait default, entity reordering).
 *  Returns the list of problems found — empty means accepted. `schema` is
 *  optional: without it, every field removal is reported (the safe direction). */
export function checkMigration(
  old: LegacySceneDoc,
  next: LegacySceneDoc,
  schema?: TraitSchemaPayload | null,
): string[];
