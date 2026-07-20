/** Scene/trait JSON validation — pure, dependency-light so it runs in BOTH the
 *  browser (runtime load path) and Node (Vite dev-server endpoints).
 *
 *  Returns *warnings*, never throws and never blocks: the engine's load path is
 *  deliberately forgiving (warn-but-load), so a single typo surfaces a precise
 *  message instead of blanking the view. Two consumers:
 *    - runtime `loadSceneFile` — console.warn each finding on load.
 *    - dev server `/api/validate-scene` + `/api/scene-mutate` — return findings
 *      in the HTTP response so an agent editing JSON can self-correct.
 *
 *  The trait schema is optional: when no browser has connected to push its live
 *  trait registry, structural + GUID-reference checks still run; trait/field
 *  type checks are skipped (reported once as an info note by the caller). */

import { isGuid, isExternalUrl, isInternalAssetPath } from '../loaders/assetRefRules';

/** Asset-reference fields, keyed by the trait they live on. A value in one of
 *  these fields must be a GUID or an external URL — never a project-internal
 *  asset path (`/games/x/foo.mesh.json`). This is the single source of truth;
 *  `editor/scene/serialize.ts` imports it for its save-time guard. */
export const REF_FIELDS_BY_TRAIT: Record<string, string[]> = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite', 'material'],
  Text3D: ['font'],
  Text2D: ['font'],
  SpriteAnimator: ['clipSet'],
  SkinnedSprite2D: ['rig'],
  UIElement: ['imageSrc'],
  ModelSource: ['glbPath'],
  SkinnedModel: ['model'],
  SkeletalAnimator: ['animSet'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
  ParticleEmitter: ['effect'],
  // NOTE: Animator has NO scalar ref field — `clip` is the active clip NAME, and the
  // `.anim.json` GUIDs live inside the JSON-string `clips` bank (parsed explicitly in
  // collectResourceRefsFromEntities + the tree-shaker's probeTraitRefs, like AudioSource.clips).
  AudioSource: ['clip'],
  // Director.timeline is a scalar `.timeline.json` GUID ref. The clip/audio GUIDs the timeline
  // references live INSIDE that JSON asset (walked by SceneManager's transitive loop + the
  // tree-shaker's timeline follower), not in trait fields — same shape as an Animator bank.
  Director: ['timeline'],
};
// NOTE: this registry is the single source of truth for SCALAR asset-ref fields —
// consumed by the validator (above) AND the build tree-shaker's keep-walk
// (plugins/asset-tree-shaker.ts), so a new ref field added here is covered by both.
// Non-scalar refs (UIElement.fontFamily = a CSS family name; AnimationLibrary.animSets
// = an array of guids) are intentionally NOT here and are handled explicitly.

/** Primitive sprite keywords that are valid `Renderable2D.sprite` values even
 *  though they're neither GUIDs nor URLs. */
const PRIMITIVE_SPRITES = new Set(['circle', 'square', 'triangle']);

type FieldType = 'number' | 'string' | 'boolean' | 'color' | 'enum' | 'entityRef' | 'bindings' | 'materialOverrides';

/** Per-trait schema slice the validator needs — a subset of the editor's
 *  TraitMeta, serializable so the browser can push it over the HMR socket.
 *  A field with `type` omitted is *known* (won't be flagged as unknown) but is
 *  not type-checked — used for fields present in the koota schema whose type the
 *  registry can't confidently infer (objects, arrays). */
export interface TraitSchema {
  category: 'component' | 'resource' | 'tag';
  fields: Record<string, { type?: FieldType; options?: string[] }>;
}

export interface SceneSchema {
  traits: Record<string, TraitSchema>;
}

export interface ValidationResult {
  warnings: string[];
  /** True when a schema was supplied and used for trait/field type checks. */
  schemaApplied: boolean;
}

interface SceneEntityLike {
  id?: number;
  name?: string;
  traits?: Record<string, unknown>;
}

