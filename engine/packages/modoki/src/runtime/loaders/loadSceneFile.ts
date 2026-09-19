/** Load a scene JSON file into an ECS world. Shared between editor and runtime. */

import { type Entity, type World } from 'koota';
import { getCurrentWorld, spawnEntity, destroyEntity, indexEntityGuid, findEntityById, findEntityByGuid } from '../core/ecs/world';
import { getAllTraits, getTraitByName } from '../core/ecs/traitRegistry';
import { loadModelTemplates, getCachedPrefab } from './meshTemplateCache';
import { isGuid, isExternalUrl, resolveRef, getAssetType, deriveGuid, newGuid, getAssetEntry, type AssetType } from './assetManifest';
import { durableGuid, deriveMemberGuid, memberStepId } from '../core/assetRefRules';
import { deriveAuthoredEntityGuids } from './authoredEntityGuids';
import { parseEntryPrefabs } from '../traits/UIEntries';
import { markUIDirty } from '../ui/uiTreeStore';
import { markOverride, clearOverrideMarks, clearAllOverrideMarks } from './overrideMarks';
import { emptyDocMap, hasDocKey } from '../core/docKeys';
import { isPersistentTraitField } from '../core/ecs/traitSchema';
import {
  mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, foldTraitOverride,
  descendPathKeyed, nestedPathKey, mergeNestedStructurePaths,
  type NestedOverridePaths,
} from './prefabOverrides';
import { SCENE_FORMAT_VERSION } from '../core/version';
import { classifyFormatVersion } from '../core/formatVersion';
import { REF_FIELDS_BY_TRAIT } from './sceneValidation';
import { parseClipBankResult } from '../audio/clipBank';
import { parseAnimClipBankResult } from '../animation/animClipBank';
import { getRunMode } from '../core/playState';
import { Transient } from '../core/traits/Transient';
import { TemplateAddedKey, addedKeyStep, templateKeyOf, setTemplateKey } from '../core/templateIdentity';
import { noteTemplateDoc, templateKeysIn, recoverTemplateKey, healMissesIn, type KeyRecoveryNode } from './templateKeyRecovery';
import { packedOf } from '../core/ecs/entityTable';
import { rebaseMemberTokens, hasMemberToken, isMemberToken, parseMemberToken, memberPathKey, type MemberStep } from '../core/templateRefs';
import { mapStringValues } from '../core/assetRefRules';
import { migrateUIAnchorZIndexStructured } from './uiAnchorZIndexMigration';
import { collectSubtreeIds } from '../core/ecs/subtreeCollect';

/** The structural delta an OUTER layer (a scene, or an ancestor prefab) applies INSIDE a nested
 *  instance that expanded from one of its rows — the interior counterpart of `NestedOverridePaths`,
 *  and keyed by the same path grammar (`nestedPathKey`).
 *
 *  Before #1358 the only per-row channel a scene had was the VALUE delta, so a structural edit made
 *  inside a row's own expansion — deleting a member, dragging one out — was captured by nothing and
 *  came back on the next load, with the dragged-out entity duplicating its guid. The user-added
 *  nested path already had this (an `AddedEntity` reference node carries `added`/`removed`/
 *  `removedTraits`); this gives the OWNED path the same channel. */
export interface NestedStructureDelta {
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
}
/** Path-keyed nested STRUCTURE — see `NestedStructureDelta` and `NestedOverridePaths`. */
export type NestedStructurePaths = Record<string, NestedStructureDelta>;

/** A child subtree an instance adds beyond what its prefab defines. Anchored to
 *  an existing prefab member by `parentLocalId`; nested adds live in `children`
 *  (their parent is implicit in the tree shape). See docs/prefab-structural-overrides.md. */
export interface AddedEntity {
  /** localId of the prefab member this subtree's root hangs under (rootLocalId
   *  for the instance root). Ignored on nested `children`. */
  parentLocalId: number;
  /** A SCENE-authored node's durable guid, spawned verbatim. `''` on a node written into a prefab
   *  TEMPLATE, which carries `key` instead (#1387). */
  guid: string;
  /** Template-local identity of a node written into a prefab TEMPLATE (a row's `added`, a row's
   *  `nestedStructure[*].added`, a reference node's `added`): stable across saves, never a live guid.
   *  Each instance derives the node's guid from it (`deriveInstanceMemberGuids`), so two instances
   *  cannot share one. Absent on a scene-authored node. See `runtime/core/templateIdentity.ts`. */
  key?: string;
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
  /** STRUCTURAL edits inside the nested instance's own nested descendants, path-keyed exactly like
   *  `nestedOverrides` and read the same way a top-level entry's `nestedStructure` is (#1369). The
   *  reference node is the outermost layer for everything under it, so this is written by a SCENE
   *  capture (`captureNestedChannels`). Promoted into a prefab by Apply, it becomes the ROW's own
   *  slot (`PrefabFileEntry.nestedStructure`, #1381). */
  nestedStructure?: NestedStructurePaths;
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
  /** Scene-level STRUCTURAL edits inside this instance's nested instances — a member deleted or
   *  dragged out of a row's own expansion. Path-keyed exactly like `nestedOverrides` (#1358). */
  nestedStructure?: NestedStructurePaths;
}

export interface SceneResourceRef {
  /** `font` = an SDF font ASSET (`Text2D.font`/`Text3D.font`), acquired scene-scoped.
   *  `font-family` = the same kind of asset consumed by the DOM (`UIElement.fontFamily`):
   *  registered with the browser via the FontFace API instead, for every VARIANT of its
   *  family. One asset can be both — Court names the same typeface from a canvas label and
   *  from DOM text — which is why they are two resource types over one asset, not one (#231). */
  type: 'model' | 'riggedModel' | 'mesh' | 'material' | 'texture' | 'video' | 'prefab' | 'font' | 'font-family' | 'environment' | 'particle' | 'animation' | 'animset' | 'spriteanim' | 'rig2d' | 'audio' | 'shader' | 'timeline';
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
  /** v10+: guid of a base scene this scene extends (base-scene persistence).
   *  Loaded additively before this scene's own entities and survives a swap
   *  to another scene sharing the same base. Absent = no base. */
  baseScene?: string;
}

export interface LoadSceneOptions {
  /** Fetch a prefab JSON file given its path. Returns null if not found. */
  fetchPrefab: (path: string) => Promise<object | null>;
  /** Called after all entities are spawned (runtime: registerEntity, editor: undo tracking) */
  onEntitySpawned?: (entity: Entity, oldId: number) => void;
  /** Whether to preload model templates from ModelSource entities */
  loadModels?: boolean;
  /** Called to re-instantiate a prefab instance. The caller handles prefab fetch + entity creation.
   *  `rootExtraTraits` are traits the scene file added on the prefab-instance root beyond what the
   *  prefab itself defines (e.g. user-added Rotate3D, AnimatePosition). `overrides` carries
   *  per-localId field-level edits captured at save time so children's local edits survive reload.
   *  Returns the spawned instance root's koota id (`undefined` = nothing spawned). The loader re-points
   *  every reference it resolved to the destroyed placeholder onto that root (#1353); a caller that
   *  returns nothing leaves those references naming a dead id. */
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
    /** Scene-level STRUCTURAL edits inside this instance's nested instances (#1358), forwarded to
     *  `instantiatePrefabIntoWorld`'s `nestedStructure`. APPENDED rather than placed beside
     *  `nestedOverrides` where it belongs logically: these arguments are positional and five
     *  implementors (SceneManager plus four test harnesses) read them by position, so inserting
     *  would silently shift `rootGuid` and `rootEditorFolder` in any implementor not updated in the
     *  same change. */
    nestedStructure?: NestedStructurePaths,
  ) => Promise<number | undefined> | number | undefined | void;
  /** Called before deleting a placeholder entity during prefab re-instantiation */
  onDeletePlaceholder?: (entityId: number) => void;
  /** Target world for entity spawning. Defaults to getCurrentWorld(). SceneManager
   *  passes the staging `nextWorld` so entities are isolated until the swap. */
  world?: World;
  /** Drop EVERY override mark before spawning (default `true`).
   *
   *  The global clear defends against ecs-id reuse ACROSS WORLDS — a world-scoped
   *  concern that was attached to a *call* back when one `loadSceneFile` call WAS
   *  one world. Phase 5 (base scenes) broke that equivalence: a chain loads N scene
   *  files into ONE world, bases first and the primary last, so the primary's call
   *  wiped the marks the base's call had just seeded and every carried/chained
   *  prefab instance serialized with EMPTY overrides (finding "A9" —
   *  `docs/reviews/a9-carried-instance-overrides-investigation.md`, defect 1).
   *
   *  `SceneManager` therefore clears ONCE per staging world and passes `false` for
   *  every chain + carry call. Left `true` by default so every other caller (tests,
   *  and any future single-scene caller) keeps byte-identical behaviour — per-entity
   *  hygiene against id reuse is independent of this flag and always runs
   *  (`clearOverrideMarks(entity)` on each fresh spawn, below — still needed with the packed key,
   *  because koota's 8-bit generation wraps; see overrideMarks.ts). */
  clearMarks?: boolean;
  /** Project-relative path of the scene file being loaded (e.g. `/assets/scenes/Lvl-0002.scene.json`).
   *
   *  Used as the scene half of the seed when an entry with no durable guid needs one derived
   *  (#1268 — see `deriveAuthoredEntityGuids`). `SceneData` carries no `id` and this loader never
   *  reads the file's top-level one, so the caller's path is the only scene identity available here.
   *
   *  ⚠️ OPTIONAL on purpose, and absent means "derive nothing". `SceneManager`'s carried-snapshot
   *  respawn synthesises its `SceneData` from live entities drawn from SEVERAL scenes, so it has no
   *  single scene identity — and those entities already hold durable guids from their originating
   *  files, which `filterPersistentDuplicates` matches on. A base-scene chain is the opposite case:
   *  it runs one call PER FILE, each with its own path, so a base entity derives the same guid no
   *  matter which level pulls it in. */
  scenePath?: string;
}

/** Thrown by `loadSceneFile` when a scene's format version is `too-new` or `unreadable`
 *  (docs/format-versioning.md § 2b-bis — Scene is REFUSE). A named class rather than a bare
 *  `Error` so a caller several frames up (the editor's `loadScene` wrapper, item 2/3 of #784
 *  phase C3) can tell "this load was refused because of its format version" apart from every
 *  other reason a scene load can throw (a missing file, a bad prefab ref, …) without parsing
 *  the message. Mirrors `ImportWriteAborted` (`editor/scene/modelImport.ts`) and
 *  `MissingAssetError` (`runtime/loaders/assetFetch.ts`) — the established shape in this repo
 *  for "a specific, nameable reason a throw needs to survive to a caller that must react
 *  differently to it than to a generic failure". */
