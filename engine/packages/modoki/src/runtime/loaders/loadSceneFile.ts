/** Load a scene JSON file into an ECS world. Shared between editor and runtime. */

import { type Entity, type World } from 'koota';
import { getCurrentWorld, spawnEntity, destroyEntity, indexEntityGuid, findEntityById, findEntityByGuid } from '../core/ecs/world';
import { getAllTraits, getTraitByName } from '../core/ecs/traitRegistry';
import { loadModelTemplates, getCachedPrefab } from './meshTemplateCache';
import { isGuid, isExternalUrl, resolveRef, getAssetType, deriveGuid, newGuid, getAssetEntry, type AssetType } from './assetManifest';
import { durableGuid, deriveMemberGuid, entityStep, isStoredRoot, isDerivedMember, type MemberPi } from '../core/assetRefRules';
import { deriveAuthoredEntityGuids } from './authoredEntityGuids';
import { parseEntryPrefabs } from '../traits/UIEntries';
import { markUIDirty } from '../ui/uiTreeStore';
import { markOverride, clearOverrideMarks, clearAllOverrideMarks } from './overrideMarks';
import { emptyDocMap, hasDocKey } from '../core/docKeys';
import { isPersistentTraitField } from '../core/ecs/traitSchema';
import {
  mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, foldTraitOverride,
  descendPathKeyed, nestedPathKey, mergeNestedStructurePaths,
  descendStructureLayers, foldStructureLayers, type StructureLayer,
  type NestedOverridePaths,
} from './prefabOverrides';
import { SCENE_FORMAT_VERSION } from '../core/version';
import { memberRowKeysIn, memberRowsIn } from '../core/ecs/memberRows';
import { parseMemberRowKey, parseNodeRowKey, memberRowNodes } from '../core/assetRefRules';
import { classifyFormatVersion } from '../core/formatVersion';
import { REF_FIELDS_BY_TRAIT } from './sceneValidation';
import { parseClipBankResult } from '../audio/clipBank';
import { parseAnimClipBankResult } from '../animation/animClipBank';
import { getRunMode } from '../core/playState';
import { Transient } from '../core/traits/Transient';
import { TemplateAddedKey, templateKeyOf, setTemplateKey } from '../core/templateIdentity';
import { noteTemplateDoc, templateKeysIn, recoverTemplateKey, healMissesIn, type KeyRecoveryNode } from './templateKeyRecovery';
import { packedOf, type PackedEntity } from '../core/ecs/entityTable';
import { rebaseMemberTokens, hasMemberToken, isMemberToken, parseMemberToken, memberPathKey, type MemberStep } from '../core/templateRefs';
import { mapStringValues } from '../core/assetRefRules';
import { migrateUIAnchorZIndexStructured } from './uiAnchorZIndexMigration';
import { collectSubtreeIds } from '../core/ecs/subtreeCollect';
import { memberPathIndex, identityTree } from '../core/ecs/memberHome';
import { resolveIdentityParents, frameDocReader, linkOwnerBeforeMove, noteFrameDoc, setRuntimeFrameDocFallback, templateFrameClimber, type IdentityNode, type IdentityPi, type TemplateDoc } from '../core/ecs/identityParents';
export { memberPathIndex } from '../core/ecs/memberHome';

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
  /** ⚠️ LEGACY since Phase 3 (#1468) — the localId-keyed move map that `SceneMemberRow.parent`
   *  replaced for every member that HAS a row. Still written for the moves no row can carry (a pre-v5
   *  template's members — `InstanceStructure.unrowed`), and always read, because a file from before
   *  Phase 3 has its moves nowhere else. A row that also moves the member wins (`applyStructureCore`);
   *  a v5 member's move migrates onto its row on the next save, a pre-v5 one stays here. */
  moved?: Record<number, string>;
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
  /** ⚠️ LEGACY since Phase 3 (#1468) — the localId-keyed move map that `SceneMemberRow.parent`
   *  replaced for every member that HAS a row. Still written for the moves no row can carry (a pre-v5
   *  template's members — `InstanceStructure.unrowed`), and always read, because a file from before
   *  Phase 3 has its moves nowhere else. A row that also moves the member wins (`applyStructureCore`);
   *  a v5 member's move migrates onto its row on the next save, a pre-v5 one stays here. */
  moved?: Record<number, string>;
  /** The nested instance's deep overrides reaching into ITS nested descendants. */
  nestedOverrides?: NestedOverridePaths;
  /** v16+: this nested instance's members, keyed by minted identity — see {@link SceneMemberRow}
   *  (#1468). A reference node IS an instance, and it carries the same channels a top-level entry
   *  does; without this slot a prefab instance dragged into another one, or PROMOTED inside one
   *  (#1468 design record R7), would be the one kind of instance whose members still had no stored identity.
   *  ⚠️ Never written into a prefab TEMPLATE: these are per-instance scene guids, and a template
   *  that carried them would hand every instance the same ones (#1293). */
  members?: Record<string, SceneMemberRow>;
  /** STRUCTURAL edits inside the nested instance's own nested descendants, path-keyed exactly like
   *  `nestedOverrides` and read the same way a top-level entry's `nestedStructure` is (#1369). The
   *  reference node is the outermost layer for everything under it, so this is written by a SCENE
   *  capture (`captureNestedChannels`). Promoted into a prefab by Apply, it becomes the ROW's own
   *  slot (`PrefabFileEntry.nestedStructure`, #1381). */
  nestedStructure?: NestedStructurePaths;
}

/** One MEMBER of a prefab instance, as the scene stores it (v16, #1468) — identity that used to be
 *  re-derived from the member's position on every load.
 *
 *  Addressed by its key in `SceneEntityEntry.members`, never by a field on itself: the key is the
 *  member's identity, and every other structural channel in this format is identity-keyed the same
 *  way (`overrides`, `removedTraits`, `moved`, `nestedOverrides`, `nestedStructure`).
 *
 *  **The key** is a `/`-joined chain of MINTED node identities, one component per instance FRAME and
 *  flat within a frame (#1468 design record D1): a member of the top-level instance is one component; a
 *  member of a nested instance is the nested ROW's identity then its own. A component is either a
 *  `PrefabEntity.nodeGuid` or an added node's `'a+' + key`. ⚠️ Tell them apart with `isGuid`, NOT by
 *  the leading letter — a guid may legitimately begin with `a`.
 *
 *  ⚠️ **A row exists only where the TEMPLATE minted an identity** (prefab v5). A member of a pre-v5
 *  template gets no row and derives as it always did. The alternative — keying such a row by its
 *  `localId` — looks like graceful degradation and is the opposite: the prefab's first re-save mints
 *  guids for every row, so every localId-keyed row in every scene orphans at once. */