/** Validate an on-disk scene object. `schema` is optional (see module docs). */
export function validateSceneData(data: unknown, schema?: SceneSchema): ValidationResult {
  const warnings: string[] = [];
  const schemaApplied = !!schema;

  const scene = data as { entities?: unknown };
  if (!scene || typeof scene !== 'object') {
    return { warnings: ['scene is not an object'], schemaApplied };
  }
  if (!Array.isArray(scene.entities)) {
    return { warnings: ['scene.entities is missing or not an array'], schemaApplied };
  }

  scene.entities.forEach((raw, idx) => {
    const entity = raw as SceneEntityLike;
    const label = entityLabel(entity, idx);

    if (entity == null || typeof entity !== 'object') {
      warnings.push(`${label}: entity is not an object`);
      return;
    }
    if (entity.traits == null || typeof entity.traits !== 'object') {
      warnings.push(`${label}: missing or invalid 'traits' object`);
      return;
    }

    for (const [traitName, traitVal] of Object.entries(entity.traits)) {
      const traitSchema = schema?.traits[traitName];
      if (schema && !traitSchema) {
        warnings.push(`${label}: unknown trait '${traitName}'`);
        // Still run ref checks below even for unknown traits.
      }

      // Tag traits serialize as `true`; component/resource as a field object.
      if (typeof traitVal === 'boolean') {
        if (traitSchema && traitSchema.category !== 'tag') {
          warnings.push(`${label}.${traitName}: expected a field object, got boolean (tag) `);
        }
        continue;
      }
      if (traitVal == null || typeof traitVal !== 'object') {
        warnings.push(`${label}.${traitName}: trait value must be an object or boolean`);
        continue;
      }

      const fields = traitVal as Record<string, unknown>;

      // Field-level type checks (only when a schema is available).
      if (traitSchema) {
        for (const [field, value] of Object.entries(fields)) {
          const hint = traitSchema.fields[field];
          if (!hint) {
            warnings.push(`${label}.${traitName}: unknown field '${field}'`);
            continue;
          }
          if (!hint.type) continue; // known field, but no confident type to check
          // EntityAttributes.parentId is a number in the live trait schema (the runtime
          // koota-id handle) but is SERIALIZED as the parent's GUID string ('' for root;
          // a legacy numeric file id is also accepted). Don't flag the on-disk guid form.
          if (traitName === 'EntityAttributes' && field === 'parentId'
              && (typeof value === 'string' || typeof value === 'number')) continue;
          const mismatch = typeMismatch(hint.type, value);
          if (mismatch) {
            warnings.push(`${label}.${traitName}.${field}: ${mismatch}`);
          } else if (hint.type === 'enum' && hint.options && typeof value === 'string' && !hint.options.includes(value)) {
            warnings.push(`${label}.${traitName}.${field}: '${value}' not in [${hint.options.join(', ')}]`);
          }
        }
      }

      // Asset-reference rule: ref fields must be a GUID or external URL.
      const refFields = REF_FIELDS_BY_TRAIT[traitName];
      if (refFields) {
        for (const field of refFields) {
          const v = fields[field];
          if (typeof v !== 'string' || v === '') continue;
          if (traitName === 'Renderable2D' && field === 'sprite' && PRIMITIVE_SPRITES.has(v)) continue;
          if (isGuid(v) || isExternalUrl(v)) continue;
          if (isInternalAssetPath(v)) {
            warnings.push(
              `${label}.${traitName}.${field}: internal asset path '${v}' — references must be a GUID (use the asset's id / .meta.json sidecar)`,
            );
          } else {
            warnings.push(`${label}.${traitName}.${field}: '${v}' is not a GUID or URL`);
          }
        }
      }
    }
  });

  // ── Structural / referential-integrity pass (schema-independent) — catches the
  //    most common agent-edit mistakes BEFORE a confusing render: duplicate ids,
  //    dangling/self parentId, dangling entity-ref targets, prefab self-reference. (F4)
  const ids = new Set<number>();
  const guids = new Set<string>();
  const dupIds = new Set<number>();
  for (const raw of scene.entities) {
    const e = raw as SceneEntityLike;
    if (e == null || typeof e !== 'object') continue;
    if (typeof e.id === 'number') { if (ids.has(e.id)) dupIds.add(e.id); ids.add(e.id); }
    const g = entAttrs(e)?.guid;
    if (typeof g === 'string' && g) guids.add(g);
  }
  for (const id of dupIds) warnings.push(`duplicate entity id #${id} — ids must be unique`);

  scene.entities.forEach((raw, idx) => {
    const e = raw as SceneEntityLike;
    if (e == null || typeof e !== 'object') return;
    const label = entityLabel(e, idx);
    const attrs = entAttrs(e);
    const ownGuid = typeof attrs?.guid === 'string' ? attrs.guid : undefined;

    // parentId: GUID (current) or numeric file id (legacy); '' / 0 = root.
    const pid = attrs?.parentId;
    if (typeof pid === 'string' && pid !== '') {
      if (pid === ownGuid) warnings.push(`${label}: parentId references itself`);
      else if (!guids.has(pid)) warnings.push(`${label}: parentId '${pid}' references no entity in the scene (orphan/re-root at load)`);
    } else if (typeof pid === 'number' && pid !== 0) {
      if (typeof e.id === 'number' && pid === e.id) warnings.push(`${label}: parentId references itself`);
      else if (!ids.has(pid)) warnings.push(`${label}: parentId #${pid} references no entity in the scene (orphan/re-root at load)`);
    }

    // Entity→entity refs: UIAction.bindings[].target must resolve to a scene guid.
    const ua = e.traits?.UIAction;
    if (ua && typeof ua === 'object') {
      const bindings = (ua as { bindings?: unknown }).bindings;
      if (Array.isArray(bindings)) {
        for (const b of bindings) {
          const t = b && typeof b === 'object' ? (b as { target?: unknown }).target : undefined;
          if (typeof t === 'string' && t !== '' && !guids.has(t)) {
            warnings.push(`${label}.UIAction.target '${t}' references no entity in the scene (dangling)`);
          }
        }
      }
    }

    // Prefab self-reference: an instance whose source is its OWN guid would recurse.
    const pi = e.traits?.PrefabInstance;
    if (pi && typeof pi === 'object' && ownGuid) {
      const src = (pi as { source?: unknown }).source;
      if (typeof src === 'string' && src === ownGuid) warnings.push(`${label}.PrefabInstance.source references its own entity (self-reference)`);
    }
  });

  return { warnings, schemaApplied };
}

