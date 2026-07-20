/** Load a scene JSON file into an ECS world. Shared between editor and runtime. */

import { type World } from 'koota';
import { getCurrentWorld, registerEntity, indexEntityGuid, findEntityByGuid } from '../ecs/world';
import { getAllTraits, getTraitByName } from '../ecs/traitRegistry';
import { loadModelTemplates, getCachedPrefab } from './meshTemplateCache';
import { isGuid, isExternalUrl, resolveRef, getAssetType, deriveGuid, newGuid, getAssetEntry } from './assetManifest';
import { markUIDirty } from '../ui/uiTreeStore';
import { markOverride, clearOverrideMarks, clearAllOverrideMarks } from './overrideMarks';
import { SCENE_FORMAT_VERSION } from '../version';
import { REF_FIELDS_BY_TRAIT } from '../scene/sceneValidation';
import { parseClipBank } from '../audio/clipBank';
import { parseAnimClipBank } from '../animation/animClipBank';
import { getRunMode } from '../systems/playState';
import { Transient } from '../traits/Transient';

/** A child subtree an instance adds beyond what its prefab defines. Anchored to
 *  an existing prefab member by `parentLocalId`; nested adds live in `children`
 *  (their parent is implicit in the tree shape). See docs/prefab-structural-overrides.md. */
export interface AddedEntity {
  /** localId of the prefab member this subtree's root hangs under (rootLocalId
   *  for the instance root). Ignored on nested `children`. */
  parentLocalId: number;
  guid: string;
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  children: AddedEntity[];
  // ── Reference-style added node (present only when this added node is itself a
  //    user-added NESTED prefab instance — e.g. a prefab dragged under a prefab
  //    member). `prefab` makes the node expand the child prefab at the anchor
  //    (parentLocalId) instead of spawning `traits`/`children`; the child's diffs
  //    ride in the structural fields below. Lets a user-added nested instance
  //    round-trip under its EXACT parent member, not re-anchored to scene root. ──
  /** Child prefab GUID. Presence ⇒ this node is a nested-instance reference. */
  prefab?: string;
  /** Per-localId field overrides on the nested instance (child localId space). */
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Child subtrees the nested instance itself adds (recursive — may hold further
   *  reference nodes). Distinct from `children` (which is empty for a reference node). */
  added?: AddedEntity[];
  /** Child prefab member localIds the nested instance deleted. */
  removed?: number[];
  /** Per-localId component names the nested instance removed from child members. */
  removedTraits?: Record<number, string[]>;
  /** The nested instance's deep overrides reaching into ITS nested descendants. */
  nestedOverrides?: NestedOverridePaths;
}

export interface SceneEntityEntry {
  id: number;
  name?: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  prefab?: string;
  /** A prefab-instance root's stable, scene-authored GUID. Prefab roots get NO
   *  guid from the prefab template (members clear theirs) and their guid is never
   *  an override, so without this they're unaddressable across a re-save. Persisted
   *  on the node and re-applied to the spawned root on load (then it anchors
   *  deriveInstanceMemberGuids), so UI refs into the instance survive. */
  guid?: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Structural overrides on a prefab instance (see AddedEntity). */
  added?: AddedEntity[];
  /** Prefab member localIds this instance deleted (top-most only; descendants cascade). */
  removed?: number[];
  /** Per-localId component (trait) names this instance deleted from prefab members. */
  removedTraits?: Record<number, string[]>;
  /** Scene-level overrides on this instance's NESTED instances (a prefab's own
   *  internal nested prefab instances, e.g. a ship's engine flames). Path-keyed so
   *  the scene can reach a member at ANY nesting depth (see NestedOverridePaths). */
  nestedOverrides?: NestedOverridePaths;
}

export interface SceneResourceRef {
  type: 'model' | 'riggedModel' | 'mesh' | 'material' | 'texture' | 'prefab' | 'font' | 'environment' | 'particle' | 'animation' | 'animset' | 'spriteanim' | 'rig2d' | 'audio' | 'shader' | 'timeline';
  path: string;
  postprocessor?: string;
}

export interface SceneData {
  version: number;
  /** v6+: explicit list of resources the scene needs. v5 and below: derived
   *  by walking entities at load time. SceneManager preloads these in parallel
   *  before instantiating any entities. */
  resources?: SceneResourceRef[];
  entities: SceneEntityEntry[];
}

export interface LoadSceneOptions {
  /** Fetch a prefab JSON file given its path. Returns null if not found. */
  fetchPrefab: (path: string) => Promise<object | null>;
  /** Called after all entities are spawned (runtime: registerEntity, editor: undo tracking) */
  onEntitySpawned?: (entity: any, oldId: number) => void;
  /** Whether to preload model templates from ModelSource entities */
  loadModels?: boolean;
  /** Called to re-instantiate a prefab instance. The caller handles prefab fetch + entity creation.
   *  `rootExtraTraits` are traits the scene file added on the prefab-instance root beyond what the
   *  prefab itself defines (e.g. user-added Rotate3D, AnimatePosition). `overrides` carries
   *  per-localId field-level edits captured at save time so children's local edits survive reload. */
  onInstantiatePrefab?: (
    source: string,
    parentId: number,
    rootTransform: Record<string, unknown> | undefined,
    oldEntityId: number,
    rootExtraTraits?: Record<string, unknown>,
    overrides?: Record<number, Record<string, Record<string, unknown>>>,
    structure?: InstanceStructureData,
    nestedOverrides?: Record<number, Record<number, Record<string, Record<string, unknown>>>>,
    /** The scene-authored stable guid for the instance root (SceneEntityEntry.guid),
     *  applied to the spawned root so it's addressable and anchors member derivation. */
    rootGuid?: string,
    /** The editor Hierarchy folder tag (EntityAttributes.editorFolder) captured on
     *  the instance root, re-applied so a foldered prefab instance stays in its
     *  folder across reload. Empty/undefined = ungrouped. */
    rootEditorFolder?: string,
  ) => void;
  /** Called before deleting a placeholder entity during prefab re-instantiation */
  onDeletePlaceholder?: (entityId: number) => void;
  /** Target world for entity spawning. Defaults to getCurrentWorld(). SceneManager
   *  passes the staging `nextWorld` so entities are isolated until the swap. */
  world?: World;
}

const TEXT_FIELDS = ['fontSize', 'fontWeight', 'textColor', 'textAlign'] as const;

/** Migrate v3→v4: move text fields from UIStyle to UIText, strip Transform from UI entities. */
function migrateSceneData(data: SceneData): void {
  if (data.version >= 4) return;
  for (const entry of data.entities) {
    // Move text fields from UIStyle → UIText
    const style = entry.traits.UIStyle;
    if (style && typeof style !== 'boolean') {
      const styleObj = style as Record<string, unknown>;
      const textFields: Record<string, unknown> = {};
      let hasText = false;
      for (const f of TEXT_FIELDS) {
        if (f in styleObj) {
          textFields[f] = styleObj[f];
          delete styleObj[f];
          hasText = true;
        }
      }
      if (hasText && !entry.traits.UIText) {
        entry.traits.UIText = textFields;
      }
    }
    // Strip Transform from UI entities (not needed for DOM-based UI)
    if (entry.traits.RenderableUI && entry.traits.Transform) {
      delete entry.traits.Transform;
    }
  }
  data.version = 4;
}

/** Migrate v4→v5: merge UIStyle, UIText, UIContent into UIElement. Strip elementType. */
function migrateV4toV5(data: SceneData): void {
  if (data.version >= 5) return;
  for (const entry of data.entities) {
    const uiEl = entry.traits.UIElement;
    if (!uiEl || typeof uiEl === 'boolean') continue;
    const el = uiEl as Record<string, unknown>;
    for (const traitName of ['UIStyle', 'UIText', 'UIContent'] as const) {
      const src = entry.traits[traitName];
      if (src && typeof src !== 'boolean') {
        Object.assign(el, src);
        delete entry.traits[traitName];
      }
    }
    // elementType removed — rendering is content-driven
    delete el.elementType;
  }
  data.version = 5;
}