export interface SceneMemberRow {
  /** The member's durable guid. The whole point: stored, not derived.
   *
   *  ⚠️ ABSENT on exactly one kind of row (Phase 4, #1468): a member the instance REMOVED. It is not
   *  live, so it has no guid to state; its row exists only to say `removed: true`, and R2 does not read
   *  it as an orphan because its node is still in the template. */
  guid?: string;
  /** The member's name, for a readable scene file AND for the one consumer that cannot get it from
   *  anywhere else — an ORPHANED row's log line (#1468 design record R2). An orphan is a row whose template
   *  member is gone, so the template cannot name it; only the row can. */
  name?: string;
  /** The guid of the parent this member was moved to inside its instance — WIRED in Phase 3, where
   *  it replaced the localId-keyed `moved` map. Absent = it sits where its own frame's template row
   *  puts it, which is the overwhelmingly common case and writes nothing.
   *
   *  ⚠️ It is a DIFF, not "the live parent, always". #1468 design record R4 is why: a template that re-parents a
   *  member must move it in every instance that has not moved it itself, and a `parent` written
   *  unconditionally would pin the member at its old place for ever and silently defeat the most
   *  common template edit there is. `memberRowParents` computes the diff; its docblock carries the
   *  frame reasoning.
   *
   *  ⚠️ R8 (#1468 design record) binds the MEMBER, not this field: a row exists only for a member that BELONGS to
   *  the frame (`memberRowKeysIn` keys by identity, so a member of another instance gets no row by
   *  construction), and a move OUT of the outermost instance is an unpack, never a `parent`. The
   *  parent itself may sit in ANOTHER frame of the same outermost instance — #1437 keeps a move under
   *  a sibling nested instance's member linked (`planMoveUnlinks`), and such a move is written here. */
  parent?: string;
  // ── The collapsed channels (#1468 design record D2, wired in Phase 4). Declared in v16 so moving the
  //    localId-keyed channels here was a CALLER migration, not a second format change. Each one is
  //    the member's own statement in THIS frame, and `foldMemberRowChannels` (prefabOverrides.ts)
  //    owns the rule: a field that is PRESENT replaces the lower layer's value for this member, an
  //    absent one leaves it. The legacy channels (`overrides`, `removed`, …) are still read, and still
  //    written for a member no row can key — a pre-v5 template, which is every prefab the released
  //    editor wrote. ──
  /** This member's field overrides — merged field by field over the lower layer, this row winning. */
  traits?: Record<string, Record<string, unknown>>;
  /** The trait names this instance removed from the member; `[]` states "none", over a lower layer's list. */
  removedTraits?: string[];
  /** The instance deleted this member. `false` is meaningful in a NESTED frame: it un-deletes a member
   *  an outer prefab layer deleted. */
  removed?: boolean;
  /** Subtrees this instance added UNDER this member; `[]` states "none". Each node's `parentLocalId`
   *  is ignored on read (the row names the anchor) and written as 0.
   *  ⚠️ It REPLACES what the chain puts under the member, so since v17 (#1516) the writer uses it only as
   *  the fallback for a list it cannot state node by node; the scene's own nodes go in `own`. */
  added?: AddedEntity[];
  /** v17 (#1516): the scene's own nodes under this member, APPENDED after the chain's — the statement
   *  `added` cannot make without restating, and so pinning, every template node beside them. On a NODE
   *  row (key ending `a+<key>`), the scene's own children of that template node. */
  own?: AddedEntity[];
  /** v17 (#1516): per-trait removals over `removedTraits` or the chain's list — `true` removes, `false`
   *  restores a trait the chain removed. `removedTraits` states the whole list and so pinned the chain's
   *  names beside the scene's. On a node row, a `true` name is dropped from the node's traits. */
  traitRemovals?: Record<string, boolean>;
  // ⚠️ `nestedOverrides` and `nestedStructure` get NO slot here, and that is not an omission. They
  //    exist only because a member two frames down had no address; the frame-chained key gives it
  //    one, so they collapse into the nested members' OWN rows. The #1468 design record records it.
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
  // ⚠️ The four localId-keyed channels below (and `nestedOverrides`/`nestedStructure`) are LEGACY since
  //    #1468 Phase 4 for any member with a row: its edits are on `members[key]` instead
  //    (`SceneMemberRow.traits`/`removedTraits`/`removed`/`added`), where a template renumber cannot
  //    redirect them. They are always READ, and still WRITTEN for the instance root's own edits (the
  //    root has no row) and for a member no row can key — a pre-v5 template's, which is every prefab
  //    the released editor wrote. `foldMemberRowChannels` folds the rows over them; a row wins.
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Structural overrides on a prefab instance (see AddedEntity). */
  added?: AddedEntity[];
  /** Prefab member localIds this instance deleted (top-most only; descendants cascade). */
  removed?: number[];
  /** Per-localId component (trait) names this instance deleted from prefab members. */
  removedTraits?: Record<number, string[]>;
  /** ⚠️ LEGACY since Phase 3 (#1468) — the localId-keyed move map that `SceneMemberRow.parent`
   *  replaced for every member that HAS a row. Still written for the moves no row can carry (a pre-v5
   *  template's members — `InstanceStructure.unrowed`), and always read, because a file from before
   *  Phase 3 has its moves nowhere else. A row that also moves the member wins (`applyStructureCore`);
   *  a v5 member's move migrates onto its row on the next save, a pre-v5 one stays here. */
  moved?: Record<number, string>;
  /** Scene-level overrides on this instance's NESTED instances (a prefab's own
   *  internal nested prefab instances, e.g. a ship's engine flames). Path-keyed so
   *  the scene can reach a member at ANY nesting depth (see NestedOverridePaths). */
  nestedOverrides?: NestedOverridePaths;
  /** Scene-level STRUCTURAL edits inside this instance's nested instances — a member deleted or
   *  dragged out of a row's own expansion. Path-keyed exactly like `nestedOverrides` (#1358). */
  nestedStructure?: NestedStructurePaths;
  /** v16+: this instance's members, keyed by minted identity — see {@link SceneMemberRow} (#1468).
   *  Absent on a v15 file and on an instance whose template predates prefab v5. */
  members?: Record<string, SceneMemberRow>;
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
  data.version = 14;
}

/** v14 → v15: no-op passthrough. Adds an optional `moved` map (member row localId → the guid of the parent
 *  it was moved to inside its instance, #1437) beside `added`/`removed`/`removedTraits` on a prefab-instance
 *  entry, a `nestedStructure` slot and an added reference node. No existing field changes shape.
 *
 *  ⚠️ The bump is still required, for the reason v14's was: Scene's disposition is REFUSE, so an older build
 *  must refuse a v15 document rather than read it, ignore `moved`, and drop every move on the next save. */
function migrateV14toV15(data: SceneData): void {
  if (data.version >= 15) return;
  data.version = 15;
}

/** v15 → v16: no-op passthrough. Adds an optional `members` map on a prefab-instance entry (#1468):
 *  one thin row per member of the instance, keyed by the member's MINTED identity rather than by its
 *  position, so a member's guid is STORED instead of re-derived from where it happens to sit.
 *
 *  Nothing to walk, and — unusually for this ladder — nothing to migrate even in principle. A v15
 *  scene has no rows, so every member derives its guid exactly as it does today, which is that
 *  scene's correct current state (#1468 design record R3). Its first ordinary save pins the then-current
 *  derived values, which is the right moment: pinning them here would freeze whatever this build
 *  happens to derive into a file nobody asked to change.
 *
 *  ⚠️ The bump is still required, for the reason v14's and v15's were: Scene's disposition is REFUSE,
 *  so an older build must refuse a v16 document rather than read it, ignore `members`, and drop every
 *  stored member identity on the next save — which is exactly the loss #1468 exists to stop, arriving
 *  through the mechanism built to prevent it. */
function migrateV15toV16(data: SceneData): void {
  if (data.version >= 16) return;
  data.version = 16;
}

/** v16 → v17: no-op passthrough. Adds, on a scene member row (#1516), `own` — the scene's own nodes, APPENDED
 *  after the chain's where `added` replaces them — and `traitRemovals` — per-trait removal statements over the
 *  chain's list; and NODE rows, keyed `<frame chain>/a+<key>`, holding one template-added node's field edits,
 *  trait additions and removals, own children, or its deletion. Together they let a scene edit ONE of the nodes a
 *  template row added (or remove one more trait) without restating, and so pinning, everything beside it.
 *
 *  Nothing to migrate: `added` and `removedTraits` keep their exact v16 meaning, so a v16 file reads unchanged,
 *  and its first ordinary save rewrites what it can node by node. ⚠️ The bump is required for the reason every
 *  bump since v14 was: Scene's disposition is REFUSE, and an older build reading a v17 file would ignore node
 *  rows, `own` and `traitRemovals` — losing the scene's edits to template nodes, its own nodes beside them, and
 *  its trait removals — then drop them all on its next save. */