export class SceneFormatRefusedError extends Error {
  readonly reason: 'too-new' | 'unreadable';
  constructor(message: string, reason: 'too-new' | 'unreadable') {
    super(message);
    this.name = 'SceneFormatRefusedError';
    this.reason = reason;
  }
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
  data.version = 9;
}

/** Migrate v9→v10: no-op passthrough. v10 only adds an optional top-level
 *  `baseScene` ref (base-scene persistence) — older files simply have none. */
function migrateV9toV10(data: SceneData): void {
  if (data.version >= 10) return;
  data.version = 10;
}

/** Backfill a synthesized numeric id (its array index) for any entry that lacks one.
 *  A v12+ file (scene-loading.md, Phase 3) no longer WRITES `entry.id`
 *  at all — nothing on disk references it any more, now that `PrefabInstance.
 *  rootInstanceId` (Phase 2) and `EntityAttributes.parentId` (pre-existing) are
 *  both guids. The loader still needs SOME per-entry numeric key for its own
 *  internal bookkeeping this pass (`idMap`, `spawnedByEntryId`,
 *  `onEntitySpawned`'s `oldId`) — the array index serves that purpose and is
 *  stable within a single load, though meaningless across loads (unlike the old
 *  on-disk id, it is never persisted or compared to a prior load's). Mutates in
 *  place, same as the version migrations above; a file that DOES carry ids
 *  (any version through v11, or hand-authored) is untouched — this only fills
 *  gaps, never overwrites. Every consumer downstream in this file assumes
 *  `entry.id` is a real number; this call is what makes that true.
 *
 *  Skips any array index already taken by an EXPLICIT id elsewhere in the file
 *  (a genuinely mixed file — some entries id'd, some not — is unusual but not
 *  impossible: hand-edited, or partially migrated) so a synthesized id can never
 *  collide with a real one. A collision would silently alias two different
 *  entities in `idMap`, misattributing a parent/prefab-root reference with no
 *  warning — caught by independent code review, 2026-07-26. */
function assignSyntheticEntityIds(data: SceneData): void {
  const used = new Set<number>();
  for (const entry of data.entities) if (typeof entry.id === 'number') used.add(entry.id);
  let next = 0;
  for (const entry of data.entities) {
    if (entry.id != null) continue;
    while (used.has(next)) next++;
    entry.id = next;
    used.add(next);
  }
}

/** Migrate v10→v11: no-op passthrough. v11 only changes HOW `PrefabInstance.
 *  rootInstanceId` (and any future `entityId`-flagged field) is WRITTEN — a GUID
 *  string instead of a raw ecs id — not the shape of the data. An older file's
 *  numeric `rootInstanceId` still loads via the same `resolveEntityIdField`'s
 *  number branch (scene-loading.md, Phase 2). */
function migrateV10toV11(data: SceneData): void {
  if (data.version >= 11) return;
  data.version = 11;
}

/** Migrate v11→v12: no-op passthrough. v12 only changes HOW entities are keyed —
 *  `serializeScene` stops writing `entry.id` entirely, since nothing on disk
 *  references it any more (scene-loading.md's `parentId` guid,
 *  Phase 2's `rootInstanceId` guid). An older file's `entry.id` is simply ignored;
 *  `assignSyntheticEntityIds` (above) backfills a fresh one for a file that lacks
 *  it, so both shapes load identically (scene-loading.md, Phase 3). */
function migrateV11toV12(data: SceneData): void {
  if (data.version >= 12) return;
  data.version = 12;
}

/** Migrate v12→v13: `UIAnchor.zIndex` is removed — it and `UIElement.zIndex` wrote the
 *  same CSS `z-index` onto the same DOM node (`applyAnchorStyle` overwrote the element's
 *  value whenever the anchor's was truthy), so the anchor field only ever shadowed the
 *  element field. A truthy anchor value is what actually rendered, so it wins: copy it
 *  onto `UIElement.zIndex` (only when there IS a `UIElement` trait — an entity with a
 *  `UIAnchor` but no `UIElement` is skipped rather than inventing one), then delete
 *  `UIAnchor.zIndex` unconditionally, truthy or not. Idempotent — a file with no
 *  `UIAnchor.zIndex` left is untouched. Structured walk (see `migrateUIAnchorZIndexStructured`)
 *  — reaches `overrides[localId][UIAnchor]`, `added[]` subtrees and `nestedOverrides` paths too,
 *  same as `migrateV8toV9`'s `renameRenderableActiveToVisibleDeep`. */
function migrateV12toV13(data: SceneData): void {
  if (data.version >= 13) return;
  // Structured walk — not just entry.traits — so overrides[localId][UIAnchor], added[] subtrees
  // and nestedOverrides paths all get the same fix (mirrors migrateV8toV9's renameRenderableActiveToVisibleDeep).
  for (const entry of data.entities) migrateUIAnchorZIndexStructured(entry);
  data.version = 13;
}

/** Migrate v13→v14: no-op passthrough. v14 only ADDS an optional path-keyed `nestedStructure`
 *  beside `nestedOverrides` (on an instance entry — #1358 — and an added reference node — #1369 —
 *  never on a prefab row itself), carrying structural edits made inside a nested instance that
 *  expanded from a row.
 *  No existing field changes shape and no v13 file can carry the key, so there is nothing to walk.
 *
 *  ⚠️ The version still had to move, and this step is what makes a v13 file carry the new number:
 *  Scene's disposition is REFUSE (docs/format-versioning.md), so an older build must refuse a v14
 *  document rather than read it, ignore the key it does not know and drop it on the next save —
 *  which is precisely the data loss #1358 fixes. */
function migrateV13toV14(data: SceneData): void {
  if (data.version >= 14) return;
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
        markOverride(entity as unknown as Entity, traitName, '');
        continue;
      }
      // Accept any field the trait PERSISTS — its koota schema, not the meta.fields
      // Inspector list. AoS traits carry non-scalar fields no Inspector row declares
      // (AnimationLibrary's animSets/boneMaps, SkinnedMeshRenderer's materials,
      // UIAction's onClickSet — the bone-map-lost-on-reload bug), and SoA traits do
      // too: Animator.clips/clip belong to a custom Inspector section and
      // EntityAttributes.editorFolder has no row at all, so the old guard dropped
      // them here AND left them unmarked, which made the next save delete them.
      // A field the schema does not declare is still skipped — the genuinely
      // renamed/stale case. See runtime/core/ecs/traitSchema.ts.
      //
      // The merge itself is `foldTraitOverride`, shared with `effectivePrefabRootTraits` (#1031) so
      // the validator's and the pool's model of a prefab root cannot drift from what spawns here.
      const has = entity.has(meta.trait);
      const { merged, accepted, rejected } = foldTraitOverride(
        has ? entity.get(meta.trait) as Record<string, unknown> : undefined,
        fields,
        (field) => isPersistentTraitField(meta, field),
      );
      for (const field of rejected) {
        console.debug(`[loadSceneFile] override skipped: unknown field ${traitName}.${field}`);
      }
      // Seed an explicit mark from the file's override map: each accepted field is a
      // recorded override and must survive serialize even if it later coincides
      // with the prefab base. See overrideMarks.ts.
      for (const field of accepted) markOverride(entity as unknown as Entity, traitName, field);
      if (!has) {
        // Added-trait override: the instance carries a trait the prefab lacks at
        // this localId. Add the whole trait rather than dropping it on the floor.
        entity.add((meta.trait as (d: Record<string, unknown>) => unknown)(merged));
      } else {
        entity.set(meta.trait, merged);
      }
    }
  }
}

// The override-map helpers live in `prefabOverrides.ts` (#1031), so `sceneValidation.ts` — which
// this file imports, and which runs in Node with no trait registry — can compose a prefab's
// effective root with the SAME rules this spawner uses. Re-exported so their existing importers
// (`editor/scene/prefab.ts`, `editor/scene/serialize.ts`) are unchanged.
export { mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, mergeNestedStructurePaths, descendPathKeyed, nestedPathKey };
export type { NestedOverridePaths };

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
 *  the runtime passes koota-`world`-direct ops (destroyEntity over the ECS-parent subtree of the mapped ids, byId map, the single
 *  instantiatePrefabIntoWorld call). `log` keeps each side's existing warn prefix. */
export interface StructureApplyOps {
  /** Delete these ECS ids and their ECS-parent subtrees. The ids already include the prefab subtree's mapped
   *  members; the cascade adds what the map cannot reach — a nested instance's own members (#1247). Both
   *  impls rely on every live parentId being an ECS id or 0 (see subtreeCollect.ts). */
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
          // A TEMPLATE node's identity is derived per instance from its key (#1387) — a guid left in
          // its bag (a legacy file) would otherwise be stamped onto every instance.
          else if (node.key) d.guid = '';
        }
        traitArgs.push(meta.trait(d));
      }
      if (!traitArgs.length) return;
      if (!node.guid && node.key) traitArgs.push(TemplateAddedKey({ key: node.key }));
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

/** Stamp a scene-authored guid onto a freshly expanded prefab-instance root, and index it.
 *  No-op when the root already carries that guid. */