/** Migrate v5→v6: derive `resources` array by walking entities. v6 scenes already
 *  have it; for older scenes we synthesize one in memory so SceneManager has a
 *  manifest to acquire from. The editor will write a real `resources` field on
 *  the next save. */
function migrateV5toV6(data: SceneData): void {
  if (data.version >= 6) {
    if (!data.resources) data.resources = [];
    return;
  }
  if (!data.resources) {
    data.resources = collectResourceRefsFromEntities(data.entities);
  }
  data.version = 6;
}

function migrateV6toV7(data: SceneData): void {
  if (data.version >= 7) return;
  for (const entry of data.entities) {
    const r2d = entry.traits['Renderable2D'];
    if (r2d && typeof r2d !== 'boolean') {
      const obj = r2d as Record<string, unknown>;
      if ('size' in obj) {
        const size = obj.size as number;
        obj.width = size;
        obj.height = size;
        delete obj.size;
      }
    }
  }
  data.version = 7;
}

/** Migrate v7→v8: Persistent.guid → EntityAttributes.guid. Persistent becomes a
 *  marker tag. Identity is consolidated on EntityAttributes for the universal
 *  cross-scene/cross-prefab UUID. */
function migrateV7toV8(data: SceneData): void {
  if (data.version >= 8) return;
  for (const entry of data.entities) {
    const p = entry.traits['Persistent'];
    if (p && typeof p === 'object') {
      const oldGuid = (p as Record<string, unknown>).guid as string | undefined;
      if (oldGuid) {
        const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
        if (ea && !ea.guid) ea.guid = oldGuid;
      }
      // Replace with marker tag (true) — Persistent no longer carries fields
      entry.traits['Persistent'] = true;
    }
  }
  data.version = 8;
}

/** Version-agnostic cleanup: `CameraFrame.showGizmo` used to be a serialized trait field but is
 *  now an editor-only preference (editorStore.cameraGizmoShown). Strip it from any loaded scene
 *  so the (now-unknown) field doesn't trip scene validation and gets dropped on the next save.
 *  Idempotent — safe to run every load. */
function stripLegacyCameraFrameShowGizmo(data: SceneData): void {
  for (const entry of data.entities) {
    const cf = entry.traits['CameraFrame'];
    if (cf && typeof cf === 'object' && 'showGizmo' in cf) delete (cf as Record<string, unknown>).showGizmo;
  }
}

/** Renderable trait names that carried the per-renderer `isActive` flag pre-v9. */
const RENDERABLE_TRAITS_V9 = new Set([
  'Renderable3D', 'Renderable3DPrimitive', 'Renderable2D', 'SkinnedModel', 'ParticleEmitter',
]);

/** v8→v9 helper: deep-walk any scene/prefab node and rename a renderable trait's
 *  `isActive` field → `isVisible` wherever it lives — directly under `traits`, in a
 *  prefab `overrides[localId][TraitName]` map, inside `added[]` subtrees, or in
 *  `nestedOverrides` paths. Every one of those stores keys the trait data by the TRAIT
 *  NAME, so a single rule — "a key that is a renderable trait name, whose object value
 *  carries `isActive`" — covers all locations. `EntityAttributes.isActive` (the entity
 *  on/off) is never under a renderable-trait key, so it is left untouched. Idempotent;
 *  also used by the one-time file-rewrite script. */
export function renameRenderableActiveToVisibleDeep(node: unknown): void {
  if (Array.isArray(node)) { for (const v of node) renameRenderableActiveToVisibleDeep(v); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (RENDERABLE_TRAITS_V9.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const t = value as Record<string, unknown>;
      if ('isActive' in t) {
        if (!('isVisible' in t)) t.isVisible = t.isActive;
        delete t.isActive;
      }
    }
    renameRenderableActiveToVisibleDeep(value);
  }
}

/** Migrate v8→v9: renderable traits' per-renderer `isActive` → `isVisible`, splitting
 *  it from the entity on/off `EntityAttributes.isActive`. Walks traits + prefab
 *  override/added/nestedOverride structures (see the helper). */
function migrateV8toV9(data: SceneData): void {
  if (data.version >= 9) return;
  for (const entry of data.entities) renameRenderableActiveToVisibleDeep(entry);
  // Terminal version of the migration chain. Sourced from SCENE_FORMAT_VERSION so
  // the constant is the single source of truth: bumping it (without chaining a new
  // migration) can't silently mislabel a freshly-migrated file as under-versioned.
  // The per-step guards above keep their literals as intermediate "step done"
  // markers — only the terminal stamp follows the constant.
  data.version = SCENE_FORMAT_VERSION;
}

/** Spawn a prefab into a target world. Generic runtime version (no editor undo,
 *  no editor-specific selection bookkeeping). Used by SceneManager and the
 *  runtime scene loader. Returns the new root entity id, or 0 on failure.
 *
 *  When `source` is provided, every spawned entity gets a `PrefabInstance` trait
 *  attached so the editor can identify prefab roots/children at runtime
 *  (instance badge in Hierarchy, Apply-to-Prefab, etc.). The prefab JSON itself
 *  doesn't carry PrefabInstance traits — we add them programmatically here. */
/** Apply a per-localId override map to a freshly-instantiated prefab using a
 *  caller-provided localId → ecsId map. Used by the scene load path where the
 *  map is already in hand. Skips unknown trait/field/localId with console.debug. */
export function applyOverridesByLocalToEcs(
  world: World,
  localToEcs: Map<number, number>,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
): void {
  if (!overrides || Object.keys(overrides).length === 0) return;
  // Map ecsId → entity handle so we can add traits the instance gained beyond the
  // prefab (added-trait overrides), not just set fields on traits it already has.
  const ecsToEntity = new Map<number, { id(): number; has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void; add(i: unknown): void }>();
  for (const e of world.entities) ecsToEntity.set((e as { id(): number }).id(), e as never);

  for (const [localIdStr, traitMap] of Object.entries(overrides)) {
    const localId = Number(localIdStr);
    const ecsId = localToEcs.get(localId);
    if (!ecsId) {
      console.debug(`[loadSceneFile] override skipped: no entity for localId ${localId}`);
      continue;
    }
    const entity = ecsToEntity.get(ecsId);
    if (!entity) continue;
    for (const [traitName, fields] of Object.entries(traitMap)) {
      const meta = getTraitByName(traitName);
      if (!meta) {
        console.debug(`[loadSceneFile] override skipped: unknown trait ${traitName}`);
        continue;
      }
      if (meta.category === 'tag') {
        // Added-tag override: the instance carries a tag the prefab lacks here.
        if (!entity.has(meta.trait)) entity.add(meta.trait);
        markOverride(ecsId, traitName, '');
        continue;
      }
      // AoS traits (function/undefined schema) carry non-scalar fields NOT listed in
      // meta.fields (AnimationLibrary.animSets/boneMaps, SkinnedMeshRenderer.materials,
      // UIAction.onClickSet). The meta.fields guard would drop them on load — the same
      // bone-map-lost-on-reload bug as the save path. Skip the guard for AoS; keep it
      // for SoA so a genuinely renamed/stale scalar field is still ignored.
      const aos = typeof (meta.trait as { schema?: unknown }).schema !== 'object';
      const known: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        // EntityAttributes.editorFolder is the editor Hierarchy folder tag — a real
        // per-instance field with NO Inspector metadata, so it isn't in meta.fields and
        // the SoA guard would wrongly drop it. Let it through so a foldered prefab
        // instance keeps its folder when the tag rides the override map (e.g. an
        // /api/scene-mutate edit). Mirrored in prefab.ts applyOverridesByRootInstance.
        const allowed = (field in meta.fields) || (meta.name === 'EntityAttributes' && field === 'editorFolder');
        if (!aos && !allowed) {
          console.debug(`[loadSceneFile] override skipped: unknown field ${traitName}.${field}`);
          continue;
        }
        known[field] = value;
        // Seed an explicit mark from the file's override map: this field is a
        // recorded override and must survive serialize even if it later coincides
        // with the prefab base. See overrideMarks.ts.
        markOverride(ecsId, traitName, field);
      }
      if (!entity.has(meta.trait)) {
        // Added-trait override: the instance carries a trait the prefab lacks at
        // this localId. Add the whole trait rather than dropping it on the floor.
        entity.add((meta.trait as (d: Record<string, unknown>) => unknown)(known));
      } else {
        const current = entity.get(meta.trait) as Record<string, unknown>;
        entity.set(meta.trait, { ...current, ...known });
      }
    }
  }
}