function migrateV16toV17(data: SceneData): void {
  if (data.version >= 17) return;
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
  /** This instance's member rows, forwarded so the removal cascade can see WHICH members have been
   *  moved (Phase 3, #1468). `applyStructureCore` reads the parent and QUEUES the move, which drains
   *  after the derive (`drainAfterDerive`), because the new parent may be an entity that only gets its
   *  guid there. */
  members?: Record<string, SceneMemberRow>;
  /** Two sources since Phase 3 (#1468). A SCENE file's legacy `moved` map — a pre-Phase-3 file, or the
   *  moves no member row can carry (a pre-v5 template); a row wins where both move one member. And the
   *  EDITOR's rebuild paths, which hand `captureInstanceStructure`'s whole view back here, REDUCED when
   *  a Revert takes a move away — the channel for "these are the moves that still apply", which the
   *  carried rows cannot answer: they state what the instance had BEFORE the revert. Phase 4 KEPT it:
   *  it never leaves the document it was captured against, and only the seams where a localId crosses
   *  to another document were moved onto identity (#1468 Phase 4). */
  moved?: Record<number, string>;
  /** IN-MEMORY only, never a file field: the OUTER frame's row for this nested instance's own ROOT
   *  (Phase 4, #1468). An owned nested root is keyed in the frame around it, but what its row states
   *  about the root's traits, removed traits and added children has to merge under THIS expansion's
   *  own lower layer — see `foldMemberRowChannels`, which produces it as `forwardRoot`. */
  rootRow?: SceneMemberRow;
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
  /** The world the structure is applied to — where a member move is queued (#1437). */
  world: World;
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
  // Members this instance moved elsewhere (#1437). A removed row does not take a moved member with it,
  // nor anything below that member: they live under their new parent now.
  //
  // ⚠️ Read off the member ROWS since Phase 3 (#1468) as well as the legacy map. The move itself is
  // only QUEUED here (below) and drains after the derive, once every guid exists. That split is what
  // lets this run here at all: "has this member moved" needs no guid resolution, while "where to"
  // does. `memberRowsIn` is asked of the tree as EXPANDED, before any removal, which is the moment
  // every member still has a live entity to be keyed by.
  const movedSet = new Set<number>(
    Object.keys(structure.moved ?? {}).map(Number).filter((lid) => localToEcs.has(lid)),
  );
  /** ecsId → the guid of the parent its ROW says it sits under (Phase 3, #1468). Keys are relative
   *  to THIS instance root, which is what makes one spelling serve every caller: the scene entry's
   *  own map, a user-added reference node's, and a nested frame's after `descendStructureLayers` has
   *  dropped one component. */
  const rowMoves = new Map<number, string>();
  if (structure.members) {
    const rootEcsId = localToEcs.get(prefab.rootLocalId ?? 1) ?? 0;
    for (const [ecsId, at] of memberRowsIn(rootEcsId, ops.world)) {
      const parent = at.key ? structure.members[at.key]?.parent : undefined;
      if (!parent) continue;
      rowMoves.set(ecsId, parent);
      // `movedSet` holds localIds of THIS document, and `memberRowsIn` also returns the members of
      // nested frames, whose `rowLocalId` is a localId of the CHILD document — the same small numbers,
      // naming unrelated rows here. Only this frame's own members go in (close-out review).
      if (at.frameRoot === rootEcsId && localToEcs.has(at.rowLocalId)) movedSet.add(at.rowLocalId);
    }
  }
  const childRows = new Map<number, number[]>();
  for (const pe of prefab.entities) {
    const ea = pe.traits['EntityAttributes'] as Record<string, unknown> | undefined;
    const parent = (ea && typeof ea === 'object' ? (ea.parentId as number) : 0) || 0;
    const list = childRows.get(parent);
    if (list) list.push(pe.localId ?? 0);
    else childRows.set(parent, [pe.localId ?? 0]);
  }

  // 1. Entity removals (cascade prefab descendants). Prune the deleted localIds
  // from the map too, so a later addition can't anchor to a destroyed member.
  if (structure.removed?.length) {
    const toDelete: number[] = [];
    const deferred: number[] = [];
    // The cascade stops at a moved member: it lives elsewhere now, and so does everything below it — a
    // removal the user made down there is listed on its own. A removed row still HOLDING a moved member
    // stays until the drain, so the member is derived through it and has moved out before it goes.
    const held = new Map<number, boolean>(); // a row's answer, reused when a later removal reaches it again
    const cut = (sub: number, top: boolean): boolean => {
      const known = held.get(sub);
      if (known !== undefined) return known;
      held.set(sub, false); // a cycle answers false
      if (!top && movedSet.has(sub)) return true;
      let holds = false;
      for (const c of childRows.get(sub) ?? []) if (cut(c, false)) holds = true;
      const ecs = localToEcs.get(sub);
      if (ecs) (holds ? deferred : toDelete).push(ecs);
      localToEcs.delete(sub);
      removedLocals.add(sub);
      held.set(sub, holds);
      return holds;
    };
    for (const lid of structure.removed) cut(lid, true);
    if (toDelete.length) ops.deleteEntities(toDelete);
    if (deferred.length) afterDeriveQueue(ops.world).deletes.push({ ecsIds: deferred, ops });
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

  // Moves wait for the derive pass (#1437): a member's guid is derived at its ROW parent, and the new
  // parent may be a member or an added node that only gets its guid there.
  //
  // Two sources, one queue: the member ROWS (Phase 3's storage) and `structure.moved` — a file's
  // legacy map, or the editor's in-memory view REDUCED by a Revert (which is why a rebuild cannot
  // simply re-assert the rows it carried). The writer never states one member in both; where a
  // hand-made or mixed document does, the ROW wins (skipped below).
  for (const [ecs, parentGuid] of rowMoves) {
    afterDeriveQueue(ops.world).moves.push({ ecsId: ecs, parentGuid, frameRoot: 0, logPrefix: ops.logPrefix });
  }
  for (const lid of movedSet) {
    const ecs = localToEcs.get(lid);
    const parentGuid = structure.moved?.[lid];
    if (ecs && parentGuid && !rowMoves.has(ecs)) afterDeriveQueue(ops.world).moves.push({ ecsId: ecs, parentGuid, frameRoot: 0, logPrefix: ops.logPrefix });
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

// ── Member moves (#1437) ──────────────────────────────────────────────────────
// A member moved inside its instance is expanded at its ROW parent, derived there, and only then moved, so
// its guid and every guid below it are the ones it had before the save. The queue drains at the end of
// `deriveInstanceMemberGuids`: every move first, then the removals a move deferred.
// Plain data rather than callbacks: each entry is one step of this load, not a subscriber.
type AfterDerive = {
  /** An instance's move names its member by `ecsId` and its new parent by guid. A PREFAB's own move (`base`)
   *  names both by path in the frame rooted at `frameRoot`: `memberPath`, and a member token. */
  moves: { ecsId?: number; memberPath?: string; parentGuid: string; frameRoot: number; base?: boolean; logPrefix: string }[];
  deletes: { ecsIds: number[]; ops: StructureApplyOps }[];
};
const afterDerive = new WeakMap<World, AfterDerive>();
function afterDeriveQueue(world: World): AfterDerive {
  let q = afterDerive.get(world);
  if (!q) { q = { moves: [], deletes: [] }; afterDerive.set(world, q); }
  return q;
}
/** Queue a prefab document's own moves (#1437 P3-b/P3-c): member path → member token of the new parent, both
 *  in the frame of the instance rooted at `frameRoot`, resolved once every guid is derived. The base of each
 *  member: an instance's own move of it overrides one, and the move of a prefab that nests the instance —
 *  queued after it, as its expansion finishes later — overrides the inner prefab's. */
export function queuePrefabMoves(world: World, frameRoot: number, moved: Record<string, string>, logPrefix: string): void {
  if (!frameRoot) return;
  for (const [memberPath, parentGuid] of Object.entries(moved)) {
    if (typeof parentGuid === 'string') afterDeriveQueue(world).moves.push({ memberPath, parentGuid, frameRoot, base: true, logPrefix });
  }
}

function drainAfterDerive(world: World): void {
  const q = afterDerive.get(world);
  if (!q) return;
  afterDerive.delete(world);
  const attrMeta = getTraitByName('EntityAttributes');
  const links: [number, number][] = [];
  if (attrMeta) for (const e of world.entities as Iterable<EntityHandle>) {
    links.push([e.id(), e.has(attrMeta.trait) ? ((e.get(attrMeta.trait) as { parentId?: number }).parentId ?? 0) : 0]);
  }
  const doomedRows = new Set(q.deletes.flatMap((d) => d.ecsIds));
  // Every path resolves BEFORE anything moves, against the rows as expanded.
  const indexes = new Map<number, Map<string, EntityHandle | null>>();
  const at = (frameRoot: number, path: string): EntityHandle | null => {
    let index = indexes.get(frameRoot);
    if (!index) { index = memberPathIndex(world, frameRoot); indexes.set(frameRoot, index); }
    return index.get(path) ?? null;
  };
  const guidOfHandle = (e: EntityHandle | null): string => (e && attrMeta ? ((e.get(attrMeta.trait) as { guid?: string }).guid ?? '') : '');
  // One move per member: an instance's own (the last of them) over any prefab's; among prefabs', the last —
  // the outermost. Moving twice would take the member through a parent no record names.
  const chosen = new Map<number, { m: AfterDerive['moves'][number]; parentGuid: string }>();
  for (const m of q.moves) {
    const ecsId = m.ecsId ?? at(m.frameRoot, m.memberPath ?? '\0')?.id();
    if (!ecsId) continue; // the instance removed the member its prefab moves: nothing to move
    const prev = chosen.get(ecsId);
    if (prev && !prev.m.base && m.base) continue;
    const t = isMemberToken(m.parentGuid) ? parseMemberToken(m.parentGuid) : null;
    const parentGuid = !t ? m.parentGuid : t.up ? '' : guidOfHandle(at(m.frameRoot, memberPathKey(t.path)));
    if (!parentGuid) console.warn(`${m.logPrefix} a prefab's move names ${m.parentGuid}, which is no member; left at its row`);
    chosen.set(ecsId, { m: { ...m, ecsId }, parentGuid });
  }
  // The moves describe the tree AFTER all of them, so one can pass through a cycle that exists only halfway: a
  // member moved under a member that was its row descendant waits for that one to move out first (#1452). A
  // move whose target still sits inside it waits for the others; one waiting once nothing else can move is a
  // real cycle, refused by moveMember with its warning. (While any wait, one is always ready: the path
  // down to its target must hold another move, and a finite tree bottoms out.)
  const settleMove = (m: AfterDerive['moves'][number], parentGuid: string): void => {
    if ((parentGuid && moveMember(world, m.ecsId!, parentGuid, m.logPrefix)) || !doomedRows.size) return;
    // The move failed, and the member still sits under a removed row that is about to go: lift it to the
    // nearest ancestor that stays, as a move, so the removal does not take it with it.
    const parentOf = new Map(links);
    let to = parentOf.get(m.ecsId!) ?? 0;
    while (to && doomedRows.has(to)) to = parentOf.get(to) ?? 0;
    const target = to ? findEntityById(to, world) as EntityHandle | undefined : undefined;
    const guid = target && attrMeta?.trait && target.has(attrMeta.trait) ? (target.get(attrMeta.trait) as { guid?: string }).guid : '';
    if (guid) moveMember(world, m.ecsId!, guid, m.logPrefix);
  };
  let pending = [...chosen.values()];
  for (let progressed = true; progressed;) {
    progressed = false;
    pending = pending.filter(({ m, parentGuid }) => {
      if (parentGuid && isInsideMember(world, m.ecsId!, parentGuid)) return true; // checked as it applies
      settleMove(m, parentGuid);
      progressed = true;
      return false;
    });
  }
  for (const { m, parentGuid } of pending) settleMove(m, parentGuid);
  // A member moved away from one of these rows keeps its path through it: the row is still in the document
  // (`core/ecs/identityParents.ts`), so nothing needs recording before it goes.
  for (const d of q.deletes) d.ops.deleteEntities(d.ecsIds);
}

/** Whether the entity whose guid is `parentGuid` sits inside `ecsId`'s subtree (itself included) right now. */
function isInsideMember(world: World, ecsId: number, parentGuid: string): boolean {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return false;
  for (let cur = findEntityByGuid(parentGuid, world) as EntityHandle | undefined, n = 0; cur && n < 10_000; n++) {
    if (cur.id() === ecsId) return true;
    const up: number = cur.has(attrMeta.trait) ? ((cur.get(attrMeta.trait) as { parentId?: number }).parentId ?? 0) : 0;
    cur = up ? findEntityById(up, world) as EntityHandle | undefined : undefined;
  }
  return false;
}

/** Reparent member `ecsId` under the entity whose guid is `parentGuid`. A target that is gone, or inside the
 *  member's own subtree, leaves the member at its row parent — a warning, never a loss. Nothing records
 *  where it came from: its template parent is read from the document (`core/ecs/identityParents.ts`) —
 *  except an OWNED nested root's owner, which its live parent stops saying once it moves
 *  ({@link linkOwnerBeforeMove}). */
function moveMember(world: World, ecsId: number, parentGuid: string, logPrefix: string): boolean {
  const attrMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  const member = findEntityById(ecsId, world) as EntityHandle | undefined;
  if (!attrMeta || !piMeta || !member?.has(attrMeta.trait) || !member.has(piMeta.trait)) return false;
  const target = findEntityByGuid(parentGuid, world) as EntityHandle | undefined;
  const ea = member.get(attrMeta.trait) as { parentId?: number; name?: string };
  if (!target) { console.warn(`${logPrefix} moved member "${ea.name}": its parent ${parentGuid} is gone; left at its row`); return false; }
  if (isInsideMember(world, ecsId, parentGuid)) { console.warn(`${logPrefix} moved member "${ea.name}": ${parentGuid} is inside it; left at its row`); return false; }
  // Refused, as it always was, from a row parent with no guid — the case a home could not be recorded for —
  // and a no-op when it is already there.
  const from = ea.parentId ? findEntityById(ea.parentId, world) as EntityHandle | undefined : undefined;
  const fromGuid = from?.has(attrMeta.trait) ? ((from.get(attrMeta.trait) as { guid?: string }).guid ?? '') : '';
  if (!fromGuid || fromGuid === parentGuid) return !!fromGuid;
  linkOwnerBeforeMove(world, ecsId);
  member.set(attrMeta.trait, { ...(member.get(attrMeta.trait) as Record<string, unknown>), parentId: target.id() });
  return true;
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
      world,
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
          { added: node.added, removed: node.removed, removedTraits: node.removedTraits, moved: node.moved, members: node.members }, undefined, node.nestedOverrides,
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
  /** The row's minted node identity (prefab v5, #1468). Absent on a pre-v5 document; stamped onto
   *  the spawned member as `PrefabInstance.nodeGuid` so a later save can carry it back. */
  nodeGuid?: string;
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
  /** A prefab row's member rows (prefab v6, #1533), keyed from the row's own expansion — the scene's
   *  `members` channel, so the row states its nested frames' structure per member and per node instead
   *  of whole (`nestedStructure`). Structural channels only: a template carries no member identity. */
  members?: Record<string, SceneMemberRow>;
};

/** A prefab cache to read documents from: the runtime's by default, the editor's for the editor's rebuild. */
type PrefabDocReader = (ref: string) => unknown;

/** R2's orphan test — does the template at `source` still declare what the scene row keyed `key` names? — the ONE
 *  spelling, for the load (`applyStoredMemberRows`) and the editor's rebuild (`settleKeptOrphans`, #1535), which
 *  must leave the kept store exactly as a reload of the same scene would. A member row is backed while every
 *  component of its key is a node the template tree still declares; a NODE row (#1516) while its frame's row adds
 *  its key (`templateFrameKeys`, per frame).
 *
 *  Asked of the DOCUMENT, not of the live world, and that is the load-bearing part: a member the instance REMOVED
 *  is absent from the world but still in the template, and its row is not an orphan. `complete` is false when a
 *  document on the way was not cached — the answer is then "cannot tell", which the load does not report. */
export function rowBackedTest(source: string, read: PrefabDocReader = getCachedPrefab): { backed(key: string): boolean; complete: boolean } {
  const { guids: known, complete } = templateNodeGuids(source, read);
  return {
    complete,
    backed: (key) => {
      const node = parseNodeRowKey(key);
      const parts = node?.frame ?? parseMemberRowKey(key);
      return !!parts.length && parts.every((c) => known.has(c)) && (!node || !!templateFrameKeys(source, node.frame, read)?.has(node.nodeKey));
    },
  };
}

/** Every minted node identity the template at `prefabRef` declares, following its nested rows.
 *
 *  A membership SET, deliberately not a key walk: it answers "does this document still contain that
 *  node" and nothing else, so it cannot disagree with `memberRowKeysIn` about what a key IS. A third
 *  spelling of the identity walk is exactly what #1468 Phase 1 spent itself removing. */
function templateNodeGuids(prefabRef: string, read: PrefabDocReader = getCachedPrefab): { guids: Set<string>; complete: boolean } {
  const guids = new Set<string>();
  const seen = new Set<string>();
  let complete = true;
  const walk = (ref: string): void => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    const doc = read(ref) as { entities?: PrefabFileEntry[] } | null;
    // ⚠️ A nested prefab that is not cached is "I cannot tell", NOT "those nodes are gone". Without
    // this the caller reports every member of an uncached nested instance as a lost row — a loud,
    // wrong claim caused by a cache miss, on exactly the documents least able to afford one.
    if (!doc?.entities) { complete = false; return; }
    for (const row of doc.entities) {
      if (row.nodeGuid) guids.add(row.nodeGuid);
      if (row.prefab) walk(row.prefab);
    }
  };
  walk(prefabRef);
  return { guids, complete };
}

/** The template keys of the nodes the template adds in ONE nested frame (#1516) — the frame `frame` names, one
 *  nested-row identity per level from `prefabRef` down — which is what a node row in that frame can name: its
 *  row's own `added`, plus the `nestedStructure` slot of each row above it whose localId path addresses exactly
 *  this frame. Only that slot: a key "backed" by any other slot applies nowhere, and read as backed it is dropped
 *  on the next save — the loss this check exists to prevent (re-review R2). Plain nodes' `children` included;
 *  not a reference node's own `added`, which is that node's frame. Null when a document on the way is not cached
 *  or the frame's row is gone.
 *
 *  Per FRAME, not template-wide: a prefab-editor re-parent keeps a node's key, so a node moved from one row's
 *  frame into another's would otherwise read as backed where the scene's row names it, apply nowhere, and drop
 *  on the next save (close-out review F5). */
function templateFrameKeys(prefabRef: string, frame: readonly string[], read: PrefabDocReader = getCachedPrefab): Set<string> | null {
  const keys = new Set<string>();
  const add = (nodes: readonly AddedEntity[] | undefined): void => {
    for (const n of nodes ?? []) { if (n?.key) keys.add(n.key); if (!n?.prefab) add(n?.children); }
  };
  const rows: PrefabFileEntry[] = [];
  let doc = read(prefabRef) as { entities?: PrefabFileEntry[] } | null;
  for (const component of frame) {
    const row = doc?.entities?.find((r) => r.nodeGuid === component && r.prefab);
    if (!row?.localId) return null;
    rows.push(row);
    doc = read(row.prefab!) as { entities?: PrefabFileEntry[] } | null;
  }
  // Row i's slot for the frame is keyed by the localIds of the rows BELOW it on the way down (`nestedPathKey`).
  rows.forEach((row, i) => {
    if (i === rows.length - 1) add(row.added);
    else add(row.nestedStructure?.[nestedPathKey(rows.slice(i + 1).map((r) => r.localId!))]?.added);
  });
  return keys;
}

/** Member rows this load could not match to any node the template still declares (R2), kept per
 *  instance-root guid so the next SAVE can write them back rather than dropping them.
 *
 *  ⚠️ **Retained, not repaired.** A row orphans when its template node is GONE — a member deleted
 *  from the prefab, or a rigged re-import that could not re-associate a renamed bone. Keeping it
 *  means an undone template edit, or a re-import that matches again, restores the scene's identity
 *  for that member instead of silently minting a new one. That is the containment the #1468 design record promises: a
 *  rename costs one orphaned row and a log line, never a re-pointed subtree.
 *
 *  ⚠️ A member the INSTANCE removed is NOT an orphan — its node is still in the template, so its row
 *  is retained silently and un-removing it gets its identity back. R2 says this explicitly, and the
 *  distinction is why this asks the DOCUMENT rather than the live world: every removed member is
 *  absent from the world and would otherwise be reported as a loss on every load.
 *
 *  ⚠️ Rows accumulate: nothing expires an orphan, so a template that churns members grows the map
 *  by ~150 bytes each time. Accepted for now — the alternative is dropping identity on a timer — but
 *  it is the reason a later phase may want a deliberate prune, and not something to discover then. */
const orphanMemberRows = new Map<string, Record<string, SceneMemberRow>>();

/** The orphan rows kept for the instance root with this guid, for the writer to re-emit (R2). */
export function keptMemberOrphans(rootGuid: string): Record<string, SceneMemberRow> | undefined {
  return orphanMemberRows.get(rootGuid);
}

/** Replace the orphan rows kept for the instance root with guid `rootGuid` — the editor rebuild's write-back
 *  (`settleKeptOrphans`, #1535). A Refresh is the other route a template change reaches an open scene by, so it
 *  must leave this store as a reload would: every row the NEW template no longer backs kept (fork 2), whatever
 *  frame it is in, and every one it backs again applied and gone. */
export function setKeptMemberOrphans(rootGuid: string, rows: Record<string, SceneMemberRow>): void {
  if (!rootGuid) return;
  if (Object.keys(rows).length) orphanMemberRows.set(rootGuid, rows);
  else orphanMemberRows.delete(rootGuid);
}

/** Drop every kept orphan. For tests — production keeps them for the lifetime of the process,
 *  because the only reader is a save of the same instance root. */
export function clearKeptMemberOrphans(): void {
  orphanMemberRows.clear();
}

/** One user-added REFERENCE node's stored member rows: its root's guid, the rows, the prefab it expands. */
export type ReferenceNodeRows = [rootGuid: string, members: Record<string, SceneMemberRow>, source: string];

/** Every user-added REFERENCE node in an `added[]` tree, with its stored member rows (`{}` when it stores none) — the ONE spelling of
 *  "where can a reference node's rows be", read by the loader to pin them and by `rebuildInstance` to
 *  carry them across a respawn (#1482). A reference node is its own row-writing root (`memberRowsIn`
 *  stops at it), so a walk of the instance around it never reaches these rows; each has to be pinned
 *  from its own node, found by the guid the node stores.
 *
 *  Collected from the DOCUMENT rather than at the spawn, because those spawns happen several frames
 *  down inside `applyStructureCore`'s ops and the node's own stored `guid` is a perfectly good handle
 *  to the root once it exists. */
export function collectReferenceNodeRows(nodes: unknown, out: ReferenceNodeRows[] = [], keyed?: ReferenceNodeRows[]): ReferenceNodeRows[] {
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as AddedEntity[]) {
    if (!n || typeof n !== 'object') continue;
    // Every reference node, rows or not: the load resets the kept-orphan store per root (R2), and a node whose file
    // states no rows keeps none (#1535 close-out re-review — a stale set otherwise went straight back to disk).
    if (n.prefab && n.guid) out.push([n.guid, n.members ?? {}, n.prefab]);
    // A TEMPLATE reference node (#1542) stores no guid — its root derives one — so it is handed back by its KEY, for a
    // caller that can find its root once the derive has run (`keepTemplateNodeOrphans`).
    else if (n.prefab && n.key) keyed?.push([n.key, n.members ?? {}, n.prefab]);
    collectReferenceNodeRows(n.added, out, keyed);
    collectReferenceNodeRows(n.children, out, keyed);
    for (const delta of Object.values(n.nestedStructure ?? {})) collectReferenceNodeRows(delta?.added, out, keyed);
    // …and a member row's `added` (Phase 4, #1468): a reference node hanging under a member now
    // rides on that member's row, and its own rows must be pinned exactly as before.
    for (const r of Object.values(n.members ?? {})) collectReferenceNodeRows(memberRowNodes<AddedEntity>(r), out, keyed);
  }
  return out;
}

/** R2 for a TEMPLATE reference node (#1542): the node's rows the template it expands no longer backs are kept under its
 *  root's DERIVED guid, which is what a later save (`captureRowChannels`) and a Refresh (`settleKeptOrphans`) read it
 *  by. Runs after the derive, because until then the root has no guid to key by.
 *
 *  `keyed` is what `collectReferenceNodeRows` found in ONE scene entry's own statements — the file that entry came
 *  from, which in the prefab-edit world is the prefab being edited. A node a NESTED template declares is folded inside
 *  the instantiation and never reaches that walk, so its rows are never kept here: they are that template's, and no
 *  save of this file writes them. The root is found by its key below the entry's root — a key is minted per node, so
 *  one entry declares it once. */
function keepTemplateNodeOrphans(world: World, entryRootId: number, keyed: readonly ReferenceNodeRows[]): void {
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta || !piMeta || !keyed.length) return;
  const parentOf = new Map<number, number>();
  const byKey = new Map<string, number[]>();
  for (const e of world.entities as Iterable<Entity>) {
    if (!e.has(eaMeta.trait)) continue;
    parentOf.set(e.id(), (e.get(eaMeta.trait) as { parentId?: number }).parentId ?? 0);
    const key = templateKeyOf(e);
    if (key && e.has(piMeta.trait) && isStoredRoot(e.get(piMeta.trait) as MemberPi, e.id())) byKey.set(key, [...(byKey.get(key) ?? []), e.id()]);
  }
  const under = (id: number): boolean => {
    for (let p = parentOf.get(id) ?? 0, hops = 0; p && hops < 10000; p = parentOf.get(p) ?? 0, hops++) if (p === entryRootId) return true;
    return false;
  };
  for (const [key, members, source] of keyed) {
    const roots = (byKey.get(key) ?? []).filter(under);
    if (roots.length === 1) applyStoredMemberRows(world, roots[0]!, members, source, undefined, true);
  }
}