/** Read an entity's serialized EntityAttributes object, or undefined. */
function entAttrs(e: SceneEntityLike | undefined): { guid?: unknown; parentId?: unknown } | undefined {
  const a = e?.traits ? (e.traits as { EntityAttributes?: unknown }).EntityAttributes : undefined;
  return a && typeof a === 'object' ? (a as { guid?: unknown; parentId?: unknown }) : undefined;
}

function entityLabel(entity: SceneEntityLike | undefined, idx: number): string {
  const name = entity?.name || (entity?.traits as { EntityAttributes?: { name?: string } } | undefined)?.EntityAttributes?.name;
  const id = entity?.id;
  if (name) return `entity '${name}'${id != null ? ` (#${id})` : ''}`;
  if (id != null) return `entity #${id}`;
  return `entity[${idx}]`;
}

/** Returns a human-readable mismatch message, or null if the value fits the type. */
function typeMismatch(type: FieldType, value: unknown): string | null {
  switch (type) {
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value) ? null : `expected number, got ${describe(value)}`;
    case 'string':
      return typeof value === 'string' ? null : `expected string, got ${describe(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `expected boolean, got ${describe(value)}`;
    case 'enum':
      return typeof value === 'string' ? null : `expected string (enum), got ${describe(value)}`;
    case 'entityRef':
      return typeof value === 'string' ? null : `expected entity GUID string, got ${describe(value)}`;
    case 'bindings': {
      if (!Array.isArray(value)) return `expected binding array, got ${describe(value)}`;
      for (let i = 0; i < value.length; i++) {
        const b = value[i] as Record<string, unknown> | null;
        if (!b || typeof b !== 'object') return `binding[${i}] must be an object`;
        if (b.event !== undefined) {
          if (typeof b.event !== 'string') return `binding[${i}].event must be a string`;
          if (!['click', 'change', 'submit'].includes(b.event)) return `binding[${i}].event "${b.event}" is not one of click/change/submit`;
        }
        if (b.kind !== 'set' && b.kind !== 'call') return `binding[${i}].kind must be 'set' or 'call' (got ${describe(b.kind)})`;
        if (b.kind === 'set') {
          for (const k of ['component', 'property'] as const) {
            if (typeof b[k] !== 'string') return `binding[${i}].${k} must be a string`;
          }
        } else if (b.kind === 'call') {
          if (typeof b.action !== 'string') return `binding[${i}].action must be a string`;
        }
      }
      return null;
    }
    case 'materialOverrides': {
      if (!Array.isArray(value)) return `expected override array, got ${describe(value)}`;
      const KINDS = ['uniform', 'prop', 'texture'];
      const SOURCES = ['constant', 'time', 'store', 'curve'];
      for (let i = 0; i < value.length; i++) {
        const o = value[i] as Record<string, unknown> | null;
        if (!o || typeof o !== 'object') return `override[${i}] must be an object`;
        // `target` may be '' — a freshly-added, not-yet-configured override (the runtime
        // ignores it). Only reject a non-string.
        if (typeof o.target !== 'string') return `override[${i}].target must be a string`;
        if (o.kind !== undefined && !KINDS.includes(o.kind as string)) return `override[${i}].kind must be 'uniform', 'prop', or 'texture'`;
        // A `texture` override (2D extra-sampler swap) has NO source — it carries a static
        // sprite/texture GUID `ref` instead. Validate the ref and skip the source checks.
        if (o.kind === 'texture') {
          if (o.ref !== undefined && typeof o.ref !== 'string') return `override[${i}].ref must be a string (a sprite/texture GUID)`;
          continue;
        }
        const src = o.source as Record<string, unknown> | undefined;
        if (!src || typeof src !== 'object') return `override[${i}].source must be an object`;
        if (!SOURCES.includes(src.type as string)) return `override[${i}].source.type "${describe(src.type)}" is not one of ${SOURCES.join('/')}`;
        // A curve source is authored as JSON — validate its nested shape so a malformed one is
        // caught here instead of throwing every frame in materialInstanceSystem.
        if (src.type === 'curve') {
          if (!Array.isArray(src.points)) return `override[${i}].source (curve) must have a points array`;
          const drv = src.driver as Record<string, unknown> | undefined;
          if (!drv || typeof drv !== 'object') return `override[${i}].source (curve) must have a driver`;
          if (drv.type === 'curve' || !SOURCES.includes(drv.type as string)) return `override[${i}].source.driver.type must be a non-curve source`;
        }
      }
      return null;
    }
    case 'color':
      // Colors are stored as a packed number (0xRRGGBB) or a CSS string (#fff).
      return typeof value === 'number' || typeof value === 'string' ? null : `expected color number or string, got ${describe(value)}`;
    default:
      return null;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