/** Deep-merge two per-localId override maps (localId → trait → field → value).
 *  `b` wins on conflicts. Used to overlay a scene's nested-instance overrides on
 *  top of a prefab row's own overrides. Neither input is mutated. */
export function mergeOverrideMaps(
  a: Record<number, Record<string, Record<string, unknown>>> | undefined,
  b: Record<number, Record<string, Record<string, unknown>>>,
): Record<number, Record<string, Record<string, unknown>>> {
  const out: Record<number, Record<string, Record<string, unknown>>> = {};
  for (const [lid, traits] of Object.entries(a ?? {})) {
    out[Number(lid)] = {};
    for (const [t, fields] of Object.entries(traits)) out[Number(lid)][t] = { ...fields };
  }
  for (const [lid, traits] of Object.entries(b)) {
    const k = Number(lid);
    out[k] ??= {};
    for (const [t, fields] of Object.entries(traits)) out[k][t] = { ...(out[k][t] ?? {}), ...fields };
  }
  return out;
}

/** Path-keyed nested overrides — lets an OUTER layer (scene or ancestor prefab)
 *  override a member nested at ANY depth, with the outermost layer winning. Each
 *  key is a dot-joined chain of nested-prefab row localIds from the addressing
 *  instance down to the target instance; the value is that target instance's
 *  per-localId override map. `"3"` overrides the instance at row 3; `"3.5"` reaches
 *  the instance at row 5 nested inside it. A single-segment key is the legacy
 *  one-level form, so older scene files remain valid unchanged. */
export type NestedOverridePaths = Record<string, Record<number, Record<string, Record<string, unknown>>>>;

/** Split path-keyed overrides at one expansion step (nested row `rowLocalId`):
 *  `direct` is the override map for that child instance's OWN members (the exact
 *  key `rowLocalId`); `forward` re-keys every deeper path (`rowLocalId.…`) with the
 *  leading segment stripped, to thread into the child's own expansion. */
export function descendNestedOverrides(
  paths: NestedOverridePaths | undefined,
  rowLocalId: number,
): { direct?: Record<number, Record<string, Record<string, unknown>>>; forward?: NestedOverridePaths } {
  if (!paths) return {};
  const prefix = String(rowLocalId);
  let direct: Record<number, Record<string, Record<string, unknown>>> | undefined;
  let forward: NestedOverridePaths | undefined;
  for (const [key, map] of Object.entries(paths)) {
    if (key === prefix) direct = map;
    else if (key.startsWith(prefix + '.')) (forward ??= {})[key.slice(prefix.length + 1)] = map;
  }
  return { direct, forward };
}

/** Merge two path-keyed override maps; `b` (the outer layer) wins per field. Used
 *  to overlay forwarded outer overrides on a prefab row's own deep overrides so the
 *  outermost layer wins at every depth. Neither input is mutated. */
export function mergeNestedOverridePaths(
  a: NestedOverridePaths | undefined,
  b: NestedOverridePaths | undefined,
): NestedOverridePaths | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: NestedOverridePaths = {};
  for (const [k, m] of Object.entries(a)) out[k] = m;
  for (const [k, m] of Object.entries(b)) out[k] = out[k] ? mergeOverrideMaps(out[k], m) : m;
  return out;
}

/** Structural overrides applied on top of a freshly-instantiated prefab. */
export interface InstanceStructureData {
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
}

type EntityHandle = {
  id(): number;
  has(t: unknown): boolean;
  get(t: unknown): unknown;
  set(t: unknown, d: unknown): void;
  add(i: unknown): void;
  remove(t: unknown): void;
  destroy(): void;
};

type PrefabLike = { entities: { localId?: number; traits: Record<string, unknown> }[]; rootLocalId?: number };

/** Every localId in the prefab subtree rooted at `rootLocalId` (inclusive). Used
 *  to cascade an entity removal to its prefab descendants. parentId in a prefab
 *  entity's EntityAttributes is stored as a localId. */
export function prefabSubtreeLocalIds(prefab: PrefabLike, rootLocalId: number): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const e of prefab.entities) {
    const ea = e.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parent = (ea && typeof ea !== 'boolean' ? (ea.parentId as number) : 0) || 0;
    const lid = e.localId ?? 0;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(lid);
  }
  const out: number[] = [];
  const stack = [rootLocalId];
  while (stack.length) {
    const lid = stack.pop()!;
    out.push(lid);
    for (const c of childrenOf.get(lid) || []) stack.push(c);
  }
  return out;
}

/** The world-parameterized primitives that differ between the editor and runtime
 *  structural-apply paths. Everything else (the removal → trait-removal → addition
 *  reconciliation against `prefab`, the re-anchor-vs-skip rule, the depth-first
 *  add order) is shared in `applyStructureCore` so the two paths can never drift.
 *  F7 from PREFAB_REVIEW: this is the "WorldOps shim" the prior review punted on.
 *
 *  The editor passes `getCurrentWorld()`-backed ops (deleteEntities, findEntity,
 *  registerEntity, its 4-call nested-instance expansion, markStructureDirty/UI);
 *  the runtime passes koota-`world`-direct ops (h.destroy, byId map, the single
 *  instantiatePrefabIntoWorld call). `log` keeps each side's existing warn prefix. */
export interface StructureApplyOps {
  /** Delete these ECS ids (cascading to children — both impls cascade). */
  deleteEntities(ecsIds: number[]): void;
  /** Resolve an ECS id to a handle whose traits can be read/removed, or undefined. */
  findEntity(ecsId: number): { has(t: unknown): boolean; remove(t: unknown): void } | undefined;
  /** Spawn a plain added entity from trait args and return its new ECS id (the
   *  caller has already excluded PrefabInstance and stamped parentId/guid). */
  spawnAdded(traitArgs: unknown[]): number;
  /** Expand a user-added nested-instance reference node under `parentEcsId`. */
  spawnNestedInstance(node: AddedEntity, parentEcsId: number): void;
  /** Run after the whole structure is applied (editor marks dirty; runtime no-ops). */
  onComplete?(): void;
  /** console-warn prefix, e.g. "[Prefab]" / "[loadSceneFile]". */
  logPrefix: string;
}

/** World-parameterized structural-apply core shared by the editor
 *  (`applyStructureByRootInstance`) and the runtime (`applyStructureByLocalToEcs`).
 *  Reconciles a captured structure (added entities, removed entities, removed
 *  traits) against `prefab` on top of an already-built `localToEcs` map.
 *  Order: entity removals → component removals → additions — an add can't anchor
 *  to a localId that's about to be removed. An addition whose anchor localId is
 *  merely absent from the prefab re-anchors to the instance root; one whose anchor
 *  was deliberately removed this pass is skipped. */