/** Put the GUIDS a scene stored for this instance's members back on them (v16, #1468) — the read half
 *  of `captureInstanceMembers`, and the reason a member's identity no longer depends on where it sits.
 *  A row's other field, `parent` (Phase 3), is not read here: `applyStructureCore` queues the move,
 *  for the reason #1437 queued the old map — the new parent may only get its guid in the derive.
 *
 *  Runs BEFORE `deriveInstanceMemberGuids`, so a pinned member arrives at that pass already carrying
 *  a guid and is simply skipped by it ("only fills EMPTY guids"). Derivation therefore becomes the
 *  FALLBACK it is meant to be (#1468 design record R3) with no change to the derive walk itself: a member with
 *  no row derives exactly what it derives today, including one BELOW a pinned member — the walk goes
 *  THROUGH a member either way, because `isDerivedMember` says a member is never an anchor.
 *
 *  ⚠️ **Precedence: a stored row BEATS a guid the template handed the member.** The only way a member
 *  arrives carrying one is a document whose member row was authored with a guid — `serializePrefab`
 *  clears them — and such a guid is shared by every instance of that template, which is #1293. The
 *  row is the SCENE's statement about ITS instance, and a per-instance statement beating a shared one
 *  is how every other override in this engine works. Derivation stays the last resort, so the full
 *  order is row > template guid > derived.
 *
 *  This started life as "only fill an EMPTY guid", mirroring `deriveInstanceMemberGuids`. Mutation
 *  said that guard could not be falsified, and asking why turned up the precedence question it was
 *  quietly answering the other way. A stale row cannot cause a wrong match here: identity is minted
 *  and never reused, so a row that finds no member DANGLES and one that finds a member is about that
 *  member. */