function applyRootGuid(world: World, rootEcsId: number, guid: string): void {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return;
  // O(1) through the entity index every spawn already populates — NOT a scan of world.entities,
  // which would make a scene with many nested instances O(instances x entities) at load.
  const e = findEntityById(rootEcsId, world) as EntityHandle | undefined;
  if (!e || !e.has(attrMeta.trait)) return;
  const ea = e.get(attrMeta.trait) as Record<string, unknown>;
  if (ea.guid === guid) return;
  e.set(attrMeta.trait, { ...ea, guid });
  indexEntityGuid(e, world);
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
      // destroyEntity, never a bare destroy(): that skipped `unregisterEntity`, so the entity index
      // kept each removed member and `findEntityById` handed back its corpse (#1222).
      // Cascades by ECS parent, like the editor's deleteEntities: the mapped ids reach a nested row's ROOT
      // but not that nested instance's own members, which would survive naming a dead parent (#1247). The
      // cascade is sound only because instantiatePrefabIntoWorld spawns its first pass parentless, so an
      // outer row still awaiting its remap cannot match a removed member's id (see subtreeCollect.ts).
      deleteEntities: (ecsIds) => {
        const attrMeta = getTraitByName('EntityAttributes');
        const links: [number, number][] = [];
        for (const e of world.entities as Iterable<EntityHandle>) {
          const ea = attrMeta && e.has(attrMeta.trait) ? (e.get(attrMeta.trait) as { parentId?: number }) : undefined;
          links.push([e.id(), ea?.parentId ?? 0]);
        }
        const toDelete = new Set(collectSubtreeIds(links, ecsIds));
        const doomed = [...world.entities].filter((e) => toDelete.has((e as EntityHandle).id()));
        for (const e of doomed) destroyEntity(e, world);
      },
      findEntity: (ecsId) => handleById().get(ecsId),
      spawnAdded: (traitArgs) => {
        const entity = spawnEntity(world, ...(traitArgs as Parameters<typeof world.spawn>));
        return entity.id();
      },
      spawnNestedInstance: (node, parentEcsId) => {
        const child = getCachedPrefab(node.prefab!) as { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string } | null;
        if (!child) { console.warn(`[loadSceneFile] added nested instance not cached: ${node.prefab}`); return; }
        const rootEcsId = instantiatePrefabIntoWorld(
          world, child, parentEcsId, undefined, node.prefab, node.overrides,
          { added: node.added, removed: node.removed, removedTraits: node.removedTraits }, undefined, node.nestedOverrides,
          node.nestedStructure,
        );
        // RESTORE the node's own guid (QA-PREFAB-0004). A nested instance's root is
        // serialized with its guid right here in the `added[]` entry — the same way a
        // TOP-LEVEL instance root carries `SceneEntityEntry.guid`, which the loader hands
        // to `onInstantiatePrefab` as `rootGuid`. This path had no equivalent, so the
        // expanded root came out guid-less and `deriveInstanceMemberGuids` minted a fresh
        // derived one: the entity survived the reload with the right parent, traits and
        // overrides, under a DIFFERENT guid. Every external reference to it (an agent's
        // captured address, a cross-entity ref) went stale on the next load with no error,
        // against the engine's own "guid is the stable anchor" contract. Stamped before
        // `deriveInstanceMemberGuids` runs, so this instance's MEMBERS also derive off the
        // stable root guid instead of off a fresh one.
        if (rootEcsId && node.guid) applyRootGuid(world, rootEcsId, node.guid);
        // A reference node written into a TEMPLATE has no guid to restore — its root derives one per
        // instance from the key, like a keyed plain node (#1387).
        else if (rootEcsId && node.key) setTemplateKey(findEntityById(rootEcsId, world) as EntityHandle | undefined, node.key);
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
  /** A prefab row's OWN structural edits inside its nested descendants (#1381) — the structural
   *  twin of `nestedOverrides`. An outer layer addressing the same path replaces it whole. */
  nestedStructure?: NestedStructurePaths;
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
 *  A node a prefab TEMPLATE added (it carries the `TemplateAddedKey` marker the loader stamps from
 *  `AddedEntity.key`) is derived the same way, stepping as `'+' + key` (#1387). It has no
 *  `PrefabInstance` and no localId, and before this it kept the template's guid in every instance.
 *
 *  Anchoring uses a snapshot of guids taken BEFORE deriving, so the result is independent of
 *  iteration order. ONE kind of derived guid is an anchor too: a guid-less instance root that a save
 *  STORES (`rootInstanceId` is itself and it did not expand from a prefab row — the structural rule
 *  `planCopyGuids` also uses). It derives its own guid through its ancestors as any member does, and
 *  its members then derive from THAT guid rather than through it. The save writes the root's guid
 *  into the file, and a reload anchors its members on it, so deriving through it instead gave every
 *  member a different guid after the first save and dangled every ref to one (#1349).
 *
 *  The guid rule itself is `deriveMemberGuid`/`memberStepId` (shared). ⚠️ The ANCESTOR walk is
 *  MIRRORED twice, because a duplicate must predict where a reload puts each member: over a scene
 *  FILE by `derivedMemberPaths` + `sceneAnchorOf` (engine/plugins/asset-fs-ops.ts, #1324/#1339), and
 *  over a live subtree by `planCopyGuids` (`core/copyIdentity.ts`: the editor's duplicate/paste and
 *  the device op, #1338) — change all three. Both mirrors step a keyed node by its key too (#1430). */
export function deriveInstanceMemberGuids(world: World): void {
  const piMeta = getTraitByName('PrefabInstance');
  const attrMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !attrMeta) return;

  type Row = { handle: EntityHandle; origGuid: string; parentId: number; stepId: number | string; hasPI: boolean; keyed: boolean; storedRoot: boolean };
  const rows = new Map<number, Row>();
  for (const e of world.entities as Iterable<EntityHandle>) {
    if (!e.has(attrMeta.trait)) continue;
    const ea = e.get(attrMeta.trait) as { guid?: string; parentId?: number };
    const hasPI = e.has(piMeta.trait);
    const pi = hasPI ? (e.get(piMeta.trait) as { localId?: number; parentLocalId?: number; rootInstanceId?: number }) : null;
    // A member's position in the chain is its localId — EXCEPT a nested-instance
    // root, whose localId is the (shared) inner root id; its distinguishing
    // position is parentLocalId (which OUTER row produced it). Two sibling nested
    // instances share inner localIds, so without this their members would collide.
    // A node a prefab TEMPLATE added (a row's `added`, or a reference node's root) steps by its template
    // key instead (#1387): it has no localId of its own, and two sibling reference nodes share one.
    const key = templateKeyOf(e);
    const stepId = key ? addedKeyStep(key) : memberStepId(pi);
    const storedRoot = !!pi && pi.rootInstanceId === e.id() && !pi.parentLocalId;
    // durableGuid: a runtime guid (#1210) is neither an identity to keep nor an anchor to derive from.
    rows.set(e.id(), { handle: e, origGuid: durableGuid(ea.guid), parentId: ea.parentId ?? 0, stepId, hasPI, keyed: !!key, storedRoot });
  }

  // The guid each guid-less row derives ('' = unaddressable), memoised: a guid-less stored root is
  // resolved on demand when a member below it needs its guid as the anchor. `null` marks a row
  // in progress, so a parent cycle resolves to '' instead of recursing.
  const derivedOf = new Map<number, string | null>();
  const resolve = (id: number, row: Row): string => {
    const memo = derivedOf.get(id);
    if (memo !== undefined) return memo ?? '';
    derivedOf.set(id, null);
    // Walk up to the nearest anchor: a row that had a guid BEFORE this pass, or a guid-less stored root.
    const path: (number | string)[] = [row.stepId];
    let anchor = '';
    let cur = rows.get(row.parentId);
    const seen = new Set<number>([id]);
    while (cur && !seen.has(cur.handle.id())) {
      if (cur.origGuid) { anchor = cur.origGuid; break; }
      if (cur.storedRoot) { anchor = resolve(cur.handle.id(), cur); break; }
      seen.add(cur.handle.id());
      path.unshift(cur.stepId);
      cur = rows.get(cur.parentId);
    }
    const derived = anchor ? deriveMemberGuid(anchor, path) : ''; // no anchored ancestor → unaddressable
    derivedOf.set(id, derived);
    return derived;
  };

  for (const [id, row] of rows) {
    if ((!row.hasPI && !row.keyed) || row.origGuid) continue; // only members / keyed added nodes that lack a guid
    const derived = resolve(id, row);
    if (!derived) continue;
    row.handle.set(attrMeta.trait, { ...(row.handle.get(attrMeta.trait) as Record<string, unknown>), guid: derived });
    indexEntityGuid(row.handle, world); // keep the guid index warm for this '' → guid mint
  }

  // Heal a template key the node lost (#1426) before anything names it: a saved scene respawns a
  // keyed node with its guid and no key, and without the marker neither member-token resolution below
  // nor the editor's override comparison can step through it. A healed node has a STORED guid, so it
  // was an anchor above, never a step — healing after the derive changes no derived guid.
  const keys = templateKeysIn(world);
  if (keys.size) {
    const nodeOf = (id: number): KeyRecoveryNode | undefined => {
      const row = rows.get(id);
      if (!row) return undefined;
      const pi = row.hasPI ? (row.handle.get(piMeta.trait) as { localId?: number; parentLocalId?: number }) : null;
      const guid = durableGuid((row.handle.get(attrMeta.trait) as { guid?: string }).guid);
      return { guid, parentId: row.parentId, key: templateKeyOf(row.handle), pi };
    };
    // Only a node INSIDE a top-level instance can be template-added, and its original anchor is at or
    // below that instance's stored root — so candidates are bounded to instances and each walk stops
    // at the root. Known misses are skipped until the node's guid or the world's key set changes.
    const insideMemo = new Map<number, boolean>();
    const inside = (id: number): boolean => {
      const hit = insideMemo.get(id);
      if (hit !== undefined) return hit;
      insideMemo.set(id, false); // a parent cycle is not inside anything
      const parent = rows.get(rows.get(id)?.parentId ?? 0);
      const v = !!parent && (parent.storedRoot || inside(parent.handle.id()));
      insideMemo.set(id, v);
      return v;
    };
    const isTop = (id: number): boolean => !!rows.get(id)?.storedRoot;
    const misses = healMissesIn(world);
    const memo = new Map<number, string>();
    // A miss is only reusable while everything the recovery read is unchanged: the node's guid, the
    // key set, and its ancestor chain up to the instance root (a reparent — or an undone one — can
    // make a failed recovery succeed with the guid and key count both unchanged). Walking ids hashes
    // nothing, so the signature stays cheap next to the recovery it skips.
    const chainOf = (id: number): string => {
      const ids: number[] = [];
      let cur = rows.get(id)?.parentId ?? 0;
      const seen = new Set<number>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        ids.push(cur);
        if (rows.get(cur)?.storedRoot) break;
        cur = rows.get(cur)?.parentId ?? 0;
      }
      return ids.join('.');
    };
    for (const [id, row] of rows) {
      // Only a node with a stored guid can have lost one: a plain node, or a REFERENCE node's root — a
      // stored root, stepped by its key exactly like a plain keyed node (#1438). A member below a root
      // steps by its localId and never had a key.
      if (row.keyed || (row.hasPI && !row.storedRoot) || !row.origGuid) continue;
      if (!inside(id)) continue;
      const tried = `${row.origGuid}|${keys.size}|${chainOf(id)}`;
      const packed = packedOf(row.handle as unknown as Entity);
      if (misses.get(packed) === tried) continue;
      const key = recoverTemplateKey(id, nodeOf, keys, memo, isTop);
      if (key) { setTemplateKey(row.handle, key); row.keyed = true; misses.delete(packed); }
      else misses.set(packed, tried);
    }
  }

  // Member tokens resolve against the guids just derived (#1352).
  resolveTemplateFrames(world);
}

// ── Template member references (#1352) ──────────────────────────────────────
// A prefab stores a reference to one of its own members as a member TOKEN (`runtime/core/templateRefs.ts`).
// Each instantiate call rebases the tokens it applies onto its path from the top call's root, so every
// token in one instantiate tree names a path from that root. The tree's root is registered here, and the
// derive pass resolves each token to the guid its member derived.

/** A prefab row's step path from its prefab's root: its flat ancestors' localIds below the root, then
 *  its own. It is the path the derive pass walks to the row's expansion (#1352). */
export function rowPathInPrefab(prefab: PrefabLike, localId: number): number[] {
  const rootLocalId = prefab.rootLocalId ?? 1;
  const parentOf = new Map<number, number>();
  for (const e of prefab.entities) {
    const ea = e.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    parentOf.set(e.localId ?? 0, (ea && typeof ea === 'object' ? (ea.parentId as number) : 0) || 0);
  }
  const path: number[] = [];
  const seen = new Set<number>();
  for (let cur = localId; cur && cur !== rootLocalId && !seen.has(cur); cur = parentOf.get(cur) ?? 0) {
    seen.add(cur);
    path.unshift(cur);
  }
  return path;
}

/** `rebaseMemberTokens` over a structural delta's `added` nodes. A REFERENCE node is left whole: its
 *  payload is applied by its own top call (`spawnNestedInstance`), in its own frame. */
function rebaseAddedTokens(nodes: AddedEntity[] | undefined, segments: readonly MemberStep[][]): AddedEntity[] | undefined {
  if (!nodes || !segments.length) return nodes;
  return nodes.map((n) => (n.prefab ? n : {
    ...n,
    traits: rebaseMemberTokens(n.traits, segments) as AddedEntity['traits'],
    children: rebaseAddedTokens(n.children, segments) ?? [],
  }));
}
function rebaseStructureTokens(structure: InstanceStructureData, segments: readonly MemberStep[][]): InstanceStructureData {
  return segments.length ? { ...structure, added: rebaseAddedTokens(structure.added, segments) } : structure;
}

/** Did the current top instantiate call's tree carry any member token? Scopes nest, because a
 *  reference node's expansion is a top call of its own inside another. */
let tokenScope: { seen: boolean } | null = null;
/** Open a top call's scope; returns the enclosing one, for `closeTokenScope` to restore. */
export function openTokenScope(): { prev: { seen: boolean } | null } {
  const prev = tokenScope;
  tokenScope = { seen: false };
  return { prev };
}
/** Close it, restoring the enclosing scope; true when a token was seen. */
export function closeTokenScope(scope: { prev: { seen: boolean } | null }): boolean {
  const seen = !!tokenScope?.seen;
  tokenScope = scope.prev;
  return seen;
}
/** Record whether any of these values holds a member token (memoised per prefab entity list). */
const tokensInEntities = new WeakMap<object, boolean>();
export function noteTokens(entities: object | undefined, ...values: unknown[]): void {
  if (!tokenScope || tokenScope.seen) return;
  if (entities) {
    let has = tokensInEntities.get(entities);
    if (has === undefined) { has = hasMemberToken(entities); tokensInEntities.set(entities, has); }
    if (has) { tokenScope.seen = true; return; }
  }
  if (values.some((v) => v !== undefined && hasMemberToken(v))) tokenScope.seen = true;
}

const pendingFrames = new WeakMap<World, number[]>();
/** Queue a top instantiate call's root for member-token resolution. The next derive pass resolves it.
 *  Exported for the editor's `instantiatePrefab`, the other expansion of the same files. */
export function registerTemplateFrame(world: World, rootEcsId: number): void {
  const list = pendingFrames.get(world);
  if (list) list.push(rootEcsId);
  else pendingFrames.set(world, [rootEcsId]);
}

/** An entity's step below its parent in the derive walk: `'+key'` for a template-keyed node,
 *  `memberStepId` for a prefab member, and `null` for a node no template can name. */
function memberStepOf(e: EntityHandle, piTrait: unknown): MemberStep | null {
  const key = templateKeyOf(e);
  if (key) return addedKeyStep(key);
  if (!e.has(piTrait)) return null;
  return memberStepId(e.get(piTrait) as { localId?: number; parentLocalId?: number });
}

/** Every member a template frame rooted at `rootEcsId` can name: path key → entity. The root is `''`.
 *  It does not descend into another STORED root, a user-added nested instance, which is its own frame;
 *  that root itself is still a target. A step two siblings share names neither of them. */
export function memberPathIndex(
  world: World, rootEcsId: number,
  /** The world's parent → children map, when the caller indexes several frames in one pass. */
  children: Map<number, EntityHandle[]> = childrenByParent(world),
): Map<string, EntityHandle | null> {
  const piMeta = getTraitByName('PrefabInstance');
  const out = new Map<string, EntityHandle | null>();
  // Found by the world walk rather than the entity index: the editor reaches this from Apply, whose
  // tests stub the world module by an explicit export list.
  let root: EntityHandle | undefined;
  for (const e of world.entities as Iterable<EntityHandle>) if (e.id() === rootEcsId) { root = e; break; }
  if (!piMeta || !root) return out;
  out.set('', root);
  const stack: [EntityHandle, MemberStep[]][] = [[root, []]];
  const seen = new Set<number>([rootEcsId]);
  while (stack.length) {
    const [e, path] = stack.pop()!;
    for (const c of children.get(e.id()) ?? []) {
      if (seen.has(c.id())) continue;
      seen.add(c.id());
      const step = memberStepOf(c, piMeta.trait);
      if (step === null) continue;
      const at = [...path, step];
      const key = memberPathKey(at);
      out.set(key, out.has(key) ? null : c);
      const pi = c.has(piMeta.trait) ? c.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number } : null;
      const storedRoot = !!pi && pi.rootInstanceId === c.id() && !pi.parentLocalId;
      if (!storedRoot) stack.push([c, at]);
    }
  }
  return out;
}

function childrenByParent(world: World): Map<number, EntityHandle[]> {
  const attrMeta = getTraitByName('EntityAttributes');
  const children = new Map<number, EntityHandle[]>();
  if (!attrMeta) return children;
  for (const e of world.entities as Iterable<EntityHandle>) {
    if (!e.has(attrMeta.trait)) continue;
    const parent = (e.get(attrMeta.trait) as { parentId?: number }).parentId ?? 0;
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  return children;
}

/** Resolve every member token held inside each queued frame to the guid of the member it names. A
 *  token that names nothing is left as it is: visibly unresolved, never silently re-pointed.
 *
 *  ⚠️ A STORED root under the frame (a separate instance: a scene child instance, a user-added nested
 *  one) is a TARGET here but never REWRITTEN. Its own bag holds tokens in its OWN frame, which its own
 *  pass resolves. Rewriting it here resolved a button's `@member:2` against the enclosing panel, so
 *  the button drove the panel's member on every load (#1352 review). */
function resolveTemplateFrames(world: World): void {
  const roots = pendingFrames.get(world);
  if (!roots?.length) return;
  pendingFrames.delete(world);
  const attrMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!attrMeta || !piMeta) return;
  const traits = getAllTraits().filter((m) => m.category !== 'tag');
  const children = childrenByParent(world);
  for (const rootId of new Set(roots)) {
    const root = findEntityById(rootId, world) as EntityHandle | undefined;
    const pi = root?.has(piMeta.trait) ? root.get(piMeta.trait) as { rootInstanceId?: number } : null;
    if (!root || pi?.rootInstanceId !== rootId) continue; // gone, or the id now names something else
    const index = memberPathIndex(world, rootId, children);
    const guidAt = (token: string): string => {
      const t = parseMemberToken(token);
      if (!t || t.up) return token;
      const target = index.get(memberPathKey(t.path));
      const guid = target ? ((target.get(attrMeta.trait) as { guid?: string }).guid ?? '') : '';
      return guid || token;
    };
    const ownFrame = (e: EntityHandle): boolean => {
      if (e.id() === rootId || !e.has(piMeta.trait)) return true;
      const p = e.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number };
      return !(p.rootInstanceId === e.id() && !p.parentLocalId);
    };
    for (const e of new Set([...index.values()].filter((x): x is EntityHandle => !!x && ownFrame(x)))) {
      for (const meta of traits) {
        if (!e.has(meta.trait)) continue;
        const data = e.get(meta.trait);
        if (!hasMemberToken(data)) continue;
        e.set(meta.trait, mapStringValues(data, (v) => (isMemberToken(v) ? guidAt(v) : v)));
      }
    }
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
  /** STRUCTURAL edits an OUTER layer applies inside this instance's nested descendants, path-keyed
   *  and forwarded exactly like `nestedOverrides` (#1358). Merged UNDER the row's own
   *  `added`/`removed`/`removedTraits` as the row expands — see the merge at the recursion. */
  nestedStructure?: NestedStructurePaths,
  /** This instance's path from the TOP instantiate call's root, one segment per nesting level (#1352).
   *  Absent on a top call, which registers its root for member-token resolution. Every value this call
   *  applies is rebased onto it (`rebaseMemberTokens`). */
  _segments?: MemberStep[][],
): number {
  const segments = _segments ?? [];
  // The keys this document declares are the candidates a later heal of this world tries (#1426).
  noteTemplateDoc(world, prefab as Parameters<typeof noteTemplateDoc>[1]);
  // A TOP call opens a token scope; nested calls report into it (#1352 review: resolution scans the
  // world, so a tree holding no token must not pay for it on every runtime spawn).
  const outerScope = _segments ? null : openTokenScope();
  noteTokens(prefab.entities, overrides, structure, nestedOverrides, nestedStructure);
  const stack = _stack ?? new Set<string>();
  if (prefab.id) {
    if (stack.has(prefab.id)) {
      if (outerScope) closeTokenScope(outerScope);
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
      // The same split for the STRUCTURAL channel (#1358): `structDirect` is what the outer layer
      // edited INSIDE this row's own expansion, `structForward` reaches deeper. The outer layer's
      // structure REPLACES the row's per-field lists rather than merging element-wise — a scene that
      // deleted a member of this expansion is stating the whole list for that instance, and merging
      // two `removed` arrays would make an un-delete unrepresentable.
      const { direct: structDirect, forward: outerStructForward } = descendPathKeyed(nestedStructure, rowLocalId);
      // The row's OWN deep structure (#1381) sits under what the outer layer forwarded — outer wins per path.
      const structForward = mergeNestedStructurePaths(entry.nestedStructure, outerStructForward);
      const childRoot = instantiatePrefabIntoWorld(
        world, child, 0, undefined, entry.prefab, childOverrides,
        // Once an outer layer addresses this path it OWNS the interior: all three lists come from
        // it, with an absent one read as EMPTY rather than falling back to the row. Per-field
        // fallback made "the row's own list no longer applies" unrepresentable — a scene that
        // deleted the last member of a row-authored `added` wrote nothing for it and the member came
        // back on the next load.
        structDirect
          ? { added: structDirect.added ?? [], removed: structDirect.removed ?? [], removedTraits: structDirect.removedTraits ?? {} }
          : { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits },
        stack, childNested,
        structForward,
        [...segments, rowPathInPrefab(prefab, rowLocalId)],
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
      // Spawn PARENTLESS: the file's parentId is a localId, not an ECS id, and the second pass reads it from
      // the entry. Left live, it names whichever entity holds that number, and a removal cascade running
      // during a nested row's expansion below would take this row with it (#1247).
      else if (meta.name === 'EntityAttributes') traitArgs.push(meta.trait({ ...(data as Record<string, unknown>), parentId: 0 }));
      else traitArgs.push(meta.trait(rebaseMemberTokens(data, segments) as Record<string, unknown>));
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
      const entity = spawnEntity(world, ...traitArgs as Parameters<typeof world.spawn>);
      clearOverrideMarks(entity); // the 8-bit generation wraps — see overrideMarks.ts
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

  // Second pass: remap parentIds in EntityAttributes. Every row — a nested-instance
  // root included — reads its parent from the FILE entry: the first pass spawned
  // rows parentless, and the recursive call spawned the nested root under 0.
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
    applyOverridesByLocalToEcs(world, localToEcs, rebaseMemberTokens(overrides, segments) as typeof overrides);
  }

  // Apply structural overrides (added/removed entities, removed traits) last, so
  // additions can resolve their anchor localId against the fully-built map and a
  // removal can't strand an override that ran before it.
  if (structure && (structure.added?.length || structure.removed?.length || structure.removedTraits)) {
    applyStructureByLocalToEcs(world, localToEcs, prefab, rebaseStructureTokens(structure, segments));
  }

  // Pop this prefab off the cycle stack — the guard tracks ANCESTORS in the
  // current expansion, not every prefab ever expanded. Without this, a prefab
  // nested more than once as a SIBLING (e.g. the same Engine Flame under both
  // wings) would falsely trip the cycle guard on the second expansion.
  if (prefab.id) stack.delete(prefab.id);

  // A TOP call's tree is one member-token frame: resolved after the derive pass (#1352).
  if (outerScope && closeTokenScope(outerScope) && rootEcsId) registerTemplateFrame(world, rootEcsId);

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
    if (!durableGuid(ea.guid as string)) { // a runtime guid (#1210) must not pre-empt guidSeed
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
  'VideoPlayer.clip': 'video',
  'Renderable2D.material': 'shader', // 2D custom material (.shader.json) — lazy-loaded by Scene2D
  'Text3D.font': 'font',
  'Text2D.font': 'font',
  'UIElement.imageSrc': 'texture',
  'UIElement.fontFamily': 'font-family',   // a font asset consumed by the DOM (#231)
  'UISettings.fontFamily': 'font-family',  // scene-wide DOM default for every UI root (#803)
  'PrefabInstance.source': 'prefab',
  'Environment.hdrPath': 'environment',
  'ParticleEmitter.effect': 'particle',
  'SpriteAnimator.clipSet': 'spriteanim',
  'SkinnedSprite2D.rig': 'rig2d',
  'AudioSource.clip': 'audio',
  'Director.timeline': 'timeline',
  // Registry fields intentionally NOT here (handled explicitly in the loop below):
  //   Renderable3DPrimitive.material — dynamic texture-or-material via getAssetType
  //   Renderable2D.sprite            — dynamic texture-or-video via getAssetType
  //   ModelSource.glbPath            — carries a postprocessor payload
};

/** Manifest asset TYPE → the SceneResourceRef type it is acquired as. Drives the
 *  generic game-trait sweep below, which types a ref by what the asset actually IS
 *  rather than by the field it sits in (there is no registry entry to consult for a
 *  game trait). The two unions are deliberately not identical:
 *    - `sprite` is a texture as far as acquisition is concerned.
 *    - `scene` is NOT a resource — scenes are loaded by SceneManager, not the
 *      resource cache, so a game trait holding a "next level" scene guid must not
 *      drag that whole scene into this one's preload.
 *    - `atlas` has no SceneResourceRef type at all: atlas MEMBERS are referenced by
 *      their own texture guids (which repoint to the packed page), so the page is
 *      already acquired through them.
 *  A type absent here is skipped, silently — an unmapped kind means "not something
 *  the resource pipeline acquires", not "dropped by accident". */
const RESOURCE_TYPE_BY_ASSET_TYPE: Partial<Record<AssetType, SceneResourceRef['type']>> = {
  mesh: 'mesh', material: 'material', prefab: 'prefab', model: 'model',
  environment: 'environment', texture: 'texture', sprite: 'texture', font: 'font',
  shader: 'shader', particle: 'particle', animation: 'animation', animset: 'animset',
  spriteanim: 'spriteanim', rig2d: 'rig2d', audio: 'audio', timeline: 'timeline',
  video: 'video',
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
 *  ModelSource.glbPath, structural entry.prefab) stay explicit.
 *  Anything held on a GAME-defined trait is caught by the generic sweep at the end. */
export function collectResourceRefsFromEntities(
  entities: ReadonlyArray<{
    traits: Record<string, unknown>;
    prefab?: string;
    added?: AddedEntity[];
    /** Per-localId prefab-instance overrides — see pushOverrideBags below. */
    overrides?: Record<string, unknown>;
    /** Path-keyed nested-instance overrides (one level deeper than `overrides`). */
    nestedOverrides?: Record<string, Record<string, unknown>>;
    /** Path-keyed nested-instance STRUCTURE (#1358) — its `added[]` nodes carry refs. */
    nestedStructure?: NestedStructurePaths;
  }>,
): SceneResourceRef[] {
  const seen = new Set<string>();
  const refs: SceneResourceRef[] = [];
  /** Every ref an EXPLICIT rule above claimed, keyed by the ref alone (not by
   *  `type:ref`). The generic sweep skips these, so a field whose declared type
   *  differs from the asset's manifest type — `SkinnedModel.model` is acquired as
   *  `riggedModel` while the .glb's manifest type is `model` — yields ONE entry
   *  with the declared type, not two entries for the same asset. */
  const claimed = new Set<string>();
  const add = (type: SceneResourceRef['type'], ref: string) => {
    if (!ref) return;
    // `font-family` deliberately does NOT claim: it is the DOM consumer of a font asset
    // (`UIElement.fontFamily`), and the SAME asset may also be referenced as an SDF `font` by
    // `Text2D.font` or a game trait — two different loads, both needed. Claiming would let
    // whichever field is visited first suppress the other, which is not the ambiguity `claimed`
    // exists to resolve (that one is about a single ref whose declared type differs from its
    // manifest type). Court authors exactly this: one typeface, named from a canvas label and
    // from DOM text; the claim silently dropped its atlas preload (#231).
    if (type !== 'font-family') claimed.add(ref);
    const key = `${type}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, path: ref });
  };

  // Flatten structural additions into the scan so an added child's mesh/material/
  // texture/effect is acquired at load too (a `traits`-only view per added node).
  const flat: Array<{ traits: Record<string, unknown>; prefab?: string }> = [];

  /** A prefab-instance's per-localId override map — `{ localId: { TraitName: { …fields } } }`.
   *  Each value is a TRAIT BAG, so pushing it into `flat` as a pseudo-entity makes every rule
   *  below (the registry loop, the explicit handlers, the generic game-trait sweep) see it with
   *  no special-casing.
   *
   *  An override can introduce a ref the base prefab does NOT have — the editor's ordinary
   *  "instantiate a prefab, then swap this instance's mesh/material" — and until now those refs
   *  reached the resources manifest through nothing at all. Measured on committed content:
   *  `games/space-console/Station.scene.json` carried **31** override-only `Renderable3D.mesh`
   *  and `.material` GUIDs absent from its `resources`, and both are ACQUIRING types, so they
   *  were neither preloaded nor scene-refcounted — and because SceneManager's fresh re-walk is
   *  THIS function, the miss survived the re-walk that normally rescues a stale manifest.
   *  The build was never affected: the tree-shaker walks `entry.overrides` itself
   *  (`asset-tree-shaker.ts` extractEntityRefs), which is why this stayed invisible for so long.
   *  Found by the #123 close-out sweep — the same "a ref the walker cannot see" pattern as the
   *  game-trait case, reached by a different route. */
  const pushOverrideBags = (map: Record<string, unknown> | undefined) => {
    if (!map || typeof map !== 'object') return;
    for (const bag of Object.values(map)) {
      if (bag && typeof bag === 'object') flat.push({ traits: bag as Record<string, unknown> });
    }
  };

  for (const entry of entities) {
    flat.push(entry);
    pushOverrideBags(entry.overrides);
    // `nestedOverrides` is path-keyed one level deeper — `{ path: { localId: { Trait: {…} } } }`.
    for (const byLocal of Object.values(entry.nestedOverrides ?? {})) pushOverrideBags(byLocal);
    const walkAdded = (node: AddedEntity) => {
      // A reference node carries a child prefab GUID — surface it so the prefab is
      // acquired; recurse BOTH the plain `children` and a reference node's `added`.
      flat.push({ traits: node.traits, prefab: node.prefab });
      // A reference-style added node is itself a nested instance, so it carries the same
      // two override shapes (F8) — the exact place assertNoPathRefs was once blind.
      pushOverrideBags(node.overrides as Record<string, unknown> | undefined);
      for (const byLocal of Object.values(node.nestedOverrides ?? {})) {
        pushOverrideBags(byLocal as Record<string, unknown>);
      }
      node.children.forEach(walkAdded);
      node.added?.forEach(walkAdded);
      // A reference node's own `nestedStructure` (#1369) holds added nodes too — the same build-side
      // blindness the entry-level slot below guards against.
      for (const delta of Object.values(node.nestedStructure ?? {})) delta.added?.forEach(walkAdded);
    };
    entry.added?.forEach(walkAdded);
    // ⚠️ `nestedStructure`'s added nodes are refs the BUILD reads through this walker
    // (`asset-tree-shaker.ts`), so missing them drops the asset from the production bundle and it
    // fails only once shipped (#53's class). serializeScene has its OWN scanner for the scene's
    // `resources` manifest — both must know this slot, and extending only that one left the build
    // blind, which is the half a round-trip test cannot see.
    for (const delta of Object.values(entry.nestedStructure ?? {})) delta.added?.forEach(walkAdded);
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
    // GLB in the build. The source GLB is not listed here; `SceneManager`'s animset acquire
    // loads it under the scene once the set is parsed (#1162).
    const animLib = entry.traits['AnimationLibrary'] as Record<string, unknown> | undefined;
    if (animLib && typeof animLib !== 'boolean') {
      const animSets = animLib.animSets;
      if (Array.isArray(animSets)) {
        for (const ref of animSets) if (looksFetchable(ref as string)) add('animset', ref as string);
      }
    }
    // UIEntries (#250) — a scroll view's entry KINDS: an ARRAY of { name, prefab } where
    // `prefab` is the GUID. Explicit rather than in REF_FIELDS_BY_TRAIT, which is scalar-only.
    //
    // ⚠️ Without this the entry prefab reaches the manifest through NOTHING, and the failure is
    // invisible in dev — the dev server serves every file off disk, so it only breaks in a
    // production build (#53, "assets the build cannot see"). Listing the prefab is also what
    // makes SceneManager's transitive prefab walk acquire what the prefab itself references.
    const entries = entry.traits['UIEntries'] as Record<string, unknown> | undefined;
    if (entries && typeof entries !== 'boolean') {
      for (const k of parseEntryPrefabs(entries.prefabs as string)) {
        if (looksFetchable(k.prefab)) add('prefab', k.prefab);
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
      // #731: parseClipBank's own never-throws contract collapses "no bank" and "malformed bank"
      // into the same `[]` — a corrupt AudioSource.clips bank would then silently ship with none
      // of its clips acquired, and the game plays silence with no signal. The Result variant tells
      // the two apart so the malformed case is at least visible.
      const { entries: audioClips, malformed: audioClipsMalformed } = parseClipBankResult(audioSrc.clips);
      if (audioClipsMalformed) console.warn(`[loadSceneFile] malformed AudioSource.clips bank — its clips will not be acquired: ${JSON.stringify(audioSrc.clips)}`);
      for (const c of audioClips) if (looksFetchable(c.ref)) add('audio', c.ref);
    }
    // Animator.clips — the named keyframe-clip bank, a JSON-string `[{name, clip, …}]`.
    // Each `clip` is a `.anim.json` GUID; parse + collect so a multi-clip animator's clips
    // all ship + survive a save. The active `clip` field is a NAME now (not a fetchable
    // ref), so Animator intentionally has NO entry in REF_FIELDS_BY_TRAIT.
    const animator = entry.traits['Animator'] as Record<string, unknown> | undefined;
    if (animator && typeof animator !== 'boolean') {
      // #731: same fail-open shape as AudioSource.clips above — a malformed bank must not read as
      // an empty, correctly-authored one.
      const { entries: animClips, malformed: animClipsMalformed } = parseAnimClipBankResult(animator.clips);
      if (animClipsMalformed) console.warn(`[loadSceneFile] malformed Animator.clips bank — its clips will not be acquired: ${JSON.stringify(animator.clips)}`);
      for (const c of animClips) if (looksFetchable(c.clip)) add('animation', c.clip);
    }
    // Renderable2D.sprite is USUALLY a texture, but a video GUID is legal there too
    // (a moving picture on a 2D sprite). Type it by what the asset actually IS, not by
    // the field it sits in — a video filed as a texture is a ref the manifest describes
    // wrongly, and the next reader to trust that type is the one who pays.
    const r2d = entry.traits['Renderable2D'] as Record<string, unknown> | undefined;
    if (r2d && typeof r2d !== 'boolean') {
      const sprite = r2d.sprite as string | undefined;
      if (looksFetchable(sprite)) {
        const t = isGuid(sprite!) ? getAssetType(sprite!) : undefined;
        add(t === 'video' ? 'video' : 'texture', sprite!);
      }
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
    // (UIElement.imageSrc + .fontFamily are both scalar registry refs now, handled by the
    //  loop above — fontFamily became a font-asset GUID in #231, so it no longer needs the
    //  by-NAME special case that used to live here.)
    // ModelSource.glbPath — a 'model' ref that also threads a postprocessor payload,
    // so it can't go through the plain scalar add() (which carries no extra field).
    const ms = entry.traits['ModelSource'] as Record<string, unknown> | undefined;
    if (ms && typeof ms !== 'boolean') {
      const glb = ms.glbPath as string | undefined;
      const postprocessor = ms.postprocessor as string | undefined;
      // GUID-only, like every other ref (resolveRef rejects internal paths).
      if (looksFetchable(glb)) {
        claimed.add(glb!); // pushed directly (postprocessor payload), so claim it by hand
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

  // ── Generic GUID sweep — makes GAME-DEFINED traits work with no registration (#123) ──
  //
  // Everything above is keyed off REF_FIELDS_BY_TRAIT, a closed engine-only const with no
  // registration API. So an asset guid held on a GAME trait (space-invader's
  // `SpaceInvaderAssets.catvaderAnim`) was structurally invisible here, and re-saving the
  // scene rebuilt `resources` WITHOUT it.
  //
  // What that costs, stated precisely — #123 filed it as an "asset the build cannot see" (the
  // #53 class), and that is NOT the failure. Two things make the stored manifest far less
  // load-bearing than it looks:
  //   - The BUILD never reads it. The tree-shaker walks scene ENTITIES via its own generic
  //     sweep (asset-tree-shaker.ts). Measured: a web build of space-invader from a manifest
  //     with both refs deleted still ships the spriteanim AND the texture.
  //   - The RUNTIME does not trust it either. `SceneManager.collectSceneResourceRefs` unions
  //     the stored `resources` with a FRESH call to this function, so a stale file self-heals
  //     ("`resources` is a hint, not the authority" — docs/scene-loading.md).
  // So what actually bit is not a stale FILE, which nothing depends on, but a blind WALKER:
  // this function is the fresh walk, so a ref it cannot see is missing from BOTH halves of
  // that union. For an acquiring type — prefab, material, model, environment, animset, audio —
  // that means never preloaded and never scene-refcounted, and no re-save could have fixed it
  // because the re-save calls this same walker. Fixing the walker fixes every scene at load,
  // including ones never re-saved; re-saving only brings the committed file back in step.
  //
  // A game cannot register into the engine without reaching into it, which the portability
  // rule forbids, so a registration API would push the drift onto every game instead of
  // removing it.
  //
  // The asset MANIFEST is already the complete guid → asset index, so no registry is needed:
  // a trait field whose string is a guid that RESOLVES in the manifest is, by construction, a
  // reference to a real asset. This is the same conclusion the build tree-shaker reached for
  // the same reason (asset-tree-shaker.ts, "Generic scalar/array GUID sweep") — the two now
  // agree on which refs exist instead of the shaker keeping a file the manifest omits.
  //
  // Silent on a miss, deliberately: an ENTITY reference is also a guid and is never in the
  // asset manifest, so warning here would fire on every parent/target field in the scene.
  // Runs as a SECOND pass over `flat` — not inside the loop above — so every explicit claim
  // is registered before any sweep decision, whichever entity carries it.
  const sweep = (value: unknown) => {
    if (typeof value !== 'string' || !isGuid(value) || claimed.has(value)) return;
    const rtype = RESOURCE_TYPE_BY_ASSET_TYPE[getAssetType(value) as AssetType];
    if (rtype) add(rtype, value);
  };
  for (const entry of flat) {
    for (const [traitName, bag] of Object.entries(entry.traits)) {
      if (!bag || typeof bag !== 'object') continue;
      // A REGISTRY field is already typed by the loop above, by the field it sits in — the
      // sweep must not re-type it from the asset's manifest type. `claimed` covers most of
      // that by VALUE, but value-level suppression cannot express one asset legitimately
      // acquired as two types: `UIElement.fontFamily` (a DOM `font-family`) and a game trait's
      // SDF `font` ref can name the SAME typeface, which is Court. Claiming made the second
      // one disappear; not claiming let the sweep re-derive an SDF `font` acquire FROM THE
      // fontFamily FIELD ITSELF — a real atlas fetch + GPU upload, on every scene load, for a
      // game whose font is DOM-only. Skipping by FIELD is what actually holds: the registry
      // owns those fields, the sweep owns the rest (#231).
      // ⚠️ `hasDocKey`, NOT a raw index (#993). `traitName` comes from the scene/prefab JSON and
      // `REF_FIELDS_BY_TRAIT` is a code-declared literal, so a trait named `constructor` returns
      // the inherited FUNCTION — and `registryFields?.includes(field)` on the next line is a
      // TypeError, i.e. a crash on the load path for EVERY scene and prefab.
      const registryFields = hasDocKey(REF_FIELDS_BY_TRAIT, traitName)
        ? REF_FIELDS_BY_TRAIT[traitName]
        : undefined;
      for (const [field, value] of Object.entries(bag as Record<string, unknown>)) {
        if (registryFields?.includes(field)) continue;
        // One level of array unwrap, to also catch an AnimationLibrary-shaped guid
        // array on a game trait (a level list, an enemy-prefab table).
        if (Array.isArray(value)) value.forEach(sweep);
        else sweep(value);
      }
    }
  }

  refs.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
  return refs;
}

/** One stored entity reference: `field` of `trait` on `entity`. */
interface EntityIdRef {
  entity: Entity; trait: unknown; field: string;
  /** The field's `onMissing` is `'stripTrait'`: with nothing to point at, the trait goes, not the value. */
  strip?: boolean;
}

function noteEntityIdRef(refsTo: Map<number, EntityIdRef[]>, target: number, ref: EntityIdRef): void {
  if (target <= 0) return;
  const list = refsTo.get(target);
  if (list) list.push(ref);
  else refsTo.set(target, [ref]);
}

function writeEntityIdRef({ entity, trait, field }: EntityIdRef, expect: number, value: number): boolean {
  if (!entity.isAlive()) return false; // the placeholder's own self-reference
  const t = trait as Parameters<Entity['get']>[0];
  if (!entity.has(t)) return false;
  const data = entity.get(t) as Record<string, unknown>;
  if (data[field] !== expect) return false; // rewritten since it was recorded
  entity.set(t, { ...data, [field]: value } as never);
  return true;
}

/** Zero every recorded reference to `placeholder` BEFORE it is destroyed, and return them (#1353).
 *  Between the destroy and the retarget, koota hands the placeholder's id to a freshly spawned member,
 *  and a structural `removed` on that member cascades by `parentId` across the world — so a reference
 *  still holding the id would be deleted with it. If nothing replaces the placeholder,
 *  {@link dropDetachedEntityIdRefs} applies each field's `onMissing` policy to what is left.
 *  Driven by the record, never by scanning for `field === id` afterwards: once destroyed, the id's new
 *  owner has children that legitimately hold it. */
function detachEntityIdRefs(refsTo: Map<number, EntityIdRef[]>, placeholder: number): EntityIdRef[] {
  const refs = refsTo.get(placeholder);
  if (!refs) return [];
  refsTo.delete(placeholder);
  return refs.filter((ref) => writeEntityIdRef(ref, placeholder, 0));
}

/** Nothing replaced the placeholder: apply each detached field's `onMissing` policy, as pass 2 does for a
 *  reference that never resolved. `'root'` keeps the 0 `detachEntityIdRefs` wrote; `'stripTrait'` removes
 *  the trait, because a `PrefabInstance` with `rootInstanceId: 0` reads as an instance ROOT on save. */
function dropDetachedEntityIdRefs(refs: EntityIdRef[]): void {
  for (const { entity, trait, strip } of refs) {
    const t = trait as Parameters<Entity['get']>[0];
    if (strip && entity.isAlive() && entity.has(t)) entity.remove(t);
  }
}

/** Point the references `detachEntityIdRefs` zeroed at the instance root that replaced the placeholder. */
function attachEntityIdRefs(refsTo: Map<number, EntityIdRef[]>, refs: EntityIdRef[], root: number): void {
  for (const ref of refs) if (writeEntityIdRef(ref, 0, root)) noteEntityIdRef(refsTo, root, ref);
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

/** Resolve a serialized `FieldHint.entityId`-flagged field value to a live koota id.
 *  - GUID string (current files) → the entity carrying that guid, via the guid index.
 *  - number > 0 (legacy files / raw ecs ids, e.g. PrefabInstance.rootInstanceId) →
 *    remapped through `idMap` (file/old-world id → fresh koota id).
 *  - '' / 0 / unknown → `'empty'` (nothing to remap; the field already holds its
 *    schema default).
 *  Returns `'miss'` when the reference doesn't resolve — distinct from `'empty'` so
 *  the caller applies the field's declared `onMissing` policy instead of guessing. */
function resolveEntityIdField(raw: unknown, idMap: Map<number, number>, world: World): number | 'empty' | 'miss' {
  if (raw == null || raw === '' || raw === 0) return 'empty';
  if (typeof raw === 'string') {
    const ent = findEntityByGuid(raw, world);
    return ent ? ent.id() : 'miss';
  }
  if (typeof raw === 'number' && raw > 0) {
    const mapped = idMap.get(raw);
    return mapped ?? 'miss';
  }
  return 'empty';
}

/** Spawn entities from scene data, remap parentIds, optionally load models and prefabs. */
export async function loadSceneFile(data: SceneData, options: LoadSceneOptions): Promise<void> {
  // New WORLD → drop every prior override mark (ecs ids are reused across worlds).
  // Marks for this scene's instances are re-seeded below as overrides are applied.
  // Classify BEFORE anything mutates `data` — see docs/format-versioning.md § 2a/2b-bis.
  // This must run ahead of the migration ladder AND the two unconditional mutators below
  // (assignSyntheticEntityIds, stripLegacyCameraFrameShowGizmo): both write into `data`
  // regardless of version, so a too-new or unreadable document was being mutated before
  // anything ever looked at its version (#784 phase C3).
  //
  // Classification happens at BOTH this site and in `SceneManager.loadScene` (right
  // after `parseAssetJson`, before `collectSceneResourceRefs`) — not because it was
  // moved, but because `SceneManager` mutates the same object (assigning
  // `sceneData.resources`) and spawns entities from it before ever calling this
  // function, so a too-new/unreadable scene must be refused before that happens,
  // not merely before this function's own migration ladder runs — `SceneManager` is
  // the only non-test caller of `loadSceneFile` (#784 phase C adversarial review,
  // finding 1). The guard stays HERE too because `loadSceneFile` is the single
  // entry every OTHER path funnels through — `preloaded` snapshots, direct
  // test/tool calls — and both sites route through the same `classifyFormatVersion`
  // and the same `SceneFormatRefusedError`, so they cannot disagree on the verdict.
  // (#807 removed a `sceneData.version = Math.max(sceneData.version ?? 6, 6)` tail
  // that used to sit at the end of `collectSceneResourceRefs` and ran before this
  // guard on a `SceneManager`-driven load — it doesn't factor into either site's
  // reasoning any more.)
  const verdict = classifyFormatVersion(data, SCENE_FORMAT_VERSION);
  if (verdict.kind === 'too-new') {
    throw new SceneFormatRefusedError(
      `Scene not loaded: its format version (${verdict.version}) is newer than this ` +
      `engine supports (${SCENE_FORMAT_VERSION}). Update the engine to open this scene.`,
      'too-new',
    );
  }
  if (verdict.kind === 'unreadable') {
    throw new SceneFormatRefusedError(
      `Scene not loaded: its format version is unreadable (${verdict.reason}). ` +
      `The file may be corrupt or hand-edited incorrectly.`,
      'unreadable',
    );
  }
  // `absent` (no version field at all) is NOT refused — a genuinely pre-v3 scene has
  // no `version` key and SHOULD run the whole migration ladder below. This looks like
  // an oversight next to the too-new/unreadable throws above, but it is deliberate:
  // `absent` is § 2a's "legacy or freshly created — readable" verdict, and refusing it
  // would break every scene the ladder exists to migrate.
  // Opt-out for a chain/carry load, where SceneManager owns the once-per-world clear
  // and a per-call clear would wipe the marks an earlier scene in the chain seeded
  // (A9 defect 1) — see the `clearMarks` docblock on LoadSceneOptions.
  if (options.clearMarks !== false) clearAllOverrideMarks();
  migrateSceneData(data);
  migrateV4toV5(data);
  migrateV5toV6(data);
  migrateV6toV7(data);
  migrateV7toV8(data);
  migrateV8toV9(data);
  migrateV9toV10(data);
  migrateV10toV11(data);
  migrateV11toV12(data);
  migrateV12toV13(data);
  migrateV13toV14(data);
  assignSyntheticEntityIds(data);
  stripLegacyCameraFrameShowGizmo(data);
  const { fetchPrefab, onEntitySpawned, loadModels = true } = options;
  const world = options.world ?? getCurrentWorld();
  const allTraits = getAllTraits();
  const idMap = new Map<number, number>();
  // Every `entityId` field this load resolved, keyed by the koota id it now holds. A reference to a
  // prefab-instance entry resolves to that instance's PLACEHOLDER, which the prefab loop below destroys
  // and replaces; this is what lets it re-point those references at the real root (#1353).
  const refsTo = new Map<number, EntityIdRef[]>();
  const spawnedByEntryId = new Map<number, Entity>(); // entry.id → spawned handle (for pass 2)

  // A guid for every entry written before #1248, derived so that each clone loading these
  // same bytes writes the same guid back (#1268). Computed over the WHOLE entity list up
  // front, because the seed needs a parent path and parents are addressed by guid — which
  // means it cannot be done entry-by-entry inside the spawn loop below. Runs ahead of
  // `deriveInstanceMemberGuids` (end of this function) so an entry this gives an identity
  // to can anchor the prefab members underneath it.
  // ⚠️ The live world's guids are passed as RESERVED, not just the file's own. `SceneManager`
  // filters `data.entities` before this point — a row shadowed by a carried `Persistent` entity, or
  // by an earlier scene in a base chain, is REMOVED — so the file alone does not know every guid
  // that is spoken for, and a guid-less twin would otherwise derive a live entity's address.
  const liveGuids: string[] = [];
  {
    const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');
    if (attrMeta) {
      for (const e of world.entities as Iterable<{ has(t: unknown): boolean; get(t: unknown): { guid?: string } }>) {
        if (!e.has(attrMeta.trait)) continue;
        const g = durableGuid(e.get(attrMeta.trait).guid);
        if (g) liveGuids.push(g);
      }
    }
  }
  const authoredGuids = deriveAuthoredEntityGuids(data.entities, options.scenePath, liveGuids);

  // First pass: spawn all entities
  for (const entry of data.entities) {
    // `durableGuid`, not raw truthiness, and for the same reason as the gate below: a RUNTIME guid
    // at `entry.guid` is not an identity. Taking it here would discard the derived guid AND stamp
    // the runtime one into EntityAttributes, which the first save then persists — a value that
    // names a different entity next session, and one `noRuntimeGuidsOnDisk.test.ts` forbids.
    const authoredGuid = durableGuid(entry.guid) || authoredGuids.get(entry.id);
    const traitArgs: any[] = [];
    let sawEntityAttributes = false;
    for (const [traitName, traitData] of Object.entries(entry.traits)) {
      const meta = allTraits.find((m) => m.name === traitName);
      if (!meta) continue;
      if (traitName === 'EntityAttributes') sawEntityAttributes = true;
      if (traitData === true) traitArgs.push(meta.trait());
      else {
        // Every `entityId`-flagged field (Phase 15's FieldHint — EntityAttributes.
        // parentId, PrefabInstance.rootInstanceId) holds a GUID (current files, since
        // Phase 2, scene-loading.md) or a legacy numeric file id — neither
        // is a valid live koota id, and spawning a GUID STRING into a numeric koota SoA
        // field would corrupt it (silently becomes NaN, not caught until the declarative
        // remap pass below runs — too late, the trait is already spawned broken). Zero
        // every such field at spawn; pass 2 resolves the real id.
        const entityIdFieldNames = Object.entries(meta.fields).filter(([, hint]) => hint.entityId).map(([k]) => k);
        let fieldData = traitData as Record<string, unknown>;
        // A prefab-instance root's own identity lives at `entry.guid` (top-level —
        // serialize.ts never bakes it into EntityAttributes.guid on disk, since it's
        // never an override). Stamp it in here so the placeholder is discoverable via
        // `findEntityByGuid` like any other entity — without it, a GUID-form
        // `rootInstanceId` that self-references this same root can never resolve in
        // the pass-2 remap below (nothing in the live world carries that guid yet),
        // so it always misses and gets stripped + warned, even though the root is
        // sitting right here. Only applies to EntityAttributes on an entry that
        // carries a top-level guid; plain entities keep serializing their guid
        // directly inside EntityAttributes and are unaffected.
        //
        // `authoredGuid` also covers the #1268 case: an entry that DOES carry
        // EntityAttributes but with no guid in it (and no top-level guid either) takes the
        // derived one here, rather than falling through to a runtime guid at spawn.
        // ⚠️ `durableGuid`, not `!fieldData.guid`. `deriveAuthoredEntityGuids` classifies an entry
        // through `durableGuid` too, so a persisted RUNTIME guid counts as no identity there and
        // gets one derived — and a raw truthiness check here would then throw that derivation away,
        // let `mintRuntimeGuid` overwrite the field, and leave the first save minting a random v4:
        // #1268 intact, in the one shape this module's docblock claims to cover. The corpus cannot
        // hold that input (`noRuntimeGuidsOnDisk.test.ts`), but a user project or a hand-edited
        // file can.
        if (traitName === 'EntityAttributes' && authoredGuid && !durableGuid(fieldData.guid as string)) {
          fieldData = { ...fieldData, guid: authoredGuid };
        }
        if (entityIdFieldNames.length === 0) traitArgs.push(meta.trait(fieldData));
        else {
          const patched: Record<string, unknown> = { ...fieldData };
          for (const key of entityIdFieldNames) patched[key] = 0;
          traitArgs.push(meta.trait(patched));
        }
      }
    }
    // The stamp above only fires while ITERATING an 'EntityAttributes' entry — but
    // serialize.ts's captured-prefab-root shape omits EntityAttributes from
    // entry.traits ENTIRELY (`minimalEa` stays empty for a top-level, unfoldered
    // instance — see serialize.ts's prefabRootCaptured), not merely guid-less. That
    // placeholder then spawns with NO EntityAttributes trait at all — undiscoverable
    // via findEntityByGuid — so pass 2's self-referencing rootInstanceId always
    // misses and strips PrefabInstance + warns, on every Stop/load, for any
    // top-level unfoldered prefab instance (observed 2026-07-28, games/3d-test's
    // "2D Animation" scene). Give the placeholder a minimal EntityAttributes carrying
    // entry.guid so it's discoverable in the meantime — onInstantiatePrefab (below)
    // replaces this placeholder with the real, fully-populated instance moments
    // later, so a bare guid-only stand-in here is enough for pass 2 to resolve.
    //
    // The same stand-in carries #1268's case, which reaches here by a different route: an
    // entry written before #1248 has NO EntityAttributes and no top-level guid, so without
    // this it spawns bare, `spawnEntity` adds the trait with a RUNTIME guid, and the first
    // save mints a random durable one — a different one in every clone. `authoredGuid` is
    // derived from the scene path and the entry's place in it, so every clone agrees.
    //
    // ⚠️ `entry.guid` and the derived guid are NOT interchangeable in the gate below. A
    // prefab root must get its placeholder even when it has no other traits (that is the
    // whole point above), but an entry with no traits AND no guid is a stray that the
    // `traitArgs.length > 0` check has always dropped — pushing an EntityAttributes onto it
    // would make it spawn as a phantom entity that no previous build had. Court carried
    // exactly such a stray until #1248 deleted it.
    if (!sawEntityAttributes) {
      const standInGuid = durableGuid(entry.guid) || (traitArgs.length > 0 ? authoredGuids.get(entry.id) : undefined);
      if (standInGuid) {
        const eaMeta = allTraits.find((m) => m.name === 'EntityAttributes');
        if (eaMeta) traitArgs.push(eaMeta.trait({ guid: standInGuid }));
      }
    }
    if (traitArgs.length > 0) {
      const entity = spawnEntity(world, ...traitArgs);
      onEntitySpawned?.(entity, entry.id);
      idMap.set(entry.id, entity.id());
      spawnedByEntryId.set(entry.id, entity);
    }
  }

  // Remap every registered `entityId`-flagged field (EntityAttributes.parentId,
  // PrefabInstance.rootInstanceId, and any future field a trait declares) through
  // `idMap` in ONE declarative pass, instead of a hand-maintained block per field —
  // the bug class scene-loading.md's "A8" finding closes structurally
  // (Phase 15). Each such field holds a raw ecs id (or, for `parentId`, sometimes a
  // guid string) captured from the OLD world/file — meaningless in this fresh world
  // until resolved. `resolveEntityIdField` handles both forms; each field's declared
  // `onMissing` policy decides what happens when the id has no live counterpart here
  // (see the `FieldHint.entityId` docblock in traitRegistry.ts for why the two existing
  // fields use different policies).
  //
  // For a prefab-instance root this is a harmless no-op on a FRESH (non-carry) load:
  // the placeholder gets this same self-consistent remap, then `onInstantiatePrefab`
  // (below) destroys it and re-instantiates the whole prefab fresh, which patches its
  // own members' rootInstanceId correctly and independently. It matters on a CARRIED
  // base-scene snapshot (SceneManager.ts's carry respawn, which omits
  // `onInstantiatePrefab` — every entity, root and members alike, spawns here as a flat
  // entry with baked trait data verbatim, copied straight out of the dying world).
  for (const meta of allTraits) {
    const entityIdFields = Object.entries(meta.fields).filter(([, hint]) => hint.entityId);
    if (entityIdFields.length === 0) continue;
    for (const entry of data.entities) {
      const traitData = entry.traits[meta.name] as Record<string, unknown> | undefined;
      if (!traitData) continue;
      const entity = spawnedByEntryId.get(entry.id);
      if (!entity || !entity.has(meta.trait)) continue;
      let patch: Record<string, unknown> | undefined;
      let stripped = false;
      for (const [fieldName, hint] of entityIdFields) {
        const resolved = resolveEntityIdField(traitData[fieldName], idMap, world);
        if (resolved === 'empty') continue; // no value / already 0 — nothing to remap
        if (resolved !== 'miss') {
          (patch ??= {})[fieldName] = resolved;
          noteEntityIdRef(refsTo, resolved, {
            entity, trait: meta.trait, field: fieldName, strip: hint.entityId!.onMissing === 'stripTrait',
          });
          continue;
        }
        if (hint.entityId!.onMissing === 'stripTrait') {
          // Say which id space `label` is in — `entry.id` is a per-LOAD synthetic
          // index (Phase 3, scene-loading.md), not a file id or a live koota id, and
          // reading it as either sends you to the wrong entity. Prefer the entity's
          // name, else its guid (present on a captured prefab root even when its
          // EntityAttributes is otherwise absent), else label the index explicitly.
          const eaData = entry.traits['EntityAttributes'] as Record<string, unknown> | undefined;
          const label = (eaData?.name as string | undefined) || entry.guid || `entry-index ${entry.id}`;
          console.warn(
            `[loadSceneFile] entity "${label}" carries a ${meta.name} whose ${fieldName} has no live ` +
            `counterpart in this load — stripping ${meta.name} so it can't poison downstream lookups ` +
            `(scene-loading.md, Phase 15).`,
          );
          entity.remove(meta.trait);
          stripped = true;
          break;
        }
        // 'root' — silently write the field's schema default (0). An orphan is a
        // legitimate partial-load outcome; sceneValidation.ts already warns on it at
        // author time, so no runtime warning here.
        (patch ??= {})[fieldName] = 0;
      }
      if (!stripped && patch) {
        entity.set(meta.trait, { ...(entity.get(meta.trait) as Record<string, unknown>), ...patch });
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
    // Every placeholder a prefab entry below may still replace (#1353). Over-inclusive on purpose —
    // a trait-form member or a prefab that fails to load stays in it — which only costs a scan.
    const placeholderIds = new Set<number>();
    for (const entry of data.entities) {
      if (!entry.prefab && !entry.traits['PrefabInstance']) continue;
      const id = idMap.get(entry.id);
      if (id) placeholderIds.add(id);
    }
    for (const entry of data.entities) {
      const pi = entry.traits['PrefabInstance'] as Record<string, unknown> | undefined;
      // A prefab instance is expressed by a top-level `prefab` ref (scene serialize
      // + nested-prefab rows) OR a baked PrefabInstance trait (legacy / live tag).
      // The trait form keeps its rootInstanceId guard so non-root members are skipped;
      // the `prefab`-field form is always a root.
      const source = (entry.prefab as string | undefined) ?? (pi?.source as string | undefined);
      if (!source) continue;
      if (pi && !entry.prefab) {
        // rootInstanceId is a GUID string (current files, since Phase 2, scene-save-
        // stability-plan.md) or a raw numeric file/ecs id (legacy files; the in-
        // memory carry-respawn snapshot, which never round-trips through JSON so it
        // stays numeric regardless of format version). "This entry IS the root" means
        // the id/guid points at ITSELF — compare against entry.id for the numeric
        // form, or this entry's OWN guid for the string form. 0 / '' means unset,
        // which is also treated as root (nothing to remap yet).
        const rootInstanceId = pi.rootInstanceId as number | string;
        const entryGuid = (entry.traits['EntityAttributes'] as Record<string, unknown> | undefined)?.guid as string | undefined;
        const isSelfOrUnset = typeof rootInstanceId === 'string'
          ? (rootInstanceId === '' || (!!entryGuid && rootInstanceId === entryGuid))
          : (rootInstanceId === 0 || rootInstanceId === entry.id);
        if (!isSelfOrUnset) continue;
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
      // `emptyDocMap()` (#986) — `name` is a trait name straight out of the scene file, and this
      // bag is then applied to the spawned prefab root, so a lost key is a lost authored trait.
      const rootExtraTraits: Record<string, unknown> = emptyDocMap();
      for (const [name, data] of Object.entries(entry.traits)) {
        if (name === 'PrefabInstance' || name === 'Transform' || name === 'EntityAttributes') continue;
        rootExtraTraits[name] = data;
      }

      const detached = detachEntityIdRefs(refsTo, newEntityId);
      options.onDeletePlaceholder?.(newEntityId);

      const rootEcsId = await options.onInstantiatePrefab(
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
        entry.nestedStructure,
      );
      if (typeof rootEcsId === 'number' && rootEcsId > 0) {
        // Everything that was resolved to the placeholder now names the root. Without this the stored
        // id stayed the placeholder's, and a child landed on whichever entity koota recycled that id
        // for — the root only when the prefab lists its root row first (#1353).
        idMap.set(entry.id, rootEcsId);
        attachEntityIdRefs(refsTo, detached, rootEcsId);
      } else {
        // Nothing replaced the placeholder: the detached references get their `onMissing` value, and a
        // later entry's numeric parent must resolve to 0 too, not to the freed id.
        dropDetachedEntityIdRefs(detached);
        idMap.delete(entry.id);
      }
      placeholderIds.delete(newEntityId);
      // This instance's parent may be a placeholder that a LATER entry replaces (a guid resolves to the
      // still-live placeholder), and the instantiation hands that parent to every row it cannot parent
      // inside the prefab — the root, an orphan row, an extra top-level row — so each such row is
      // recorded like a pass-2 reference. Anything else holding a live placeholder's id is a reference
      // to it, so matching on the value is exact while the placeholder is alive.
      if (placeholderIds.has(ecsParent)) {
        const eaTrait = getTraitByName('EntityAttributes')?.trait;
        if (eaTrait) {
          for (const e of world.entities as Iterable<Entity>) {
            if (!e.has(eaTrait)) continue;
            if ((e.get(eaTrait) as { parentId?: unknown }).parentId !== ecsParent) continue;
            noteEntityIdRef(refsTo, ecsParent, { entity: e, trait: eaTrait, field: 'parentId' });
          }
        }
      }

      // Demoted to debug: this fires per instance on every (hot-)reload — at log
      // level it spams the console + isn't free under heavy reload churn (F9).
      console.debug(`[loadSceneFile] Instantiated prefab "${source}"`);
    }
  }

  // All prefab instances are now expanded with correct parentIds — give their
  // members stable, addressable GUIDs so entities can reference into instances.
  deriveInstanceMemberGuids(world);
}