export function applyStructureCore(
  ops: StructureApplyOps,
  localToEcs: Map<number, number>,
  prefab: PrefabLike,
  structure: InstanceStructureData,
): void {
  // localIds intentionally deleted by THIS pass — an addition anchored to one of
  // these is skipped (deliberate removal), whereas an addition whose anchor is
  // merely absent from the prefab re-anchors to the root (see additions below).
  const removedLocals = new Set<number>();

  // 1. Entity removals (cascade prefab descendants). Prune the deleted localIds
  // from the map too, so a later addition can't anchor to a destroyed member.
  if (structure.removed?.length) {
    const toDelete: number[] = [];
    for (const lid of structure.removed) {
      for (const sub of prefabSubtreeLocalIds(prefab, lid)) {
        const ecs = localToEcs.get(sub);
        if (ecs) toDelete.push(ecs);
        localToEcs.delete(sub);
        removedLocals.add(sub);
      }
    }
    if (toDelete.length) ops.deleteEntities(toDelete);
  }

  // 2. Component removals.
  if (structure.removedTraits) {
    for (const [lidStr, names] of Object.entries(structure.removedTraits)) {
      const ecs = localToEcs.get(Number(lidStr));
      if (!ecs) continue;
      const entity = ops.findEntity(ecs);
      if (!entity) continue;
      for (const name of names) {
        const meta = getTraitByName(name);
        if (meta && entity.has(meta.trait)) entity.remove(meta.trait);
      }
    }
  }

  // 3. Additions (depth-first, parent before child). Not tagged PrefabInstance —
  // re-detected structurally on the next capture, so save/reload is idempotent.
  // EXCEPT a reference node (node.prefab) → expand a whole user-added nested instance.
  if (structure.added?.length) {
    const spawnNode = (node: AddedEntity, parentEcsId: number): void => {
      // Reference node → expand the child prefab as a user-added nested instance
      // under the anchor (parentLocalId stays 0 so the next capture re-detects it).
      if (node.prefab) {
        ops.spawnNestedInstance(node, parentEcsId);
        return;
      }
      const traitArgs: unknown[] = [];
      for (const [traitName, data] of Object.entries(node.traits)) {
        const meta = getTraitByName(traitName);
        if (!meta || meta.name === 'PrefabInstance') continue;
        if (data === true) { traitArgs.push(meta.trait()); continue; }
        const d = { ...(data as Record<string, unknown>) };
        if (meta.name === 'EntityAttributes') {
          d.parentId = parentEcsId;
          if (node.guid) d.guid = node.guid;
        }
        traitArgs.push(meta.trait(d));
      }
      if (!traitArgs.length) return;
      const newId = ops.spawnAdded(traitArgs);
      for (const child of node.children) spawnNode(child, newId);
    };
    const rootEcs = localToEcs.get(prefab.rootLocalId ?? 1);
    for (const node of structure.added) {
      let parentEcsId = localToEcs.get(node.parentLocalId);
      if (!parentEcsId) {
        if (removedLocals.has(node.parentLocalId)) {
          // Anchor was deleted by this same pass — a deliberate removal, so the
          // dependent addition is dropped.
          console.warn(`${ops.logPrefix} added entity "${node.name}" anchor localId ${node.parentLocalId} was removed; skipping`);
          continue;
        }
        // Anchor merely absent from the prefab (e.g. the prefab changed) — keep the
        // addition by re-anchoring it to the instance root rather than losing it.
        parentEcsId = rootEcs;
        if (!parentEcsId) continue;
        console.warn(`${ops.logPrefix} added entity "${node.name}" anchor localId ${node.parentLocalId} missing; re-anchored to root`);
      }
      spawnNode(node, parentEcsId);
    }
  }

  ops.onComplete?.();
}

/** Apply structural overrides (added entities, removed entities, removed traits)
 *  on top of an instantiated prefab, using a localId → ecsId map. Runtime side —
 *  operates on a koota world directly so the loader stays free of editor deps.
 *  Delegates to the shared `applyStructureCore` (see F7) with koota-world ops. */
export function applyStructureByLocalToEcs(
  world: World,
  localToEcs: Map<number, number>,
  prefab: PrefabLike,
  structure: InstanceStructureData,
): void {
  // Lazily build an id → handle map only when a removal/component pass needs it.
  let byId: Map<number, EntityHandle> | null = null;
  const handleById = (): Map<number, EntityHandle> => {
    if (!byId) {
      byId = new Map<number, EntityHandle>();
      for (const e of world.entities) byId.set((e as EntityHandle).id(), e as EntityHandle);
    }
    return byId;
  };

  applyStructureCore(
    {
      logPrefix: '[loadSceneFile]',
      deleteEntities: (ecsIds) => {
        const toDelete = new Set(ecsIds);
        for (const e of world.entities) {
          const h = e as EntityHandle;
          if (toDelete.has(h.id())) h.destroy();
        }
      },
      findEntity: (ecsId) => handleById().get(ecsId),
      spawnAdded: (traitArgs) => {
        const entity = world.spawn(...(traitArgs as Parameters<typeof world.spawn>));
        registerEntity(entity, world);
        return entity.id();
      },
      spawnNestedInstance: (node, parentEcsId) => {
        const child = getCachedPrefab(node.prefab!) as { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string } | null;
        if (!child) { console.warn(`[loadSceneFile] added nested instance not cached: ${node.prefab}`); return; }
        instantiatePrefabIntoWorld(
          world, child, parentEcsId, undefined, node.prefab, node.overrides,
          { added: node.added, removed: node.removed, removedTraits: node.removedTraits }, undefined, node.nestedOverrides,
        );
      },
    },
    localToEcs,
    prefab,
    structure,
  );
}

type PrefabFileEntry = {
  localId?: number;
  traits: Record<string, unknown>;
  prefab?: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  /** A prefab row's OWN deep overrides reaching into its nested descendants
   *  (path-keyed). Outer layers merge over these (outermost wins). */
  nestedOverrides?: NestedOverridePaths;
};

/** Give prefab-instance MEMBERS a stable, addressable GUID.
 *
 *  Prefab templates clear member GUIDs (so two instances don't collide), so a
 *  freshly-expanded member has none — nothing outside the instance can reference
 *  it. Here we derive one deterministically from the nearest scene-anchored
 *  ancestor's GUID + the chain of prefab-member localIds down to the member.
 *  Same scene → same id every load (no need to serialize it); different instances
 *  anchor on different root GUIDs, so members stay unique. Only fills EMPTY guids
 *  — a scene-assigned guid (e.g. the instance root) is never overwritten.
 *
 *  Anchoring uses a snapshot of guids taken BEFORE deriving, so the result is
 *  independent of iteration order (derived guids never become anchors). */
export function deriveInstanceMemberGuids(world: World): void {
  const piMeta = getTraitByName('PrefabInstance');
  const attrMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !attrMeta) return;

  type Row = { handle: EntityHandle; origGuid: string; parentId: number; stepId: number; hasPI: boolean };
  const rows = new Map<number, Row>();
  for (const e of world.entities as Iterable<EntityHandle>) {
    if (!e.has(attrMeta.trait)) continue;
    const ea = e.get(attrMeta.trait) as { guid?: string; parentId?: number };
    const hasPI = e.has(piMeta.trait);
    // A member's position in the chain is its localId — EXCEPT a nested-instance
    // root, whose localId is the (shared) inner root id; its distinguishing
    // position is parentLocalId (which OUTER row produced it). Two sibling nested
    // instances share inner localIds, so without this their members would collide.
    const pi = hasPI ? (e.get(piMeta.trait) as { localId?: number; parentLocalId?: number }) : null;
    const stepId = pi ? (pi.parentLocalId || pi.localId || 0) : 0;
    rows.set(e.id(), { handle: e, origGuid: ea.guid || '', parentId: ea.parentId ?? 0, stepId, hasPI });
  }

  for (const [id, row] of rows) {
    if (!row.hasPI || row.origGuid) continue; // only members that lack a guid
    // Walk up to the nearest ancestor that had a guid BEFORE this pass.
    const path: number[] = [row.stepId];
    let anchor = '';
    let cur = rows.get(row.parentId);
    const seen = new Set<number>([id]);
    while (cur && !seen.has(cur.handle.id())) {
      if (cur.origGuid) { anchor = cur.origGuid; break; }
      seen.add(cur.handle.id());
      path.unshift(cur.stepId);
      cur = rows.get(cur.parentId);
    }
    if (!anchor) continue; // no scene-anchored ancestor → leave unaddressable
    const derived = deriveGuid(`${anchor}|${path.join('.')}`);
    row.handle.set(attrMeta.trait, { ...(row.handle.get(attrMeta.trait) as Record<string, unknown>), guid: derived });
    indexEntityGuid(row.handle, world); // keep the guid index warm for this '' → guid mint
  }
}