function applyStoredMemberRows(
  world: World, rootEcsId: number, members: Record<string, SceneMemberRow>, source: string, pinned?: Set<number>,
  /** Keep the orphans only (R2), pinning no guid: a TEMPLATE node's rows, read after the derive (`keepTemplateNodeOrphans`),
   *  carry no member identity, and a guid one held anyway must not land past the collision guard. */
  keepOnly = false,
): void {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return;
  if (!Object.keys(members).length) {
    const root = findEntityById(rootEcsId, world) as EntityHandle | undefined;
    const guid = durableGuid(root?.has(attrMeta.trait) ? (root.get(attrMeta.trait) as { guid?: string }).guid : '');
    if (guid) orphanMemberRows.delete(guid);
    return;
  }
  for (const [ecsId, key] of keepOnly ? [] : memberRowKeysIn(rootEcsId, world)) {
    const row = members[key];
    if (!row) continue;
    const guid = durableGuid(row.guid);
    if (!guid) continue;
    const e = findEntityById(ecsId, world) as EntityHandle | undefined;
    if (!e || !e.has(attrMeta.trait)) continue;
    const ea = e.get(attrMeta.trait) as Record<string, unknown>;
    if (ea.guid === guid) continue;
    e.set(attrMeta.trait, { ...ea, guid });
    indexEntityGuid(e, world);
    pinned?.add(ecsId);
  }

  // R2 — a row naming a node the template no longer declares. Asked of the DOCUMENT, not of the live
  // world, and that is the load-bearing part: a member this instance REMOVED is absent from the world
  // but still IN the template, so a live-world test would report a loss on every load of every
  // instance that has ever deleted a member. Such a row is dropped silently, as R2 says — its member
  // can only come back through undo, which restores the scene entry and its rows with it.
  const root = findEntityById(rootEcsId, world) as EntityHandle | undefined;
  const rootGuid = durableGuid(root?.has(attrMeta.trait) ? (root.get(attrMeta.trait) as { guid?: string }).guid : '');
  if (!rootGuid) return;
  const { backed, complete } = rowBackedTest(source);
  const orphans: Record<string, SceneMemberRow> = {};
  let count = 0;
  for (const [key, row] of Object.entries(members)) {
    // A NODE row (#1516) orphans when the template no longer adds its node, and is kept exactly as a member
    // row is (fork 2, owner 2026-09-24): the node vanishes with the template, and a template that brings it
    // back brings the scene's edit back with it.
    if (backed(key)) continue;
    orphans[key] = row;
    count++;
  }
  if (!count) { orphanMemberRows.delete(rootGuid); return; }
  // Keep them either way — what differs is whether we are entitled to SAY they are gone.
  orphanMemberRows.set(rootGuid, orphans);
  if (!complete) return; // a prefab this walk could not read; see templateNodeGuids
  // Named, and once per instance. A count alone cannot be acted on, and the row is the ONE place the
  // member's name can still come from — its template node is gone, so nothing else knows it.
  const named = Object.entries(orphans).slice(0, 5).map(([k, r]) => `"${r.name || '?'}" (${k})`).join(', ');
  console.warn(`[loadSceneFile] ${count} member row${count === 1 ? '' : 's'} in instance ${rootGuid} name no node the template still declares: ${named}${count > 5 ? `, +${count - 5} more` : ''} — kept, in case the template edit is undone`);
}