export function instantiatePrefabIntoWorld(
  world: World,
  prefab: { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string },
  parentId: number = 0,
  rootTransform?: Record<string, unknown>,
  source?: string,
  overrides?: Record<number, Record<string, Record<string, unknown>>>,
  structure?: InstanceStructureData,
  _stack?: Set<string>,
  /** Overrides an OUTER layer (scene / ancestor prefab) applies to this instance's
   *  nested descendants, path-keyed so any depth is reachable; forwarded recursively
   *  as nested rows expand. Outermost layer wins (see NestedOverridePaths). */
  nestedOverrides?: NestedOverridePaths,
): number {
  const stack = _stack ?? new Set<string>();
  if (prefab.id) {
    if (stack.has(prefab.id)) {
      console.error(`[loadSceneFile] cycle detected — prefab ${prefab.id} nests itself; aborting`);
      return 0;
    }
    stack.add(prefab.id);
  }

  const piMeta = getTraitByName('PrefabInstance');
  const localToEcs = new Map<number, number>();
  // ECS ids of THIS prefab's own (non-nested) members — rootInstanceId is set only
  // on these; inner members keep their own (child) rootInstanceId from recursion.
  const ownMemberIds: number[] = [];

  // First pass: spawn each row (nested rows recurse into the child prefab).
  for (const entry of prefab.entities) {
    if (entry.prefab) {
      const child = getCachedPrefab(entry.prefab) as { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string } | null;
      if (!child) { console.warn(`[loadSceneFile] nested prefab not cached: ${entry.prefab}`); continue; }
      const rowLocalId = entry.localId ?? 0;
      // Overrides an OUTER layer addressed at this nested row: `direct` hits this
      // child's own members (merged over the row's own overrides — outer wins);
      // `forward` reaches deeper and is threaded into the child's expansion. The
      // row may ALSO carry its own deep overrides, which the outer layer wins over.
      const { direct: outerDirect, forward: outerForward } = descendNestedOverrides(nestedOverrides, rowLocalId);
      const childOverrides = outerDirect ? mergeOverrideMaps(entry.overrides, outerDirect) : entry.overrides;
      const childNested = mergeNestedOverridePaths(entry.nestedOverrides, outerForward);
      const childRoot = instantiatePrefabIntoWorld(
        world, child, 0, undefined, entry.prefab, childOverrides,
        { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits }, stack, childNested,
      );
      // Stamp parentLocalId so a later serialize knows which row produced this
      // instance (and can store/restore its scene-level overrides).
      if (childRoot && rowLocalId && piMeta) {
        let childEntity: { has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void } | undefined;
        for (const e of world.entities) {
          if ((e as { id(): number }).id() === childRoot) { childEntity = e as never; break; }
        }
        if (childEntity?.has(piMeta.trait)) {
          childEntity.set(piMeta.trait, { ...(childEntity.get(piMeta.trait) as Record<string, unknown>), parentLocalId: rowLocalId });
        }
      }
      if (childRoot && rowLocalId) localToEcs.set(rowLocalId, childRoot);
      continue;
    }

    const traitArgs: unknown[] = [];
    for (const [traitName, data] of Object.entries(entry.traits)) {
      const meta = getTraitByName(traitName);
      if (!meta) continue;
      // Skip any PrefabInstance trait baked into the JSON — we add our own with
      // the correct source + rootInstanceId below
      if (meta.name === 'PrefabInstance') continue;
      if (data === true) traitArgs.push(meta.trait());
      else traitArgs.push(meta.trait(data as Record<string, unknown>));
    }
    // Attach PrefabInstance trait if the registry knows about it. rootInstanceId
    // is set in the second pass after we know the root ECS id.
    if (piMeta && source !== undefined) {
      traitArgs.push(piMeta.trait({
        source,
        localId: entry.localId ?? 0,
        rootInstanceId: 0, // patched in pass 2
      }));
    }
    if (traitArgs.length > 0) {
      const entity = world.spawn(...traitArgs as Parameters<typeof world.spawn>);
      registerEntity(entity, world);
      clearOverrideMarks(entity.id()); // fresh member — drop stale marks on a reused id
      const localId = entry.localId ?? 0;
      if (localId) localToEcs.set(localId, entity.id());
      ownMemberIds.push(entity.id());
    }
  }

  const rootLocalId = prefab.rootLocalId ?? 1;
  const rootEcsId = localToEcs.get(rootLocalId) ?? 0;

  // Build an id → handle map ONCE for the post-spawn passes below. Without it each
  // pass scanned the whole world per row (O(n²) over a large prefab/scene).
  const handleById = new Map<number, EntityHandle>();
  for (const e of world.entities) handleById.set((e as EntityHandle).id(), e as EntityHandle);

  // Second pass: remap parentIds in EntityAttributes. A nested-instance root's
  // parentId is read from the OUTER file's EntityAttributes (its live parentId was
  // set to 0 by the recursive call); ordinary rows read their live (= file) value.
  const attrMeta = getTraitByName('EntityAttributes');
  if (attrMeta) {
    for (const entry of prefab.entities) {
      const localId = entry.localId ?? 0;
      if (!localId) continue;
      const newId = localToEcs.get(localId);
      if (!newId) continue;
      const handle = handleById.get(newId);
      if (!handle || !handle.has(attrMeta.trait)) continue;
      const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
      const localParent = (ea?.parentId as number) ?? 0;
      const newParentId = localParent === 0
        ? parentId  // root → parent passed by caller
        : (localToEcs.get(localParent) ?? parentId);
      handle.set(attrMeta.trait, { ...(handle.get(attrMeta.trait) as Record<string, unknown>), parentId: newParentId });
    }
  }

  // Patch rootInstanceId on this prefab's OWN members only (never inner members).
  if (piMeta && source !== undefined && rootEcsId) {
    for (const id of ownMemberIds) {
      const handle = handleById.get(id);
      if (handle?.has(piMeta.trait)) {
        handle.set(piMeta.trait, { ...(handle.get(piMeta.trait) as Record<string, unknown>), rootInstanceId: rootEcsId });
      }
    }
  }

  // Apply root transform override (e.g. scene-level placement of the prefab)
  if (rootTransform && rootEcsId) {
    const tfMeta = getTraitByName('Transform');
    const handle = handleById.get(rootEcsId);
    if (tfMeta && handle?.has(tfMeta.trait)) {
      const tf = { ...(handle.get(tfMeta.trait) as Record<string, number>) };
      for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz']) {
        if (rootTransform[k] !== undefined) tf[k] = rootTransform[k] as number;
      }
      handle.set(tfMeta.trait, tf);
    }
  }

  // Apply per-localId field overrides captured at scene-save time. Runs AFTER
  // rootTransform so an override on Transform fields wins over the legacy
  // root-Transform-only mechanism. rootExtraTraits is applied separately by the
  // caller AFTER this function returns; overriding fields on user-added root
  // traits is a known limitation (see plan).
  if (overrides) {
    applyOverridesByLocalToEcs(world, localToEcs, overrides);
  }

  // Apply structural overrides (added/removed entities, removed traits) last, so
  // additions can resolve their anchor localId against the fully-built map and a
  // removal can't strand an override that ran before it.
  if (structure && (structure.added?.length || structure.removed?.length || structure.removedTraits)) {
    applyStructureByLocalToEcs(world, localToEcs, prefab, structure);
  }

  // Pop this prefab off the cycle stack — the guard tracks ANCESTORS in the
  // current expansion, not every prefab ever expanded. Without this, a prefab
  // nested more than once as a SIBLING (e.g. the same Engine Flame under both
  // wings) would falsely trip the cycle guard on the second expansion.
  if (prefab.id) stack.delete(prefab.id);

  return rootEcsId;
}

/** Spawn a prefab instance into a world at RUNTIME (gameplay) — as opposed to
 *  scene-load instantiation, which is driven by loadSceneFile + onInstantiatePrefab.
 *
 *  A scene-authored instance carries a serialized root guid (stable across reloads).
 *  A runtime instance has none, so this mints a FRESH unique root guid: multiple live
 *  instances of the same prefab must never share a guid (the guid is now the entity's
 *  identity in the index + cross-entity refs). Members get deterministic guids derived
 *  off that unique root, so they're unique per instance too. Root + members are added
 *  to the guid index, so they're immediately addressable by guid.
 *
 *  `opts.guidSeed` makes the root guid DETERMINISTIC — `deriveGuid(seed)` instead of the
 *  random `newGuid()`. A caller on a deterministic sim path (e.g. a Timeline control track
 *  spawning on an exact tick) MUST pass a stable seed built from stable ids (the Director's
 *  guid + track/clip index — never a runtime entity id), so two identical-seed replays mint
 *  the same guid and the event journal stays byte-reproducible. Omit it for genuinely ad-hoc
 *  runtime spawns, which want a fresh random identity each time.
 *
 *  Returns the root entity's koota id (0 on failure). */
export function spawnPrefabInstance(
  world: World,
  prefab: { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string },
  opts: { parentId?: number; rootTransform?: Record<string, unknown>; source?: string; guidSeed?: string; forceTransient?: boolean } = {},
): number {
  const rootEcsId = instantiatePrefabIntoWorld(
    world, prefab, opts.parentId ?? 0, opts.rootTransform, opts.source ?? prefab.id,
  );
  if (!rootEcsId) return 0;
  const attrMeta = getTraitByName('EntityAttributes');
  let root: EntityHandle | undefined;
  for (const e of world.entities) { if ((e as EntityHandle).id() === rootEcsId) { root = e as EntityHandle; break; } }
  if (attrMeta && root?.has(attrMeta.trait)) {
    const ea = root.get(attrMeta.trait) as Record<string, unknown>;
    if (!ea.guid) {
      const guid = opts.guidSeed ? deriveGuid(opts.guidSeed) : newGuid();
      root.set(attrMeta.trait, { ...ea, guid }); indexEntityGuid(root, world);
    }
  }
  // TRANSIENCE (preview-mode-refactor, Phase 2): a runtime spawn while the run-mode is not
  // `stopped` (a scrub/preview/play control-track spawn) is a live-world artifact that must
  // never reach disk. Mark the root Transient — the serializer skips it AND its whole subtree,
  // so a preview/scrub spawn can't leak into a saved scene. (During Play the snapshot/revert
  // already discards it; the tag makes the guarantee uniform + covers a plain drag-scrub, which
  // holds no snapshot.)
  //   `forceTransient` bypasses the RunMode check for callers whose spawn is ALWAYS an editor-
  // preview artifact regardless of mode — the Timeline scrub reconciler (`previewControlAt`) runs
  // from the commit/undo pose while the mode is still `stopped`, so without this a scrub-spawned
  // control prefab would be untagged and serialize into the authored scene (timeline review C1).
  if (root && (opts.forceTransient || getRunMode() !== 'stopped')) root.add(Transient);
  // Derive unique member guids off the (now guid-stamped) root, then index them.
  deriveInstanceMemberGuids(world);
  return rootEcsId;
}

/** True if a trait field holds something the resource loader should fetch —
 *  a GUID (resolved via manifest) or an external URL. References are GUID-only;
 *  internal asset paths are no longer accepted (rejected loudly by resolveRef).
 *  One predicate for every ref field — mesh/material/sprite/imageSrc share the
 *  exact same contract. */
function looksFetchable(ref: string | undefined): boolean {
  return !!ref && (isGuid(ref) || isExternalUrl(ref));
}

/** Simple scalar ref field → the SceneResourceRef type it acquires. This data-drives
 *  the scalar portion of collectResourceRefsFromEntities from REF_FIELDS_BY_TRAIT (the
 *  registry the validator + tree-shaker already share), so a new scalar ref field added
 *  there is acquired/refcounted at load — not silently omitted from the scene `resources`
 *  manifest (which caused pop-in + a scene-scoped refcount leak). Keyed `${trait}.${field}`.
 *  Fields present in REF_FIELDS_BY_TRAIT but ABSENT here need special handling and are
 *  done explicitly in the loop below (Renderable3DPrimitive.material's dynamic
 *  texture-vs-material type; ModelSource.glbPath's postprocessor payload). Guarded by a
 *  drift test that asserts every scalar registry field yields a resource ref. */
const SCALAR_RESOURCE_TYPE_BY_FIELD: Record<string, SceneResourceRef['type']> = {
  'Renderable3D.mesh': 'mesh',
  'Collider3D.mesh': 'mesh',   // convex/trimesh collision mesh (may differ from the render mesh)
  'Renderable3D.material': 'material',
  'SkinnedModel.model': 'riggedModel',
  'SkeletalAnimator.animSet': 'animset',
  'Renderable2D.sprite': 'texture',
  'Renderable2D.material': 'shader', // 2D custom material (.shader.json) — lazy-loaded by Scene2D
  'Text3D.font': 'font',
  'Text2D.font': 'font',
  'UIElement.imageSrc': 'texture',
  'PrefabInstance.source': 'prefab',
  'Environment.hdrPath': 'environment',
  'ParticleEmitter.effect': 'particle',
  'SpriteAnimator.clipSet': 'spriteanim',
  'SkinnedSprite2D.rig': 'rig2d',
  'AudioSource.clip': 'audio',
  'Director.timeline': 'timeline',
  // Registry fields intentionally NOT here (handled explicitly in the loop below):
  //   Renderable3DPrimitive.material — dynamic texture-or-material via getAssetType
  //   ModelSource.glbPath            — carries a postprocessor payload
};

/** Walk entities and extract every resource ref they reference. Mirrors the
 *  editor's collectResourceRefs in scene/serialize.ts but lives here so the
 *  runtime loader doesn't depend on the editor module. Sorted + deduped.
 *  `path` in the returned refs may be a GUID or a path; downstream loaders
 *  accept both.
 *
 *  The SCALAR ref fields are data-driven from REF_FIELDS_BY_TRAIT (via
 *  SCALAR_RESOURCE_TYPE_BY_FIELD); the non-scalar / dynamic / payload-bearing refs
 *  (AnimationLibrary.animSets, SkinnedMeshRenderer.materials, Renderable3DPrimitive.material,
 *  ModelSource.glbPath, UIElement.fontFamily, structural entry.prefab) stay explicit. */