/** The UNIQUENESS guard (#1468 Phase 2B): a guid a ROW pinned can be one another member
 *  DERIVES, and then two entities answer to one address — #1355's shape, which nothing in this
 *  format previously had any reason to check, because a member's guid was only ever derived and the
 *  derived set is internally collision-free (one hash per anchor+path).
 *
 *  Reachable without anything being corrupt: a row pins member M to the guid it had at some earlier
 *  path, the template moves M, and whatever now occupies M's old path derives that same guid.
 *
 *  **The PIN yields, not the derived member**, and that direction is the whole safety of this: an
 *  un-pinned member falls back to derivation, which is where it was before v16 and is addressable;
 *  a de-derived member would have no guid at all and become unaddressable, a failure v16 did not
 *  have. So this clears the pin and re-runs the derive, which fills exactly the guids it cleared.
 *
 *  ⚠️ Reported per entity, and loudly. The scene keeps its row, so the next save writes it back and
 *  the collision returns on every load until someone repairs the document — which is the right
 *  behaviour (silently rewriting a row is how identity gets lost) and the reason it must be visible.
 *
 *  ⚠️ **Run to a FIXPOINT, because one pass can create the collision it is fixing.** The re-derive
 *  fills the cleared members with values that can themselves meet a pin that was not dropped: row
 *  `/gM` pins M to a guid K derives (M's pin goes), row `/gN` pins N to M's OWN derivation — which
 *  had one holder at scan time, so nothing was dropped there — and the re-derive then hands M that
 *  same guid. Two members, one address, no warning: the #1355 shape arriving through the guard.
 *  Raised as PLAUSIBLE by the Phase 2B close-out review, which could not build the two-pin fixture;
 *  I could, so it is CONFIRMED and pinned by a test that reddens on a single pass. It terminates
 *  because `cleared` only ever increments alongside `live.delete(id)` and the loop returns when a
 *  pass clears nothing, so `live` shrinks by at least one per pass and is bounded by `pinned`.
 *
 *  ⚠️ **Calling `deriveInstanceMemberGuids` more than once per load is safe, and this is the part
 *  worth checking before touching it.** Verified in the code, twice independently: `drainAfterDerive`
 *  does `afterDerive.delete(world)` on ENTRY, so the move queue drains exactly once and passes 2..N
 *  find nothing (`resolveTemplateFrames` has the same shape). The derive fills only EMPTY guids, so a
 *  later pass touches only what this one cleared. And a re-derived member gets the SAME guid the
 *  first pass would have given it even though the moves have since been applied — because the walk
 *  reads a moved member's TEMPLATE parent from the document (`core/ecs/identityParents.ts`), not where
 *  the move put it (#1468 Phase 6; it read a recorded home, `homeParent`, before). */