export function collectResourceRefsFromEntities(
  entities: ReadonlyArray<{ traits: Record<string, unknown>; prefab?: string; added?: AddedEntity[] }>,
): SceneResourceRef[] {
  const seen = new Set<string>();
  const refs: SceneResourceRef[] = [];
  const add = (type: SceneResourceRef['type'], ref: string) => {
    if (!ref) return;
    const key = `${type}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, path: ref });
  };

  // Flatten structural additions into the scan so an added child's mesh/material/
  // texture/effect is acquired at load too (a `traits`-only view per added node).
  const flat: Array<{ traits: Record<string, unknown>; prefab?: string }> = [];
  for (const entry of entities) {
    flat.push(entry);
    const walkAdded = (node: AddedEntity) => {
      // A reference node carries a child prefab GUID — surface it so the prefab is
      // acquired; recurse BOTH the plain `children` and a reference node's `added`.
      flat.push({ traits: node.traits, prefab: node.prefab });
      node.children.forEach(walkAdded);
      node.added?.forEach(walkAdded);
    };
    entry.added?.forEach(walkAdded);
  }

  for (const entry of flat) {
    // Scalar refs — data-driven from REF_FIELDS_BY_TRAIT so a new registry field is
    // acquired/refcounted here too (not just validated + kept in the prod build).
    // Fields needing dynamic type / extra payload are skipped here and handled below.
    for (const [traitName, fields] of Object.entries(REF_FIELDS_BY_TRAIT)) {
      const t = entry.traits[traitName];
      if (!t || typeof t !== 'object') continue;
      for (const field of fields) {
        const rtype = SCALAR_RESOURCE_TYPE_BY_FIELD[`${traitName}.${field}`];
        if (!rtype) continue; // special-cased below (or intentionally not a resource)
        const v = (t as Record<string, unknown>)[field] as string | undefined;
        if (looksFetchable(v)) add(rtype, v!);
      }
    }

    // ── Non-scalar / dynamic / payload-bearing refs (not expressible above) ──

    // AnimationLibrary — shared cross-model clips (P6), an ARRAY of .animset.json's.
    // Each animset's `source` GLB holds the actual clips; listing the animset keeps
    // both the animset file AND (via the tree-shaker's animset→source follow) the clip
    // GLB in the build. The source GLB is loaded lazily by the render sync.
    const animLib = entry.traits['AnimationLibrary'] as Record<string, unknown> | undefined;
    if (animLib && typeof animLib !== 'boolean') {
      const animSets = animLib.animSets;
      if (Array.isArray(animSets)) {
        for (const ref of animSets) if (looksFetchable(ref as string)) add('animset', ref as string);
      }
    }
    // Per-mesh material overrides (Unity-style SkinnedMeshRenderer) resolve to
    // .mat.json materials — acquire each so the materialCache loads them (else
    // resolveMaterial returns undefined and the node keeps its baked GLB material).
    const smr = entry.traits['SkinnedMeshRenderer'] as Record<string, unknown> | undefined;
    if (smr && typeof smr !== 'boolean') {
      const materials = smr.materials as Record<string, string> | undefined;
      if (materials && typeof materials === 'object') {
        for (const guid of Object.values(materials)) if (looksFetchable(guid)) add('material', guid);
      }
    }
    // AudioSource.clips — the named clip bank, a JSON-string `[{key,ref}]`. Each
    // `ref` is an audio GUID; parse + collect them so a source's banked clips
    // (referenced by key from `audio.setClip`/`audio.playOneShot`, NOT by a scalar
    // trait ref) all ship + survive a save. The scalar `AudioSource.clip` is already
    // handled by the loop above.
    const audioSrc = entry.traits['AudioSource'] as Record<string, unknown> | undefined;
    if (audioSrc && typeof audioSrc !== 'boolean') {
      for (const c of parseClipBank(audioSrc.clips)) if (looksFetchable(c.ref)) add('audio', c.ref);
    }
    // Animator.clips — the named keyframe-clip bank, a JSON-string `[{name, clip, …}]`.
    // Each `clip` is a `.anim.json` GUID; parse + collect so a multi-clip animator's clips
    // all ship + survive a save. The active `clip` field is a NAME now (not a fetchable
    // ref), so Animator intentionally has NO entry in REF_FIELDS_BY_TRAIT.
    const animator = entry.traits['Animator'] as Record<string, unknown> | undefined;
    if (animator && typeof animator !== 'boolean') {
      for (const c of parseAnimClipBank(animator.clips)) if (looksFetchable(c.clip)) add('animation', c.clip);
    }
    const r3dp = entry.traits['Renderable3DPrimitive'] as Record<string, unknown> | undefined;
    if (r3dp && typeof r3dp !== 'boolean') {
      // material may be a .mat.json GUID or a raw texture GUID — collect under
      // its real type so the right loader preloads it (mirrors serialize.ts).
      const material = r3dp.material as string | undefined;
      if (looksFetchable(material)) {
        const t = isGuid(material!) ? getAssetType(material!) : undefined;
        add(t === 'texture' ? 'texture' : 'material', material!);
      }
    }
    // UIElement.fontFamily — a CSS family NAME (not a guid), acquired as a font.
    // (UIElement.imageSrc is the scalar 'texture' ref handled by the loop above.)
    const ui = entry.traits['UIElement'] as Record<string, unknown> | undefined;
    if (ui && typeof ui !== 'boolean') {
      const fontFamily = ui.fontFamily as string | undefined;
      if (fontFamily) add('font', fontFamily);
    }
    // ModelSource.glbPath — a 'model' ref that also threads a postprocessor payload,
    // so it can't go through the plain scalar add() (which carries no extra field).
    const ms = entry.traits['ModelSource'] as Record<string, unknown> | undefined;
    if (ms && typeof ms !== 'boolean') {
      const glb = ms.glbPath as string | undefined;
      const postprocessor = ms.postprocessor as string | undefined;
      // GUID-only, like every other ref (resolveRef rejects internal paths).
      if (looksFetchable(glb)) {
        const key = `model:${glb}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ type: 'model', path: glb!, postprocessor: postprocessor || 'none' });
        }
      }
    }
    // MaterialInstance overrides with kind:'texture' carry a per-instance `ref` (a
    // sprite/texture GUID bound to a 2D shader's extra sampler) — nested in the overrides
    // array, so not a scalar registry field. List each so the resources manifest stays
    // complete (the texture acquire is a no-op/lazy, but the build tree-shaker + a save
    // re-derive should see it). The shader's own texture-PARAM defaults live inside the
    // .shader.json (async to read) — followed by the build tree-shaker's processShader, not here.
    const mi = entry.traits['MaterialInstance'] as Record<string, unknown> | undefined;
    if (mi && typeof mi !== 'boolean' && Array.isArray(mi.overrides)) {
      for (const o of mi.overrides) {
        const ov = o as { kind?: string; ref?: unknown };
        if (ov?.kind === 'texture' && looksFetchable(ov.ref as string | undefined)) add('texture', ov.ref as string);
      }
    }
    // Structural prefab reference on the entity itself (not a trait field).
    if (looksFetchable(entry.prefab)) add('prefab', entry.prefab!);
  }

  refs.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
  return refs;
}

/** Resolve a serialized parentId to a live koota id in `world`.
 *  - GUID string (current files) → the entity carrying that guid, via the guid index.
 *  - number > 0 (legacy files) → remapped through `idMap` (file id → fresh koota id).
 *  - '' / 0 / unknown → 0 (root). */
function resolveParentRef(raw: unknown, idMap: Map<number, number>, world: World): number {
  if (typeof raw === 'string') {
    if (!raw) return 0;
    const ent = findEntityByGuid(raw, world);
    return ent ? ent.id() : 0;
  }
  if (typeof raw === 'number' && raw > 0) return idMap.get(raw) ?? 0;
  return 0;
}