function dropCollidingPins(world: World, pinned: ReadonlySet<number>): void {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return;
  const live = new Set(pinned);
  for (let pass = 0; live.size; pass++) {
    const holders = new Map<string, number[]>();
    for (const e of world.entities as Iterable<EntityHandle>) {
      if (!e.has(attrMeta.trait)) continue;
      const guid = durableGuid((e.get(attrMeta.trait) as { guid?: string }).guid);
      if (!guid) continue;
      const list = holders.get(guid);
      if (list) list.push(e.id());
      else holders.set(guid, [e.id()]);
    }
    let cleared = 0;
    for (const [guid, ids] of holders) {
      if (ids.length < 2) continue;
      // Only a PIN is dropped. Two entities sharing a guid for any other reason is a different defect
      // and not this pass's to silently paper over.
      for (const id of ids.filter((i) => live.has(i))) {
        const e = findEntityById(id, world) as EntityHandle | undefined;
        if (!e || !e.has(attrMeta.trait)) { live.delete(id); continue; }
        const ea = e.get(attrMeta.trait) as Record<string, unknown>;
        console.warn(`[loadSceneFile] stored member row pins guid ${guid}, which another entity in this scene also holds — dropping the pin for "${String(ea.name ?? '?')}" and deriving instead; the scene document needs repairing`);
        e.set(attrMeta.trait, { ...ea, guid: '' });
        live.delete(id); // a dropped pin is not a pin any more, and cannot be dropped twice
        cleared++;
      }
    }
    if (!cleared) return;
    // The derive fills EMPTY guids, so this is exactly the set just cleared — and the next pass asks
    // whether what it filled collides with a pin that is still standing.
    deriveInstanceMemberGuids(world);
  }
}

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
 *  The guid rule itself is `deriveMemberGuid` and the step classifier `entityStep` /
 *  `isStoredRoot` / `isDerivedMember` (`runtime/core/assetRefRules.ts`, shared since #1468
 *  Phase 1 — this walk used to spell all four inline). ⚠️ The ANCESTOR walk is
 *  MIRRORED twice, because a duplicate must predict where a reload puts each member: over a scene
 *  FILE by `derivedMemberPaths` + `sceneAnchorOf` (engine/plugins/asset-fs-ops.ts, #1324/#1339), and
 *  over a live subtree by `planCopyGuids` (`core/copyIdentity.ts`: the editor's duplicate/paste and
 *  the device op, #1338) — change all three. Both mirrors step a keyed node by its key too (#1430). */
export function deriveInstanceMemberGuids(world: World): void {
  const piMeta = getTraitByName('PrefabInstance');
  const attrMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !attrMeta) return;

  type Row = { handle: EntityHandle; origGuid: string; parentId: number; stepId: MemberStep; extra: MemberStep[]; hasPI: boolean; keyed: boolean; storedRoot: boolean; derivedMember: boolean; placed?: boolean };
  const rows = new Map<number, Row>();
  // The same walk feeds the identity resolver, so it does not walk the world a second time.
  const nodes: IdentityNode[] = [];
  const packedById = new Map<number, PackedEntity>();
  for (const e of world.entities as Iterable<EntityHandle>) {
    packedById.set(e.id(), packedOf(e as unknown as Entity));
    if (!e.has(attrMeta.trait)) continue;
    const ea = e.get(attrMeta.trait) as { guid?: string; parentId?: number };
    const hasPI = e.has(piMeta.trait);
    const pi = hasPI ? (e.get(piMeta.trait) as MemberPi) : null;
    // A member's position in the chain is its localId — EXCEPT a nested-instance
    // root, whose localId is the (shared) inner root id; its distinguishing
    // position is parentLocalId (which OUTER row produced it). Two sibling nested
    // instances share inner localIds, so without this their members would collide.
    // A node a prefab TEMPLATE added (a row's `added`, or a reference node's root) steps by its template
    // key instead (#1387): it has no localId of its own, and two sibling reference nodes share one.
    const key = templateKeyOf(e);
    const stepId = entityStep(pi, key);
    const storedRoot = isStoredRoot(pi, e.id());
    // A member of an instance — linked to another root, or an OWNED nested root — whose guid is always derived.
    const derivedMember = isDerivedMember(pi, e.id(), key);
    // durableGuid: a runtime guid (#1210) is neither an identity to keep nor an anchor to derive from.
    rows.set(e.id(), { handle: e, origGuid: durableGuid(ea.guid), parentId: ea.parentId ?? 0, stepId, extra: [], hasPI, keyed: !!key, storedRoot, derivedMember });
    nodes.push({ id: e.id(), parentId: ea.parentId ?? 0, guid: ea.guid ?? '', pi: pi as IdentityPi });
  }
  // A member moved inside its instance steps from its TEMPLATE parent (#1437), read from the document the
  // frame was expanded from, with a step for each template row between that is gone (#1468 Phase 6). Asked
  // only of the rows a walk actually reaches: on a runtime spawn that is the new instance's members, not the
  // whole world (close-out review: resolving every row cost ~1 ms a spawn at 3000 entities).
  const parents = resolveIdentityParents(nodes, frameDocReader(world, undefined, packedById));
  const place = (row: Row | undefined): Row | undefined => {
    if (row && row.hasPI && !row.placed) {
      const at = parents.of(row.handle.id());
      row.parentId = at.parentId;
      row.extra = at.extra;
      row.placed = true;
    }
    return row;
  };

  // The guid each guid-less row derives ('' = unaddressable), memoised: a guid-less stored root is
  // resolved on demand when a member below it needs its guid as the anchor. `null` marks a row
  // in progress, so a parent cycle resolves to '' instead of recursing.
  const derivedOf = new Map<number, string | null>();
  const resolve = (id: number, row: Row): string => {
    const memo = derivedOf.get(id);
    if (memo !== undefined) return memo ?? '';
    derivedOf.set(id, null);
    // Walk up to the nearest anchor: a row that had a guid BEFORE this pass, or a guid-less stored root.
    place(row);
    const path: (number | string)[] = [...row.extra, row.stepId];
    let anchor = '';
    let cur = place(rows.get(row.parentId));
    const seen = new Set<number>([id]);
    while (cur && !seen.has(cur.handle.id())) {
      // A MEMBER's guid is derived, never an anchor (#1437): at load no member has one yet, so the walk goes
      // through it. Once derived it must STILL go through, or a later pass — the rebuild of an owned nested
      // instance, whose outer members already carry guids — anchors on the nearest member and derives guids
      // a reload does not reproduce.
      if (cur.origGuid && !cur.derivedMember) { anchor = cur.origGuid; break; }
      if (cur.storedRoot) { anchor = resolve(cur.handle.id(), cur); break; }
      seen.add(cur.handle.id());
      path.unshift(...cur.extra, cur.stepId);
      cur = place(rows.get(cur.parentId));
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
      const row = place(rows.get(id));
      if (!row) return undefined;
      const pi = row.hasPI ? (row.handle.get(piMeta.trait) as { localId?: number; parentLocalId?: number }) : null;
      const guid = durableGuid((row.handle.get(attrMeta.trait) as { guid?: string }).guid);
      return { guid, parentId: row.parentId, key: templateKeyOf(row.handle), pi, extra: row.extra };
    };
    // Only a node INSIDE a top-level instance can be template-added, and its original anchor is at or
    // below that instance's stored root — so candidates are bounded to instances and each walk stops
    // at the root. Known misses are skipped until the node's guid or the world's key set changes.
    const insideMemo = new Map<number, boolean>();
    const inside = (id: number): boolean => {
      const hit = insideMemo.get(id);
      if (hit !== undefined) return hit;
      insideMemo.set(id, false); // a parent cycle is not inside anything
      const parent = rows.get(place(rows.get(id))?.parentId ?? 0);
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
      let cur = place(rows.get(id))?.parentId ?? 0;
      const seen = new Set<number>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        ids.push(cur);
        if (rows.get(cur)?.storedRoot) break;
        cur = place(rows.get(cur))?.parentId ?? 0;
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
  // Only now do moved members leave their row parents (#1437).
  drainAfterDerive(world);
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

// memberPathIndex (and the child map it walks) moved to core/ecs/memberHome.ts, beside the other identity
// walks, so the core-layer promotion of an owned nested root can re-derive through it (#1447).

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
  const tree = identityTree(world);
  const indexes = new Map<number, ReturnType<typeof memberPathIndex>>();
  const indexOf = (frame: number) => {
    let index = indexes.get(frame);
    if (!index) { index = memberPathIndex(world, frame, tree); indexes.set(frame, index); }
    return index;
  };
  let climb: ReturnType<typeof templateFrameClimber> | undefined;
  for (const rootId of new Set(roots)) {
    const root = findEntityById(rootId, world) as EntityHandle | undefined;
    const pi = root?.has(piMeta.trait) ? root.get(piMeta.trait) as { rootInstanceId?: number } : null;
    if (!root || pi?.rootInstanceId !== rootId) continue; // gone, or the id now names something else
    const index = indexOf(rootId);
    // A `^` left after the rebase climbs out of this top call's root. Only a template reference node's root has a
    // frame above it (#1541): the instance holding the node, and from there the frames around that.
    const guidAt = (token: string): string => {
      const t = parseMemberToken(token);
      if (!t) return token;
      const frame = t.up ? (climb ??= templateFrameClimber(world))(rootId, t.up) : rootId;
      if (!frame) return token;
      const target = (t.up ? indexOf(frame) : index).get(memberPathKey(t.path));
      const guid = target ? ((target.get(attrMeta.trait) as { guid?: string }).guid ?? '') : '';
      return guid || token;
    };
    const ownFrame = (e: EntityHandle): boolean => {
      if (e.id() === rootId || !e.has(piMeta.trait)) return true;
      return !isStoredRoot(e.get(piMeta.trait) as MemberPi, e.id());
    };
    for (const e of new Set([...index.values()].filter((x): x is NonNullable<typeof x> => !!x && ownFrame(x)))) {
      for (const meta of traits) {
        if (!e.has(meta.trait)) continue;
        const data = e.get(meta.trait);
        if (!hasMemberToken(data)) continue;
        e.set(meta.trait, mapStringValues(data, (v) => (isMemberToken(v) ? guidAt(v) : v)));
      }
    }
  }
}

const readRuntimeTemplateDoc = (source: string) => getCachedPrefab(source) as TemplateDoc | undefined;

export function instantiatePrefabIntoWorld(
  world: World,
  prefab: { entities: PrefabFileEntry[]; rootLocalId?: number; id?: string; moved?: Record<string, string> },
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
  /** The structural LAYERS reaching this frame, innermost first (#1533) — set by the recursion only. A
   *  top call has one, built from `structure.members` and `nestedStructure`; each nested row it expands
   *  adds its own (`descendStructureLayers`). */
  _layers?: StructureLayer<NestedStructureDelta, SceneMemberRow>[],
  /** The first of `_layers` whose direct rows fold at this frame (`descendStructureLayers`). */
  _foldFrom = 0,
): number {
  const segments = _segments ?? [];
  const layers = _layers ?? [{ slots: nestedStructure, rows: structure?.members, rootRow: structure?.rootRow }];
  // The frame's member ROWS, translated into this document's localIds and folded over the legacy
  // channels (Phase 4, #1468) — FIRST, so everything below, token noting included, sees one set of
  // channels in the address space of the document it is expanding. A row names its member by minted
  // identity, so this is the moment a template renumber stops mattering: `prefab` is the CURRENT
  // document, whatever it was when the scene was saved. Every layer's rows fold, inner first (#1533).
  const lower = { overrides, added: structure?.added, removed: structure?.removed, removedTraits: structure?.removedTraits };
  const { channels: folded, forwardRoots } = foldStructureLayers(prefab, layers, _foldFrom, lower);
  if (folded !== lower && structure) {
    overrides = folded.overrides;
    structure = { ...structure, added: folded.added, removed: folded.removed, removedTraits: folded.removedTraits };
  }
  // The keys this document declares are the candidates a later heal of this world tries (#1426).
  noteTemplateDoc(world, prefab as Parameters<typeof noteTemplateDoc>[1]);
  // Identity walks read a frame's document; one whose root record is gone (a flat respawn) falls back to
  // the runtime cache, which this module owns (`identityParents.ts`). Idempotent — set on every spawn.
  setRuntimeFrameDocFallback(readRuntimeTemplateDoc);
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
      // Per LAYER since #1533: the row's own (`nestedStructure`, `members`) joins the ones reaching this frame,
      // innermost, and `structDirect` is the slot of the outermost layer that addresses the row.
      const { layers: childLayers, direct: structDirect, foldFrom } = descendStructureLayers(layers, entry, forwardRoots);
      const { forward: outerStructForward } = descendPathKeyed(nestedStructure, rowLocalId);
      // The row's OWN deep structure (#1381) sits under what the outer layer forwarded — outer wins per path.
      // Kept beside the layers for what reads the merged view (token noting); the layers are what apply.
      const structForward = mergeNestedStructurePaths(entry.nestedStructure, outerStructForward);
      // This row's own frame, one component down the identity chain (Phase 3, #1468) — the OUTERMOST layer's
      // rows, which `applyStructureCore` reads for moves (a template's rows carry none).
      const childMembers = childLayers[childLayers.length - 1]!.rows;
      const childRoot = instantiatePrefabIntoWorld(
        world, child, 0, undefined, entry.prefab, childOverrides,
        // Once an outer layer addresses this path it OWNS the interior: all three lists come from
        // it, with an absent one read as EMPTY rather than falling back to the row. Per-field
        // fallback made "the row's own list no longer applies" unrepresentable — a scene that
        // deleted the last member of a row-authored `added` wrote nothing for it and the member came
        // back on the next load.
        // ⚠️ `members` rides ALONGSIDE that ownership rule, never inside it: an outer layer owning
        // this row's three structural lists says nothing about identity, and a `structDirect` that
        // omitted the rows would drop every stored guid inside this expansion.
        structDirect
          ? { added: structDirect.added ?? [], removed: structDirect.removed ?? [], removedTraits: structDirect.removedTraits ?? {}, moved: structDirect.moved, members: childMembers }
          : { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits, members: childMembers },
        stack, childNested,
        structForward,
        [...segments, rowPathInPrefab(prefab, rowLocalId)],
        childLayers, foldFrom,
      );
      // Stamp parentLocalId so a later serialize knows which row produced this
      // instance (and can store/restore its scene-level overrides).
      if (childRoot && rowLocalId && piMeta) {
        let childEntity: { has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void } | undefined;
        for (const e of world.entities) {
          if ((e as { id(): number }).id() === childRoot) { childEntity = e as never; break; }
        }
        if (childEntity?.has(piMeta.trait)) {
          // `parentNodeGuid` beside `parentLocalId` (#1468): this nested root's own `nodeGuid` is its
          // identity in the CHILD document, so the OUTER row's identity has nowhere else to live.
          childEntity.set(piMeta.trait, {
            ...(childEntity.get(piMeta.trait) as Record<string, unknown>),
            parentLocalId: rowLocalId, parentNodeGuid: entry.nodeGuid ?? '',
          });
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
        // The row's own identity, handed to the member it spawns (#1468). '' for a pre-v5 document:
        // it has none, and nothing here may invent one — minting belongs to the save.
        nodeGuid: entry.nodeGuid ?? '',
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

  // What this frame's localIds MEAN — the document it was expanded from, recorded at its root: every identity
  // walk reads its members' template parents from it (`core/ecs/identityParents.ts`, #1468 Phase 6).
  if (source && rootEcsId) noteFrameDoc(world, source, prefab, handleById.get(rootEcsId) as Entity | undefined);

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
  if (structure && (structure.added?.length || structure.removed?.length || structure.removedTraits || structure.moved || structure.members)) {
    applyStructureByLocalToEcs(world, localToEcs, prefab, rebaseStructureTokens(structure, segments));
  }

  // Pop this prefab off the cycle stack — the guard tracks ANCESTORS in the
  // current expansion, not every prefab ever expanded. Without this, a prefab
  // nested more than once as a SIBLING (e.g. the same Engine Flame under both
  // wings) would falsely trip the cycle guard on the second expansion.
  if (prefab.id) stack.delete(prefab.id);
  if (prefab.moved) queuePrefabMoves(world, rootEcsId, prefab.moved, '[loadSceneFile]');

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
    /** Member rows (v16) — since Phase 4 (#1468) a row's `traits` and `added` carry refs too. */
    members?: Record<string, SceneMemberRow>;
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
      walkRows(node.members);
    };
    /** A member row's edits (Phase 4, #1468) — the channels the rows took over from `overrides` and
     *  `added`, so the same two shapes: a trait bag, and added nodes. Missing them here drops an
     *  override-only asset from the scene's preload and refcount exactly as `overrides` once did. */
    const walkRows = (members: Record<string, SceneMemberRow> | undefined): void => {
      for (const r of Object.values(members ?? {})) {
        if (r?.traits && typeof r.traits === 'object') flat.push({ traits: r.traits });
        memberRowNodes<AddedEntity>(r).forEach(walkAdded);
      }
    };
    entry.added?.forEach(walkAdded);
    walkRows(entry.members);
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
  migrateV14toV15(data);
  migrateV15toV16(data);
  migrateV16toV17(data);
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

  /** Rows to pin once EVERY instance has finished expanding (v16, #1468) — see the apply below.
   *  Declared out here so a base-scene chain's per-file calls each pin their own instances. */
  const storedMembers: [number, Record<string, SceneMemberRow>, string][] = [];
  /** The same, for every nested instance a REFERENCE node spawns (`collectReferenceNodeRows`). */
  const addedInstanceRows: ReferenceNodeRows[] = [];
  /** …and every TEMPLATE reference node in an entry's own statements, per entry root (#1542, `keepTemplateNodeOrphans`). */
  const templateNodeRows: [number, ReferenceNodeRows[]][] = [];
  const collectAddedRows = (nodes: unknown, keyed?: ReferenceNodeRows[]): void => { collectReferenceNodeRows(nodes, addedInstanceRows, keyed); };
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
        { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits, moved: entry.moved, members: entry.members },
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
        // Deferred, not applied here: a nested instance below this one may still be expanding, and
        // the walk that finds a member's row key reads the finished ECS parent tree.
        // Every instance, rows or not: a load is what makes the kept-orphan store current for this root (R2), and
        // one whose entry states no rows keeps none — a stale set left behind would be replayed by the editor's
        // next rebuild (`settleKeptOrphans`, #1535 close-out review F4).
        storedMembers.push([rootEcsId, entry.members ?? {}, source]);
        const keyed: ReferenceNodeRows[] = [];
        collectAddedRows(entry.added, keyed);
        for (const delta of Object.values(entry.nestedStructure ?? {})) collectAddedRows(delta?.added, keyed);
        for (const r of Object.values(entry.members ?? {})) collectAddedRows(memberRowNodes<AddedEntity>(r), keyed);
        if (keyed.length) templateNodeRows.push([rootEcsId, keyed]);
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

  // All prefab instances are now expanded with correct parentIds. Stored member identity goes on
  // FIRST (v16, #1468), so the derive below fills only what no row named — derivation is the
  // fallback now, not the rule.
  const pinned = new Set<number>();
  for (const [rootEcsId, members, source] of storedMembers) applyStoredMemberRows(world, rootEcsId, members, source, pinned);
  // A reference node's root is addressed by the guid the node stores; `applyRootGuid` has already put
  // it on the spawned root, so it resolves here.
  for (const [rootGuid, members, source] of addedInstanceRows) {
    const root = findEntityByGuid(rootGuid, world) as EntityHandle | undefined;
    if (root) applyStoredMemberRows(world, root.id(), members, source, pinned);
  }
  // …then give every remaining member a stable, addressable GUID so entities can reference into
  // instances: a pre-v16 scene, a template that predates prefab v5, and every member a row did not
  // name all land here, deriving exactly what they always did.
  deriveInstanceMemberGuids(world);
  if (pinned.size) dropCollidingPins(world, pinned);
  for (const [entryRootId, keyed] of templateNodeRows) keepTemplateNodeOrphans(world, entryRootId, keyed);
}