/** Spawn entities from scene data, remap parentIds, optionally load models and prefabs. */
export async function loadSceneFile(data: SceneData, options: LoadSceneOptions): Promise<void> {
  // New scene → drop every prior override mark (ecs ids are reused across worlds).
  // Marks for this scene's instances are re-seeded below as overrides are applied.
  clearAllOverrideMarks();
  migrateSceneData(data);
  migrateV4toV5(data);
  migrateV5toV6(data);
  migrateV6toV7(data);
  migrateV7toV8(data);
  migrateV8toV9(data);
  stripLegacyCameraFrameShowGizmo(data);
  // Forward-version guard: the migration steps only upgrade OLDER files. A scene
  // authored by a NEWER engine (version > current) passes through untouched and
  // would load silently even though its data may not be understood — warn loudly
  // so a downgrade mismatch isn't invisible.
  if (typeof data.version === 'number' && data.version > SCENE_FORMAT_VERSION) {
    console.warn(
      `[scene] file format version ${data.version} is newer than this engine supports ` +
      `(${SCENE_FORMAT_VERSION}). Loading anyway — some data may be ignored or misread. ` +
      `Update the engine if the scene looks wrong.`,
    );
  }
  const { fetchPrefab, onEntitySpawned, loadModels = true } = options;
  const world = options.world ?? getCurrentWorld();
  const allTraits = getAllTraits();
  const idMap = new Map<number, number>();
  const spawnedByEntryId = new Map<number, any>(); // entry.id → spawned handle (for pass 2)

  // First pass: spawn all entities
  for (const entry of data.entities) {
    const traitArgs: any[] = [];
    for (const [traitName, traitData] of Object.entries(entry.traits)) {
      const meta = allTraits.find((m) => m.name === traitName);
      if (!meta) continue;
      if (traitData === true) traitArgs.push(meta.trait());
      else if (traitName === 'EntityAttributes') {
        // parentId in the file is a GUID (current) or a legacy file id (number) —
        // neither is a valid live koota id, and spawning a string into the numeric
        // parentId field would corrupt it. Spawn with 0; pass 2 resolves the real id.
        traitArgs.push(meta.trait({ ...(traitData as Record<string, unknown>), parentId: 0 }));
      }
      else traitArgs.push(meta.trait(traitData as Record<string, unknown>));
    }
    if (traitArgs.length > 0) {
      const entity = world.spawn(...traitArgs);
      registerEntity(entity, world);
      onEntitySpawned?.(entity, entry.id);
      idMap.set(entry.id, entity.id());
      spawnedByEntryId.set(entry.id, entity);
    }
  }

  // Remap parentIds (in EntityAttributes). Resolve each entity's serialized parentId
  // (a GUID in current files, a numeric file id in legacy ones) to its fresh koota id.
  // The guid form needs no idMap — it survives the world rebuild on its own.
  const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');
  if (attrMeta) {
    for (const entry of data.entities) {
      const ea = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
      if (!ea) continue;
      const entity = spawnedByEntryId.get(entry.id);
      if (!entity) continue;
      const newParentId = resolveParentRef(ea.parentId, idMap, world);
      if (!newParentId) continue; // root (or unresolved) — already spawned with parentId 0
      if (entity.has(attrMeta.trait)) {
        entity.set(attrMeta.trait, { ...(entity.get(attrMeta.trait) as Record<string, unknown>), parentId: newParentId });
      }
    }
  }

  // Notify UI tree that entities changed (one call for the whole batch)
  markUIDirty();

  // Preload model templates from ModelSource entities. This standalone preload
  // runs only when a caller drives loadSceneFile WITHOUT SceneManager's refcounted
  // acquire (SceneManager passes loadModels:false — it already acquired the model).
  // Mirror acquireModel's LOD-aware branch: when the model went through the LOD
  // pipeline the build tree-shaker DROPS the source GLB, so loading the source
  // path would 404 on device — load each baked LOD instead. (F2)
  if (loadModels) {
    for (const entry of data.entities) {
      const ms = entry.traits['ModelSource'] as Record<string, string> | undefined;
      if (!ms?.glbPath) continue;
      const glbPath = resolveRef(ms.glbPath);
      if (!glbPath) {
        console.warn(`[loadSceneFile] Unresolvable model ref: ${ms.glbPath}`);
        continue;
      }
      const lodPaths = getAssetEntry(ms.glbPath)?.modelCache?.lodPaths;
      try {
        if (lodPaths && lodPaths.length > 0) {
          await Promise.allSettled(lodPaths.map(p => loadModelTemplates(p, undefined, ms.postprocessor || 'none')));
        } else {
          await loadModelTemplates(glbPath, undefined, ms.postprocessor || 'none');
        }
      } catch (e) {
        console.warn(`[loadSceneFile] Failed to load model templates for ${glbPath}:`, e);
      }
    }
  }

  // Re-instantiate prefab instances — delegated to caller (editor vs runtime specific)
  if (options.onInstantiatePrefab) {
    for (const entry of data.entities) {
      const pi = entry.traits['PrefabInstance'] as Record<string, unknown> | undefined;
      // A prefab instance is expressed by a top-level `prefab` ref (scene serialize
      // + nested-prefab rows) OR a baked PrefabInstance trait (legacy / live tag).
      // The trait form keeps its rootInstanceId guard so non-root members are skipped;
      // the `prefab`-field form is always a root.
      const source = (entry.prefab as string | undefined) ?? (pi?.source as string | undefined);
      if (!source) continue;
      if (pi && !entry.prefab) {
        const rootInstanceId = pi.rootInstanceId as number;
        if (rootInstanceId !== 0 && rootInstanceId !== entry.id) continue;
      }

      const newEntityId = idMap.get(entry.id);
      if (!newEntityId) continue;

      // Verify prefab exists before instantiating
      const prefab = await fetchPrefab(source);
      if (!prefab) {
        console.warn(`[loadSceneFile] Could not find prefab "${source}"`);
        continue;
      }

      const rootTf = entry.traits['Transform'] as Record<string, unknown> | undefined;
      const rootEa = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
      // Parent the spawned prefab where the placeholder sat — remap the FILE
      // parentId to its ECS id (pass 1 already spawned that parent). Without this,
      // a prefab instance parented to another entity (e.g. a nested prefab under an
      // outer member) would hang off a stale file id.
      const ecsParent = resolveParentRef(rootEa?.parentId, idMap, world);

      // Gather scene-level customizations the user added to the prefab-instance root
      // beyond what the prefab itself defines (Rotate3D, AnimatePosition, etc.). These
      // would otherwise be lost when the placeholder is destroyed below. Skip
      // PrefabInstance (managed by the spawn), Transform (in rootTf), and
      // EntityAttributes (name/parentId come from the prefab + placement — applying
      // it wholesale would clobber the spawned root with the placeholder's file ids).
      const rootExtraTraits: Record<string, unknown> = {};
      for (const [name, data] of Object.entries(entry.traits)) {
        if (name === 'PrefabInstance' || name === 'Transform' || name === 'EntityAttributes') continue;
        rootExtraTraits[name] = data;
      }

      options.onDeletePlaceholder?.(newEntityId);

      await options.onInstantiatePrefab(
        source,
        ecsParent,
        rootTf,
        newEntityId,
        rootExtraTraits,
        entry.overrides,
        { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits },
        entry.nestedOverrides,
        entry.guid,
        typeof rootEa?.editorFolder === 'string' ? (rootEa.editorFolder as string) : undefined,
      );

      // Demoted to debug: this fires per instance on every (hot-)reload — at log
      // level it spams the console + isn't free under heavy reload churn (F9).
      console.debug(`[loadSceneFile] Instantiated prefab "${source}"`);
    }
  }

  // All prefab instances are now expanded with correct parentIds — give their
  // members stable, addressable GUIDs so entities can reference into instances.
  deriveInstanceMemberGuids(world);
}
