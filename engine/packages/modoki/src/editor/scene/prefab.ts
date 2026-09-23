/** Prefab system — save, load, and instantiate prefab entity trees. */

import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld, spawnEntity, findEntityByGuid, indexEntityGuid } from '../../runtime/core/ecs/world';
import { endFrames, relinkDetachedMembers, remapWorldGuidRefs, stampDerivedMemberGuids, applyGuidRemap, type DetachedMember } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, setFrameDocFallback, noteFrameDoc } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsIn, memberRowsToWrite, rowWritingRoot } from '../../runtime/core/ecs/memberRows';
import { isPrefabEditRowGuid } from './prefabEditGuids';
import { nestedMoveRef, toLocalIdKeys } from './overrideKeyGrammar';
import { IDENTITY_TRS, mergeTrs, localToWorldTrs } from '../../runtime/scene/transformSpace';
import { memberPathRecords, deriveMemberChain, rewritePrefabMemberTokens, type PrefabReader } from '../../runtime/loaders/memberPaths';
import { hasDocKey, putOwn } from '../../runtime/core/docKeys';
import { collectUnknownFields, mergeUnknownFields } from '../../runtime/core/formatVersion';
import { validatePrefabData, REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { postWriteFile, jsonFileBody, repairPrefabMemberPaths } from '../backend/editorBackend';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, deleteEntities, markStructureDirty, readTraitData, readTraitDataFull, writeTraitField, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { collectTransientSubtreeIds, filterAuthoringVisible, runtimeExcludedMessage } from './authoringScope';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid, registerAsset, getGuidForPath, isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { durableGuid, mapStringValues, deriveMemberGuid, remapGuidValues, memberPathSteps, entityStep, isStoredRoot, isOwnedRoot, isDerivedMember, type MemberPi } from '../../runtime/core/assetRefRules';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';
import { templateKeyOf, setTemplateKey } from '../../runtime/core/templateIdentity';
import { templateKeysOf, recoverTemplateKey as recoverKeyFrom, type KeyRecoveryNode } from '../../runtime/loaders/templateKeyRecovery';
import { assertNoRuntimeGuids } from './runtimeGuidTripwire';
import { entityRef, type EntityRef } from '../undo/entityRef';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { assetIsAbsent, parseAssetJson, ASSET_FETCH_INIT } from '../../runtime/loaders/assetFetch';
import { invalidatePrefab, replaceCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { markOverride, clearOverrideMarks, getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { isPersistentTraitField, isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { writtenTraitKeys } from './traitDefault';
import { adoptParentScene, resolveAffectedScenes } from './sceneDirty';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, InstanceStructureData, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { keptMemberOrphans, mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, mergeNestedStructurePaths, descendPathKeyed, nestedPathKey, deriveInstanceMemberGuids, applyStructureCore, rowPathInPrefab, registerTemplateFrame, memberPathIndex, openTokenScope, closeTokenScope, noteTokens, queuePrefabMoves } from '../../runtime/loaders/loadSceneFile';
import { rebaseMemberTokens, isMemberToken, parseMemberToken, memberToken, memberPathKey, type MemberStep } from '../../runtime/core/templateRefs';

/** Fields that persist in a SCENE but must never be baked into a prefab TEMPLATE,
 *  keyed "Trait.field".
 *
 *  `EntityAttributes.editorFolder` is the Hierarchy grouping tag — where the author
 *  filed THIS entity in THIS scene, with no runtime effect. A template inheriting it
 *  would drop every future instance into one author's folder. It is excluded here
 *  DELIBERATELY and by name; it used to be excluded by accident, as collateral of the
 *  `meta.fields` gate that also lost `Animator.clips` (see traitSchema.ts). `guid` is
 *  handled separately below — it is rewritten, not dropped. */
const SCENE_ONLY_TEMPLATE_FIELDS = new Set(['EntityAttributes.editorFolder']);

/** True when a live field must be kept OUT of a written prefab template: pure
 *  runtime read-back, or a scene-only organizational field. Shared by both paths
 *  that write a template — creating a prefab, and applying overrides back into one. */
export function isTemplateExcludedField(meta: TraitMeta, field: string): boolean {
  return isRuntimeOnlyField(meta, field) || SCENE_ONLY_TEMPLATE_FIELDS.has(`${meta.name}.${field}`);
}

// ── Types ───────────────────────────────────────────────

export interface PrefabEntity {
  localId: number;
  /** This node's MINTED identity within the prefab — stable, never positional, never reused (v5, #1468).
   *
   *  ⚠️ It does NOT replace `localId`, which stays the document's array key and the space
   *  `EntityAttributes.parentId` and a scene's `overrides`/`removed` are written in. What it adds is
   *  the one property `localId` cannot have: `planPrefabRows` allocates above the max over SURVIVING
   *  members, so deleting the top-numbered member frees its number for the next save to hand to a
   *  DIFFERENT node — which silently repoints every key naming it, the cost `serializePrefab`'s own
   *  `preserveLocalIds` docblock spells out. A minted guid can only ever dangle, and a dangling key is
   *  something a reader can notice.
   *
   *  Optional in the TYPE because a read-back document may predate v5; every row this serializer
   *  writes has one. A row that arrives without one is minted a fresh guid at the next SAVE and never
   *  at a read — see `nodeGuidsFor`. */
  nodeGuid?: string;
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  // ── Nested-instance fields (present only when this entity is a nested prefab
  //    root). A `prefab` ref makes this row a *reference* to a child prefab,
  //    mirroring how a scene's SerializedEntity stores an instance — the child's
  //    own members are NOT listed here; they expand from the child file at load.
  //    The row's own EntityAttributes.parentId stays in the OUTER localId space. ──
  /** Child prefab GUID. Presence ⇒ this row is a nested-instance root. */
  prefab?: string;
  /** Per-localId field overrides on the nested instance (child localId space). */
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Child subtrees the nested instance adds beyond the child prefab. */
  added?: AddedEntity[];
  /** Child prefab member localIds the nested instance deleted. */
  removed?: number[];
  /** Per-localId component names the nested instance removed from child members. */
  removedTraits?: Record<number, string[]>;
  /** This row's OWN deep overrides reaching into its nested descendants (path-keyed,
   *  see NestedOverridePaths). Lets an outer prefab override a member nested more
   *  than one level inside it; outer layers merge over these (outermost wins). */
  nestedOverrides?: NestedOverridePaths;
  /** This row's OWN structural edits inside its nested descendants (path-keyed, #1381) — the
   *  structural twin of `nestedOverrides`. Written by promotion (a reference node's slot becomes
   *  the row's) and by a prefab-edit save (captured from the row's live expansion). An outer layer
   *  that addresses the same path replaces the entry whole. */
  nestedStructure?: NestedStructurePaths;
}

/** The format version this serializer writes. Every writer stamps THIS — never a value derived
 *  from the document's content (#379).
 *
 *  The rule it replaced was `nestedRefs.size > 0 ? 2 : 1`, i.e. "2 once the prefab actually
 *  nests one". That reads as a minimum-reader floor rather than a format version, and it can
 *  DECREASE: delete a prefab's last nested instance and the next save rewrote `2` back to `1`.
 *  A format marker that goes backwards is worse than none — the day a v3 ships with a real
 *  migration ladder, such a file claims a serializer that never touched it and gets migrated as
 *  something it is not. Two of the writers here (`mergeRiggedPrefab`, and the nested-instance
 *  path) already treated it monotonically, so the codebase disagreed with itself.
 *
 *  FOUR call sites write it — `serializePrefab`, `mergeRiggedPrefab`, the nested-instance path,
 *  and `applyOverridesToPrefab`. The last was missed by #379's first pass precisely because it
 *  never mentioned `version` at all, so a grep for the token could not find it.
 *
 *  Scenes are the precedent: `engine/scripts/migrate-legacy-scenes.mjs` pins one number and
 *  triggers on `(doc.version ?? 0) < 12`, never on what the document contains.
 *
 *  v3: `UIAnchor.zIndex` removed (mirrors scene v13). Prefabs still have no migration LADDER
 *  (nothing on the loading path inspects this field at all — see above), so the fix for the
 *  data-loss window isn't version-gated either: `getPrefabSource` and `fetchPrefab`
 *  (meshTemplateCache.ts) both run `migrateUIAnchorZIndexStructured` on every entity,
 *  unconditionally, on every load — cheap and idempotent, so it costs nothing to apply to an
 *  already-migrated (or v3-native) file. The version bump here only makes freshly-written
 *  files honest about which serializer touched them, same as every bump before it.
 *
 *  v4: an optional top-level `moved` map (#1437 P3-b — a member the prefab places under a member of one of
 *  its nested instances). Still no ladder, and still nothing on the loading path reads this field: an older
 *  build loads a v4 file and ignores `moved`, so such a member sits at its row parent there. */
export { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';

export interface PrefabFile {
  /** Stable UUID — written once at save, never changes across renames/moves. */
  id?: string;
  /** The format version the file was WRITTEN by — {@link PREFAB_FORMAT_VERSION}, always, for
   *  anything this serializer produces. Not a capability floor and not content-derived.
   *
   *  v1, v2 and v3 all share the same shape (the nested-instance fields are optional, and v3
   *  only drops a trait FIELD, not a structural shape), so an older file still loads unchanged
   *  and nothing on the loading path inspects this at all (#365). Documents written before
   *  #379/this change and never re-saved still carry a `1` or `2` on disk; they load fine, and
   *  this field reports what wrote them, not what this build would write.
   *
   *  Widened from `1 | 2 | 3` to `number` (#784) — this is a read-back document (bytes may
   *  come from a newer build than this one understands), and the literal union made
   *  `existing.version` at a v4+ document lie about its own type (#734 precedent). */
  version: number;
  name: string;
  rootLocalId: number;
  entities: PrefabEntity[];
  /** Members the prefab places under a parent no row relation can express (#1437 P3-b/P3-c) — a member of
   *  one of its NESTED instances, or a nested instance's member placed in this prefab: the member's path →
   *  a member token for its new parent, both in this prefab's frame. Its row keeps its parent, so the
   *  member's identity — its path — is unchanged. Resolved after the derive pass; an instance's own move of
   *  the same member overrides it, and so does the move of a prefab nesting this one. */
  moved?: Record<string, string>;
}

// ── Save as Prefab ──────────────────────────────────────

/** Collect an entity and all its descendants (flat list) — O(n) via Map lookup */
function collectTree(entityId: number, allEntities: EntityInfo[]): EntityInfo[] {
  const byParent = new Map<number, EntityInfo[]>();
  const byId = new Map<number, EntityInfo>();
  for (const e of allEntities) {
    byId.set(e.id, e);
    if (!byParent.has(e.parentId)) byParent.set(e.parentId, []);
    byParent.get(e.parentId)!.push(e);
  }
  const result: EntityInfo[] = [];
  const queue = [entityId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const entity = byId.get(id);
    if (!entity) continue;
    result.push(entity);
    for (const child of (byParent.get(id) || [])) queue.push(child.id);
  }
  return result;
}

/** Which entities of `tree` become ROWS of the prefab, and what localId each one gets.
 *
 *  ⚠️ This is THE numbering for a prefab's localId address space, and it exists as one function
 *  because it used to exist as two (#1278). `serializePrefab` decides the rows; Create Prefab
 *  then stamps `PrefabInstance.localId` onto the live tree, and that stamp MUST agree — it is
 *  the same address space a scene's `overrides`/`removed` are keyed in (docs/prefabs.md
 *  § "localId stability"). Tagging used to re-derive it by counting the live tree, which
 *  disagreed for every member ordered after a nested instance, and the next save then wrote
 *  overrides under an id denoting a different member. **Anything that needs to know a member's
 *  localId calls this; nothing re-derives it.**
 *
 *  Membership is genuinely not inferable from the hierarchy, which is why re-deriving it kept
 *  going wrong: a nested instance's own members, the added subtrees it folded in, and every OWNED
 *  nested instance inside it at any depth (the row partition, `captureNestedChannels`'
 *  `ownedMemberEcsIds`) are dropped. The last were once NOT, and each got a second reference row
 *  at the prefab root (#1382). "Every descendant of a nested root" is the wrong rule in both
 *  directions — `memberEcsIds` is a world-wide query on `rootInstanceId`, so a member reparented
 *  out of the subtree is dropped too, and a user-added instance inside is captured as an `added`
 *  reference node rather than skipped as a member.
 *
 *  Returns null when a nested ref would make the prefab transitively contain itself. */
/** One nested-instance row `planPrefabRows` decided on: the reference capture plus the row's own
 *  nested channels (#1381). */
interface PlannedNestedRow {
  ref: InstanceReference;
  /** The baseline each `nestedStructure` path is compared against once tokenized (#1352). */
  structureBaselines: Map<string, InstanceStructureData>;
  childPrefab: PrefabFile;
  nestedOverrides?: NestedOverridePaths;
  nestedStructure?: NestedStructurePaths;
}

function planPrefabRows(
  tree: EntityInfo[],
  selectedEntityId: number,
  existingId?: string,
  preserveLocalIds?: Map<number, number>,
): { nestedRefs: Map<number, PlannedNestedRow>; flatTree: EntityInfo[]; ecsToLocal: Map<number, number> } | null {
  const piMeta = getTraitByName('PrefabInstance');

  // ── Find nested-instance roots and the members they consume ──
  const nestedRefs = new Map<number, PlannedNestedRow>();
  const skip = new Set<number>(); // ecs ids excluded from the flat tree
  if (piMeta) {
    for (const e of tree) {
      if (e.id === selectedEntityId) continue; // never collapse the selection root
      // Already folded into another nested instance as a reference `added` node
      // (a user-added instance nested inside another) — don't ALSO emit a row.
      if (skip.has(e.id)) continue;
      if (!e.traits.includes('PrefabInstance')) continue;
      const pi = readTraitData(e.id, piMeta);
      if (!pi || pi.rootInstanceId !== e.id) continue; // not a self-rooted instance root
      const source = pi.source as string;
      // Cycle guard: refuse to write a nested ref that would make this prefab
      // transitively contain itself (A → B → A). Saves the user from a file that
      // can only ever partially expand (the instantiate-time guard would bail).
      if (existingId && wouldCreateCycle(existingId, source)) {
        console.error(`[Prefab] refusing to save — nesting "${source}" inside "${existingId}" creates a cycle`);
        return null;
      }
      const childPrefab = getCachedPrefabSync(source);
      if (!childPrefab) {
        console.warn(`[Prefab] nested prefab "${source}" not cached; flattening instead of referencing`);
        continue;
      }
      // TEMPLATE form: this is written into a prefab file (#1387).
      const ref = captureInstanceReference(e.id, source, childPrefab, { template: true });
      // The row is the OUTERMOST layer for its own nested rows within this file, so it carries their
      // edits itself — the same writer a scene entry and a reference node use (#1381). Captured from
      // the live expansion rather than passed through from the file, or an edit made in the prefab
      // editor inside a nested row would be overwritten by the value it replaced.
      const structureBaselines = new Map<string, InstanceStructureData>();
      const channels = captureNestedChannels(source, ref.ownedNested, { omitUnchanged: true, template: true, baselinesOut: structureBaselines });
      nestedRefs.set(e.id, { ref, childPrefab, structureBaselines, nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure });
      // Exclude the nested instance's members (except the root, which becomes a
      // reference row) and any added subtrees it folded in.
      for (const m of ref.memberEcsIds) if (m !== e.id) skip.add(m);
      for (const c of ref.consumedEcsIds) skip.add(c);
      // …and every OWNED nested instance inside it, at any depth (#1382): the row re-expands them from
      // its own prefab. Given a row of their own they were written twice — once implicitly, once at
      // the prefab root — and the tagger then re-stamped the owned root onto that second row.
      for (const m of channels.ownedMemberEcsIds) skip.add(m);
      for (const c of channels.consumedEcsIds) skip.add(c);
    }
  }

  // Assign localIds over the surviving tree. Without a preserve map this is the original
  // positional numbering (1-based, root = 1) — the create-a-prefab-from-an-entity path, where
  // there is no prior numbering to honour. With one (a prefab-edit RE-save) every member keeps
  // the id it already had, so a scene's localId-keyed overrides keep pointing at the same
  // member; only genuinely new members are allocated, above the highest preserved id.
  const flatTree = tree.filter((e) => !skip.has(e.id));
  const ecsToLocal = new Map<number, number>();
  if (preserveLocalIds) {
    let next = 0;
    for (const e of flatTree) next = Math.max(next, preserveLocalIds.get(e.id) ?? 0);
    for (const e of flatTree) {
      const kept = preserveLocalIds.get(e.id);
      ecsToLocal.set(e.id, kept ?? ++next);
    }
  } else {
    flatTree.forEach((e, i) => ecsToLocal.set(e.id, i + 1));
  }
  return { nestedRefs, flatTree, ecsToLocal };
}

/** Does a freshly-computed plan still describe the prefab that was WRITTEN? The two are computed
 *  either side of an `await` (see `tagEntityTreeAsInstance`), so this is the tripwire for the
 *  world or the prefab cache having moved underneath. Compares row count and, positionally,
 *  which rows are nested references — enough to catch a member appearing or vanishing and a
 *  nested child becoming cacheable mid-flight (which flips it from flattened to a reference row
 *  and shifts every localId after it). */
function planMatchesFile(
  plan: { flatTree: EntityInfo[]; nestedRefs: Map<number, unknown> },
  written: PrefabFile,
  source: string,
): boolean {
  const mismatch = (why: string) => {
    console.error(`[Prefab] not tagging "${source}" — the live tree no longer matches the prefab just written (${why}). The entities were left untagged rather than pointed at rows that may not exist.`);
    return false;
  };
  if (plan.flatTree.length !== written.entities.length) {
    return mismatch(`${plan.flatTree.length} rows now vs ${written.entities.length} written`);
  }
  for (let i = 0; i < plan.flatTree.length; i++) {
    if (plan.nestedRefs.has(plan.flatTree[i].id) !== !!written.entities[i].prefab) {
      return mismatch(`row ${i + 1} changed between a nested reference and a plain member`);
    }
  }
  return true;
}

/** The entities a Create Prefab gesture treats as AUTHORING input for `selectedEntityId`.
 *
 *  ⚠️ **Create Prefab reads the world TWICE** — `serializePrefab` writes the file, then
 *  `tagEntityTreeAsInstance` re-walks it and re-runs `planPrefabRows` to convert the live tree into
 *  an instance — and the second read REFUSES to tag when its plan does not match the file
 *  (`planMatchesFile`, a bare `return`). So the two must select the same entities or Create Prefab
 *  silently leaves the tree unlinked: a prefab asset on disk, no instance in the scene, nothing
 *  logged. That is why this is a function rather than the same two lines written twice.
 *
 *  Runtime artifacts (pooled UIEntries rows, timeline scrub/control spawns) are excluded — unless
 *  the SELECTION ROOT is itself one, which makes the gesture a deliberate "bake this" and must
 *  produce the thing the user selected rather than an empty file. */
function authoringEntitiesFor(selectedEntityId: number, all: EntityInfo[]): { entities: EntityInfo[]; excluded: number } {
  const links = all.map((e) => [e.id, e.parentId] as const);
  const inSelection = collectSubtreeIds(links, [selectedEntityId]);
  const parentOf = new Map(all.map((e) => [e.id, e.parentId] as const));
  const isRuntime = (id: number): boolean => !!findEntity(id)?.has(Transient);

  // A generated REGION, not a tagged entity, is the unit — because in production every member of
  // one carries the tag (`spawnEntity` tags whatever is spawned inside a system tick), so "drop
  // tagged entities" would strip a deliberate bake down to its root and lose every child.
  // A region starts where a tagged entity's PARENT is not tagged.
  const regionRoots: number[] = [];
  for (const id of inSelection) {
    if (id === selectedEntityId) continue;          // one region may start AT the selection: that is the bake
    if (!isRuntime(id)) continue;
    if (isRuntime(parentOf.get(id) ?? 0)) continue; // inside a region already accounted for
    regionRoots.push(id);
  }
  if (regionRoots.length === 0) return { entities: all, excluded: 0 };

  // ⚠️ Scoped to the SELECTION, twice over. The count must be, or a scene with a pool somewhere in
  // it warns on every Create Prefab about entities it did not drop (review F1) — the alarm that
  // makes the true report unreadable. And the exclusion must be, or a selection that sits INSIDE a
  // generated region cannot be serialized at all: the region's own subtree contains the selection,
  // so a world-wide filter removes the very entity being turned into a prefab. The first cut
  // answered that by switching filtering OFF whenever the selection was anywhere inside a region,
  // which let an unrelated region deeper in the selection through — #1306 re-opened, silently
  // (re-review finding 3, measured).
  const runtimeIds = new Set(collectSubtreeIds(links, regionRoots));
  return { entities: all.filter((e) => !runtimeIds.has(e.id)), excluded: runtimeIds.size };
}

/** Serialize selected entity + descendants as a prefab.
 *  Pass `existingId` when re-saving an existing prefab to preserve its UUID.
 *
 *  Nested prefab instances inside the subtree (a self-rooted PrefabInstance below
 *  the selection root) are written as *reference rows* — one row carrying the
 *  child `prefab` GUID + captured overrides/structure — and their members are
 *  excluded from the flat output. The selection root itself is never collapsed
 *  this way (so "save instance as prefab" still flattens the instance). */
/** Rewrites refs held in a TEMPLATE being written from the live tree under `rootEcsId` (#1352).
 *
 *  A payload is in the frame of the instance it is applied to: the written root for a flat row's bag,
 *  a nested row's live root for its `overrides`/`added`, and the owned instance a `nestedOverrides` /
 *  `nestedStructure` path addresses. A string value equal to the guid of an entity the payload's frame
 *  can name becomes a member token. If only an ENCLOSING frame can name it, the token climbs `^` once
 *  per level, and it always takes the NEAREST such frame. That makes the spelling canonical, which the
 *  #1381 no-op comparison needs: MID's own save and OUTER's save of the same MID interior must write
 *  the same token, or OUTER pins an interior it never changed. A ref out of the written tree is left
 *  as it is.
 *
 *  Steps: the written root's frame names each row by its NEW localId (`ecsToLocal`). Any other frame
 *  is a live instance whose members step as the derive pass walks them (`memberPathIndex`). A
 *  reference node's payload is left whole, since it is applied in its own frame. */
function templateTokenizer(rootEcsId: number, all: EntityInfo[], ecsToLocal: Map<number, number>, rowParent: Map<number, number> = new Map()) {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const piOf = (id: number) => (piMeta ? readTraitData(id, piMeta) as { localId?: number; parentLocalId?: number; rootInstanceId?: number } | null : null);
  // A written ROW hangs where it lives; a nested instance's member by its IDENTITY — from its template parent
  // when it was moved (#1437) — since that is where the written prefab's expansion derives it.
  const identity = worldIdentityParents(getCurrentWorld());
  const children = new Map<number, EntityInfo[]>();
  for (const e of all) {
    const parent = ecsToLocal.has(e.id) ? (rowParent.get(e.id) ?? e.parentId) : identity.parentOf(e.id);
    const list = children.get(parent);
    if (list) list.push(e);
    else children.set(parent, [e]);
  }
  const pathInRoot = new Map<string, MemberStep[]>();
  const pathById = new Map<number, MemberStep[]>([[rootEcsId, []]]);
  const rootGuid = all.find((e) => e.id === rootEcsId)?.guid;
  if (rootGuid) pathInRoot.set(rootGuid, []);
  const stack: [number, MemberStep[]][] = [[rootEcsId, []]];
  const seen = new Set<number>([rootEcsId]);
  while (stack.length) {
    const [id, path] = stack.pop()!;
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const key = templateKeyOf(findEntity(c.id));
      const pi = piOf(c.id);
      const step: MemberStep | null = ecsToLocal.has(c.id) ? ecsToLocal.get(c.id)!
        : (key || pi) ? entityStep(pi, key) : null;
      if (step === null) continue;
      const at = ecsToLocal.has(c.id) ? [...path, step] : [...path, ...identity.of(c.id).extra, step];
      if (c.guid) pathInRoot.set(c.guid, at);
      pathById.set(c.id, at);
      if (!isStoredRoot(pi, c.id) || ecsToLocal.has(c.id)) stack.push([c.id, at]);
    }
  }
  const frames = new Map<number, Map<string, MemberStep[]>>([[rootEcsId, pathInRoot]]);
  const pathsIn = (frame: number): Map<string, MemberStep[]> => {
    let out = frames.get(frame);
    if (out) return out;
    out = new Map();
    if (eaMeta) {
      for (const [key, target] of memberPathIndex(getCurrentWorld(), frame)) {
        const guid = target ? (target.get(eaMeta.trait) as { guid?: string }).guid : '';
        if (guid) out.set(guid, memberPathSteps(key));
      }
    }
    frames.set(frame, out);
    return out;
  };
  /** The frame one level out: a written row's frame is the root's, and an owned nested instance's
   *  frame is the one its row sits in. */
  const enclosing = (frame: number): number => {
    if (frame === rootEcsId) return 0;
    if (ecsToLocal.has(frame)) return rootEcsId;
    const parent = eaMeta ? ((readTraitData(frame, eaMeta)?.parentId as number) || 0) : 0;
    return (parent && piOf(parent)?.rootInstanceId) || rootEcsId;
  };
  /** token → the guid it was written for, so `undeclaredKeys` can put one back. */
  const origin = new Map<string, string>();
  const value = (v: unknown, frame: number): unknown => mapStringValues(v, (str) => {
    if (!str) return str;
    for (let f = frame, up = 0; f; f = enclosing(f), up++) {
      const p = pathsIn(f).get(str);
      if (p) { const t = memberToken(up, p); origin.set(t, str); return t; }
    }
    return str;
  });
  /** `v` with every token that steps through a key no file declares turned back into its guid. The key
   *  was minted for a live node the write then left out, because the file's pre-key version of that
   *  interior still counts as unchanged (`sameStructure`). A token for it would name nothing on
   *  reload, where the guid still resolved (#1352 review). */
  const undeclaredKeys = (v: unknown, declared: ReadonlySet<string>): unknown => mapStringValues(v, (str) => {
    const t = isMemberToken(str) ? parseMemberToken(str) : null;
    if (!t || !t.path.some((step) => typeof step === 'string' && !declared.has(step.slice(1)))) return str;
    return origin.get(str) ?? str;
  });
  const added = (nodes: AddedEntity[] | undefined, frame: number): AddedEntity[] | undefined => nodes?.map((n) => (n.prefab ? n : {
    ...n, traits: value(n.traits, frame) as AddedEntity['traits'], children: added(n.children, frame) ?? [],
  }));
  /** The live owned instance a `nestedOverrides`/`nestedStructure` path addresses below `rowRoot`
   *  (each step a row localId), or 0.
   *
   *  ⚠️ "Which instance owns this nested root" is asked of its OWNER (`identityParents.ts`), never its
   *  live parent. An owned nested root moved BESIDE its frame — under a member of another nested
   *  instance inside the same outermost instance — stays owned (`planMoveUnlinks` neither strips nor
   *  promotes it), so reading the live parent made this return 0 and the caller tokenize the path in the
   *  wrong frame. Found by #1468 Phase 2B's close-out sweep: three other sites already answer this
   *  question this way (the identity tree, `planMoveUnlinks`, `memberRowKeysIn`) and this was the fourth.
   *
   *  ⚠️ **No test, and saying so rather than implying one.** The observable is a member token
   *  resolved in the wrong frame inside a prefab-within-prefab-within-prefab, which no fixture in
   *  this repo builds. What makes it safe without one is that the owner falls back to the live
   *  parent's frame for a root that never moved, so every case that works today is byte-identical and
   *  only a MOVED root behaves differently. */
  const frameAt = (rowRoot: number, pathKey: string): number => {
    let cur = rowRoot;
    for (const step of memberPathSteps(pathKey)) {
      let next = 0;
      for (const e of all) {
        const pi = piOf(e.id);
        if (!pi || pi.rootInstanceId !== e.id || pi.parentLocalId !== step) continue;
        if (identity.ownerOf(e.id) === cur) { next = e.id; break; }
      }
      if (!next) return 0;
      cur = next;
    }
    return cur;
  };
  /** A live entity's path in the written prefab's frame, or undefined when it is not one it can name. */
  const pathOf = (id: number): MemberStep[] | undefined => pathById.get(id);
  return { value, added, frameAt, undeclaredKeys, pathOf, root: rootEcsId };
}

/** Resolves the member tokens in a prefab BASE value against the live instance rooted at
 *  `rootInstanceId`, so it can be compared with the live value, which holds guids (#1352). A `^`
 *  climbs to the instance whose row expanded this one. A token that names nothing stays as it is. */
export function baseTokenResolver(rootInstanceId: number): (value: unknown) => unknown {
  const world = getCurrentWorld();
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const indexes = new Map<number, ReturnType<typeof memberPathIndex>>();
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  const frameUp = (root: number, up: number): number => {
    let r = root;
    for (let i = 0; i < up && r; i++) {
      const pi = piMeta ? readTraitData(r, piMeta) : null;
      if (!pi?.parentLocalId || !eaMeta) return 0; // a stored root is its own frame: nothing above it
      r = (identity ??= worldIdentityParents(world)).ownerOf(r); // a moved nested root's frame is its owner's (#1437)
    }
    return r;
  };
  const resolve = (token: string): string => {
    const t = parseMemberToken(token);
    const frame = t ? frameUp(rootInstanceId, t.up) : 0;
    if (!t || !frame || !eaMeta) return token;
    let index = indexes.get(frame);
    if (!index) { index = memberPathIndex(world, frame); indexes.set(frame, index); }
    const target = index.get(memberPathKey(t.path));
    const guid = target ? ((target.get(eaMeta.trait) as { guid?: string }).guid ?? '') : '';
    return guid || token;
  };
  return (value) => mapStringValues(value, (v) => (isMemberToken(v) ? resolve(v) : v));
}

/** The node guid every written row keeps (#1468) — CARRIED where a genuine correspondence to the
 *  document being overwritten exists, MINTED where none does.
 *
 *  THREE carriers, because the re-save paths hold identity in different places:
 *
 *  - `preserved` (ecsId → node guid) — prefab-EDIT, which loads a document into a scratch world of
 *    PLAIN entities and re-serializes it. There is no live prefab link to read, so its baseline
 *    document is the only thing that knows; `savePrefabEdit` builds the map beside `preserveLocalIds`.
 *  - the live `PrefabInstance.nodeGuid` — every other re-save. A member of an instance of THIS prefab
 *    was expanded from the row it is about to be written back into, so its identity is this
 *    document's to keep. ⚠️ Gated on `pi.source === existingId` deliberately: a member of some OTHER
 *    prefab's instance carries an identity in THAT document's frame, and copying it here would make
 *    two documents name one node.
 *  - the live `PrefabInstance.parentNodeGuid` — a NESTED REFERENCE ROW, whose own `nodeGuid` answers
 *    the wrong question (it is the root's identity in the CHILD document, and the row's identity
 *    belongs to THIS one). ⚠️ **Its gate is asked of the TREE, not of the row**, because a nested
 *    root's `source` names the child prefab and so can never equal `existingId`: the selection root
 *    must itself be an instance of `existingId`. `planPrefabRows` has already dropped every DEEPER
 *    nested root from `flatTree` (`channels.ownedMemberEcsIds`), so what survives is a direct row of
 *    this document; a user-ADDED nested instance has `parentLocalId` 0 and therefore no
 *    `parentNodeGuid`, which is why it correctly mints instead.
 *
 *  Everything else mints. That is the honest answer, not a fallback: Create-Prefab-Replace over an
 *  unrelated tree, an agent `create` over an existing path and a fresh model import have no
 *  correspondence to the old rows at all. Minting makes every stored key naming an old row DANGLE,
 *  which a reader can detect — where today's positional renumbering silently REPOINTS them at whichever
 *  node inherited the number.
 *
 *  ⚠️ **ONE class does not carry, and "everything else mints" must not be read as covering it.**
 *
 *  1. **An instance whose `source` is a PATH rather than a GUID.** `tagEntityTreeAsInstance` and
 *     `setPrefabSource` both fall back to the raw path when the manifest cannot resolve it, while
 *     `existingId` is always a GUID — so the gate misses and every row re-mints. Narrow, and it
 *     resolves itself once the manifest indexes the asset. It bites the TREE gate above as well as
 *     the per-member one, so a path-sourced instance loses its nested rows' identity too.
 *
 *  ⚠️ **The nested reference row USED to be the second class, and Phase 2B closed it** (#1468). It is
 *  recorded here because the shape of the hole is worth keeping: the field that would have fixed it
 *  existed as a NUMBER (`parentLocalId`) the whole time, and the reason it was left open for a phase
 *  was that an identity twin of it had no reader until the scene stored member rows — a field nothing
 *  reads being its own defect class (CLAUDE.md: *an unwired field is a lie with a tooltip*). Until
 *  then prefab-EDIT carried nested rows and nothing else did, so one document kept nested identity
 *  under Cmd+S and lost it through every other `existingId` path.
 *
 *  ⚠️ Minting happens HERE, on the write, and nowhere else. A reader that minted would hand two
 *  readers of one file two different identities for one node, and any key written against the loser
 *  dangles at the next load. A v4 document therefore stays unmigrated until something saves it
 *  (§ Phase 5 of docs/plans/prefab-member-identity-plan.md: files migrate on next save). */
function nodeGuidsFor(
  flatTree: EntityInfo[],
  existingId: string | undefined,
  preserved: Map<number, string> | undefined,
  selectedEntityId: number,
  nestedRowIds: ReadonlySet<number>,
): (ecsId: number) => string {
  const piMeta = getTraitByName('PrefabInstance');
  const carried = new Map<number, string>();
  const claimed = new Map<string, number>();
  const take = (ecsId: number, guid: string): void => {
    const other = claimed.get(guid);
    if (other !== undefined) {
      // Two live entities claiming one template node — a duplicated member whose copy kept the
      // link. Only one row can BE that node, so the later one is minted a fresh identity. Said out
      // loud rather than resolved quietly: silently picking a winner is how a duplicate ends up
      // sharing a stored key with its original, which is the failure this field exists to prevent.
      // ⚠️ The row NAMES, not the ECS ids (close-out review R7). Runtime ids are reassigned on every
      // reload (CLAUDE.md § Debug Tools), and the one shape that reaches this branch is a damaged
      // DOCUMENT — so the reader needs something they can find in the file they have to repair.
      const nameOf = (id: number) => flatTree.find((e) => e.id === id)?.name ?? `ecs:${id}`;
      console.warn(`[Prefab] two rows claim node guid ${guid} ("${nameOf(other)}" and "${nameOf(ecsId)}") — the document names one node twice; minting a fresh identity for the second`);
      return;
    }
    claimed.set(guid, ecsId);
    carried.set(ecsId, guid);
  };
  // Is this live tree an instance of the document being overwritten? Asked ONCE, of the selection
  // root, because it is the only place a nested row's frame can be read from (see the docblock).
  const rootPi = piMeta && existingId ? readTraitData(selectedEntityId, piMeta) as { source?: string } | null : null;
  const treeIsInstanceOfTarget = !!rootPi && rootPi.source === existingId;
  for (const e of flatTree) {
    const fromEdit = preserved?.get(e.id);
    if (fromEdit) { take(e.id, fromEdit); continue; }
    if (!piMeta || !existingId) continue;
    const pi = readTraitData(e.id, piMeta) as { source?: string; nodeGuid?: string; parentNodeGuid?: string } | null;
    if (nestedRowIds.has(e.id)) {
      if (treeIsInstanceOfTarget && pi?.parentNodeGuid) take(e.id, pi.parentNodeGuid);
      continue;
    }
    if (pi?.source === existingId && pi.nodeGuid) take(e.id, pi.nodeGuid);
  }
  return (ecsId) => carried.get(ecsId) ?? newGuid();
}

export function serializePrefab(
  selectedEntityId: number,
  existingId?: string,
  opts?: {
    /** ecsId → the localId that entity ALREADY had in the prefab being re-saved.
     *
     *  Only prefab-edit can supply this, and only prefab-edit needs it: localIds are the
     *  address space a SCENE's `overrides` / `removed` / `removedTraits` are keyed in, so
     *  renumbering them on a re-save silently repoints or drops every override on every
     *  instance. Positional numbering does renumber — a prefab whose members were authored
     *  with a gap (a deleted sibling) compacts on the next save (measured on sling's
     *  FieldCorner: `drip` 4 → 2). Members with no entry here (the user added them during
     *  the edit) are allocated ABOVE every preserved id, never into a freed gap. */
    preserveLocalIds?: Map<number, number>;
    /** ecsId → the node guid that entity's row ALREADY had in the prefab being re-saved (#1468).
     *
     *  The prefab-EDIT twin of `preserveLocalIds`, and needed for the same reason and by the same
     *  single caller: the edit world holds the document as PLAIN entities with no prefab link, so
     *  nothing live remembers which row each one is. Without it every node in an edited prefab would
     *  be re-minted on every save — identity that changes on each Cmd+S is worse than none.
     *  Rows with no entry here are minted (a member the user added during the edit; a row of a
     *  pre-v5 document, which has no identity to keep). */
    preserveNodeGuids?: Map<number, string>;
    /** Keep this as the prefab's `name` instead of taking the ROOT ENTITY's name.
     *
     *  The two are independent: the asset is named by its file, the root entity by the
     *  author. Defaulting to the root's name silently renames the asset on any re-save —
     *  measured on sling, where "Cover Enemy" and "Green Enemy" both became "Enemy"
     *  because that is what their root entity is called. */
    name?: string;
    /** Called when the walk dropped runtime entities (pooled rows, preview spawns) from the
     *  selection — with how many. The exclusion itself is not optional; this is only how a caller
     *  SURFACES it (a toast, an MCP response field). `serializePrefab` always logs it too. */
    onRuntimeExcluded?: (count: number) => void;
    /** localId → the row parent that member had in the prefab being RE-saved (prefab-edit). A row whose live
     *  parent is no row — the prefab's own move put it under a nested member (#1437) — is written back under
     *  it, with the move kept in `moved`, instead of losing its parent. */
    rowParents?: Map<number, number>;
  },
): PrefabFile | null {
  const rawEntities = getAllEntities();
  // #1306: a live runtime artifact under the selection is NOT authoring input — a UIEntries pooled
  // row or a timeline scrub spawn would otherwise be written into the new file as an ordinary
  // authored member (measured: `["Ship","Flame","PooledRow"]`). The pool runs while the sim is
  // STOPPED (priority 270 > TRANSFORM), so this is the everyday case, not a Play-mode one.
  //
  // ⚠️ Unless the SELECTION ROOT is itself Transient: pointing Create Prefab straight at generated
  // content is a deliberate "bake this" and must produce the thing the user selected, not an empty
  // file. The exclusion is about what rides along UNASKED.
  const { entities: allEntities, excluded: excludedCount } = authoringEntitiesFor(selectedEntityId, rawEntities);
  if (excludedCount > 0) {
    // Reported, never silent (owner, 2026-09-17): a prefab that quietly lost members is the
    // surprise that gets filed as a bug weeks later. The console line is by construction here;
    // `onRuntimeExcluded` is how an interactive caller raises it to a toast or an MCP response.
    console.warn(`[Prefab] ${runtimeExcludedMessage(excludedCount)}`);
    opts?.onRuntimeExcluded?.(excludedCount);
  }
  const tree = collectTree(selectedEntityId, allEntities);
  if (tree.length === 0) return null;

  const plan = planPrefabRows(tree, selectedEntityId, existingId, opts?.preserveLocalIds);
  if (!plan) return null; // cycle — planPrefabRows already reported it
  const { nestedRefs, flatTree, ecsToLocal } = plan;

  const allTraits = getAllTraits();
  const prefabEntities: PrefabEntity[] = [];
  const nestedRowIds = new Set(nestedRefs.keys());
  const nodeGuidOf = nodeGuidsFor(flatTree, existingId, opts?.preserveNodeGuids, selectedEntityId, nestedRowIds);
  const rowParent = rowParentsFor(selectedEntityId, flatTree, allEntities, ecsToLocal, opts?.rowParents, nestedRowIds);
  // A ref from one member of the written tree to another becomes a member TOKEN (#1352): the file is a
  // template, and the live guid it held names the SOURCE entity in every instance.
  const tokens = templateTokenizer(selectedEntityId, allEntities, ecsToLocal, rowParent);

  for (const entityInfo of flatTree) {
    const localId = ecsToLocal.get(entityInfo.id)!;

    // Nested-instance root → reference row (child prefab + captured diffs). Only
    // EntityAttributes (name + remapped parentId) is written inline; the child's
    // own traits come from the child file, edits ride in `overrides`.
    const nested = nestedRefs.get(entityInfo.id);
    if (nested) {
      const parentLocal = ecsToLocal.get(rowParent.get(entityInfo.id) ?? 0) || 0;
      // Each payload is in the frame of the instance it is applied to: the row's own in the child's
      // (one level down), a nested path's in the instance that path addresses.
      const frameOf = (pathKey: string) => tokens.frameAt(entityInfo.id, pathKey) || entityInfo.id;
      let nestedStructure: NestedStructurePaths | undefined;
      for (const [k, delta] of Object.entries(nested.nestedStructure ?? {})) {
        const t = { ...delta, added: tokens.added(delta.added, frameOf(k)) ?? [] };
        const baseline = nested.structureBaselines.get(k);
        if (baseline && sameStructure(t, baseline)) continue; // #1381's no-op rule, over tokenized content
        (nestedStructure ??= {})[k] = t;
      }
      const nestedOverrides = nested.nestedOverrides
        ? Object.fromEntries(Object.entries(nested.nestedOverrides).map(([k, v]) => [k, tokens.value(v, frameOf(k))]))
        : undefined;
      prefabEntities.push({
        localId,
        nodeGuid: nodeGuidOf(entityInfo.id),
        name: entityInfo.name,
        traits: { EntityAttributes: { name: entityInfo.name, parentId: parentLocal, guid: '' } },
        prefab: nested.ref.source,
        overrides: tokens.value(nested.ref.overrides, entityInfo.id) as typeof nested.ref.overrides,
        added: tokens.added(nested.ref.added, entityInfo.id),
        removed: nested.ref.removed,
        removedTraits: nested.ref.removedTraits,
        nestedOverrides: nestedOverrides as NestedOverridePaths | undefined,
        nestedStructure,
      });
      continue;
    }

    const entry: PrefabEntity = { localId, nodeGuid: nodeGuidOf(entityInfo.id), name: entityInfo.name, traits: {} };

    // Read each trait's data
    for (const meta of allTraits) {
      if (!entityInfo.traits.includes(meta.name)) continue;
      // Skip PrefabInstance trait — don't nest prefab metadata
      if (meta.name === 'PrefabInstance') continue;

      if (meta.category === 'tag') {
        entry.traits[meta.name] = true;
        continue;
      }

      // O(1) direct read — was a full-world query.updateEach per trait (O(n²) over
      // the scene). Read what the trait PERSISTS (its koota schema), the same rule
      // the override paths use: AoS traits need it for their non-scalar fields
      // (AnimationLibrary's animSets/boneMaps), and SoA traits need it for a schema
      // field a custom Inspector section owns — Animator.clips/clip, which the old
      // curated read dropped, so Create Prefab produced a template with an EMPTY
      // clip bank. See runtime/core/ecs/traitSchema.ts.
      const traitData = readTraitDataFull(entityInfo.id, meta);

      if (traitData) {
        // Drop what a TEMPLATE must not carry: runtime read-back (Time.elapsed,
        // RigidBody.isSleeping, SkeletalAnimator.activeClip/time/weight — otherwise
        // creating a prefab from an animating entity bakes a nondeterministic frame
        // in) and scene-only organizational fields.
        for (const key of Object.keys(traitData)) {
          if (isTemplateExcludedField(meta, key)) delete (traitData as Record<string, unknown>)[key];
        }
        // ⚠️ Drop BLANK asset refs. `readTraitDataFull` writes every schema field, so a
        // `Renderable2D` with no material serialized `material: ""` — a blank ref, which
        // `tests/assets/authoredAssetRefs.test.ts` correctly fails (#53: an unset ref is invisible
        // to every other test — neither dangling nor a literal path — and surfaces only in a
        // production build).
        //
        // This USED to be a manual cleanup after `modoki_prefab create`. That is untenable now that
        // prefabs are hand-tuned in the editor: every Cmd+S in prefab-edit re-adds them, so a human
        // repositioning a badge turns `npm run verify` red and has to know to go and strip eight
        // keys out of the JSON. Measured: one save of Court's tray-badge prefab reintroduced 8.
        //
        // Dropping the key is a semantic NO-OP — the loader rebuilds each trait with
        // `meta.trait(partialData)` and koota fills every absent field from the same schema, so ''
        // and absent load identically. Deliberately narrow: only `''`, and only on fields the ref
        // registry already names, rather than omitting every default-valued field the way SCENES do.
        // Full omission would also drop an authored number that happens to equal its default, and
        // at least one consumer reads prefab fields BY NAME and treats a missing one as "no layout"
        // (Court's layoutFromPrefabDoc → a silent fallback to code constants).
        for (const field of REF_FIELDS_BY_TRAIT[meta.name] ?? []) {
          if ((traitData as Record<string, unknown>)[field] === '') delete (traitData as Record<string, unknown>)[field];
        }
        // Remap parentId from ECS IDs to localIds (parentId is in EntityAttributes).
        // Clear `guid` — prefab files are templates; per-instance identity lives on
        // the live entity, not in the prefab definition. Otherwise every instance
        // of the prefab would start with the same (stale) guid.
        if (meta.name === 'EntityAttributes') {
          if (traitData['parentId'] !== undefined) {
            (traitData as Record<string, unknown>)['parentId'] = ecsToLocal.get(rowParent.get(entityInfo.id) ?? 0) || 0;
          }
          (traitData as Record<string, unknown>)['guid'] = '';
        }
        entry.traits[meta.name] = tokens.value(traitData, tokens.root) as typeof traitData;
      }
    }

    prefabEntities.push(entry);
  }

  // Rewrite asset path refs in trait data to GUIDs where the manifest knows them.
  // After the one-shot migration this is a no-op (already GUIDs).
  for (const pe of prefabEntities) {
    for (const [traitName, fields] of Object.entries(PREFAB_REF_FIELDS)) {
      const data = pe.traits[traitName];
      if (!data || typeof data === 'boolean') continue;
      const obj = data as Record<string, unknown>;
      for (const field of fields) {
        const v = obj[field];
        if (typeof v !== 'string' || !v || isGuid(v)) continue;
        const g = getGuidForPath(v);
        if (g) obj[field] = g;
      }
    }
  }

  // A token may name a keyed node only if some file declares that key: this one, or a prefab it nests.
  const declared = new Set<string>(templateKeysOf({ entities: prefabEntities } as PrefabFile));
  for (const doc of new Set(prefabCache.values())) for (const k of templateKeysOf(doc)) declared.add(k);
  for (const pe of prefabEntities) {
    pe.traits = tokens.undeclaredKeys(pe.traits, declared) as typeof pe.traits;
    for (const field of ['overrides', 'added', 'nestedOverrides', 'nestedStructure'] as const) {
      if (pe[field]) (pe as unknown as Record<string, unknown>)[field] = tokens.undeclaredKeys(pe[field], declared);
    }
  }

  const moved = templateMoves(selectedEntityId, tree, ecsToLocal, tokens.pathOf, rowParent);

  const file: PrefabFile = {
    id: existingId ?? newGuid(),
    // The format version this serializer writes, unconditionally — see PREFAB_FORMAT_VERSION
    // for why this must not be derived from `nestedRefs` (#379).
    version: PREFAB_FORMAT_VERSION,
    name: opts?.name ?? tree[0].name,
    // The root's ASSIGNED id, not a hardcoded 1 — with a preserve map it keeps whatever the
    // file already used, and every `parentId: <root>` in the entity rows is remapped through
    // the same table, so the two can't disagree.
    rootLocalId: ecsToLocal.get(selectedEntityId) ?? 1,
    entities: prefabEntities,
    ...(moved ? { moved } : {}),
  };
  assertNoRuntimeGuids(file, 'a serialized prefab');
  return file;
}

/** Each written row's row parent: its live parent when that is a row (the ordinary case, a re-parent in the
 *  editor included). A row whose live parent is NOT one — it sits under a member of a nested instance, where
 *  a prefab's own move put it (#1437) — keeps the row it derives from: its template parent when it is linked
 *  (`identityParents.ts`), else the prefab-edit `hints` (localId → parent localId), else its nearest row
 *  ancestor. */
function rowParentsFor(
  rootEcsId: number, flatTree: EntityInfo[], all: EntityInfo[], ecsToLocal: Map<number, number>, hints?: Map<number, number>,
  /** The rows that are nested instances: never a row parent to fall back on — a row hung under one would share
   *  a path with that prefab's own row of the same localId. */
  nestedRows: ReadonlySet<number> = new Set(),
): Map<number, number> {
  const byId = new Map(all.map((e) => [e.id, e]));
  const identityOf = worldIdentityParents(getCurrentWorld());
  const ecsOfLocal = new Map([...ecsToLocal].map(([ecs, lid]) => [lid, ecs]));
  const out = new Map<number, number>();
  for (const e of flatTree) {
    if (e.id === rootEcsId || ecsToLocal.has(e.parentId)) { out.set(e.id, e.parentId); continue; }
    const identity = identityOf.parentOf(e.id);
    // Never a row inside its own live subtree now: that would write a parent cycle (identity parent or hint).
    const underSelf = (id: number | undefined): boolean => {
      for (let a = id, n = 0; a && n < 10_000; a = byId.get(a)?.parentId, n++) if (a === e.id) return true;
      return false;
    };
    let hinted = hints ? ecsOfLocal.get(hints.get(ecsToLocal.get(e.id)!) ?? -1) : undefined;
    if (underSelf(hinted)) hinted = undefined;
    let up = e.parentId;
    for (let n = 0; up && !(ecsToLocal.has(up) && !nestedRows.has(up)) && n < 10_000; n++) up = byId.get(up)?.parentId ?? 0;
    out.set(e.id, ecsToLocal.has(identity) && !underSelf(identity) ? identity : hinted ?? (up || rootEcsId));
  }
  // Choices made row by row can still close a loop across several rows (a moved row's template parent now under another
  // moved row). Any row on a loop falls back to its nearest live row ancestor; the live tree has none, so
  // repeating until nothing loops ends.
  const liveRowAncestor = (id: number): number => {
    let up = byId.get(id)?.parentId ?? 0;
    for (let n = 0; up && !(ecsToLocal.has(up) && !nestedRows.has(up)) && n < 10_000; n++) up = byId.get(up)?.parentId ?? 0;
    return up || rootEcsId;
  };
  for (let changed = true, pass = 0; changed && pass < 1_000; pass++) {
    changed = false;
    for (const e of flatTree) {
      if (e.id === rootEcsId) continue;
      const seen = new Set<number>([e.id]);
      for (let p = out.get(e.id); p !== undefined && p !== rootEcsId; p = out.get(p)) {
        if (seen.has(p)) {
          if (p === e.id && out.get(e.id) !== liveRowAncestor(e.id)) { out.set(e.id, liveRowAncestor(e.id)); changed = true; }
          break;
        }
        seen.add(p);
      }
    }
  }
  return out;
}

/** The written prefab's own `moved` (#1437 P3-c): every member of a nested instance in the tree that sits
 *  under a parent other than the one the written prefab would give it WITHOUT this map — its row parent,
 *  or where one of its nested prefabs' own moves puts it (the outermost such prefab's). "Moved back" to its
 *  row included. Member and parent are named by path in the written frame (`pathOf`). A written ROW needs
 *  none: it is written under its live parent. `undefined` when there is nothing to write. */
function templateMoves(
  rootEcsId: number, tree: EntityInfo[], ecsToLocal: Map<number, number>, pathOf: (id: number) => MemberStep[] | undefined,
  rowParent: Map<number, number>,
): Record<string, string> | undefined {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return undefined;
  const byId = new Map(tree.map((e) => [e.id, e]));
  const identity = worldIdentityParents(getCurrentWorld());
  const piOf = (id: number) => readTraitData(id, piMeta) as { rootInstanceId?: number; source?: string } | null;
  // The base each nested prefab's own moves give, the INNERMOST first so the outermost — which the loader
  // applies last — overwrites.
  const frames = tree
    .filter((e) => e.id !== rootEcsId && piOf(e.id)?.rootInstanceId === e.id)
    .map((e) => ({ id: e.id, doc: getCachedPrefabSync(piOf(e.id)!.source ?? ''), depth: pathOf(e.id)?.length ?? Infinity }))
    .sort((a, b) => b.depth - a.depth);
  const base = new Map<number, number>();
  for (const f of frames) {
    if (!f.doc?.moved) continue;
    const index = memberPathIndex(getCurrentWorld(), f.id);
    for (const [key, token] of Object.entries(f.doc.moved)) {
      const t = parseMemberToken(token);
      const member = index.get(key);
      const target = t && !t.up ? index.get(memberPathKey(t.path)) : null;
      if (member && target) base.set(member.id(), target.id());
    }
  }
  const out: Record<string, string> = {};
  // A written row whose live parent is no row: written under its row parent, and moved from there.
  for (const e of tree) {
    const row = rowParent.get(e.id);
    if (e.id === rootEcsId || row === undefined || row === e.parentId) continue;
    const member = pathOf(e.id);
    const parent = pathOf(e.parentId);
    if (member && parent) out[memberPathKey(member)] = memberToken(0, parent);
  }
  const candidates = new Set([...base.keys(), ...tree.filter((e) => identity.moved(e.id)).map((e) => e.id)]);
  for (const id of candidates) {
    const e = byId.get(id);
    if (!e || ecsToLocal.has(id)) continue;
    const at = base.get(id) ?? identity.parentOf(id);
    if (e.parentId === at) continue;
    const member = pathOf(id);
    const parent = pathOf(e.parentId);
    if (member && parent) out[memberPathKey(member)] = memberToken(0, parent);
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Rigged re-import merge (P7b-2b) ──────────────────────

/** Stable identity of a prefab entity for the rigged re-import merge. The skeleton
 *  (model root / mesh nodes / bones) is regenerated from the GLB on every import;
 *  matching by a STABLE identity instead of positional localId lets the merge keep a
 *  bone's localId across re-imports, so a user-added child's `parentId` stays valid.
 *  Returns null for a user-added entity (no skeleton identity → preserved wholesale). */
function riggedEntityIdentity(pe: PrefabEntity, rootLocalId: number): string | null {
  if (pe.localId === rootLocalId) return 'root';
  const smr = pe.traits['SkinnedMeshRenderer'];
  if (smr && typeof smr === 'object') return `mesh:${(smr as Record<string, unknown>).node ?? ''}`;
  const bone = pe.traits['Bone'];
  if (bone && typeof bone === 'object') return `bone:${(bone as Record<string, unknown>).name ?? ''}`;
  return null;
}

/** Remap an entity's `EntityAttributes.parentId` through a localId remap (clones the
 *  EntityAttributes object so the source isn't mutated). */
function remapPrefabParent(
  traits: Record<string, Record<string, unknown> | boolean>,
  remap: Map<number, number>,
): Record<string, Record<string, unknown> | boolean> {
  const ea = traits['EntityAttributes'];
  if (ea && typeof ea === 'object') {
    const p = (ea as Record<string, unknown>).parentId;
    if (typeof p === 'number' && p !== 0 && remap.has(p)) {
      traits['EntityAttributes'] = { ...(ea as Record<string, unknown>), parentId: remap.get(p)! };
    }
  }
  return traits;
}

/** Merge a freshly-imported rigged prefab with the user's existing on-disk prefab
 *  (P7b-2b). The skeleton — root, mesh nodes, bones, their bind-pose transforms, and
 *  the import-emitted traits — comes from `fresh` (a re-import refreshes the rig from
 *  source). Everything the USER added survives: extra entities (a sword hung on a
 *  bone, an Animator child) AND extra traits on a skeleton entity (a BoneAttachment,
 *  an Animator). Bones are matched by NAME, so a bone keeps its localId across
 *  re-imports and a child's `parentId` stays pointed at it. A user child whose parent
 *  bone/mesh was REMOVED from the rig is re-anchored to the model root.
 *
 *  Policy (intentional, documented): for a matched skeleton entity, `fresh` traits
 *  win (re-import is authoritative over the rig); only traits the import doesn't emit
 *  are carried over from `existing`. User-added ENTITIES are preserved verbatim. */
export function mergeRiggedPrefab(fresh: PrefabFile, existing: PrefabFile): PrefabFile {
  const existingByIdentity = new Map<string, PrefabEntity>();
  for (const pe of existing.entities) {
    const idy = riggedEntityIdentity(pe, existing.rootLocalId);
    if (idy) existingByIdentity.set(idy, pe);
  }
  const userEntities = existing.entities.filter(
    (pe) => riggedEntityIdentity(pe, existing.rootLocalId) === null,
  );

  // Allocator for brand-new fresh skeleton entities (a bone added to the rig) — above
  // every id used by either side so it can't collide with a preserved localId.
  let nextId = 0;
  for (const pe of fresh.entities) nextId = Math.max(nextId, pe.localId);
  for (const pe of existing.entities) nextId = Math.max(nextId, pe.localId);
  nextId += 1;

  // fresh localId → merged localId (matched skeleton → existing id; new → allocation).
  const freshRemap = new Map<number, number>();
  for (const pe of fresh.entities) {
    const idy = riggedEntityIdentity(pe, fresh.rootLocalId);
    const match = idy ? existingByIdentity.get(idy) : undefined;
    freshRemap.set(pe.localId, match ? match.localId : nextId++);
  }

  const mergedSkeleton: PrefabEntity[] = fresh.entities.map((pe) => {
    const traits = remapPrefabParent({ ...pe.traits }, freshRemap);
    const idy = riggedEntityIdentity(pe, fresh.rootLocalId);
    const match = idy ? existingByIdentity.get(idy) : undefined;
    if (match) {
      // Preserve user-added traits the import doesn't emit (Animator, BoneAttachment…).
      for (const [tname, tdata] of Object.entries(match.traits)) {
        // ⚠️ `hasDocKey`/`putOwn` (#986). `tname` is a trait name from the EXISTING prefab JSON and
        // `traits` is a spread of the fresh one, so a trait named after an Object.prototype member
        // read as already-present and the user's preserved trait was DROPPED on re-import — a
        // silent data loss, which is what this loop exists to prevent.
        if (!hasDocKey(traits, tname)) putOwn(traits, tname, tdata);
      }
    }
    // The matched row keeps the EXISTING document's node identity (#1468, § 3.5 Part 2). A minted id
    // cannot survive a document regenerated from a GLB that has never heard of it, so the merge's
    // content match — `riggedEntityIdentity`, already here for `localId` — is what carries it. A rig
    // node the re-import ADDED keeps the guid `serializePrefab` just minted for it.
    // ⚠️ This does not survive a DCC rename, and nothing can: a rename destroys the only
    // correspondence the GLB offers. The bounded outcome is one orphaned row, not a re-pointed one.
    return { ...pe, localId: freshRemap.get(pe.localId)!, ...(match?.nodeGuid ? { nodeGuid: match.nodeGuid } : {}), traits };
  });

  // Valid parent localIds after merge (skeleton + preserved user entities).
  const validParents = new Set<number>(mergedSkeleton.map((e) => e.localId));
  for (const pe of userEntities) validParents.add(pe.localId);

  const mergedUser: PrefabEntity[] = userEntities.map((pe) => {
    const ea = pe.traits['EntityAttributes'];
    if (ea && typeof ea === 'object') {
      const parentId = (ea as Record<string, unknown>).parentId as number | undefined;
      if (parentId !== undefined && parentId !== 0 && !validParents.has(parentId)) {
        // Parent (a bone/mesh node) removed by the re-import → re-anchor to root.
        return { ...pe, traits: { ...pe.traits, EntityAttributes: { ...(ea as Record<string, unknown>), parentId: fresh.rootLocalId } } };
      }
    }
    return pe;
  });

  // Everything this build owns, named ONCE so the carry-through below cannot disagree with it.
  // ⚠️ `satisfies`, not a bare `Record<string, unknown>` (close-out review F8). This used to be a
  // five-field object literal checked against `PrefabFile`; widening it to a bare record to feed
  // `Object.keys` silently gave up that check, so a renamed or dropped field would compile.
  const known = {
    id: fresh.id ?? existing.id,
    // The merge output is written by THIS serializer, so it carries this serializer's version
    // rather than the older of the two inputs' (#379) — but never DOWNGRADES. `existing` is
    // whatever is on disk, which the `1 | 2 | 3` type does not actually constrain: re-importing
    // a rigged model over a file from an OLDER serializer would otherwise stamp it with that
    // older number and invite a later migration to re-migrate a document already at the newer
    // shape.
    // v3 arrived in #762/#762-follow-up (UIAnchor.zIndex removed, folded into UIElement.zIndex)
    // and it is safe to preserve-the-higher-number here: v3 only DROPS a trait field, it does
    // not change the entity shape (see the v1/v2/v3 note on PREFAB_FORMAT_VERSION above), and
    // every load path (getPrefabSource/fetchPrefab/instantiatePrefab) runs
    // migrateUIAnchorZIndexStructured unconditionally on every entity regardless of the stamped
    // version. So a v2-labelled-as-v3 merge here is never actually read as v2 semantics — the
    // migration re-applies (idempotently) the next time anything loads it. A hypothetical v4
    // that changes SHAPE (not just drops a field) would not get this same free pass and would
    // need its own decision here.
    // `preservedVersion()` (runtime/core/formatVersion.ts) is the shared form of this exact
    // rule, but routing prefab through it needs a verdict computed first — that's #784 phase
    // C3, not this change.
    version: Math.max(PREFAB_FORMAT_VERSION, existing.version),
    name: fresh.name,
    rootLocalId: fresh.rootLocalId,
    entities: [...mergedSkeleton, ...mergedUser],
  } satisfies Partial<PrefabFile> & Record<string, unknown>;
  // Every OTHER top-level field of the on-disk document rides through untouched (#1468). Until this
  // change the return above WAS the whole function — a five-field object literal — so a rigged
  // re-import discarded every field it did not itself compute. `moved` is one of them, and `moved`
  // is what v4 ADDED, so this was live data loss at the version the repo already ships. The comment
  // above anticipated the shape — "a hypothetical v4 that changes SHAPE would not get this same free
  // pass" — without noticing that v4 was already that version.
  //
  // ⚠️ The carried list is DERIVED from what was just written, not transcribed. A hand-kept list of
  // "fields we know" is a claim that goes wrong in both directions: it drops a field added above it
  // and it silently claims one that was removed. `Object.keys` cannot disagree with the literal.
  //
  // ⚠️ This is `collectUnknownFields` read as "fields this WRITER does not compute", one notch wider
  // than its own docblock's "fields this BUILD does not know". Sound here, and the reason is the
  // version rule that docblock asks for: the output is stamped `max(CURRENT, existing.version)`, so
  // every field carried out of `existing` is claimed at a version at least as high as the one that
  // wrote it. Nothing is conditional on a version the output does not claim.
  //
  // Carrying `moved` VERBATIM is correct, not merely convenient: its keys and tokens are member
  // paths in this prefab's own frame, and the merge hands a *new* localId only to a skeleton entity
  // the re-import ADDED (`nextId++`, above every id either side uses). A matched entity keeps the
  // EXISTING id and a user entity is untouched, so no id an existing entry can name is reassigned to
  // a different node. An entry naming a bone the re-import DELETED is deliberately left in place:
  // `drainAfterDerive` already tolerates it ("nothing to move", plus a warn for a target that names
  // no member), which is louder and more accurate than dropping it here where nothing would report.
  //
  // `fresh` contributes nothing — it is this importer's own output, from a GLB tree with no nested
  // instances, so it has neither unknown fields nor a `moved` map.
  return mergeUnknownFields(known, collectUnknownFields(existing, Object.keys(known))) as unknown as PrefabFile;
}

/** Resolve the stable id a (re)written prefab at `prefabPath` must keep, so a
 *  model re-import never mints a fresh guid that orphans scenes whose
 *  PrefabInstance.source points at the old one (the tropical-island bug).
 *
 *  Order matters:
 *    1. the asset manifest's registered guid for this path — survives even a
 *       full file rewrite, and is the fast/offline path,
 *    2. the on-disk file's `id` — covers a freshly-scanned prefab the manifest
 *       hasn't indexed yet.
 *  Returns undefined only when neither knows it (a genuinely new prefab); the
 *  caller then mints a fresh guid via serializePrefab's `existingId ?? newGuid()`. */
export async function classifyExistingPrefabId(prefabPath: string): Promise<ExistingDocumentId> {
  return classifyExistingDocumentId(prefabPath);
}

/** What a caller about to overwrite `docPath` may conclude about the id it already carries.
 *
 *  ⚠️ Three outcomes, not two, and the third is the point (#1468, #896's class). `undefined` used to
 *  mean all of "genuinely missing", "the dev server answered 500", "the bytes are corrupt" and
 *  "written by a newer build" at once — and every caller reads it as *first-time import* and mints a
 *  FRESH guid over a document whose bytes are still on disk. Every scene referencing the old id then
 *  dangles, which is #1468's own subject arriving through a different door. */
export type ExistingDocumentId =
  /** The manifest or the file itself says what it is. Keep it. */
  | { kind: 'known'; id: string }
  /** Nothing to orphan — the path is free, or the document carries no id. Minting is correct. */
  | { kind: 'mintable'; reason: 'absent' | 'no-id' }
  /** Something is there and this build could not read it, or must not rewrite it. Do NOT mint, and
   *  do NOT write: `reason` is written for a human and is what the caller should surface. */
  | { kind: 'refuse'; reason: string };

/** The id an existing JSON asset document at `docPath` already carries, by a two-step lookup:
 *
 *    1. the asset manifest's registered guid for this path — survives even a full file rewrite,
 *       and is the fast/offline path,
 *    2. the on-disk file's `id` — covers a freshly-scanned document the manifest hasn't indexed yet.
 *
 *  Nothing about the lookup is prefab-specific; the New-asset "Replace" path uses it for materials
 *  too, so replacing one keeps the refs that point at it (#1215).
 *
 *  ⚠️ Absence is decided by `assetIsAbsent`, NEVER by `isMissingAsset` — #896's scar is that the
 *  wide predicate makes a 5xx read as absent, which is exactly the substitution this function must
 *  not authorise. `parseAssetJson` is what classifies the response, so the dev server's SPA
 *  fallback (a 200 serving index.html) counts as absent and a mid-body network drop does not.
 *
 *  ⚠️ The too-new check is PREFAB-ONLY, deliberately. Each document kind has its own version ladder
 *  and its own disposition — a scene REFUSES at load, `/api/asset-write` gates on
 *  `ASSET_WRITE_FORMAT_VERSION`, and a `.meta.json` sidecar has `assertSidecarWritable`. Comparing a
 *  material's `version` against `PREFAB_FORMAT_VERSION` would be a confident wrong answer, so this
 *  asks the question only where it knows which constant means anything. */
export async function classifyExistingDocumentId(docPath: string): Promise<ExistingDocumentId> {
  const known = getGuidForPath(docPath);
  if (known) return { kind: 'known', id: known };
  let data: unknown;
  try {
    data = await parseAssetJson(await fetch(assetUrl(docPath), ASSET_FETCH_INIT), docPath);
  } catch (e) {
    if (assetIsAbsent(e)) return { kind: 'mintable', reason: 'absent' };
    // ⚠️ The wording does NOT assert the file is there (#1468 close-out review F6). One caller —
    // Scene create — classifies a path that may legitimately be EMPTY, and a backend restart or a
    // mid-body drop lands here rather than on `absent`. "X exists but could not be read" was then a
    // confident false statement about a path with nothing on it.
    return { kind: 'refuse', reason: `could not read ${docPath} to check what is there (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'refuse', reason: `${docPath} is not a JSON object` };
  }
  const doc = data as { id?: unknown; version?: unknown };
  if (docPath.endsWith('.prefab.json') && typeof doc.version === 'number' && doc.version > PREFAB_FORMAT_VERSION) {
    return {
      kind: 'refuse',
      reason: `${docPath} was written by a newer build (prefab format ${doc.version}; this build writes `
        + `${PREFAB_FORMAT_VERSION}). Overwriting it would discard whatever the newer format added.`,
    };
  }
  return typeof doc.id === 'string' && doc.id ? { kind: 'known', id: doc.id } : { kind: 'mintable', reason: 'no-id' };
}

const PREFAB_REF_FIELDS: Record<string, string[]> = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite'],
  UIElement: ['imageSrc'],
  ModelSource: ['glbPath'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
  ParticleEmitter: ['effect'],
};

// ── Instantiate Prefab ──────────────────────────────────

/** Spawn entities from a prefab file into the world. Returns the root entity's
 *  ECS ID.
 *
 *  Nested-instance rows (`PrefabEntity.prefab`) recursively expand the child
 *  prefab (read synchronously from the cache — call `preloadNestedPrefabs` first),
 *  set the child's source + its own overrides/structure, and hang the child root
 *  under the correct outer member. `_stack` guards against reference cycles. */
export function instantiatePrefab(
  prefab: PrefabFile,
  parentId: number = 0,
  _stack?: Set<string>,
  /** Overrides an OUTER layer applies to this prefab's nested descendants (path-
   *  keyed); forwarded recursively as nested rows expand. Outermost layer wins. */
  _nestedOverrides?: NestedOverridePaths,
  /** STRUCTURAL edits an outer layer applies inside this prefab's nested descendants, path-keyed and
   *  forwarded exactly like `_nestedOverrides` — the editor twin of `instantiatePrefabIntoWorld`'s
   *  parameter (#1369), so a reference node's `nestedStructure` expands the same in both. */
  _nestedStructure?: NestedStructurePaths,
  /** This instance's path from the TOP call's root, one segment per nesting level — the loader
   *  twin's parameter (#1352). Absent on a top call, which registers its root for member-token
   *  resolution; callers run `deriveInstanceMemberGuids`, which resolves it. */
  _segments?: MemberStep[][],
): number {
  const segments = _segments ?? [];
  // The loader twin's token scope: a tree holding no member token registers no frame (#1352 review).
  const outerScope = _segments ? null : openTokenScope();
  noteTokens(prefab.entities, _nestedOverrides, _nestedStructure);
  const stack = _stack ?? new Set<string>();
  if (prefab.id) {
    if (stack.has(prefab.id)) {
      if (outerScope) closeTokenScope(outerScope);
      console.error(`[Prefab] cycle detected — prefab ${prefab.id} nests itself; aborting expansion`);
      return 0;
    }
    stack.add(prefab.id);
  }

  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  const localToEcs = new Map<number, number>();
  // ECS ids of THIS prefab's own (non-nested) members. rootInstanceId is set only
  // on these — inner members already got their own rootInstanceId via recursion.
  const ownMemberIds: number[] = [];

  const allTraits = getAllTraits(); // hoisted out of the per-row loop

  // First pass: spawn each row.
  for (const pe of prefab.entities) {
    // Migrate legacy UIAnchor.zIndex → UIElement.zIndex (SCENE_FORMAT_VERSION 12→13) — this
    // row's raw traits bag may come from a RAW fetch that never ran through getPrefabSource
    // (Assets.tsx/Hierarchy.tsx/Inspector.tsx's instantiate paths), so this is the one place
    // all of them converge. Runs BEFORE the `pe.prefab` branch below (which `continue`s) —
    // `overrides`/`added`/`nestedOverrides` exist ONLY on a nested-instance row (one that
    // carries `pe.prefab`), so a call placed after that branch — as this one used to be —
    // never actually reaches them; that row IS the case this migration exists to cover, since
    // a legacy override bag setting `UIAnchor.zIndex` on a nested member has nowhere else to
    // be caught. Structured (see uiAnchorZIndexMigration.ts) rather than a shape-agnostic deep
    // walk — it knows the override-bag carrier policy differs from the trait-bag one.
    migrateUIAnchorZIndexStructured(pe);

    if (pe.prefab) {
      // Nested-instance root: recursively expand the child prefab.
      const child = getCachedPrefabSync(pe.prefab);
      if (!child) {
        console.warn(`[Prefab] nested prefab not cached (call preloadNestedPrefabs): ${pe.prefab}`);
        continue;
      }
      // Overrides an OUTER layer addressed at this nested row: `direct` hits this
      // child's own members; `forward` reaches deeper. The row's own deep overrides
      // (pe.nestedOverrides) are merged under the outer layer (outer wins).
      const { direct: outerDirect, forward: outerForward } = descendNestedOverrides(_nestedOverrides, pe.localId);
      const childNested = mergeNestedOverridePaths(pe.nestedOverrides, outerForward);
      // The structural split, as the loader does it: an outer layer that addresses this row OWNS its
      // interior (all three lists, an absent one read as empty); `structForward` reaches deeper.
      const { direct: structDirect, forward: outerStructForward } = descendPathKeyed(_nestedStructure, pe.localId);
      // The row's OWN deep structure (#1381) sits under the outer layer's — the loader's rule.
      const structForward = mergeNestedStructurePaths(pe.nestedStructure, outerStructForward);
      const childSegments = [...segments, rowPathInPrefab(prefab, pe.localId)];
      const childRoot = instantiatePrefab(child, 0, stack, childNested, structForward, childSegments);
      if (!childRoot) continue;
      setPrefabSource(childRoot, pe.prefab);
      // Stamp parentLocalId so serialize knows which row produced this nested
      // instance (used to address scene-level overrides on it), and `parentNodeGuid` beside it so a
      // re-save of THIS prefab can carry the row's minted identity (#1468) — the nested root's own
      // `nodeGuid` belongs to the child document's frame and cannot answer for this one.
      if (PrefabInstanceMeta) {
        const childEntity = findEntity(childRoot);
        if (childEntity?.has(PrefabInstanceMeta.trait)) {
          childEntity.set(PrefabInstanceMeta.trait, {
            ...(childEntity.get(PrefabInstanceMeta.trait) as Record<string, unknown>),
            parentLocalId: pe.localId, parentNodeGuid: pe.nodeGuid ?? '',
          });
        }
      }
      // Applied HERE rather than inside the child call (the loader's shape), so rebased here, onto the
      // child's segments: these values are in the child's frame (#1352).
      const childOverrides = outerDirect ? mergeOverrideMaps(pe.overrides, outerDirect) : pe.overrides;
      if (childOverrides) applyOverridesByRootInstance(childRoot, rebaseMemberTokens(childOverrides, childSegments) as typeof childOverrides);
      if (structDirect) {
        applyStructureByRootInstance(childRoot, child, {
          added: rebaseAddedMemberTokens(structDirect.added ?? [], childSegments), removed: structDirect.removed ?? [], removedTraits: structDirect.removedTraits ?? {},
        });
      } else if (pe.added?.length || pe.removed?.length || pe.removedTraits) {
        applyStructureByRootInstance(childRoot, child, { added: rebaseAddedMemberTokens(pe.added, childSegments), removed: pe.removed, removedTraits: pe.removedTraits });
      }
      localToEcs.set(pe.localId, childRoot);
      continue;
    }

    const traitArgs: any[] = [];
    for (const meta of allTraits) {
      const saved = pe.traits[meta.name];
      if (saved === undefined) continue;
      if (meta.name === 'PrefabInstance') continue; // we add our own below

      if (saved === true) {
        traitArgs.push(meta.trait());
      } else {
        const data = { ...(saved as Record<string, unknown>) };
        // Migrate legacy Renderable.sprite → mesh
        if (meta.name === 'Renderable3D' && data.sprite && !data.mesh) {
          data.mesh = data.sprite; delete data.sprite;
        }
        // Spawn PARENTLESS; the second pass reads the parent from the file entry. The file's parentId is
        // a localId, and left live it would name whichever entity holds that number — so the removal
        // cascade of a nested row's structure, which runs below mid-pass, would take this row (#1247).
        if (meta.name === 'EntityAttributes') data.parentId = 0;
        traitArgs.push(meta.trait(rebaseMemberTokens(data, segments) as Record<string, unknown>));
      }
    }

    if (PrefabInstanceMeta) {
      traitArgs.push(PrefabInstanceMeta.trait({
        source: '',          // set by the caller who knows the file path
        localId: pe.localId,
        // '' for a pre-v5 document, which carries no identity to hand over (#1468).
        nodeGuid: pe.nodeGuid ?? '',
        rootInstanceId: 0,   // set after the root is known (second pass)
      }));
    }

    const entity = spawnEntity(getCurrentWorld(), ...traitArgs);
    // Still needed with the packed key: the 8-bit generation wraps (overrideMarks.ts).
    clearOverrideMarks(entity);
    localToEcs.set(pe.localId, entity.id());
    ownMemberIds.push(entity.id());
  }

  const rootEcsId = localToEcs.get(prefab.rootLocalId) || 0;
  // What this frame's localIds mean, recorded at its root — the loader twin does the same
  // (`identityParents.ts`). By the document's own id: `setPrefabSource` stamps that ref.
  if (prefab.id && rootEcsId) noteFrameDoc(getCurrentWorld(), prefab.id, prefab, findEntity(rootEcsId) ?? undefined);

  // Second pass: remap EntityAttributes.parentId for every row (including the
  // nested-instance root). Every row reads its parent from the FILE entry — the
  // first pass spawned them all parentless (#1247). Direct findEntity writes — was
  // a full-world query.updateEach per row (O(n²)).
  const attrMeta = getTraitByName('EntityAttributes');
  if (attrMeta) {
    for (const pe of prefab.entities) {
      const ecsId = localToEcs.get(pe.localId);
      if (!ecsId) continue;
      const entity = findEntity(ecsId);
      if (!entity || !entity.has(attrMeta.trait)) continue;
      const ea = entity.get(attrMeta.trait) as Record<string, unknown>;
      const fileEa = pe.traits['EntityAttributes'];
      const localParent = fileEa && typeof fileEa === 'object'
        ? ((fileEa as Record<string, unknown>).parentId as number ?? 0)
        : 0;
      const newParent = localParent > 0 ? (localToEcs.get(localParent) || parentId) : parentId;
      entity.set(attrMeta.trait, { ...ea, parentId: newParent });
    }
  }

  // Set rootInstanceId on this prefab's OWN members only — never on inner
  // members, which carry their own (child) rootInstanceId.
  if (PrefabInstanceMeta && rootEcsId) {
    for (const id of ownMemberIds) {
      const entity = findEntity(id);
      if (entity?.has(PrefabInstanceMeta.trait)) {
        entity.set(PrefabInstanceMeta.trait, { ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), rootInstanceId: rootEcsId });
      }
    }
  }

  // The prefab's own moves (#1437 P3-b), resolved after the derive pass; an instance's own move of the same
  // member overrides one.
  if (prefab.moved) queuePrefabMoves(getCurrentWorld(), rootEcsId, prefab.moved, '[Prefab]');

  // Refresh subscribers with the remapped parent links — refreshes fired during
  // the spawn loop saw stale local parentIds.
  markStructureDirty();
  // Rebuild the UI projection too — a UI prefab's entities won't render otherwise
  // (markStructureDirty only refreshes the Hierarchy; the DOM UI tree needs this).
  markUIDirty();

  if (prefab.id) stack.delete(prefab.id);
  if (outerScope && closeTokenScope(outerScope) && rootEcsId) registerTemplateFrame(getCurrentWorld(), rootEcsId);
  return rootEcsId;
}

/** `rebaseMemberTokens` over `added` nodes; a reference node is left whole (it is its own frame).
 *  The loader's `rebaseAddedTokens`, for the structure the editor applies at the parent level. */
function rebaseAddedMemberTokens(nodes: AddedEntity[] | undefined, segments: MemberStep[][]): AddedEntity[] | undefined {
  if (!nodes || !segments.length) return nodes;
  return nodes.map((n) => (n.prefab ? n : {
    ...n,
    traits: rebaseMemberTokens(n.traits, segments) as AddedEntity['traits'],
    children: rebaseAddedMemberTokens(n.children, segments) ?? [],
  }));
}

/** Set the source path on all entities of a prefab instance */
export function setPrefabSource(rootEcsId: number, source: string) {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Callers pass the prefab's asset PATH; store a GUID instead when one resolves.
  // The runtime + serializer are GUID-only — a raw path here makes getPrefabSource
  // (used for live override detection) hit resolveRef's hard rejection. Fall back
  // to the given ref only when the manifest can't resolve it yet.
  const ref = isGuid(source) ? source : (getGuidForPath(source) ?? source);

  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], _entity) => {
    if ((pi as Record<string, unknown>).rootInstanceId === rootEcsId) {
      (pi as Record<string, unknown>).source = ref;
    }
  });
}

// ── Override Detection ──────────────────────────────────

/** Cache of loaded prefab files by source path */
const prefabCache = new Map<string, PrefabFile>();
// Identity walks read a frame's template parents from the document it was expanded from — the loader records
// that per world; this is what they read for a frame the editor made itself (its own `instantiatePrefab`, a
// Create Prefab tag, an undo respawn into a world that never expanded the source). `identityParents.ts`.
setFrameDocFallback((source) => prefabCache.get(source) ?? null);

/** Load a prefab file (cached). `source` is a prefab GUID (resolved via the
 *  manifest) or a legacy path like "/models/.../island.prefab.json". Cached by
 *  the original ref so guid + path callers don't fetch twice. */
export async function getPrefabSource(source: string): Promise<PrefabFile | null> {
  if (prefabCache.has(source)) return prefabCache.get(source)!;
  const prefab = await fetchPrefabSource(source);
  if (prefab) prefabCache.set(source, prefab);
  return prefab;
}

/** Read a prefab file from disk, uncached — `getPrefabSource`'s fetch half, shared with
 *  `refreshPrefabSourceForPath`. */
async function fetchPrefabSource(source: string, init?: RequestInit): Promise<PrefabFile | null> {
  // Normally a GUID (resolve via manifest). A freshly-instantiated instance can
  // still carry a path before its owning scene is saved + normalized; resolveRef
  // rejects internal asset paths loudly, so fetch a path ref directly instead.
  const url = isGuid(source) ? resolveRef(source) : assetUrl(source);
  if (!url) return null;
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const prefab: PrefabFile = await res.json();
    // Prefabs carry no migration chain at all — PREFAB_FORMAT_VERSION is a writer-only stamp
    // nothing on the loading path inspects (#365/#379). Applying the zIndex migration
    // unconditionally here (cheap, idempotent) is the smallest thing that closes the same
    // data-loss window a versioned migration closes for scenes — see uiAnchorZIndexMigration.ts.
    // Structured walk — reaches overrides[localId][UIAnchor], added[] subtrees and
    // nestedOverrides paths too (including this prefab FILE's own nested rows), not just
    // entry.traits.
    for (const entry of prefab.entities) migrateUIAnchorZIndexStructured(entry);
    if (prefab.id) registerAsset(prefab.id, url, 'prefab');
    return prefab;
  } catch { return null; }
}

/** Re-read the cached copy of a prefab whose FILE changed on disk from outside the editor (#1169).
 *  `setPrefabCache` covers the editor's own writes; this covers a hand edit or a `git checkout`,
 *  which reach the editor only as a watcher event (`agentBridge.ts` `handleSceneChanged`). Without
 *  it the reload rebuilds instances from the new file while override capture keeps diffing them
 *  against this stale copy, and a trait or entity the new prefab added is saved as an override.
 *
 *  ⚠️ REFRESH, never delete (close-out review). This cache has SYNC readers that treat a miss as "not
 *  a prefab": `serializePrefab` flattens a nested instance it cannot find, and a prefab-edit save
 *  refuses once the edited prefab is gone from it. In prefab-edit mode no reload follows to fill a
 *  hole, so a delete made the next save inline a nested prefab and report success. So the new file is
 *  fetched FIRST and swapped in, and an unreadable file (a half-typed hand edit, a deletion) keeps the
 *  old entry — dropping it would also make the NEXT event skip the key as cold, so the fixed file
 *  would never be read. A key nobody has read is left cold rather than warmed.
 *
 *  Swapped only if nobody replaced the entry during the fetch: an Apply-to-Prefab landing then has
 *  already put the newer content in (its own write never reaches the watcher), and two external
 *  writes can race their refreshes. And the prefab OPEN in prefab-edit mode keeps its copy: the edit
 *  world still holds the old content, so the save it diffs against must stay the one it opened —
 *  refreshing it changes what that save does without the world ever showing the external version.
 *
 *  Keyed by whatever ref the caller used, a GUID normally and a path for a not-yet-normalized
 *  instance, so both keys are refreshed. Does NOT touch the runtime cache: the watcher path evicts
 *  that itself. */
export async function refreshPrefabSourceForPath(path: string): Promise<void> {
  const guid = getGuidForPath(path);
  const editing = useEditorStore.getState().editingPrefab?.guid;
  for (const key of guid ? [guid, path] : [path]) {
    const before = prefabCache.get(key);
    if (before === undefined || key === editing) continue;
    const fresh = await fetchPrefabSource(key, { cache: 'no-store' });
    if (fresh && prefabCache.get(key) === before) prefabCache.set(key, fresh);
  }
}

/** Synchronous cache lookup — returns the prefab if already loaded, else null.
 *  `instantiatePrefab` is sync, so a nested child must be preloaded (see
 *  `preloadNestedPrefabs`) before instantiation. */
export function getCachedPrefabSync(source: string): PrefabFile | null {
  return prefabCache.get(source) ?? null;
}

/** Transitively fetch every nested prefab referenced by `prefab` (and their
 *  nested children) into the cache, so a later sync `instantiatePrefab` can read
 *  them. Cycle-safe via `seen`. Call this from async entry points before
 *  instantiating a prefab that may contain nested instances. */
export async function preloadNestedPrefabs(prefab: PrefabFile, seen = new Set<string>()): Promise<void> {
  const children = prefab.entities.map((e) => e.prefab).filter((s): s is string => !!s);
  for (const childRef of children) {
    if (seen.has(childRef)) continue;
    seen.add(childRef);
    const child = await getPrefabSource(childRef);
    if (child) await preloadNestedPrefabs(child, seen);
  }
}

/** Warm every prefab referenced by the LIVE entity subtree under `selectedEntityId`,
 *  so the sync cache readers that run over that subtree can see them (#1284).
 *
 *  ⚠️ This is the counterpart to `preloadNestedPrefabs`, and the difference between the
 *  two IS the defect it fixes. `preloadNestedPrefabs` walks a prefab FILE's reference
 *  rows; the sync readers walk the LIVE TREE. Anything live-but-not-in-the-file is
 *  therefore never warmed by it, and every such reader treats "not in the cache" as
 *  "not a prefab" and silently takes its degraded branch:
 *    - `planPrefabRows` flattens a held nested instance into copies (Create Prefab had
 *      no warm at all, so after an ordinary scene load EVERY live instance was cold —
 *      the scene loader fills the RUNTIME cache, not this one);
 *    - `captureNestedRef` drops a user-added nested subtree from `added[]` entirely;
 *    - `captureNestedInstanceOverrides` / `reapplyNestedInstanceOverrides` lose a
 *      nested instance's per-copy overrides across a rebuild, with no warning at all.
 *
 *  ⚠️ **Calling this does not make those readers safe everywhere — only on the paths that
 *  call it.** Every async entry point that reaches one of them now does, INCLUDING the undo and
 *  redo closures: `UndoAction.undo/redo` are typed `(): void | Promise<void>` and `undoManager`
 *  awaits them under its own in-flight mutex, so a closure that needs to warm can. An earlier
 *  version of this comment called those closures "synchronous … can never await", which was
 *  false and was the stated reason for deferring them.
 *
 *  ⚠️ **These calls are now belt-and-braces, not the mechanism.** Since #1295 the cache is
 *  populated by construction — `instantiatePrefabInstance` caches under the ref the instance
 *  carries, and `installEditorPrefabCacheWarm` fills it on every scene swap from what the loader
 *  already parsed. These are kept because each costs a `Map.has` once warm and the failure they
 *  guard against is silent; the source census that used to police them was deleted, because it
 *  needed a new anchor per reader and every sweep that anchored on ONE of them missed a path.
 *
 *  Call this from the async entry point BEFORE any of them, exactly as the scene save
 *  already does for its own capture loop (`serialize.ts`, "Preload every referenced
 *  prefab so captureInstanceOverrides can read from the cache without async I/O").
 *
 *  The warmed set is deliberately a SUPERSET of the set `planPrefabRows` turns into
 *  reference rows: it includes the selection root, which that function never collapses.
 *  Over-warming costs one cached fetch; under-warming is the bug — so the asymmetry is
 *  the point, and a later change to the membership rule cannot silently re-open this.
 *
 *  ⚠️ No recursion into each fetched FILE's own rows, deliberately. `collectTree` is a
 *  full descendant walk and `instantiatePrefab` gives every nested root its own
 *  `PrefabInstance`, so an instance nested N levels deep is its OWN entry in this loop —
 *  and every sync reader this feeds walks the live tree too, so a file row with no live
 *  instance is never read. A `preloadNestedPrefabs(child, seen)` call here was written
 *  first and removed: it made the depth case pass for the WRONG reason, and the pair was
 *  mutually redundant, so neither line could be shown to fail on its own. The depth-2
 *  case is covered in coldPrefabCacheWarming.test.ts and dies if this walk is truncated. */
export async function preloadNestedPrefabsForSubtree(selectedEntityId: number): Promise<void> {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return;
  // Collect first, then fetch in parallel — the scene save's equivalent preload does the same
  // (`serialize.ts`). The Set is what dedupes; it is NOT a side effect of fetching serially,
  // so parallelising cannot reintroduce a double fetch for two instances of one source.
  const seen = new Set<string>();
  for (const e of collectTree(selectedEntityId, getAllEntities())) {
    if (!e.traits.includes('PrefabInstance')) continue;
    const source = readTraitData(e.id, piMeta)?.source as string | undefined;
    if (source) seen.add(source);
  }
  await Promise.all([...seen].map((source) => getPrefabSource(source)));
}

/** Spawn an instance of a prefab that was loaded from an asset PATH, and leave the editor
 *  prefab cache answering to the key the instance actually CARRIES (#1295).
 *
 *  ⚠️ This closes the gap that made every per-call-site warm necessary, and it is the reason
 *  a world-level warm alone could not replace them. The three raw-fetch instantiate entry
 *  points (Assets, Hierarchy, Inspector — and their undo respawns) fetched the file, spawned
 *  it, then called `setPrefabSource`, which stores the **GUID** when the manifest resolves one.
 *  Nothing ever cached the prefab under that guid, so a prefab dropped in mid-session was
 *  invisible to every sync reader — `planPrefabRows` flattened it, `captureNestedRef` dropped
 *  it — no matter what happened at scene load.
 *
 *  ⚠️ Sets the map DIRECTLY rather than calling `setPrefabCache`, deliberately: that helper also
 *  rewrites the runtime cache entry (and bumps its revision, re-spawning every pool built from it —
 *  #1308), because every one of its callers follows a prefab FILE WRITE. This one follows a READ,
 *  and churning the runtime cache on every drag-drop would be pure cost. */
export async function instantiatePrefabInstance(
  prefab: PrefabFile, sourcePath: string, parentId: number = 0,
): Promise<number> {
  const rootId = await instantiatePrefabAsync(prefab, parentId);
  if (!rootId) return rootId;
  // Under a base entity the new instance belongs to that base (#1429). Every caller's redo re-runs this
  // helper, so the stamp comes back with it.
  adoptParentScene(rootId);
  setPrefabSource(rootId, sourcePath);
  // Whatever ref setPrefabSource settled on — the guid when the manifest resolves it, the raw
  // path when it cannot (a freshly-instantiated instance before its scene is saved).
  const piMeta = getTraitByName('PrefabInstance');
  const live = piMeta ? (readTraitData(rootId, piMeta)?.source as string | undefined) : undefined;
  if (live) primeEditorPrefabCache(live, prefab);
  return rootId;
}

/** Seed the editor prefab cache from a READ — the scene-load warm and the instantiate helper.
 *
 *  ⚠️ Deliberately NOT `setPrefabCache`, and the difference is the whole reason this exists:
 *  that one also rewrites the runtime cache (`replaceCachedPrefab`), because all of ITS callers
 *  follow a prefab FILE WRITE. A read-side seed doing that would bump the prefab's revision and
 *  re-spawn every pooled row built from it (#1308) — on every drag-drop, and once per prefab on
 *  every scene swap. */
export function primeEditorPrefabCache(source: string, prefab: PrefabFile): void {
  prefabCache.set(source, prefab);
}

/** Is this source already in the editor cache? (`getCachedPrefabSync` answers the same
 *  question, but returning the file invites a caller to use a copy it should not hold.) */
export function isEditorPrefabCached(source: string): boolean {
  return prefabCache.has(source);
}

/** Async-safe instantiate: preload every nested child into the editor cache, THEN
 *  run the synchronous `instantiatePrefab`. Use this from UI entry points (drag-drop,
 *  Instantiate buttons) — `instantiatePrefab` alone silently skips nested rows whose
 *  child file isn't cached yet, so callers MUST preload first. This makes the
 *  preload contract un-missable for the common case. */
export async function instantiatePrefabAsync(prefab: PrefabFile, parentId: number = 0): Promise<number> {
  await preloadNestedPrefabs(prefab);
  const rootId = instantiatePrefab(prefab, parentId);
  // The prefab file clears EntityAttributes.guid (templates carry no per-instance
  // identity), so a freshly-instantiated root has an empty guid until the next
  // scene save. Mint one NOW so the instance is referenceable immediately — entity-
  // ref fields (e.g. BoneAttachment.target) resolve a dropped entity by its guid,
  // so an empty-guid root silently no-ops on drop. Doing it here (not on save) also
  // gives deriveInstanceMemberGuids a stable anchor for the members below.
  const attrMeta = getTraitByName('EntityAttributes');
  if (attrMeta && rootId) {
    const rootEntity = findEntity(rootId);
    if (rootEntity?.has(attrMeta.trait)) {
      const ea = rootEntity.get(attrMeta.trait) as Record<string, unknown>;
      // A runtime guid (#1210) is not an identity: mint over it like an empty one.
      if (!durableGuid(ea.guid as string)) { rootEntity.set(attrMeta.trait, { ...ea, guid: newGuid() }); indexEntityGuid(rootEntity); }
    }
  }
  // Stamp stable member GUIDs so the new instance's children are referenceable.
  deriveInstanceMemberGuids(getCurrentWorld());
  return rootId;
}

/** True if nesting `childGuid` inside `parentGuid` would create a reference cycle
 *  — i.e. the child transitively nests the parent (or IS the parent). Best-effort
 *  sync walk over the editor cache; the instantiate-time `_stack` guard backstops
 *  any cycle this can't see (e.g. a child not yet cached). */
export function wouldCreateCycle(parentGuid: string, childGuid: string, _seen = new Set<string>()): boolean {
  if (!parentGuid || !childGuid) return false;
  if (childGuid === parentGuid) return true;
  if (_seen.has(childGuid)) return false;
  _seen.add(childGuid);
  const child = getCachedPrefabSync(childGuid);
  if (!child) return false; // not cached — can't verify here; instantiate guard backstops
  // Every prefab the file expands: its nested rows, and the reference nodes those rows add (#1446 close-out).
  for (const ref of expandedPrefabRefs(child.entities)) {
    if (wouldCreateCycle(parentGuid, ref, _seen)) return true;
  }
  return false;
}

/** Every prefab ref a list of rows or added nodes EXPANDS, at any depth: a node's own `prefab`, its `children`,
 *  a reference node's own `added`, and the `added` lists of its `nestedStructure` slots. Never `traits` — a trait
 *  field that happens to be called `prefab` (a spawner naming what it spawns) is data, not nesting. */
function expandedPrefabRefs(nodes: readonly { prefab?: string; children?: AddedEntity[]; added?: AddedEntity[]; nestedStructure?: NestedStructurePaths }[]): string[] {
  const out: string[] = [];
  const walk = (n: (typeof nodes)[number]) => {
    if (n.prefab) out.push(n.prefab);
    for (const c of n.children ?? []) walk(c);
    for (const c of n.added ?? []) walk(c);
    for (const slot of Object.values(n.nestedStructure ?? {})) for (const c of slot.added ?? []) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** Does this added subtree hold an instance of `target` — a promotion that would make the prefab contain
 *  itself (#1446)? Only the slots that expand count ({@link expandedPrefabRefs}), never trait data. The expansion refuses a cyclic row, so the promoted instance came back empty after the refresh and
 *  the user's instance was gone. A scene may hold one — it expands fine there; only the file cannot. */
function addedNestsPrefab(node: AddedEntity, target: string): boolean {
  return expandedPrefabRefs([node]).some((ref) => wouldCreateCycle(target, ref));
}

/** Structural equality with float tolerance, used by `getOverrideValues` to decide
 *  whether an instance field actually diverges from the prefab base. Scalars compare
 *  directly (numbers within 1e-6); AoS object/array fields (e.g.
 *  `AnimationLibrary.animSets`/`boneMaps`, `SkinnedMeshRenderer.materials`) compare by
 *  VALUE. A plain reference `!==` would flag those on EVERY rigged instance — the live
 *  array and the array parsed from the prefab JSON are distinct instances even when
 *  their contents are identical — bloating scenes with redundant override blocks and
 *  freezing the field so later prefab-base edits can't propagate. The tolerance also
 *  reaches NESTED numbers (e.g. material color floats), which the old top-level-only
 *  check missed. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[], bv = b as unknown[];
    if (av.length !== bv.length) return false;
    return av.every((x, i) => valuesEqual(x, bv[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && valuesEqual(ao[k], bo[k]));
}

/** Get override values: fields that differ from the prefab source.
 *  Returns a nested record keyed by traitName → fieldName → live value. */
export function getOverrideValues(
  entityLocalId: number,
  currentTraits: Record<string, Record<string, unknown>>,
  prefab: PrefabFile,
  /** Resolves the member tokens a base value holds against this instance (`baseTokenResolver`), so a
   *  ref the template names by path compares equal to the guid it resolved to (#1352). Without it a
   *  token-bearing base field reads as overridden on every instance. */
  resolveBase?: (value: unknown) => unknown,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const prefabEntity = prefab.entities.find((e) => e.localId === entityLocalId);
  if (!prefabEntity) return result;

  for (const [traitName, currentData] of Object.entries(currentTraits)) {
    if (traitName === 'PrefabInstance') continue;
    const prefabData = prefabEntity.traits[traitName];

    // Trait the prefab doesn't define at this localId → the user added it to the
    // instance (root OR child). Capture the whole trait so it round-trips. This is
    // the unified "added-trait override" path; it replaces the old root-only
    // rootExtraTraits mechanism (the loader still reads rootExtraTraits for legacy
    // scenes). Added tags land here too with currentData === {} → captured as {name: {}}.
    if (prefabData === undefined) {
      // Capture the whole added trait, minus pure runtime read-back fields
      // (runtimeOnly) — persisting e.g. SkeletalAnimator.time / RigidBody.isSleeping
      // would bake a nondeterministic frame into the scene override.
      const addMeta = getTraitByName(traitName);
      const captured: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(currentData)) {
        if (addMeta?.fields[k]?.runtimeOnly) continue;
        captured[k] = v;
      }
      result[traitName] = captured;
      continue;
    }
    // Tag the prefab already defines at this localId: nothing to capture (it comes
    // from the prefab). Removing a prefab-defined tag on an instance isn't tracked,
    // same as removing any prefab-defined trait.
    if (prefabData === true) continue;

    const original = prefabData as Record<string, unknown>;
    // ⚠️ A field ABSENT from the base is not "unknown" — it is the trait's schema DEFAULT, because
    // that is exactly what the loader rebuilds it as (`meta.trait(partialData)`, koota fills the
    // rest). Skipping it instead (the old `origValue !== undefined` gate alone) makes a real
    // instance override invisible to every RAW caller of this function: the Inspector's
    // "overridden" highlight, and the Apply-to-Prefab / Revert-Overrides dialogs, which build their
    // checkbox tree from these diffs — so the field cannot be applied or reverted at all. The SAVE
    // path escapes it only because `captureInstanceOverrides` folds marked fields back in.
    //
    // This became reachable when `serializePrefab` started dropping BLANK asset refs (a prefab with
    // no material no longer writes `material: ""`), but it was always latent: any prefab authored
    // without a field hits it.
    const baseSchema = (getTraitByName(traitName)?.trait as { schema?: Record<string, unknown> } | undefined)?.schema;
    for (const [field, value] of Object.entries(currentData)) {
      if (field === 'parentId') continue; // parentId is remapped, skip
      // guid is per-instance identity — minted when the instance is created/saved,
      // while prefab files clear it (templates carry no identity). It legitimately
      // differs from the base but must NEVER be treated as an override: applying it
      // back would write one instance's guid into the prefab base and make every
      // future instance collide on the same guid. Since v16 it is also a ROW
      // (`captureInstanceMembers`), so both exclusions of it now hold for one reason:
      // the guid is written in exactly one channel (#1468).
      if (traitName === 'EntityAttributes' && field === 'guid') continue;
      const rawOrig = field in original ? original[field] : baseSchema?.[field];
      const origValue = resolveBase ? resolveBase(rawOrig) : rawOrig;
      if (origValue !== undefined && !valuesEqual(value, origValue)) {
        if (!result[traitName]) result[traitName] = {};
        result[traitName][field] = value;
      }
    }
  }

  return result;
}

/** Build the `currentTraits` bag `getOverrideValues` compares against the prefab base.
 *
 *  `readTraitDataFull`, NOT `readTraitData`: the latter returns only the curated Inspector
 *  subset in `meta.fields`, so every persistent field a custom Inspector section owns
 *  (`Animator.clips`, `AudioSource.clips`) and every AoS field (`AnimationLibrary.animSets`,
 *  `SkinnedMeshRenderer.materials`, `UIAction.onClickSet`) would be ABSENT from the
 *  comparison — reported as "not overridden" whatever its value. Runtime-only read-back
 *  fields are then stripped, or a live playhead would read as an override on every instance.
 *
 *  Shared rather than inlined because the Apply/Revert DIALOG built this bag with the
 *  curated read while the serializer used the full one, so the dialog under-reported exactly
 *  those fields and a user could not apply them (found by the QA-CTX-0003 close-out sweep —
 *  the third site where that same substitution has bitten). One builder, one answer. */
export function collectComparableTraits(
  ecsId: number,
  allTraits: TraitMeta[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const meta of allTraits) {
    if (meta.name === 'PrefabInstance') continue;
    const data = readTraitDataFull(ecsId, meta);
    if (!data) continue;
    for (const field of Object.keys(data)) {
      if (isRuntimeOnlyField(meta, field)) delete data[field];
    }
    out[meta.name] = data;
  }
  return out;
}

/** Get overrides: fields that differ from the prefab source.
 *  Returns a set of "traitName.fieldName" strings for overridden fields. */
export function getOverrides(
  entityLocalId: number,
  currentTraits: Record<string, Record<string, unknown>>,
  prefab: PrefabFile,
  resolveBase?: (value: unknown) => unknown,
): Set<string> {
  const overrides = new Set<string>();
  const values = getOverrideValues(entityLocalId, currentTraits, prefab, resolveBase);
  for (const [traitName, fields] of Object.entries(values)) {
    for (const field of Object.keys(fields)) {
      overrides.add(`${traitName}.${field}`);
    }
  }
  return overrides;
}

// ── Instance-keyed scan cost (review F11 — measured, no index threaded) ──────
//  The instance-keyed helpers below (capture/apply overrides + structure,
//  collectInstanceRoots, localToEcsGuid, findChildNestedRoot, resolveInstance
//  context, setPrefabSource) each `getCurrentWorld().query(PrefabInstance)
//  .updateEach(...)` and filter to one `rootInstanceId`.
//
//  F11 proposed threading a `rootInstanceId → members` index through all of them.
//  Measured first, per the finding's own "measure first": koota's `query(Trait)`
//  is ARCHETYPE-based — it iterates only entities that CARRY `PrefabInstance`, NOT
//  the whole world. So each scan is O(live prefab-instance members), not
//  O(worldEntities) as the finding's wording implied; a 10k-entity scene with a
//  handful of small instances scans only those few dozen tagged members. The one
//  nested case (`findChildNestedRoot` inside `reapplyNestedInstanceOverrides`) is
//  O(nestingDepth × members), still bounded by tagged members. A full Apply/Refresh
//  chains ~5-8 such scans; at realistic instance-member counts that is sub-millisecond
//  and dwarfed by the teardown/respawn + render it triggers.
//  Verdict: the constant-factor win does not justify threading a mutable index
//  through 9 functions — extra surface area that the GUID-resolved-undo + dual
//  prefab-cache invariants would have to stay correct against. Revisit only if a
//  profile on a scene with MANY large instances shows these scans dominating an
//  interactive Apply. (Tag count, not world size, is the metric to watch.)
//
/** Capture all per-localId overrides for every entity in a prefab instance.
 *  Returns `{}` if the root has no overrides anywhere. */
/** The guid of the parent the prefab moves (P3-b) place a live entity under, in the instance rooted at
 *  `rootInstanceId` — '' when none does, or its target names no member. `prefab` is that instance's document;
 *  an ENCLOSING instance's document can move the same member too, and the outermost one wins, as the loader
 *  applies it last. Without the enclosing ones a nested instance read the outer prefab's move as the
 *  instance's own, and every copy saved it (review F4). Memoised. */
/** While a rebuild captures nested instances: the document each enclosing instance root was EXPANDED from, when
 *  the cache already holds a newer one (a refresh after Apply). Read against the new document, a member still at
 *  its old place looked moved back, and the capture cancelled the very move being applied. */
let expandedFrom: ReadonlyMap<number, PrefabFile> | null = null;

/** The instance roots ENCLOSING an owned nested instance rooted at `rootInstanceId`, innermost first, each with
 *  the document it was expanded from — up to the stored root. Empty for a stored root. */
function enclosingFrames(rootInstanceId: number): { root: number; doc: PrefabFile | null }[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const out: { root: number; doc: PrefabFile | null }[] = [];
  if (!piMeta || !eaMeta) return out;
  const identity = worldIdentityParents(getCurrentWorld());
  for (let root = rootInstanceId, n = 0; root && n < 64; n++) {
    const pi = readTraitData(root, piMeta);
    if (!pi?.parentLocalId) break; // a stored root: nothing encloses it
    root = identity.ownerOf(root);
    if (root) out.push({ root, doc: expandedFrom?.get(root) ?? getCachedPrefabSync((readTraitData(root, piMeta)?.source as string) || '') });
  }
  return out;
}

function prefabMoveTargets(rootInstanceId: number, prefab: PrefabFile): (ecsId: number) => string {
  const eaMeta = getTraitByName('EntityAttributes');
  type Frame = { index: ReturnType<typeof memberPathIndex>; pathOf: Map<number, string>; doc: PrefabFile };
  let frames: Frame[] | null = null;
  const frameChain = (): Frame[] => {
    const world = getCurrentWorld();
    return [{ root: rootInstanceId, doc: prefab }, ...enclosingFrames(rootInstanceId)].filter((f) => f.doc?.moved).map((f) => {
      const index = memberPathIndex(world, f.root);
      return { index, pathOf: new Map([...index].filter(([, e]) => e).map(([k, e]) => [e!.id(), k])), doc: f.doc! };
    });
  };
  return (ecsId) => {
    if (!eaMeta) return '';
    frames ??= frameChain();
    let base = '';
    for (const f of frames) {
      const t = parseMemberToken(f.doc.moved?.[f.pathOf.get(ecsId) ?? '\0'] ?? '');
      const target = t && !t.up ? f.index.get(memberPathKey(t.path)) : null;
      if (target) base = (target.get(eaMeta.trait) as { guid?: string }).guid ?? '';
    }
    return base;
  };
}

/** This instance's MEMBER ROWS as the scene stores them (v16, #1468): each live member's minted
 *  identity → the guid it currently carries. The point of the whole plan — a member's guid stops
 *  being re-derived from where it happens to sit and becomes something the file states.
 *
 *  `memberRowKeysIn` decides which members are keyed and under what, in ONE spelling shared with the
 *  loader that reads the rows back; its docblock carries the four exclusions and why each one is not
 *  a row. This function only turns those keys into rows.
 *
 *  Emitted in KEY order, not tree order. A key is stable across everything this plan exists to
 *  survive, so the block does not churn when a template row moves or is renumbered; tree order would
 *  reorder the whole map on any of those. Unreadable to a human either way — that is what `name` is
 *  for.
 *
 *  ⚠️ A member with no DURABLE guid gets no row. `durableGuid` excludes a runtime guid (#1210),
 *  which is a per-session handle and not an identity to write down; and an unaddressable member
 *  (no anchored ancestor) has '' and nothing to store. Both keep deriving — the same answer they give
 *  today. */
/** Put the member identity an instance HAD back onto the tree a REBUILD has just re-expanded
 *  (Refresh, Revert, and every other `rebuildInstance` caller — v16, #1468).
 *
 *  A rebuild destroys the members and expands fresh ones, which then take DERIVED guids: the
 *  loader's stored rows live in the scene file, not in the live world, so without this a Refresh
 *  silently replaces every pinned identity with a derived one and the next save writes the
 *  derived values over the rows. That is precisely § 3.4's failure — an artist re-imports, members
 *  renumber, and identity is lost — arriving through the gesture meant to pick the change up.
 *
 *  The rows come from `captureInstanceMembers` on the LIVE tree before the teardown, because the live
 *  guids ARE the pinned values (the load put them there). So this is a carry, not a re-read of the
 *  file, and it works the same whether the instance was loaded from disk or created this session.
 *
 *  `applyGuidRemap` rather than a hand-rolled write, because it is the SAME primitive the two
 *  sibling mechanisms use (`stampDerivedMemberGuids`, `promoteOwnedRoots`) and it is less code than
 *  writing, re-indexing and remapping refs by hand.
 *
 *  ⚠️ **Not falsifiable by the suite, and stated rather than implied.** Mutating it to a bare write
 *  leaves every test green, twice over: `findEntityByGuid` SELF-HEALS on a miss (one rescan, then
 *  retry), so the missing re-index costs speed and not correctness; and nothing this rebuild does
 *  holds a reference to the transient derived guid for the ref-remap to repair. What a bare write
 *  would really cost is `peekEntityByGuid`, which never rescans by design — a guid written without
 *  indexing is invisible to a caller running inside a structure change. No such caller is on this
 *  path today, which is exactly why this note exists instead of a test that cannot fail. */
function restoreInstanceMembers(rootEcsId: number, rows: Record<string, SceneMemberRow>): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta || !Object.keys(rows).length) return;
  const remap = new Map<string, string>();
  for (const [ecsId, key] of memberRowKeysIn(rootEcsId)) {
    const want = durableGuid(rows[key]?.guid);
    if (!want) continue;
    const had = durableGuid((readTraitData(ecsId, eaMeta) as { guid?: string } | null)?.guid);
    if (had === want) continue;
    // A member with no guid at all is written directly — `applyGuidRemap` keys on the OLD value, and
    // '' would match every guid-less entity in the world — and INDEXED here, because
    // `writeTraitField` does not and the lookups later in this rebuild would not find it.
    if (!had) {
      writeTraitField(ecsId, eaMeta, 'guid', want);
      const e = findEntity(ecsId);
      if (e) indexEntityGuid(e);
    } else remap.set(had, want);
  }
  applyGuidRemap(remap);
}

/** Where each member of `rootInstanceId`'s instance tree sits when that is NOT where its own frame's
 *  TEMPLATE puts it — the guid that goes into `SceneMemberRow.parent` (Phase 3, #1468). Members that
 *  sit where their template says are absent, so the common case writes nothing.
 *
 *  ## ⚠️ Why a DIFF and not simply "the live parent, always"
 *
 *  Always-writing would be far simpler here — no document to consult, no frame to resolve — and it
 *  is WRONG, for the case § 3.3 R4 calls the most common template edit there is. A template that
 *  re-parents a member from A to B must move it in every instance that has not moved it itself. A
 *  stored `parent: <A's guid>` would pin the member under A for ever and silently defeat the edit;
 *  an absent `parent` lets it follow the template, which is what "the instance did not override
 *  this" has to mean. `parent` is an override, and an override is a diff.
 *
 *  ## What "where its template puts it" is
 *
 *  Per FRAME, because a member of an owned nested instance is placed by the CHILD document:
 *  `memberRowsIn` hands back the frame root and the member's localId in THAT frame's document, so
 *  the row's `EntityAttributes.parentId` names its template parent in the same localId space. A
 *  member the PREFAB ITSELF moves (#1437 P3-b) is at its base where the prefab put it, not where
 *  its row hangs — `prefabMoveTargets` answers that, and it is asked first for exactly that reason.
 *
 *  ⚠️ A frame whose document is not cached yields NO answer for its members, and they are then left
 *  alone rather than recorded as moved. Writing a `parent` for a member whose template position is
 *  unknown would turn a cache miss into a stored override nobody made. */
function memberRowParents(
  rootInstanceId: number,
  prefab: PrefabFile,
  /** The members to ask about, as ecsId → their localId in THIS document, when that is not the same
   *  question as "which members have a row here".
   *
   *  ⚠️ The two domains genuinely differ, and the difference is a FRAME. `memberRowsIn` follows
   *  IDENTITY, so an owned nested root dragged OUT of this instance into the one around it belongs
   *  to that outer frame and is absent here — correct for a row key, wrong for the capture, whose
   *  job is exactly to record that it left. `captureInstanceStructure` therefore passes its own
   *  `localToEcs` + `ownedByEcs`, which is every row this DOCUMENT declares, wherever it has been
   *  dragged to. */
  domain?: Map<number, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return out;
  const rows: Map<number, { frameRoot: number; rowLocalId: number }> = domain
    ? new Map([...domain].map(([ecsId, rowLocalId]) => [ecsId, { frameRoot: rootInstanceId, rowLocalId }]))
    : memberRowsIn(rootInstanceId);
  const guidOf = (id: number): string => durableGuid(readTraitData(id, eaMeta)?.guid as string | undefined);
  const liveParentGuid = (id: number): string => guidOf((readTraitData(id, eaMeta)?.parentId as number) || 0);

  // (frame, localId in that frame) → the live entity, inverted from the ONE walk rather than
  // rebuilt: a second index of "which entity is row L of frame F" is the mirror this module already
  // has three of.
  const atRowLocal = new Map<string, number>();
  for (const [id, at] of rows) atRowLocal.set(`${at.frameRoot}:${at.rowLocalId}`, id);
  // With an explicit domain the caller's own map is the index, and it already covers every row of
  // this document — including the ones `memberRowsIn` puts in another frame.
  if (domain) for (const [ecsId, rowLocalId] of domain) atRowLocal.set(`${rootInstanceId}:${rowLocalId}`, ecsId);

  const docOf = new Map<number, PrefabFile | null>();
  const parentLocalOf = new Map<number, Map<number, number>>();
  const moveBaseOf = new Map<number, (ecsId: number) => string>();
  const frame = (root: number): { doc: PrefabFile | null; parentLocal: Map<number, number>; base: (ecsId: number) => string } => {
    if (!docOf.has(root)) {
      const doc = root === rootInstanceId
        ? prefab
        : (expandedFrom?.get(root) ?? getCachedPrefabSync((readTraitData(root, piMeta)?.source as string) || '') ?? null);
      docOf.set(root, doc);
      const byLocal = new Map<number, number>();
      for (const pe of doc?.entities ?? []) {
        const ea = pe.traits['EntityAttributes'];
        byLocal.set(pe.localId, ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0);
      }
      parentLocalOf.set(root, byLocal);
      moveBaseOf.set(root, doc ? prefabMoveTargets(root, doc) : () => '');
    }
    return { doc: docOf.get(root) ?? null, parentLocal: parentLocalOf.get(root)!, base: moveBaseOf.get(root)! };
  };

  for (const [ecsId, at] of rows) {
    const live = liveParentGuid(ecsId);
    if (!live) continue;                                    // no parent, or one with no durable guid
    const f = frame(at.frameRoot);
    if (!f.doc) continue;                                   // template unknown — say nothing
    const base = f.base(ecsId);
    let home = base;
    if (!home) {
      const parentLocal = f.parentLocal.get(at.rowLocalId);
      if (parentLocal === undefined) continue;            // not a row of this document — say nothing
      // The frame's own root holds the document's `rootLocalId`, and a row directly under it names
      // that number; 0 is the root's own parent and never a member's.
      if (!parentLocal || parentLocal === (f.doc.rootLocalId ?? 1)) home = guidOf(at.frameRoot);
      else {
        const p = atRowLocal.get(`${at.frameRoot}:${parentLocal}`) ?? 0;
        // ⚠️ A row parent that is GONE from this instance — REMOVED by it, or UNPACKED so it is no
        // longer a member — leaves '' and the member counts as moved, because there is no template
        // position left for it to be sitting at. This is the case the deleted `PrefabInstance.homeSteps` existed
        // for: with identity derived, a vanished home had to be replaced by the steps it used to
        // contribute, or the member's path changed and so did its guid. With identity stored there
        // is no path to preserve, so the answer is simply "wherever it is now is an override".
        if (!p) home = '';
        else if (!(home = guidOf(p))) continue;           // present but not addressable — say nothing
      }
    }
    if (live !== home) out.set(ecsId, live);
  }
  return out;
}

export function captureInstanceMembers(rootInstanceId: number, prefab?: PrefabFile): Record<string, SceneMemberRow> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out: Record<string, SceneMemberRow> = {};
  if (!eaMeta) return out;
  // `memberRowsToWrite` is the shared predicate — keyed AND holding a durable guid to state. The two
  // stampers skip a member on the strength of a row existing for it, so "a row exists" has exactly
  // one spelling and this is a consumer of it rather than a second copy of the durability rule.
  const keyed = [...memberRowsToWrite(rootInstanceId)].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // ⚠️ Without the template there is no `parent`, and that is a CARRY, not a save: `rebuildInstance`
  // reads the rows off the live tree purely to put them back on the re-expanded one, and the moves
  // it must survive ride in the structure it re-applies. A save always has the document.
  const parents = prefab ? memberRowParents(rootInstanceId, prefab) : new Map<number, string>();
  for (const [ecsId, key] of keyed) {
    const ea = readTraitData(ecsId, eaMeta) as { guid?: string; name?: string } | null;
    const guid = durableGuid(ea?.guid);
    if (!guid) continue; // unreachable through `memberRowsToWrite`; kept so `guid` is a string here
    const parent = parents.get(ecsId);
    out[key] = { guid, ...(ea?.name ? { name: ea.name } : {}), ...(parent ? { parent } : {}) };
  }
  // R2 — rows the load could not match to any node the template still declares are written back
  // rather than dropped, so an undone template edit (or a re-import that matches again) restores
  // the scene's identity for that member. A live member always wins the key, so a row that comes
  // back stops being an orphan on the next load without anything here noticing.
  const rootGuid = durableGuid((readTraitData(rootInstanceId, eaMeta) as { guid?: string } | null)?.guid);
  for (const [key, row] of Object.entries(rootGuid ? keptMemberOrphans(rootGuid) ?? {} : {})) {
    if (!out[key]) out[key] = row;
  }
  return out;
}

export function captureInstanceOverrides(
  rootInstanceId: number,
  prefab: PrefabFile,
): Record<number, Record<string, Record<string, unknown>>> {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return {};

  const allTraits = getAllTraits();
  const result: Record<number, Record<string, Record<string, unknown>>> = {};
  const resolveBase = baseTokenResolver(rootInstanceId);

  // Which members sit somewhere their own template does not put them — the Transform exception
  // below, and the ONE question it needs answered.
  //
  // ⚠️ This read `PrefabInstance.homeParent` until Phase 3 (#1468), and the gate is the reason that
  // field was the riskiest thing in this phase to delete: `prefab.ts`'s own note on the gate says a
  // re-imported prefab whose base changed under an un-edited instance otherwise freezes spurious
  // overrides and *"breaks the instance (mesh collapses)"*. Asking the same question of the DOCUMENT
  // instead of a remembered guid is what makes the field retirable — `memberRowParents` already
  // computes exactly this for the save, base target (#1437 P3-b) included, so the gate and the
  // capture cannot drift into two answers.
  const domain = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const d = pi as Record<string, unknown>;
    if (d.rootInstanceId !== rootInstanceId || !d.localId || entity.id() === rootInstanceId) return;
    domain.set(entity.id(), d.localId as number);
  });
  const movedMembers = memberRowParents(rootInstanceId, prefab, domain);

  // Walk every entity that belongs to this instance via PrefabInstance.rootInstanceId
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;

    // Snapshot live trait data for comparison. Read what the trait PERSISTS (its
    // koota schema), exactly as serializeScene does — NOT the meta.fields subset.
    // AoS traits need it for their non-scalar fields (AnimationLibrary's
    // animSets/boneMaps, SkinnedMeshRenderer's materials, UIAction's onClickSet —
    // the bone-map-lost-on-save bug), and SoA traits need it too: a schema field
    // can be absent from meta.fields because a custom Inspector section owns it
    // (Animator.clips/clip) or it has no row at all (EntityAttributes.editorFolder),
    // and the curated read made those invisible to the diff, so a save dropped them.
    // runtimeOnly fields are excluded here — live read-back (Animator.activeClip,
    // SkeletalAnimator.time) must never be frozen into a file as an override, and
    // excluding it at the READ means no later path can resurrect it. Tags: the read
    // returns {} for a tag the entity has (null if absent), so an added tag shows up
    // as `{name: {}}`. See runtime/core/ecs/traitSchema.ts.
    const currentTraits = collectComparableTraits(entity.id(), allTraits);

    const diffs = getOverrideValues(localId, currentTraits, prefab, resolveBase);
    const markSet = getOverrideMarkSet(entity);

    // Mark-gate prefab-DEFINED field diffs. getOverrideValues reports every field
    // whose live value differs from the prefab base — but a divergence alone is NOT
    // an override: when a prefab is RE-IMPORTED and its base changes under an
    // un-edited instance (e.g. the FBX-wrapper bake rewriting root-bone scale/rot),
    // the instance's still-old values diverge from the new base and would be frozen
    // as spurious overrides, breaking the instance (mesh collapses) while a fresh
    // instance renders. A real override is one the user explicitly made, which is
    // recorded as a mark (inspector + gizmo edits mark; scene load re-seeds marks
    // from stored overrides). So drop a diverged field that carries no mark. Added
    // traits (prefab doesn't define them at this localId) are structural, not
    // base-relative field diffs, so they're kept regardless.
    //
    // EXCEPT the Transform of a member moved inside its instance (#1437): its local pose is relative to a
    // parent the prefab never gave it, so every field that differs from the base is part of the move, and
    // none of it needs a mark. Moved back home, the stamp is gone and the gate applies again, so a round
    // trip pins nothing.
    // A member at the place its PREFAB moves it to (P3-b) is at its base: not moved, for this purpose.
    const moved = movedMembers.has(entity.id());
    const prefabEntity = prefab.entities.find((e) => e.localId === localId);
    for (const [traitName, fields] of Object.entries(diffs)) {
      const prefabData = prefabEntity?.traits[traitName];
      if (prefabData === undefined || prefabData === true) continue; // added trait/tag — keep
      if (moved && traitName === 'Transform') continue;
      for (const field of Object.keys(fields)) {
        if (!markSet?.has(`${traitName}.${field}`)) delete (fields as Record<string, unknown>)[field];
      }
      if (Object.keys(fields).length === 0) delete diffs[traitName];
    }

    // Fold in EXPLICIT override marks whose value COINCIDES with the base (so the
    // value-diff above didn't report them) — e.g. after the base was edited to
    // match. A marked field is a recorded override; emit its current value.
    if (markSet) {
      for (const markKey of markSet) {
        const dot = markKey.indexOf('.');
        const traitName = markKey.slice(0, dot);
        const field = markKey.slice(dot + 1);
        if (traitName === 'PrefabInstance') continue;
        // A member's guid is per-instance identity, and since v16 it is a ROW (`captureInstanceMembers`)
        // — so it must be written in exactly one place. Emitting it here too would put the same value
        // in two channels with no rule for which wins, and an edit to one would be silently discarded
        // by the other on the next load. #1468 asked for this line to be reconciled; the reconciliation
        // is that it stays, with the reason upgraded from "it is nothing" to "it is a row".
        if (traitName === 'EntityAttributes' && field === 'guid') continue;
        if (diffs[traitName] && field in diffs[traitName]) continue; // already captured
        const cur = currentTraits[traitName]?.[field];
        if (cur === undefined) continue;
        (diffs[traitName] ??= {})[field] = cur;
      }
    }

    if (Object.keys(diffs).length > 0) {
      result[localId] = diffs;
    }
  });

  return result;
}

/** Apply a captured override map to a prefab instance, locating entities by
 *  matching `PrefabInstance.localId` within the same `rootInstanceId`. Silently
 *  skips entries whose localId/trait/field no longer exists in the live world. */
export function applyOverridesByRootInstance(
  rootInstanceId: number,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
): void {
  if (!overrides || Object.keys(overrides).length === 0) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Build localId → ecsId map for this instance
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });

  for (const [localIdStr, traitMap] of Object.entries(overrides)) {
    const localId = Number(localIdStr);
    const ecsId = localToEcs.get(localId);
    if (!ecsId) {
      console.debug(`[Prefab] override skipped: no entity for localId ${localId} in instance ${rootInstanceId}`);
      continue;
    }
    const member = findEntity(ecsId);
    if (!member) continue;
    for (const [traitName, fields] of Object.entries(traitMap)) {
      const meta = getTraitByName(traitName);
      if (!meta) {
        console.debug(`[Prefab] override skipped: unknown trait ${traitName}`);
        continue;
      }
      if (meta.category === 'tag') {
        // Added-tag override: ensure the tag is present on the instance. writeTraitField
        // adds the tag for a truthy value (field name is ignored for tags).
        writeTraitField(ecsId, meta, '', true);
        markOverride(member, traitName, '');
        continue;
      }
      // Accept any field the trait PERSISTS (its koota schema), so a re-apply keeps
      // an AoS trait's non-scalar fields AND a SoA field that has no Inspector row
      // (Animator.clips/clip, EntityAttributes.editorFolder). A field the schema does
      // not declare is still skipped — that's the stale/renamed case the old guard
      // wanted. See runtime/core/ecs/traitSchema.ts.
      const known: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        if (!isPersistentTraitField(meta, field)) {
          console.debug(`[Prefab] override skipped: unknown field ${traitName}.${field}`);
          continue;
        }
        known[field] = value;
      }
      const entity = member;
      if (!entity.has(meta.trait)) {
        // Added-trait override (root or child): the instance carries a trait the
        // prefab lacks at this localId. Add it whole so prefab refresh preserves it.
        entity.add(meta.trait(known));
      } else {
        for (const [field, value] of Object.entries(known)) {
          writeTraitField(ecsId, meta, field, value);
        }
      }
      // Seed explicit marks from the override map so these fields survive a later
      // serialize even if the prefab base is edited to coincide with them.
      for (const field of Object.keys(known)) markOverride(member, traitName, field);
    }
  }
}

// ── Structural Overrides (added/removed entities, removed traits) ──────

/** Result of comparing an instance's live tree against its prefab. `added` and
 *  `removed`/`removedTraits` are the structural diffs; `consumedEcsIds` are the
 *  live ECS ids folded into `added` (serialize skips them, as it skips members). */
export interface InstanceStructure {
  added: AddedEntity[];
  removed: number[];
  removedTraits: Record<number, string[]>;
  /** Members moved to another parent inside the instance (#1437): row localId → live parent guid. */
  moved: Record<number, string>;
  /** The subset of {@link moved} NO member row will carry — a member of a pre-v5 template (no key),
   *  or a keyed one with no durable guid (`memberRowsToWrite`). What a writer puts in the legacy
   *  `moved` map (#1468 Phase 3 close-out): a row is the only other place a move can go, and every
   *  prefab the released editor wrote is pre-v5, so dropping these lost the move on reload. */
  unrowed?: Record<number, string>;
  consumedEcsIds: Set<number>;
  /** ecsId → the nested-prefab ROW localId it is the expansion of, for the nested instances
   *  directly under this instance's members. This is the AUTHORITATIVE owned/independent split
   *  (#1354): `serializeScene` must route by this rather than re-testing `PrefabInstance.
   *  parentLocalId` itself, or the two disagree and an instance is written by neither — see the
   *  ⚠️ note on the partition in `captureInstanceStructure`. */
  ownedNested: Map<number, number>;
  /** For a REBUILD only (#1437, owner's B): moves inside owned nested instances to drop from, or set on, what
   *  the rebuild captures of them — keyed `~moved.<chain>:<lid>` (`nestedFrameMoves`). A revert drops the
   *  ones it reverts; its undo sets them back. */
  nestedMoves?: { drop?: string[]; set?: Record<string, string> };
}

/** The ONE compaction an added node's trait bag goes through (#1381 close-out): schema-default fields
 *  dropped, a runtime guid dropped, the live `parentId` dropped (#1377). Shared by the live capture
 *  (`snapshotAddedTraits`) and by `sameStructure`, which runs a FILE-authored bag through it so a
 *  legacy full bag compares equal to the compacted capture of the entity it spawns. Idempotent. */
function compactAddedTraitData(meta: TraitMeta, data: Record<string, unknown>): Record<string, unknown> {
  const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
  const soa = !!schema && typeof schema === 'object';
  const copy: Record<string, unknown> = {};
  // `writtenTraitKeys` (traitDefault.ts) is the SAME rule serialize.ts writes a top-level entity
  // with, and the one the committed-scene guard checks (#1412). Sharing it also closed a real gap:
  // this loop claimed to mirror serialize.ts but never skipped `runtimeOnly` fields.
  for (const key of writtenTraitKeys(soa ? schema! : null, data, meta.fields)) {
    // Skip a field still holding its schema default — the rule serialize.ts applies to a
    // top-level entity, which `snapshotAddedTraits`' note has always CLAIMED this mirrors and did not.
    //
    // Safe because an added child has NO prefab base to diff against: it is a whole new entity,
    // and `spawnNode` (loadSceneFile.ts) rebuilds it with `meta.trait(d)`, so koota refills
    // every absent key from the same schema this compared against. Round-trip identical.
    //
    // NOT the same thing as a member OVERRIDE, and the distinction is load-bearing:
    // `captureInstanceOverrides` diffs against the PREFAB's value, so overriding a prefab's
    // non-default back to the schema default is still written. Nothing here touches that path.
    //
    // Safe through PROMOTION too (`insertAddedSubtree` folds an added child into the prefab as
    // a member): `getOverrideValues` already reads an absent base field as the schema default
    // — see its own ⚠️ note — because prefab files already omit fields. So a compacted child
    // promoted into a prefab does not make every instance report a spurious override.
    //
    // Two exclusions carried over verbatim from serialize.ts. AoS traits (function schema) have
    // no per-key schema to compare against and stay FULL — that is the fidelity case
    // `snapshotAddedTraits`' note exists for (AudioSource.clips, SkinnedMeshRenderer.materials,
    // AnimationLibrary.animSets; the bone-map-lost-on-save bug). And an `entityId` field is
    // never skipped: a default entity reference is a meaningful value, not an absence.
    copy[key] = data[key];
  }
  // A runtime guid (#1210) is not a durable address — capture it as unguided, exactly as a
  // guid-less entity was: never an `added[].guid`, a `+added.<guid>` key, OR the copied trait's
  // own `guid` (the loop above already copied it, and the loader keeps a non-empty one).
  if (meta.name === 'EntityAttributes') {
    if (!durableGuid(data.guid as string)) delete copy.guid;
    // A LIVE ecs id (#1377) — recycled across sessions, so persisting it is save churn and a
    // `parentId` that reads as authoritative to the next reader. Nothing reads it back: an added
    // node is anchored by `parentLocalId` / its place in `children`, and both consumers
    // (`spawnNode` in loadSceneFile.ts, promotion's `insertAddedSubtree`) overwrite it. Explicit
    // because it is an `entityId` field, which the compaction loop above never skips.
    delete copy.parentId;
  }
  return copy;
}

/** Snapshot every trait on a live entity (full schema fidelity, like serialize),
 *  excluding PrefabInstance. Returns the trait bag + the entity's stable guid. */
function snapshotAddedTraits(ecsId: number): { bag: Record<string, Record<string, unknown> | boolean>; guid: string } {
  const bag: Record<string, Record<string, unknown> | boolean> = {};
  let guid = '';
  const entity = findEntity(ecsId);
  if (!entity) return { bag, guid };
  for (const meta of getAllTraits()) {
    if (meta.name === 'PrefabInstance') continue;
    if (!entity.has(meta.trait)) continue;
    if (meta.category === 'tag') { bag[meta.name] = true; continue; }
    const data = entity.get(meta.trait) as Record<string, unknown>;
    // Mirror serialize.ts EXACTLY: prefer the koota schema keys, else fall back to
    // the LIVE DATA keys (not the curated meta.fields). AoS traits (callback form,
    // e.g. UIAction, AudioSource, SkinnedMeshRenderer) expose a *function* schema and
    // carry non-scalar fields absent from meta.fields (AudioSource.clips,
    // SkinnedMeshRenderer.materials, AnimationLibrary.animSets) — using meta.fields
    // here would silently drop them on a user-ADDED prefab child, breaking the
    // "survives a save" guarantee. data-key fallback keeps full fidelity.
    const copy = compactAddedTraitData(meta, data);
    if (meta.name === 'EntityAttributes') guid = durableGuid(data.guid as string);
    bag[meta.name] = copy;
  }
  return { bag, guid };
}

/** Which document a structural capture is written INTO. */
export interface StructureCaptureOpts {
  /** TEMPLATE form (#1387): the capture is written into a prefab file, so an added node carries its
   *  template `key` and `guid: ''` — never the live guid, which every instance of the prefab would
   *  then spawn with. Default (scene form): the live durable guid, as a scene-authored node carries. */
  template?: boolean;
  /** SCENE FILE form (#1468 Phase 4): a user-added reference node's edits go onto its member rows
   *  (`moveChannelsOntoRows`). Set only by the scene writer — every other capture of a live instance
   *  is an in-memory TRANSPORT (a rebuild, Apply, Revert) whose consumers re-spawn from the localId
   *  channels against the same document, where a localId is a perfectly good address. Folding there
   *  handed the editor's reference-node spawn a node it could not read, and a rebuild lost the edits. */
  rows?: boolean;
}

/** An added node's identity in the document being written: the live durable guid (scene form), or
 *  the template key (template form). The key comes off the live marker; failing that it is RECOVERED
 *  from the node's derived guid (`recoverTemplateKey`); only a node that never came from a template
 *  gets a fresh one. Stamped either way, so the next template write of the same live entity writes the
 *  same key rather than churning it. */
function addedNodeIdentity(ecsId: number, template: boolean | undefined): { guid: string; key?: string } {
  if (!template) {
    const eaMeta = getTraitByName('EntityAttributes');
    return { guid: eaMeta ? durableGuid(readTraitData(ecsId, eaMeta)?.guid as string) : '' }; // #1210
  }
  const entity = findEntity(ecsId);
  let key = templateKeyOf(entity);
  if (!key) {
    key = recoverTemplateKey(ecsId) || newGuid();
    setTemplateKey(entity, key);
  }
  return { guid: '', key };
}

/** The template key a live added node had when it was spawned, recovered from its guid — for when
 *  the marker is gone (Play→Stop, delete→undo, a saved scene; #1387, #1426). The algorithm is the
 *  runtime's (`runtime/loaders/templateKeyRecovery.ts`), shared with the loader's heal; the editor's
 *  candidates are the keys its own prefab cache declares, which include a prefab being edited that no
 *  world ever expanded. `''` when nothing matches. */
function recoverTemplateKey(ecsId: number, memo = new Map<number, string>()): string {
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta) return '';
  const keys = new Set<string>();
  for (const doc of new Set(prefabCache.values())) for (const k of templateKeysOf(doc)) keys.add(k);
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  const nodeOf = (id: number): KeyRecoveryNode | undefined => {
    const ea = readTraitData(id, eaMeta);
    if (!ea) return undefined;
    const pi = piMeta ? readTraitData(id, piMeta) as { localId?: number; parentLocalId?: number } | null : null;
    // By IDENTITY, as the derive pass walked it (#1437): a member moved inside its instance steps from its
    // template parent (`identityParents.ts`).
    const at = pi ? (identity ??= worldIdentityParents(getCurrentWorld())).of(id) : { parentId: (ea.parentId as number) || 0, extra: [] };
    return { guid: durableGuid(ea.guid as string), parentId: at.parentId, key: templateKeyOf(findEntity(id)), pi, extra: at.extra };
  };
  return recoverKeyFrom(ecsId, nodeOf, keys, memo);
}

/** Compute the structural diff between a live prefab instance and its source:
 *  child entities the instance added, prefab members it deleted, and prefab
 *  components it removed from surviving members. (Added components are already
 *  captured as added-trait overrides by captureInstanceOverrides.) */
export function captureInstanceStructure(rootInstanceId: number, prefab: PrefabFile, opts: StructureCaptureOpts = {}): InstanceStructure {
  const empty: InstanceStructure = { added: [], removed: [], removedTraits: {}, moved: {}, consumedEcsIds: new Set(), ownedNested: new Map() };
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return empty;

  // Exclude Transient spawns (scrub/preview/play control-track prefabs, UIEntries pooled rows) AND
  // their subtree, so the structural-diff walk below never classifies one as a `userAdded` child and
  // bakes it into the instance's `added` overrides (review H2). Without this, a control-track prefab
  // spawned under an authored prefab-instance member would round-trip to disk via the
  // structural-capture pass, bypassing the top-level serialize filter. Shared with `serializeScene`,
  // `serializePrefab` and `collectInstanceRoots` — see `collectTransientSubtreeIds` for why the four
  // of them must answer this the same way (#1301/#1306).
  const allEntities = filterAuthoringVisible(getAllEntities());
  const byId = new Map<number, EntityInfo>();
  const childrenOf = new Map<number, EntityInfo[]>();
  for (const e of allEntities) {
    byId.set(e.id, e);
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e);
  }

  // Members of THIS instance: localId ↔ ecsId.
  const localToEcs = new Map<number, number>();
  const ecsToLocal = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;
    localToEcs.set(localId, entity.id());
    ecsToLocal.set(entity.id(), localId);
  });
  if (localToEcs.size === 0) return empty;

  const isMember = (ecsId: number) => ecsToLocal.has(ecsId);
  // Where each entity's TEMPLATE puts it (`identityParents.ts`) — asked for moves below.
  const identity = worldIdentityParents(getCurrentWorld());
  // A member of ANOTHER instance moved in here (#1437): its own instance records the move, so capturing it
  // as an added child too would spawn it twice.
  const movedIn = (ecsId: number) => !isMember(ecsId) && identity.moved(ecsId);
  // …and an OWNED nested root that another frame's row expanded, hanging here where that row puts it: a nested
  // row under a nested row (#1468 Phase 6 close-out). Its owner's prefab expands it; captured here too it came
  // back twice on reload.
  const foreignOwned = (ecsId: number): boolean => {
    const pi = readTraitData(ecsId, PrefabInstanceMeta) as MemberPi;
    if (!isOwnedRoot(pi, ecsId)) return false;
    const owner = identity.ownerOf(ecsId);
    // A stamp with no frame behind it (#1383's partial chain) belongs to nobody else: it stays what it was.
    return owner !== 0 && owner !== rootInstanceId;
  };
  // …and in a prefab-edit world, a ROW of the edited prefab that its own move placed under one of ours: it is
  // written as that prefab's row, not captured as something added here.
  const editRow = (ecsId: number) => isPrefabEditRowGuid(byId.get(ecsId)?.guid);
  // Classify a non-member child that is a self-rooted prefab instance (a NESTED
  // instance hanging under one of our members):
  //  - 'owned'     — it expanded from THIS prefab's own definition (its
  //                  PrefabInstance.parentLocalId is set). It round-trips via the
  //                  prefab row / nestedOverrides; capturing it as `added` here
  //                  would double-count it (re-spawn members on the expanded child).
  //  - 'userAdded' — the user dragged it in (parentLocalId 0 — it did NOT come from
  //                  the prefab definition). Captured as a reference `added` node so
  //                  it round-trips under its EXACT parent member rather than being
  //                  dropped / re-anchored to scene root.
  //  - 'none'      — not a nested-instance root (an ordinary added entity).
  // ⚠️ This is a PARTITION over the rows, not a per-node test (#1354). A nested prefab row expands
  // to EXACTLY ONE instance, so each row is claimed at most once and every other instance at that
  // anchor is independent ('userAdded'). The old code answered per node against a `Set` of
  // "<member>:<source>" keys, which any number of nodes could match: a duplicated nested root and a
  // user-added instance under a member that already owned a row of that prefab both came back
  // 'owned', both serialized into the one row's `nestedOverrides`, and the later one won — the other
  // was silently lost on reload. Claiming per row is what makes that unrepresentable, and it is also
  // what makes the row path a sound key for the scene-side structure slot (#1358).
  //
  // Owned nested rows declared by THIS prefab, grouped by anchor member + source. A prefab may nest
  // the SAME source twice under one member, so each key holds a LIST of row localIds.
  const rowsByAnchor = new Map<string, number[]>();
  for (const pe of prefab.entities) {
    if (!pe.prefab) continue;
    const ea = pe.traits['EntityAttributes'];
    const memberLocal = ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0;
    const key = `${memberLocal}:${pe.prefab}`;
    const rows = rowsByAnchor.get(key);
    if (rows) rows.push(pe.localId);
    else rowsByAnchor.set(key, [pe.localId]);
  }
  // Every self-rooted prefab instance hanging DIRECTLY under a member of this instance — the only
  // place a row of this prefab can expand. Sorted by ecsId so the assignment below is deterministic
  // rather than dependent on world-query order.
  // A nested root MOVED inside this instance is looked for under its TEMPLATE parent, where its row is (#1437).
  const identityChildrenOf = new Map<number, EntityInfo[]>();
  for (const e of allEntities) {
    const parent = (e.traits.includes('PrefabInstance') && identity.parentOf(e.id)) || e.parentId;
    if (!identityChildrenOf.has(parent)) identityChildrenOf.set(parent, []);
    identityChildrenOf.get(parent)!.push(e);
  }
  const nestedCandidates: { ecsId: number; key: string; stamp: number }[] = [];
  // The anchors a row of this prefab can expand under: every member, and — for a nested row under a nested row
  // (#1468 Phase 6 close-out) — every nested root this instance OWNS, standing for the row that expanded it.
  // Only a candidate this instance owns is taken from under one: that root's own nested rows are its frame's.
  // (Defensive: a root of the nested frame could only claim one of OUR rows by sharing its stamp and source
  // AND anchor — the shape where path-derived identity already gives the two roots one guid, which no row
  // capture can repair. So no test can reach this line and keep the guids apart; it is kept for the claim.)
  const anchors: Array<[number, number, boolean]> = [...ecsToLocal].map(([ecs, lid]) => [ecs, lid, false]);
  for (const e of allEntities) {
    const pi = e.traits.includes('PrefabInstance') ? readTraitData(e.id, PrefabInstanceMeta) as MemberPi : null;
    if (isOwnedRoot(pi, e.id) && identity.ownerOf(e.id) === rootInstanceId) anchors.push([e.id, pi!.parentLocalId!, true]);
  }
  for (const [memberEcs, memberLocal, nestedAnchor] of anchors) {
    for (const child of identityChildrenOf.get(memberEcs) || []) {
      if (nestedAnchor && identity.ownerOf(child.id) !== rootInstanceId) continue;
      if (!child.traits.includes('PrefabInstance')) continue;
      const pi = readTraitData(child.id, PrefabInstanceMeta);
      if (!pi || pi.rootInstanceId !== child.id) continue;
      // Its template parent is a row this instance removed: that row is still the one it anchors at.
      const steps = identity.of(child.id).extra;
      nestedCandidates.push({
        ecsId: child.id,
        key: `${steps.length ? steps[steps.length - 1] : memberLocal}:${(pi.source as string) || ''}`,
        stamp: (pi.parentLocalId as number) || 0,
      });
    }
  }
  nestedCandidates.sort((a, b) => a.ecsId - b.ecsId);
  /** ecsId → the row localId it is the expansion of. Absent ⇒ independent. */
  const ownedByEcs = new Map<number, number>();
  const claimedRows = new Set<number>();
  // The one claim pass — an exact stamp claims its own row, first by ecsId when two carry the same
  // one. The stamp is what every row expansion writes (see below), so it is the whole signal.
  //
  // A stamp naming a row that is NOT at this candidate's anchor is not honoured — the row it names
  // expands under a different member, so this instance cannot be that row's expansion.
  // ⚠️ This is a consistency property, NOT a repaired symptom, and the distinction is worth keeping
  // straight: the stamp is written at load from the row itself, and `reparentEntity` UNPACKS an owned
  // nested root rather than relocating it stamped, so I could not reach a foreign-anchor stamp from
  // the editor. It stays because `nestedRowPresent` now reads this same map: honouring such a stamp
  // would report a row as present while nothing sits under its actual parent member, suppressing a
  // legitimate `removed`.
  for (const c of nestedCandidates) {
    if (!c.stamp || claimedRows.has(c.stamp)) continue;
    if (!rowsByAnchor.get(c.key)?.includes(c.stamp)) continue;
    claimedRows.add(c.stamp);
    ownedByEcs.set(c.ecsId, c.stamp);
  }
  // ⚠️ There is NO pass for an UNSTAMPED instance, and there must not be (#1367). Every path that
  // expands a row stamps it — the loader (`instantiatePrefabIntoWorld`), the editor's
  // `instantiatePrefab`, and Create Prefab's tag — so a live unstamped instance is never a row's own
  // expansion: it is one the user dragged in, a duplicate (`clearOwnedNestedStampFromSnapshot`), or
  // an unlinked root. A second pass once let such an instance claim a free row; it took a user-added
  // instance to BE a deleted row's expansion, so a no-op save dropped the user's addition AND
  // resurrected the row. A root guid cannot discriminate either: a nested root's derived guid is
  // itself computed from this stamp (`memberStepId`). Pinned by the stamp-invariant test.
  const nestedRootKind = (ecsId: number): 'owned' | 'userAdded' | 'none' => {
    const info = byId.get(ecsId);
    if (!info?.traits.includes('PrefabInstance')) return 'none';
    const pi = readTraitData(ecsId, PrefabInstanceMeta);
    if (!pi || pi.rootInstanceId !== ecsId) return 'none';
    // A nested root deeper than a member (under a plain added node) is never a candidate above, so
    // it cannot be a row of THIS prefab — 'userAdded' captures it instead of dropping it.
    return ownedByEcs.has(ecsId) ? 'owned' : 'userAdded';
  };

  // ── removed entities (prefab members with no live counterpart), top-most only ──
  const prefabParent = new Map<number, number>();
  const prefabTraitsByLocal = new Map<number, string[]>();
  for (const pe of prefab.entities) {
    const ea = pe.traits['EntityAttributes'];
    const parent = ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0;
    prefabParent.set(pe.localId, parent);
    prefabTraitsByLocal.set(pe.localId, Object.keys(pe.traits));
  }
  // A nested-prefab row (`pe.prefab`) expands into its OWN foreign-instance root, which is never a
  // direct member of THIS instance, so `localToEcs` cannot answer for it. Reading its absence from
  // there falsely stripped the nested instance on every re-serialize (the bug that detached the
  // spaceship's engine flames to scene root), so the row is looked for where it expands. Skipping
  // nested rows outright instead meant an owned nested instance that was deleted, or moved out,
  // re-expanded on reload beside its moved copy — two entities per guid (#1355).
  //
  // Present ⇔ CLAIMED — the same assignment `nestedRootKind` reads, so "is this row still here" and
  // "is this instance that row" cannot disagree. Strict on purpose, and only sound together with the
  // strict partition above (#1367): an unstamped instance is independent there, so it is captured as
  // an `added[]` reference node, and the row it might have been is written to `removed[]` here.
  // Leniency for an unstamped instance at the anchor (#1354's F4) kept the row alive beside that
  // reference node — the resurrected half of #1367. Still present: a row whose prefab is not cached
  // (it expanded to nothing, which is not a removal), one whose parent member is gone (its own
  // removal covers it), and one with no localId (unaddressable by `removed[]`).
  const nestedRowPresent = (pe: PrefabFile['entities'][number]): boolean => {
    const parentLocal = prefabParent.get(pe.localId) ?? 0;
    const parentMember = localToEcs.get(parentLocal);
    if (!pe.localId || !parentMember || !getCachedPrefabSync(pe.prefab!)) return true;
    return claimedRows.has(pe.localId);
  };
  const removedSet = new Set<number>();
  for (const pe of prefab.entities) {
    if (pe.prefab ? !nestedRowPresent(pe) : !localToEcs.has(pe.localId)) removedSet.add(pe.localId);
  }
  const removed: number[] = [];
  for (const lid of removedSet) if (!removedSet.has(prefabParent.get(lid) ?? 0)) removed.push(lid);
  removed.sort((a, b) => a - b);

  // ── removed components on surviving members ──
  const removedTraits: Record<number, string[]> = {};
  for (const [localId, ecsId] of localToEcs) {
    const info = byId.get(ecsId);
    if (!info) continue;
    const gone = (prefabTraitsByLocal.get(localId) || [])
      .filter((n) => n !== 'PrefabInstance' && !info.traits.includes(n));
    if (gone.length) removedTraits[localId] = gone;
  }

  // ── moved members: linked, but under a parent other than their row's (#1437) ──
  // ⚠️ Phase 3 (#1468) made this a DIFF AGAINST THE TEMPLATE, computed by `memberRowParents`, where
  // it used to be read off `PrefabInstance.homeParent` — the guid a member remembered at the moment
  // it was dragged. That field existed only because a member's identity was derived from where it
  // sat, so a move had to be un-done before every identity walk; with identity stored, "has this
  // member moved" is answerable from the document and the live parent alone, and nothing has to be
  // remembered. Same answer, one less thing that can go stale. (Phase 6 then retired the fields'
  // other two roles the same way — `identityParents.ts` — and deleted them.)
  //
  // A TEMPLATE capture (a prefab written from a live tree) still records none: its values would be
  // live scene guids, which name nothing in the prefab's own space — nor, in another instance,
  // anything of that instance.
  //
  // ⚠️ This map is a VIEW of the moves, and the file writes only part of it: a member with a row
  // carries its move as `parent`, and only `unrowed` — the moves no row will carry — goes to the
  // legacy `moved` map. What consumes the whole map is the rebuild transport and Apply to Prefab /
  // Revert — in-memory, against this one document, where a localId is a sound address (#1468 Phase 4
  // kept it: only the seams where a localId crosses to ANOTHER document were changed).
  const moved: Record<number, string> = {};
  const rowParents = opts.template
    ? new Map<number, string>()
    : memberRowParents(rootInstanceId, prefab, new Map<number, number>([
      ...[...localToEcs].filter(([, ecsId]) => ecsId !== rootInstanceId).map(([lid, ecsId]) => [ecsId, lid] as [number, number]),
      ...ownedByEcs,
    ]));
  // Asked of the root whose save WRITES the rows, not of this one: a nested capture's own key space
  // can name a member the writer's cannot (`rowWritingRoot`).
  const rowed = opts.template ? new Map<number, string>() : memberRowsToWrite(rowWritingRoot(rootInstanceId));
  const unrowed: Record<number, string> = {};
  const noteMove = (ecsId: number, rowLocal: number): void => {
    const to = rowParents.get(ecsId);
    if (!to) return;
    moved[rowLocal] = to;
    if (!rowed.has(ecsId)) unrowed[rowLocal] = to;
  };
  for (const [localId, ecsId] of localToEcs) if (ecsId !== rootInstanceId) noteMove(ecsId, localId);
  for (const [ecsId, rowLocal] of ownedByEcs) noteMove(ecsId, rowLocal);

  // ── added entities: non-member descendants of each member ──
  const consumedEcsIds = new Set<number>();

  // A user-added nested instance → reference node (its source + per-instance diffs).
  // Recursion is via captureInstanceReference → captureInstanceStructure, which
  // captures any user-added instances nested deeper inside it.
  const captureNestedRef = (ecsId: number, parentLocalId: number): AddedEntity | null => {
    const pi = readTraitData(ecsId, PrefabInstanceMeta);
    const source = pi?.source as string | undefined;
    if (!source) return null;
    const childPrefab = getCachedPrefabSync(source);
    if (!childPrefab) {
      console.warn(`[Prefab] user-added nested instance "${source}" not cached; exact placement not captured`);
      return null;
    }
    const ref = captureInstanceReference(ecsId, source, childPrefab, opts);
    for (const m of ref.memberEcsIds) consumedEcsIds.add(m);
    for (const c of ref.consumedEcsIds) consumedEcsIds.add(c);
    // The node is the OUTERMOST layer for its own nested rows, so it carries their scene edits itself
    // — the same two channels a top-level entry carries (#1369). Without them an edit inside a row
    // expansion of a DRAGGED-IN prefab was captured by nothing and came back on reload.
    const channels = captureNestedChannels(source, ref.ownedNested, { template: opts.template, rows: opts.rows });
    for (const c of channels.consumedEcsIds) consumedEcsIds.add(c);
    const node = {
      parentLocalId, ...addedNodeIdentity(ecsId, opts.template), name: byId.get(ecsId)?.name || '', traits: {}, children: [],
      prefab: source,
      overrides: ref.overrides, added: ref.added, removed: ref.removed, removedTraits: ref.removedTraits, moved: ref.moved,
      nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure,
    };
    // A reference node IS an instance, so it carries its members' identity like any other (v16,
    // #1468) — and since Phase 4 the edits its rows can key — but NEVER into a prefab TEMPLATE, where
    // per-instance guids would be handed to every instance at once (#1293), and whose frozen format has
    // no rows to put an edit on. `opts.template` is the flag the rest of this capture uses to tell the
    // two documents apart.
    if (!opts.rows || opts.template) {
      const members = opts.template ? {} : captureInstanceMembers(ecsId, childPrefab);
      return { ...node, ...(Object.keys(members).length ? { members } : {}) };
    }
    const moved = moveChannelsOntoRows(ecsId, childPrefab, source, node, captureInstanceMembers(ecsId, childPrefab), channels.frames);
    const nonEmpty = <T,>(v: T | undefined): T | undefined =>
      v === undefined || (Array.isArray(v) ? v.length : Object.keys(v as object).length) ? v : undefined;
    return {
      ...node,
      overrides: nonEmpty(moved.channels.overrides), added: nonEmpty(moved.channels.added),
      removed: nonEmpty(moved.channels.removed), removedTraits: nonEmpty(moved.channels.removedTraits),
      nestedOverrides: nonEmpty(moved.channels.nestedOverrides), nestedStructure: nonEmpty(moved.channels.nestedStructure),
      ...(Object.keys(moved.members).length ? { members: moved.members } : {}),
    };
  };

  // Capture one non-member child as an AddedEntity (plain subtree OR nested-instance
  // reference), or null if it should be skipped (owned nested instance).
  const captureChild = (childEcsId: number, parentLocalId: number): AddedEntity | null => {
    const kind = nestedRootKind(childEcsId);
    if (kind === 'owned') return null;                  // round-trips via the prefab/nestedOverrides
    if (kind === 'userAdded') return captureNestedRef(childEcsId, parentLocalId);
    return snapshotSubtree(childEcsId, parentLocalId);
  };

  function snapshotSubtree(ecsId: number, parentLocalId: number): AddedEntity {
    consumedEcsIds.add(ecsId);
    const { bag, guid } = snapshotAddedTraits(ecsId);
    // The bag's own copy of the guid goes with the node's: a template node's identity is its key.
    const ea = bag['EntityAttributes'];
    if (opts.template && ea && ea !== true) delete ea.guid;
    const children: AddedEntity[] = [];
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id) || movedIn(child.id) || foreignOwned(child.id) || editRow(child.id)) continue;
      const node = captureChild(child.id, 0); // child of a plain added node → tree-shape parent
      if (node) children.push(node);
    }
    // Scene form keeps the snapshot's own guid; template form takes the key (#1387).
    const identity = opts.template ? addedNodeIdentity(ecsId, true) : { guid };
    return { parentLocalId, ...identity, name: byId.get(ecsId)?.name || '', traits: bag, children };
  }

  const added: AddedEntity[] = [];
  for (const [ecsId, localId] of ecsToLocal) {
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id) || movedIn(child.id) || foreignOwned(child.id) || editRow(child.id)) continue;
      const node = captureChild(child.id, localId);
      if (node) added.push(node);
    }
  }

  return { added, removed, removedTraits, moved, unrowed, consumedEcsIds, ownedNested: ownedByEcs };
}

// ── Scene-level nested channels (moved from serialize.ts for #1369, so captureNestedRef can reach them) ──

/** Capture a nested instance's SCENE-specific override delta: its full per-localId
 *  override (vs the child prefab base) minus the fields the parent prefab's own
 *  nested row already overrides. So the scene stores only what it uniquely changed
 *  on this nested instance — the row's own overrides (e.g. the flames' mirrored
 *  positions) stay owned by the parent prefab and aren't redundantly baked in. */
export function captureNestedSceneDelta(
  nestedRootId: number,
  childPrefab: PrefabFile,
  rowOverrides: Record<number, Record<string, Record<string, unknown>>> | undefined,
): Record<number, Record<string, Record<string, unknown>>> {
  const all = captureInstanceOverrides(nestedRootId, childPrefab);
  for (const [lidStr, traits] of Object.entries(all)) {
    const lid = Number(lidStr);
    // A nested instance's member guids are regenerated from the prefab chain each
    // load — never scene-authored — so drop them; otherwise the serialize guid
    // pre-pass makes every nested member look "overridden".
    if (traits.EntityAttributes) delete (traits.EntityAttributes as Record<string, unknown>).guid;
    const rowTraits = rowOverrides?.[lid];
    for (const [traitName, fields] of Object.entries(traits)) {
      const rowFields = rowTraits?.[traitName];
      // `hasDocKey` (#986): `f` and `rowFields` both derive from scene/prefab JSON, so a
      // prototype-named field tested TRUE against any rowFields object and was wrongly
      // deleted from the serialized output.
      if (rowFields) for (const f of Object.keys(fields)) if (hasDocKey(rowFields, f)) delete fields[f];
      if (Object.keys(fields).length === 0) delete traits[traitName];
    }
    if (Object.keys(traits).length === 0) delete all[lid];
  }
  return all;
}

/** The override map the PREFAB FILES alone would apply to a nested instance reached
 *  by `path` (a chain of nested-row localIds) from a fresh instantiation of
 *  `topSource` — i.e. every ancestor prefab row's own overrides + deep overrides
 *  targeting it, resolved outside-in exactly like the runtime. Subtracted from the
 *  live capture so the scene stores only the delta IT uniquely changed (and an
 *  intermediate prefab change still propagates). All path prefabs must be cached. */
export function resolveEffectivePrefabOverride(
  topSource: string | PrefabFile,
  path: number[],
): Record<number, Record<string, Record<string, unknown>>> {
  // A DOCUMENT names the top level directly: a refresh resolves against the file the live tree was
  // expanded from, which the cache no longer holds (#1401).
  let prefab: PrefabFile | null = typeof topSource === 'string' ? getCachedPrefabSync(topSource) : topSource;
  let pending: NestedOverridePaths | undefined;
  let result: Record<number, Record<string, Record<string, unknown>>> = {};
  for (let i = 0; i < path.length; i++) {
    if (!prefab) return result;
    const r = path[i];
    const row = prefab.entities.find((e) => e.localId === r && e.prefab);
    if (!row) return result;
    const { direct, forward } = descendNestedOverrides(pending, r);
    const stepDirect = direct ? mergeOverrideMaps(row.overrides, direct) : (row.overrides ?? {});
    pending = mergeNestedOverridePaths(row.nestedOverrides, forward);
    if (i === path.length - 1) result = stepDirect;
    prefab = getCachedPrefabSync(row.prefab!);
  }
  return result;
}

/** The structural lists the PREFAB CHAIN itself already applies to the nested instance at `path` —
 *  the structural twin of `resolveEffectivePrefabOverride`, walking the same rows in the same order
 *  (#1358).
 *
 *  Used as the baseline to diff a captured interior against: the scene writes `nestedStructure` only
 *  where the live interior differs from what the prefabs already produce, so an intermediate prefab
 *  gaining a member still propagates into every instance instead of being frozen out by a scene that
 *  restated the old list. */
function resolveEffectivePrefabStructure(
  topSource: string | PrefabFile,
  path: number[],
): { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> } {
  // The path-keyed descend, exactly as `resolveEffectivePrefabOverride` walks it (#1381). A prefab
  // ROW can carry `nestedStructure` (promotion writes a reference node's slot into it, and a
  // prefab-edit save captures one), so an intermediate row can own the interior of an instance
  // deeper on the path. Without this the baseline read the innermost row's own lists: a scene that
  // un-deleted a member the row's structure deleted captured an interior equal to that stale
  // baseline, wrote nothing, and the member was deleted again on the next load.
  //
  // (Before #1381 only a scene capture wrote the slot, so this descend had no producer and was
  // removed as dead code — correctly at the time. It returned with its producer.)
  let prefab: PrefabFile | null = typeof topSource === 'string' ? getCachedPrefabSync(topSource) : topSource;
  let pending: NestedStructurePaths | undefined;
  let result: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> } = {};
  for (let i = 0; i < path.length; i++) {
    if (!prefab) return result;
    const row = prefab.entities.find((e) => e.localId === path[i] && e.prefab);
    if (!row) return result;
    const { direct, forward } = descendPathKeyed(pending, path[i]!);
    if (i === path.length - 1) {
      // An outer row addressing this path OWNS the interior — all three lists, absent read as empty
      // (the loader's `structDirect` rule).
      result = direct
        ? { added: direct.added ?? [], removed: direct.removed ?? [], removedTraits: direct.removedTraits ?? {}, moved: direct.moved ?? {} }
        : { added: row.added, removed: row.removed, removedTraits: row.removedTraits };
    }
    pending = mergeNestedStructurePaths(row.nestedStructure, forward);
    prefab = getCachedPrefabSync(row.prefab!);
  }
  return result;
}

/** Do two structural deltas state the same interior? (the row writer's `omitUnchanged` test, #1381)
 *
 *  Compared by a canonical form, because the two sides are the same CONTENT written by different
 *  hands: absent and empty lists are one statement; `removed` and `added` are sets (the capture
 *  writes `added` in anchor order, a hand-authored file in any order); and a file-authored trait bag
 *  is run through the capture's own compaction (`compactAddedTraitData`), so a legacy FULL bag
 *  matches the compacted capture of the entity it spawns. Anything still different writes the path,
 *  which is the safe direction.
 *
 *  Node IDENTITY (`key`, `guid`) is compared only when both sides key every node (#1387). A file written
 *  before keys existed has none — a guid-less node, or one carrying the durable guid #1387 is about —
 *  while the capture writes a key and `guid: ''` for each live node. That file's untouched interior is
 *  still unchanged content, and pinning it into the OUTER row on a no-op save is the #1381 defect over
 *  again. It migrates when its OWN prefab is re-saved, which writes the keys there. */
function sameStructure(
  a: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
  b: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  // Sorted BY their JSON but kept as values: nesting the JSON strings themselves re-escaped every level's
  // quotes inside its parent's, so the text doubled per level of `children` (measured 1.4 s at 22 deep,
  // out of memory at 24 — #1352 close-out).
  const asSet = (items: unknown[]): unknown[] => items
    .map((x) => [JSON.stringify(x), x] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, x]) => x);
  const withoutBagGuid = (traits: Record<string, unknown>): Record<string, unknown> => {
    const ea = traits['EntityAttributes'];
    if (!ea || typeof ea !== 'object' || !('guid' in ea)) return traits;
    const { guid: _drop, ...rest } = ea as Record<string, unknown>;
    return { ...traits, EntityAttributes: rest };
  };
  const allKeyed = (nodes: AddedEntity[] | undefined): boolean =>
    (nodes ?? []).every((n) => !!n.key && allKeyed(n.children) && allKeyed(n.added));
  const withKeys = allKeyed(a.added) && allKeyed(b.added);
  const node = (n: AddedEntity): unknown => {
    const traits: Record<string, unknown> = {};
    for (const [name, data] of Object.entries(n.traits ?? {})) {
      const meta = getTraitByName(name);
      traits[name] = data === true || !meta ? data : compactAddedTraitData(meta, data as Record<string, unknown>);
    }
    const { key, guid, ...rest } = n;
    return canon({
      ...rest, ...(withKeys ? { key, guid } : {}), traits: withKeys ? traits : withoutBagGuid(traits),
      children: asSet((n.children ?? []).map(node)),
      ...(n.added ? { added: asSet(n.added.map(node)) } : {}),
    });
  };
  const norm = (d: typeof a) => JSON.stringify(canon({
    added: asSet((d.added ?? []).map(node)),
    removed: [...(d.removed ?? [])].sort((x, y) => x - y),
    removedTraits: Object.fromEntries(Object.entries(d.removedTraits ?? {})
      .filter(([, names]) => names.length).map(([k, names]) => [k, [...names].sort()])),
    moved: d.moved ?? {},
  }));
  return norm(a) === norm(b);
}

/** Does this structural delta state nothing at all? */
function emptyStructure(
  v: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
): boolean {
  return !v.added?.length && !v.removed?.length && !Object.keys(v.removedTraits ?? {}).length && !Object.keys(v.moved ?? {}).length;
}

/** The SCENE-level nested channels of one instance — `nestedOverrides` and `nestedStructure`, both
 *  path-keyed from `source` — captured by walking its owned nested instances top-down (#1369).
 *
 *  ONE walk for every instance that owns a scene-side slot: a top-level instance (`serializeScene`)
 *  and a user-added nested instance written as a reference node (`captureNestedRef`). Each is the
 *  outermost layer for everything under it. The walk used to live in `serializeScene` only, resolving
 *  each owned nested instance UP to a top-level root, so a chain passing through a reference node
 *  resolved to nothing and every edit beneath it was dropped on save — value and structure alike.
 *
 *  `ownedNested` is `captureInstanceStructure(root).ownedNested` — the row partition — and each level
 *  descends through that level's own partition, so "which instance is row N's expansion" is answered
 *  by exactly one rule at every depth. Paths are written in sorted order so the saved key order does
 *  not depend on ECS ids. All prefabs along the paths must be cached (`serializeScene` preloads them). */
export function captureNestedChannels(
  source: string,
  ownedNested: ReadonlyMap<number, number>,
  opts: {
    /** The PREFAB-ROW writer's rule (#1381): also omit a path whose live interior EQUALS what the
     *  prefab chain already applies. A scene keeps the restate-when-non-empty rule below; a row must
     *  not, or a no-op prefab-edit save pins the inner prefab's own authored structure into the outer
     *  file and a later edit to the inner prefab stops reaching any instance of the outer one.
     *  Sound for a row, where #1358 found it unsound for a scene, because both sides are now the same
     *  document: file-authored `added` nodes are written by this same compacting capture, and the
     *  live `parentId` that made them differ is no longer captured (#1377). A mismatch still writes,
     *  which is the conservative direction. */
    omitUnchanged?: boolean;
    /** Capture each interior in TEMPLATE form (`StructureCaptureOpts`) — set by a prefab-file writer. */
    template?: boolean;
    /** Capture each interior in SCENE FILE form (`StructureCaptureOpts.rows`) — set by the scene writer. */
    rows?: boolean;
    /** With `omitUnchanged`: DEFER the omission — keep every path, and record the baseline it would
     *  have been compared against. `serializePrefab` compares after rewriting refs into member tokens
     *  (#1352): a live bag holds guids where the file holds tokens, so an early compare always differed
     *  and pinned the interior. */
    baselinesOut?: Map<string, InstanceStructureData>;
  } = {},
): {
  nestedOverrides?: NestedOverridePaths; nestedStructure?: NestedStructurePaths; consumedEcsIds: Set<number>;
  /** Every live entity the owned nested instances ARE, at every depth — each root and its members.
   *  A flat writer skips these, since the owner's row re-expands them (#1382). */
  ownedMemberEcsIds: Set<number>;
  /** Path key → the live nested root that path addresses (and the path itself, as the walk built it),
   *  for every path this walk could capture — what `moveChannelsOntoRows` needs to turn a path-keyed
   *  entry into member rows (#1468 Phase 4). */
  frames: Map<string, { root: number; path: number[] }>;
} {
  const frames = new Map<string, { root: number; path: number[] }>();
  const consumedEcsIds = new Set<number>();
  const ownedMemberEcsIds = new Set<number>();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { consumedEcsIds, ownedMemberEcsIds, frames };
  let membersByRoot: Map<number, number[]> | undefined;
  const membersOf = (rootId: number): number[] => {
    if (!membersByRoot) {
      const byRoot = new Map<number, number[]>();
      getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
        const r = (pi as Record<string, unknown>).rootInstanceId as number;
        if (!r) return;
        const list = byRoot.get(r);
        if (list) list.push(entity.id());
        else byRoot.set(r, [entity.id()]);
      });
      membersByRoot = byRoot;
    }
    return membersByRoot.get(rootId) ?? [];
  };
  const overrides = new Map<string, Record<number, Record<string, Record<string, unknown>>>>();
  const structures = new Map<string, NestedStructurePaths[string]>();
  const order: number[][] = [];
  const walk = (owned: ReadonlyMap<number, number>, path: number[]) => {
    for (const [ecsId, rowLocalId] of owned) {
      const childSource = readTraitData(ecsId, PrefabInstanceMeta)?.source as string | undefined;
      const childPrefab = childSource ? getCachedPrefabSync(childSource) : undefined;
      ownedMemberEcsIds.add(ecsId);
      for (const m of membersOf(ecsId)) ownedMemberEcsIds.add(m);
      if (!childPrefab) {
        // The instance still re-expands from its owner's row (that row names ITS prefab, not this
        // one), so it stays skipped — but its interior cannot be captured, so skip that too rather
        // than let an added child fall out as a root row (#1381 review). Dropped with a warning, the
        // `captureNestedRef` precedent; every caller warms the cache first (#1295).
        const all = getAllEntities();
        const lost = collectSubtreeIds(all.map((e) => [e.id, e.parentId] as const), [ecsId]);
        for (const id of lost) ownedMemberEcsIds.add(id);
        // Count only what the USER added: an entity with no PrefabInstance, or a user-added (unstamped)
        // instance root. Members of the uncached prefab's own nested rows re-expand from it, and a
        // Transient spawn is never authored (review of the first cut: both inflated the count).
        const authored = new Set(filterAuthoringVisible(all).map((e) => e.id));
        const extra = lost.filter((id) => {
          if (id === ecsId || !authored.has(id)) return false;
          const pi = readTraitData(id, PrefabInstanceMeta);
          return !pi || isStoredRoot(pi, id);
        });
        if (extra.length) console.warn(`[Prefab] nested prefab "${childSource}" not cached; ${extra.length} entit${extra.length === 1 ? 'y' : 'ies'} added inside it not captured`);
        continue;
      }
      const at = [...path, rowLocalId];
      const key = nestedPathKey(at);
      frames.set(key, { root: ecsId, path: at });
      order.push(at);
      // Subtract what the whole prefab chain applies to this instance (not just the immediate row)
      // so a deep scene edit stores only its own delta.
      const delta = captureNestedSceneDelta(ecsId, childPrefab, resolveEffectivePrefabOverride(source, at));
      if (Object.keys(delta).length > 0) overrides.set(key, delta);
      // The STRUCTURAL interior (#1358). Skipped ONLY when the live interior and the prefab chain's
      // own are both empty — the common case, and the one that must stay absent so a member added to
      // the inner prefab later still reaches an untouched instance. Otherwise all three lists are
      // written VERBATIM, empty arrays included, because once the scene addresses a path it OWNS the
      // interior: comparing against the file-authored baseline field by field was wrong twice over
      // (the two documents are not comparable — the live side is compacted by `snapshotAddedTraits` —
      // and dropping an empty list made "the row's own list no longer applies" unrepresentable, so
      // deleting the last member of a row-authored `added` came back on reload).
      const structure = captureInstanceStructure(ecsId, childPrefab, { template: opts.template, rows: opts.rows });
      for (const id of structure.consumedEcsIds) consumedEcsIds.add(id);
      const live = {
        added: structure.added, removed: structure.removed, removedTraits: structure.removedTraits,
        ...(Object.keys(structure.unrowed ?? {}).length ? { moved: structure.unrowed } : {}),
      };
      const baseline = resolveEffectivePrefabStructure(source, at);
      const unchanged = emptyStructure(live) && emptyStructure(baseline);
      if (opts.omitUnchanged && opts.baselinesOut) {
        if (!unchanged) { structures.set(key, live); opts.baselinesOut.set(key, baseline); }
      } else if (!unchanged && !(opts.omitUnchanged && sameStructure(live, baseline))) structures.set(key, live);
      walk(structure.ownedNested, at);
    }
  };
  walk(ownedNested, []);
  order.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
  const nestedOverrides: NestedOverridePaths = {};
  const nestedStructure: NestedStructurePaths = {};
  for (const at of order) {
    const key = nestedPathKey(at);
    const o = overrides.get(key);
    if (o) nestedOverrides[key] = o;
    const st = structures.get(key);
    if (st) nestedStructure[key] = st;
  }
  return {
    nestedOverrides: Object.keys(nestedOverrides).length ? nestedOverrides : undefined,
    nestedStructure: Object.keys(nestedStructure).length ? nestedStructure : undefined,
    consumedEcsIds,
    ownedMemberEcsIds,
    frames,
  };
}

/** The localId-keyed channels of one instance, as a scene writer holds them before writing. */
export interface InstanceChannels {
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  nestedOverrides?: NestedOverridePaths;
  nestedStructure?: NestedStructurePaths;
}

/** Move every edit a MEMBER ROW can carry off the localId-keyed channels and onto the row (#1468
 *  Phase 4) — the write half of `foldMemberRowChannels`, and the reason a scene's edits now survive a
 *  template renumber: the row is addressed by the member's minted identity, the channel by a position.
 *
 *  `rootId` is the instance whose SAVE writes `members` (a top-level instance, or a user-added reference
 *  node), `prefab` its document, `ch` the channels captured for it and `nestedFrames` the path → live
 *  nested root map `captureNestedChannels` returns. Neither input is mutated.
 *
 *  **What stays in the legacy channel, and why each one must:**
 *  - **the instance ROOT's own edits** — the root has no row, it IS the entry (plan § 4 Phase 2B,
 *    finding A); its localId is the document's root and never renumbers;
 *  - **a member no row can key** — a pre-v5 template's member (no `nodeGuid`, which is every prefab the
 *    released editor wrote), or a live member with no durable guid (`memberRowsToWrite`'s rule, which
 *    the two stampers also rely on);
 *  - **a nested frame's STRUCTURE, whole, unless every member it touches is keyable** — the legacy
 *    `nestedStructure[path]` REPLACES the frame's lists, so half of it on rows and half in the channel
 *    would be one statement in two places with nothing to say which half is authoritative.
 *
 *  A nested frame's structure moves as PER-MEMBER statements of the live state, for every member the
 *  live interior OR the prefab chain's baseline touches: the explicit `removed: false`,
 *  `removedTraits: []` and `added: []` are what carry the legacy slot's "the prefab's list no longer
 *  applies" (see `foldMemberRowChannels`). A REMOVED member has no live entity, so its row is keyed from
 *  the frame's key and the member's `nodeGuid` in the frame's document, and carries no guid. */
export function moveChannelsOntoRows(
  rootId: number,
  prefab: PrefabFile,
  source: string,
  ch: InstanceChannels,
  members: Record<string, SceneMemberRow>,
  nestedFrames: ReadonlyMap<string, { root: number; path: number[] }> = new Map(),
): { channels: InstanceChannels; members: Record<string, SceneMemberRow> } {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return { channels: ch, members };
  const rowed = memberRowsToWrite(rootId);
  const keyOf = memberRowKeysIn(rootId);
  const out: Record<string, SceneMemberRow> = { ...members };
  const row = (key: string): SceneMemberRow => (out[key] = { ...(out[key] ?? {}) });

  // localId → live ecs, per frame root, from one query.
  const byFrame = new Map<number, Map<number, number>>();
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const d = pi as { rootInstanceId?: number; localId?: number };
    if (!d.rootInstanceId || !d.localId) return;
    let m = byFrame.get(d.rootInstanceId);
    if (!m) byFrame.set(d.rootInstanceId, (m = new Map()));
    m.set(d.localId, entity.id());
  });

  /** The row key for member `lid` of the frame rooted at `frameRoot` (document `doc`, frame key
   *  `frameKey` — '' for the top frame), or '' when no row may carry it. `live` asks for a member that
   *  must exist (an override, a removed trait, an anchor); a removed member need not. */
  const keyFor = (frameRoot: number, doc: PrefabFile, frameKey: string, lid: number, live: boolean): string => {
    if (lid === (doc.rootLocalId ?? 1)) {
      // The frame's own root: the top frame's has no row; a nested one's row is the FRAME's key.
      return frameRoot !== rootId && rowed.has(frameRoot) ? frameKey : '';
    }
    const ecs = byFrame.get(frameRoot)?.get(lid);
    if (ecs) return rowed.get(ecs) ?? '';
    if (live) return '';
    const g = doc.entities.find((e) => e.localId === lid)?.nodeGuid;
    return g && isGuid(g) && (frameRoot === rootId || frameKey) ? `${frameKey}/${g}` : '';
  };

  // ── The top frame: per member, per channel. ──
  const legacy: InstanceChannels = { ...ch };
  if (ch.overrides) {
    const keep: typeof ch.overrides = {};
    for (const [lidStr, traits] of Object.entries(ch.overrides)) {
      const key = keyFor(rootId, prefab, '', Number(lidStr), true);
      if (key) row(key).traits = traits;
      else keep[Number(lidStr)] = traits;
    }
    legacy.overrides = Object.keys(keep).length ? keep : undefined;
  }
  if (ch.removedTraits) {
    const keep: Record<number, string[]> = {};
    for (const [lidStr, names] of Object.entries(ch.removedTraits)) {
      const key = keyFor(rootId, prefab, '', Number(lidStr), true);
      if (key) row(key).removedTraits = names;
      else keep[Number(lidStr)] = names;
    }
    legacy.removedTraits = Object.keys(keep).length ? keep : undefined;
  }
  if (ch.removed) {
    const keep: number[] = [];
    for (const lid of ch.removed) {
      const key = keyFor(rootId, prefab, '', lid, false);
      if (key) row(key).removed = true;
      else keep.push(lid);
    }
    legacy.removed = keep.length ? keep : undefined;
  }
  if (ch.added) {
    const keep: AddedEntity[] = [];
    for (const node of ch.added) {
      const key = keyFor(rootId, prefab, '', node.parentLocalId, true);
      if (key) (row(key).added ??= []).push({ ...node, parentLocalId: 0 });
      else keep.push(node);
    }
    legacy.added = keep.length ? keep : undefined;
  }

  // ── Nested frames. ──
  const frameOf = (path: string): { root: number; doc: PrefabFile; key: string; steps: number[] } | null => {
    const at = nestedFrames.get(path);
    const src = at ? (readTraitData(at.root, piMeta)?.source as string | undefined) : undefined;
    const doc = src ? getCachedPrefabSync(src) : null;
    const key = at ? keyOf.get(at.root) ?? '' : '';
    return at && doc && key ? { root: at.root, doc, key, steps: at.path } : null;
  };
  if (ch.nestedOverrides) {
    const keep: NestedOverridePaths = {};
    for (const [path, byLocal] of Object.entries(ch.nestedOverrides)) {
      const f = frameOf(path);
      const rest: Record<number, Record<string, Record<string, unknown>>> = {};
      for (const [lidStr, traits] of Object.entries(byLocal)) {
        const key = f ? keyFor(f.root, f.doc, f.key, Number(lidStr), true) : '';
        if (key) row(key).traits = traits;
        else rest[Number(lidStr)] = traits;
      }
      if (Object.keys(rest).length) keep[path] = rest;
    }
    legacy.nestedOverrides = Object.keys(keep).length ? keep : undefined;
  }
  if (ch.nestedStructure) {
    const keep: NestedStructurePaths = {};
    for (const [path, live] of Object.entries(ch.nestedStructure)) {
      const f = frameOf(path);
      // A move no row can carry (`unrowed`) means this frame already has a member no row can key.
      if (!f || Object.keys(live.moved ?? {}).length) { keep[path] = live; continue; }
      const base = resolveEffectivePrefabStructure(source, f.steps);
      const liveRemoved = new Set(live.removed ?? []);
      const touched = new Map<number, { removed: boolean; traits: boolean; added: boolean }>();
      const touch = (lid: number, what: 'removed' | 'traits' | 'added') => {
        const t = touched.get(lid) ?? { removed: false, traits: false, added: false };
        t[what] = true;
        touched.set(lid, t);
      };
      for (const lid of [...(live.removed ?? []), ...(base.removed ?? [])]) touch(lid, 'removed');
      for (const lid of [...Object.keys(live.removedTraits ?? {}), ...Object.keys(base.removedTraits ?? {})]) touch(Number(lid), 'traits');
      for (const n of [...(live.added ?? []), ...(base.added ?? [])]) touch(n.parentLocalId, 'added');
      const keys = new Map<number, string>();
      for (const lid of touched.keys()) {
        const k = keyFor(f.root, f.doc, f.key, lid, !liveRemoved.has(lid));
        if (!k) break;
        keys.set(lid, k);
      }
      if (keys.size !== touched.size) { keep[path] = live; continue; }
      for (const [lid, t] of touched) {
        const r = row(keys.get(lid)!);
        if (t.removed) r.removed = liveRemoved.has(lid);
        if (t.traits) r.removedTraits = live.removedTraits?.[lid] ?? [];
        if (t.added) r.added = (live.added ?? []).filter((n) => n.parentLocalId === lid).map((n) => ({ ...n, parentLocalId: 0 }));
      }
    }
    legacy.nestedStructure = Object.keys(keep).length ? keep : undefined;
  }

  const sorted: Record<string, SceneMemberRow> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k]!;
  return { channels: legacy, members: sorted };
}

/** A nested instance captured as a reference: its source + per-instance diffs,
 *  plus the live ECS ids that belong to it (so a serializer can exclude them
 *  from a flat write). Shared by serializeScene + serializePrefab. */
export interface InstanceReference {
  source: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  /** The moves no member row carries ({@link InstanceStructure.unrowed}) — the legacy map. */
  moved?: Record<number, string>;
  /** All live members of this instance (PrefabInstance.rootInstanceId === root). */
  memberEcsIds: Set<number>;
  /** Added subtrees folded into `added` (their live ids — also skip on write). */
  consumedEcsIds: Set<number>;
  /** The row partition: owned nested root ecsId → the row it expands (see `captureNestedChannels`). */
  ownedNested: Map<number, number>;
}

/** Capture an instance as a reference for serialization: overrides + structural
 *  diffs against `prefab`, plus its member/consumed ECS ids. Returns `undefined`
 *  collections when empty so the written JSON stays minimal. */
export function captureInstanceReference(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
  opts: StructureCaptureOpts = {},
): InstanceReference {
  const overrides = captureInstanceOverrides(rootInstanceId, prefab);
  const structure = captureInstanceStructure(rootInstanceId, prefab, opts);
  const memberEcsIds = new Set<number>();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (PrefabInstanceMeta) {
    getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
      if ((pi as Record<string, unknown>).rootInstanceId === rootInstanceId) memberEcsIds.add(entity.id());
    });
  }
  return {
    source,
    overrides: Object.keys(overrides).length ? overrides : undefined,
    added: structure.added.length ? structure.added : undefined,
    removed: structure.removed.length ? structure.removed : undefined,
    removedTraits: Object.keys(structure.removedTraits).length ? structure.removedTraits : undefined,
    moved: Object.keys(structure.unrowed ?? {}).length ? structure.unrowed : undefined,
    memberEcsIds,
    consumedEcsIds: structure.consumedEcsIds,
    ownedNested: structure.ownedNested,
  };
}

/** Apply a captured structure on top of a freshly-instantiated instance (editor
 *  side; mirrors loadSceneFile's applyStructureByLocalToEcs). Reconciles against
 *  `prefab`: removals/removed-traits absent from the prefab no-op; an addition
 *  whose anchor localId is gone re-anchors to the instance root. Order: entity
 *  removals → component removals → additions. */
export function applyStructureByRootInstance(
  rootInstanceId: number,
  prefab: PrefabFile,
  structure: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string>; members?: Record<string, SceneMemberRow> },
): void {
  if (!structure) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  const localToEcs = new Map<number, number>();
  const nestedRoots: [number, number][] = [];
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    const parentLocalId = (piData.parentLocalId as number) || 0;
    if (isOwnedRoot(piData as MemberPi, entity.id())) nestedRoots.push([parentLocalId, entity.id()]);
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });
  if (localToEcs.size === 0) return;
  // A nested row's localId maps to the instance it expanded to, as `instantiatePrefabIntoWorld`'s map
  // does on the runtime side — so a `removed` nested row (#1355) is deleted here too, not skipped.
  const members = new Set(localToEcs.values());
  const eaMeta = getTraitByName('EntityAttributes');
  for (const [rowLocalId, id] of nestedRoots) {
    const parent = eaMeta ? ((readTraitData(id, eaMeta)?.parentId as number) || 0) : 0;
    if (members.has(parent) && !localToEcs.has(rowLocalId)) localToEcs.set(rowLocalId, id);
  }

  // Delegate to the world-parameterized shared core (F7) with editor-world ops, so
  // the runtime (applyStructureByLocalToEcs) and editor paths can never drift.
  applyStructureCore(
    {
      logPrefix: '[Prefab]',
      world: getCurrentWorld(),
      deleteEntities: (ecsIds) => deleteEntities(ecsIds),
      findEntity: (ecsId) => findEntity(ecsId) ?? undefined,
      spawnAdded: (traitArgs) => {
        const entity = spawnEntity(getCurrentWorld(), ...(traitArgs as Parameters<ReturnType<typeof getCurrentWorld>['spawn']>));
        return entity.id();
      },
      // Editor nested-instance expansion: instantiate → tag source → replay
      // overrides → recurse structure. parentLocalId stays 0 on the spawned root so
      // the next capture re-detects it as user-added.
      spawnNestedInstance: (node, parentEcsId) => {
        const child = getCachedPrefabSync(node.prefab!);
        if (!child) { console.warn(`[Prefab] added nested instance "${node.prefab}" not cached`); return; }
        // The node's own `overrides`/`added` are applied AFTER the expansion below closes its token scope,
        // so this scope wraps the whole node: the loader's twin hands them INTO its top call, which notes
        // them there (#1352 close-out review).
        const scope = openTokenScope();
        noteTokens(undefined, node.overrides, node.added);
        // The node's nested channels expand with it, as the loader's twin does (#1369).
        const childRoot = instantiatePrefab(child, parentEcsId, undefined, node.nestedOverrides, node.nestedStructure);
        if (!childRoot) { closeTokenScope(scope); return; }
        if (closeTokenScope(scope)) registerTemplateFrame(getCurrentWorld(), childRoot);
        // RESTORE the node's own guid — the editor-side twin of the loader fix (QA-PREFAB-0004).
        // `captureNestedRef` reads the live guid onto the reference node precisely so a rebuild
        // can put it back, and `rebuildInstance` already does exactly this for the OUTER root
        // ("refs into the instance survive the rebuild"). Without it a Revert to Prefab, an
        // Apply, or the undo/redo of a prefab drop re-expands the nested instance with the
        // TEMPLATE's guid — which prefab templates clear, so it comes back as '' and the entity
        // is not addressable by guid at all, worse than the loader's fresh-guid churn.
        const eaMeta = getTraitByName('EntityAttributes');
        if (eaMeta && node.guid) {
          writeTraitField(childRoot, eaMeta, 'guid', node.guid);
          const ent = findEntity(childRoot);
          if (ent) indexEntityGuid(ent);
        } else if (node.key) {
          // A TEMPLATE reference node has no guid to restore; its root derives one from the key (#1387).
          setTemplateKey(findEntity(childRoot), node.key);
        }
        setPrefabSource(childRoot, node.prefab!);
        if (node.overrides) applyOverridesByRootInstance(childRoot, node.overrides);
        if (node.added?.length || node.removed?.length || node.removedTraits || node.moved || node.members) {
          applyStructureByRootInstance(childRoot, child, { added: node.added, removed: node.removed, removedTraits: node.removedTraits, moved: node.moved, members: node.members });
        }
      },
      onComplete: () => {
        markStructureDirty();
        markUIDirty(); // added entities may be UI — rebuild the DOM UI tree
      },
    },
    localToEcs,
    prefab,
    structure,
  );
}

// ── File I/O ────────────────────────────────────────────

/** Tag every entity in the tree rooted at `rootEcsId` with a PrefabInstance
 *  trait pointing to `source`. localIds match the prefab's localId scheme
 *  (BFS order, root = 1) so per-localId overrides round-trip correctly.
 *
 *  ⚠️ The numbering comes from `planPrefabRows` — the SAME function `serializePrefab` uses to
 *  decide rows (#1278). It used to be re-derived here by counting the live tree, which the
 *  serializer does not do: a nested instance collapses to one reference row and its members are
 *  dropped, so the two disagreed for every member ordered after it and the next save paired each
 *  live entity with the wrong row. **Do not re-derive this — call the planner.**
 *
 *  A nested row is NOT retagged onto `source`: a reload leaves it linked to its own child
 *  prefab and stamps only `parentLocalId` (the outer row that produced it — see
 *  `instantiatePrefabIntoWorld`). This mirrors that, so the live world after Create Prefab
 *  equals the world after a save + reload, and its members are left alone entirely.
 *
 *  ⚠️ PASS `writtenPrefab` whenever you have it. One planner does NOT mean one answer: the
 *  caller serializes, then `await`s a file write — on a Replace that await includes the
 *  `confirmReplace` DIALOG, an unbounded wait during which MCP ops and the file-watcher's scene
 *  reload keep running. The plan computed here is therefore a SECOND read of mutable world +
 *  prefab-cache state. If it disagrees with the file, tagging writes localIds addressing rows
 *  that do not exist, and such an entity is then written to neither the scene entry nor the
 *  overrides — it is simply gone on the next load. So the plan is checked against the file and a
 *  mismatch REFUSES to tag: an untagged entity round-trips as an `added` node, which is the
 *  degradation that loses nothing. */
export function tagEntityTreeAsInstance(rootEcsId: number, source: string, writtenPrefab?: PrefabFile): Map<string, string> {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return new Map();

  // Callers pass the prefab's asset PATH; store a GUID instead when one resolves
  // (callers register the new prefab before tagging). PrefabInstance.source is
  // GUID-only — a raw path bakes a literal into the scene JSON on save and trips
  // resolveRef's hard rejection on load. Mirrors setPrefabSource. Falls back to
  // the given ref only when the manifest can't resolve it yet.
  const ref = isGuid(source) ? source : (getGuidForPath(source) ?? source);

  // Mirror serializePrefab's localId assignment (BFS, root = 1) — including WHICH entities it
  // selects, which is why both go through `authoringEntitiesFor`. A tree containing a runtime
  // subtree the file does not have fails `planMatchesFile` below and refuses to tag at all.
  const { entities: allEntities } = authoringEntitiesFor(rootEcsId, getAllEntities());
  const tree = collectTree(rootEcsId, allEntities);

  /** The identity the file just written gave this row (#1468). Without `writtenPrefab` there is
   *  nothing to read it from, so the live tree is left with '' and picks its identity up at the next
   *  load instead — the same degradation `planMatchesFile` already accepts for the plan check, and
   *  both production callers (`assetOps`, `agentEditorOps`) do pass the file. */
  const rowNodeGuids = new Map<number, string>(
    (writtenPrefab?.entities ?? []).map((pe) => [pe.localId, pe.nodeGuid ?? '']),
  );
  const nodeGuidAt = (localId: number): string => rowNodeGuids.get(localId) ?? '';

  /** ⚠️ `piData` must name EVERY field of PrefabInstance. koota's generated setter is a partial
   *  merge (`if ('k' in value) store.k[i] = value.k`), so an omitted field keeps its old value —
   *  and this used to be masked by Create Prefab stripping the trait first. A surviving
   *  `parentLocalId` makes serialize classify the row as an OWNED nested instance of the prefab
   *  it used to belong to (`serialize.ts` `parentIsMember && parentLocalId`), which writes no
   *  scene entry for it at all and loses the new link on the next reload. */
  const applyTag = (ecsId: number, localId: number) => {
    const entity = findEntity(ecsId);
    if (!entity) return;
    // ⚠️ `ownerGuid` is CLEARED, not omitted — see the partial-merge warning above. Tagging captures the
    //  tree AS IT STANDS, so every member is at its row in the new prefab and none of them is "moved"
    //  relative to it; a link left from the PREVIOUS prefab would name a frame this tree no longer
    //  belongs to. (The home fields it replaced were cleared here for the same reason, #1461 close-out F1.)
    const piData = { source: ref, localId, nodeGuid: nodeGuidAt(localId), rootInstanceId: rootEcsId, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '' };
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, piData);
    else entity.add(PrefabInstanceMeta.trait(piData));
  };

  // The same decision procedure the serializer used — but a SECOND read of the world, so it is
  // checked against the file before anything is written. (`planPrefabRows` only returns null for
  // a cycle, which needs `existingId`; this call passes none, so that cannot fire here.)
  const plan = planPrefabRows(tree, rootEcsId)!;
  if (writtenPrefab && !planMatchesFile(plan, writtenPrefab, source)) return new Map();
  for (const info of plan.flatTree) {
    const localId = plan.ecsToLocal.get(info.id)!;
    const nested = plan.nestedRefs.get(info.id);
    if (nested) {
      // Nested reference row — keep its link to its OWN prefab and stamp only which outer row
      // produced it, exactly as instantiatePrefabIntoWorld does on reload. Its members are not
      // rows of this prefab and are left untouched.
      const entity = findEntity(info.id);
      if (entity?.has(PrefabInstanceMeta.trait)) {
        entity.set(PrefabInstanceMeta.trait, {
          ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>),
          parentLocalId: localId, parentNodeGuid: nodeGuidAt(localId), ownerGuid: '', // at its row: nothing to link
        });
      }
      continue;
    }
    applyTag(info.id, localId);
  }
  // What these members' localIds now MEAN — the document just written — so every identity walk reads their
  // template parents from it before any reload has expanded it (`identityParents.ts`, #1468 Phase 6).
  if (writtenPrefab) noteFrameDoc(getCurrentWorld(), ref, writtenPrefab, findEntity(rootEcsId) ?? undefined);
  // The tags above make these entities MEMBERS, whose identity the reload derives from the anchor and
  // the path — but they still hold the random guids they had as plain entities, and the file written
  // alongside says `guid: ''` on every row. Give them that identity now, or everything written before
  // the first save+reload that names a member by guid names one that will never exist again (#1461).
  // Returned so Create Prefab's undo can reverse it; the callers mint the root's guid before tagging,
  // which is what gives this an anchor to derive from.
  const guidRemap = stampDerivedMemberGuids(rootEcsId);
  markStructureDirty();
  return guidRemap;
}

/** Undo of the member rename {@link tagEntityTreeAsInstance} returned (#1461): the map reversed and
 *  applied, so every member is addressable by the guid it had before Create Prefab, refs included.
 *
 *  Run it BEFORE `reattachPrefabInstance`: Create Prefab snapshots the tree's prior links one line ahead
 *  of the tag, and that snapshot addresses each member by the guid it held then, so reattaching first
 *  would be asked to resolve guids that are not live yet. Untag is by ecs id and does not care.
 *  The order is PINNED — `packages/modoki/tests/editor/createPrefabUndo.test.ts` asserts the undo
 *  sequence as `['unstamp', 'untag', 'reattach']` on both the create and the replace branch. */
export function unstampMemberGuids(remap: ReadonlyMap<string, string>): void {
  if (!remap.size) return;
  applyGuidRemap(new Map([...remap].map(([from, to]) => [to, from])));
}

/** Inverse of tagEntityTreeAsInstance — strip the PrefabInstance trait off the entities that
 *  belong to `source` in the tree rooted at `rootEcsId`. Used for undo when a newly-created
 *  prefab is reverted.
 *
 *  ⚠️ `source` is REQUIRED (#1272). It used to be optional, and the optional path stripped EVERY
 *  link in the subtree — including a held nested instance's link to its OWN child prefab, which
 *  tagging deliberately never touched. An optional parameter whose default is the old broken
 *  behaviour is the scar #1278 left; it does not get made twice. Undo then depends on `reattachPrefabInstance` putting that link
 *  back from the GUID-keyed snapshot — and after a Play→Stop the nested instance's guid has been
 *  re-minted (it is owned-nested now, so `serialize.ts` writes no scene entry for it and
 *  `deriveInstanceMemberGuids` derives a fresh guid from the new root on load). The ref misses,
 *  reattach skips it silently, and the instance is left plain with its link to Q gone for good.
 *
 *  Scoping by source removes the need to resolve anything across the reload: after a reload this
 *  prefab's own rows carry `source === this prefab` and a held nested instance carries its own
 *  child prefab's guid, so "what this Create Prefab added" is answerable from the live data
 *  rather than from an identity that did not survive.
 *
 *  A nested root that this prefab OWNED also loses its `parentLocalId` — the row that owned it is
 *  being removed, so it goes back to being a free-standing instance. One nested deeper (owned by
 *  the child prefab, not by this one) keeps its stamp, because its owner is untouched.
 *
 *  ⚠️ That test — "was my nearest linked ancestor stripped?" — is a PROXY for the real question,
 *  "did this tagging write my `parentLocalId`?", whose answer is `plan.nestedRefs`. It is wrong in
 *  two shapes, both left standing on #1272: a nested instance held inside ANOTHER held instance
 *  keeps the stamp this Create Prefab wrote (its ancestor was not stripped), and one owned by an
 *  OUTER prefab is zeroed rather than returned to that prefab's row id. Both need the pre-create
 *  value, which only the snapshot has — and reattach cannot reach it once the guid re-derives. */
export function untagEntityTreeAsInstance(rootEcsId: number, source: string): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Callers pass the asset PATH; PrefabInstance.source is GUID-only. Mirrors tagEntityTreeAsInstance.
  const ref = isGuid(source) ? source : (getGuidForPath(source) ?? source);

  const allEntities = getAllEntities();
  const tree = collectTree(rootEcsId, allEntities);
  const sourceOf = new Map<number, string | undefined>();
  const removed = new Set<number>();

  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity?.has(PrefabInstanceMeta.trait)) continue;
    const pi = entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    sourceOf.set(info.id, pi.source as string | undefined);
    if (pi.source !== ref) continue; // a nested instance's OWN link — not ours
    removed.add(info.id);
  }
  // (A member moved away from one of these keeps its path with nothing recorded: the document still has the
  // rows, `identityParents.ts`.)
  for (const id of removed) findEntity(id)?.remove(PrefabInstanceMeta.trait);

  // A kept nested root whose owning row we just removed is no longer owned by anything.
  {
    const parentOf = new Map(tree.map((i) => [i.id, i.parentId]));
    for (const info of tree) {
      if (removed.has(info.id) || !sourceOf.has(info.id)) continue;
      // The nearest ancestor that carries a link decides who owned this one.
      let cur = parentOf.get(info.id) ?? 0;
      while (cur && !sourceOf.has(cur)) cur = parentOf.get(cur) ?? 0;
      if (!cur || !removed.has(cur)) continue; // owned by a child prefab, or by nothing — leave it
      const entity = findEntity(info.id);
      if (!entity?.has(PrefabInstanceMeta.trait)) continue;
      entity.set(PrefabInstanceMeta.trait, {
        ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), parentLocalId: 0, parentNodeGuid: '',
      });
    }
  }
  // ⚠️ A scoped strip that matched NOTHING, on a tree that does carry links, means undo left the
  // whole subtree tagged as an instance of a prefab it has just deleted. Silent is exactly what
  // this function was changed to stop being (#1272 review F5).
  if (!removed.size && sourceOf.size) {
    console.error(`[Prefab] untagEntityTreeAsInstance: nothing in this subtree is tagged as "${source}", though ${sourceOf.size} entit${sourceOf.size === 1 ? 'y carries' : 'ies carry'} some other prefab link — the tree was left tagged.`);
  }
  markStructureDirty();
}

/** A captured PrefabInstance trait, used to undo a detach. `ref`/`rootRef` are what reattach resolves
 *  through; `id` is the capture-time ECS id, kept for diagnostics only. */
export interface DetachedInstanceTrait { id: number; ref: EntityRef; rootRef: EntityRef; data: Record<string, unknown>; }

/** What a detach undoes: the links it stripped off the tree, and the members OUTSIDE the tree it promoted or
 *  unlinked because their frame ended with it (#1453). */
export interface DetachSnapshot { links: DetachedInstanceTrait[]; orphans: DetachedMember[]; }

/** Detach a prefab instance — strip the `PrefabInstance` trait off the instance
 *  root and EVERY descendant in its subtree (nested instances included), turning
 *  the live tree into ordinary, unlinked entities. Mirrors Unity's "Unpack
 *  Prefab Completely". The entities, their transforms, and their other traits are
 *  untouched — only the prefab link is severed, so later edits to the source
 *  prefab no longer propagate here and the tree serializes as plain entities.
 *  Returns a snapshot of the removed traits so the action can be undone.
 *
 *  ⚠️ The snapshot is keyed by GUID (`entityRef`), NOT by ECS id (#1264 close-out review). Detach itself
 *  is id-stable, but that was never enough: OTHER undo entries run between a detach and its undo — a
 *  delete + undo respawns a subtree, and koota recycles ids last-freed-first, so two siblings came back
 *  with each other's ids and reattach cross-wired their localIds with no error. `rootInstanceId` is an
 *  ECS id too, so it is re-derived from `rootRef` at reattach. `entityRef` mints a guid for a member that
 *  has none.
 *
 *  ⚠️ LIMIT — a guid only helps while the entity KEEPS it. A detach leaves plain entities whose guids
 *  are saved, so Hierarchy/agent Detach undo survives Play→Stop. **Create Prefab's snapshot does
 *  not**: a held nested instance ends up INSIDE the new prefab, and `serialize.ts` writes no scene
 *  entry for an owned nested instance (`parentIsMember && parentLocalId`) — only a `nestedOverrides`
 *  delta against the outer row. Its guid never reaches disk, so `deriveInstanceMemberGuids` re-mints
 *  it from the new root on reload and these refs miss.
 *
 *  That is still true, and #1272 fixed the CONSEQUENCE rather than the identity:
 *  `untagEntityTreeAsInstance` takes the prefab's source and strips only its own rows, so undo never
 *  destroys the nested link and never needs the snapshot to resolve it. `reattachPrefabInstance`
 *  returns the count it could not resolve instead of swallowing it. Do NOT re-key this snapshot on
 *  a localId path to "fix" the miss — the address it would need is the one #1278 had to make a
 *  single source of truth, and undo no longer depends on it.
 *
 *  `opts.strip: false` snapshots WITHOUT removing the traits — for a caller that is about to
 *  overwrite the links itself and only wants the undo record (#1278). Create Prefab is one:
 *  stripping first used to leave a held nested instance's members plain, because the tagging
 *  that followed deliberately does not retag them. Detach proper keeps the default.
 *
 *  A member MOVED out of the tree (#1437) is not in `collectTree`, but its frame ends with the strip all
 *  the same. The strip runs `endFrames` first, as a delete does: an owned nested root moved out becomes a
 *  standalone instance, and anything else is unlinked where it stands. Left linked to a frame that no
 *  longer exists, it was written nowhere and vanished on reload (#1453). Those go in `orphans`. */
export function detachPrefabInstance(rootEcsId: number, opts?: { strip?: boolean }): DetachSnapshot {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { links: [], orphans: [] };
  const strip = opts?.strip !== false;
  const tree = collectTree(rootEcsId, getAllEntities());
  const snapshot: DetachedInstanceTrait[] = [];
  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity || !entity.has(PrefabInstanceMeta.trait)) continue;
    const pi = entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    // Every field, `parentLocalId` included: it addresses a NESTED instance's per-instance overrides, and a
    // snapshot that dropped it reattached a nested instance as top-level (0) on undo (#1264 close-out).
    snapshot.push({
      id: info.id, ref: entityRef(info.id), rootRef: entityRef(pi.rootInstanceId as number),
      data: { source: pi.source, localId: pi.localId, nodeGuid: pi.nodeGuid ?? '', rootInstanceId: pi.rootInstanceId, parentLocalId: pi.parentLocalId, parentNodeGuid: pi.parentNodeGuid ?? '', ownerGuid: pi.ownerGuid ?? '' },
    });
  }
  let orphans: DetachedMember[] = [];
  if (strip) {
    orphans = endFrames(new Set(snapshot.map((s) => s.id))); // BEFORE the strip: the owner walk reads these links
    for (const s of snapshot) findEntity(s.id)?.remove(PrefabInstanceMeta.trait);
  }
  if (snapshot.length) markStructureDirty();
  return { links: snapshot, orphans };
}

/** Inverse of detachPrefabInstance — re-add the captured PrefabInstance traits
 *  (undo of a detach), and relink the members outside the tree it promoted or unlinked (#1453). */
export function reattachPrefabInstance(
  detached: DetachSnapshot,
  /** The subtree undo is restoring. Given, an unresolved ref is only counted as LOST once the link
   *  is confirmed absent from the world. Omit it and every unresolved ref counts, which is right
   *  for a caller that stripped the whole tree (Detach). */
  opts?: { rootEcsId?: number },
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  const { links: snapshot, orphans } = detached;
  if (!PrefabInstanceMeta || (!snapshot.length && !orphans.length)) return 0;
  // Orphans first: relinking reverses a promotion's member rename, and the refs below resolve by guid.
  relinkDetachedMembers(orphans);
  const unresolvedEntries: DetachedInstanceTrait[] = [];
  for (const entry of snapshot) {
    const live = entry.ref.resolve();
    const entity = live == null ? undefined : findEntity(live);
    if (!entity) { unresolvedEntries.push(entry); continue; }
    const root = entry.rootRef.resolve();
    const restored = root == null ? entry.data : { ...entry.data, rootInstanceId: root };
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, restored);
    else entity.add(PrefabInstanceMeta.trait(restored));
  }
  markStructureDirty();
  if (!unresolvedEntries.length) return 0;

  // ⚠️ AN UNRESOLVED REF IS NOT A LOST LINK, and counting it as one made this report fire on
  // the very flow the #1272 fix makes work. The snapshot is taken with `strip: false`, so it also
  // holds the entities the scoped untag deliberately KEEPS — a held nested instance, whose guid the
  // reload re-mints. Its ref misses every time, and nothing needed doing to it. Counting refs
  // announced "2 links could not be put back" over a completely correct undo, which is worse than
  // the silence it replaced: it sends the next reader hunting a phantom.
  //
  // So the question is asked of the WORLD, not of the snapshot: is this link actually absent now?
  // (Limit: two sibling instances of the same prefab at the same localId are indistinguishable
  // here, so a genuine loss can be masked by a surviving twin. That under-reports rather than
  // crying wolf, which is the side to err on for something a human reads.)
  if (opts?.rootEcsId == null) return unresolvedEntries.length;
  const present = new Set<string>();
  for (const info of collectTree(opts.rootEcsId, getAllEntities())) {
    const e = findEntity(info.id);
    if (!e?.has(PrefabInstanceMeta.trait)) continue;
    const pi = e.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    present.add(`${pi.source}|${pi.localId}|${pi.parentLocalId ?? 0}`);
  }
  return unresolvedEntries.filter(({ data: d }) => !present.has(`${d.source}|${d.localId}|${d.parentLocalId ?? 0}`)).length;
}

/** Seed (or evict) the in-memory prefab cache. Used by save/import flows so
 *  the Inspector's override detection picks up newly-written prefabs without
 *  a re-fetch. */
export function setPrefabCache(source: string, prefab: PrefabFile | null): void {
  if (prefab) prefabCache.set(source, prefab);
  else prefabCache.delete(source);
  // Keep the runtime refcounted prefab cache in sync — every setPrefabCache call follows a prefab
  // file write (save-as-prefab, overwrite, delete/undo). A write REPLACES the runtime entry rather
  // than evicting it: an eviction strands every synchronous runtime reader until the next scene
  // load (#1308). A delete still evicts.
  if (prefab) replaceCachedPrefab(source, prefab);
  else invalidatePrefab(source);
}

/** Look up an entity's PrefabInstance source + rootInstanceId. Returns null if
 *  the entity is not part of a prefab instance.
 *
 *  EXPORTED because the agent ops need the same lookup to turn a `{guid}` into the
 *  `(source, rootInstanceId)` pair `applyToPrefabWithUndo`/`revertOverridesSelective`
 *  take. It was briefly copied into `agentEditorOps.ts` instead — the duplicated-private-
 *  helper trap docs/editor.md warns about, and worse here than usual: the copy would keep
 *  answering plausibly after this one's rules changed (a nested member's rootInstanceId
 *  points at ITS OWN prefab's root, not the outermost one), so the two would disagree only
 *  on nested instances. One lookup, one answer. */
export function resolveInstanceContext(entityId: number): { source: string; rootInstanceId: number } | null {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return null;
  let source = '';
  let rootInstanceId = 0;
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    if (entity.id() !== entityId) return;
    source = (pi as Record<string, unknown>).source as string;
    rootInstanceId = (pi as Record<string, unknown>).rootInstanceId as number;
  });
  if (!source || !rootInstanceId) return null;
  return { source, rootInstanceId };
}

/** Write the new prefab JSON to its source path. Tries the dev-server API
 *  first (we know the path); falls back to a save-file picker. */
/** Warn about the inert-size trap at prefab WRITE time (#42) — a `UIElement` size authored on an
 *  axis the anchor stretches is stored and shown in the Inspector, but never applied.
 *
 *  Why write time rather than load, and why this is only half the fix: docs/scene-loading.md
 *  (pass 4). Warns, never blocks — a dead size is inert, not corrupt.
 *
 *  The one thing that must stay HERE, because it is invisible in the code and looks like an
 *  obvious cleanup: call this from EVERY AUTHORING write (Apply-to-Prefab, Save-as-Prefab, prefab edit
 *  mode save, the agent `create` op — #1251), never from `writePrefabFile`. That is the single choke point for prefab writes AND the
 *  undo/redo restore path (`installPrefabSnapshot`), so hooking it warns while someone REVERTS the
 *  value. Guarded by tests/editor/warnInertPrefabSizes.test.ts. */
export function warnInertPrefabSizes(prefab: unknown, source: string): string[] {
  // Name the FILE even when the caller holds the GUID (PrefabInstance.source and prefab edit mode both
  // do) — the same resolution writePrefabFile applies before it writes.
  const where = isGuid(source) ? (resolveRef(source) || source) : source;
  const { warnings } = validatePrefabData(prefab);
  for (const w of warnings) {
    console.warn(`[Editor] ${where}: ${w}`);
  }
  // Returned for a caller whose reader is not the editor Console — the agent op answers in its response.
  return warnings;
}

export async function writePrefabFile(source: string, prefab: PrefabFile): Promise<boolean> {
  return (await writePrefabFileReport(source, prefab)).ok;
}

/** The same write, with the backend's REASON kept (#1468). A boolean cannot carry why a save
 *  failed, and under the format gate the most likely why — "a newer build wrote this file" — is
 *  something only the human can act on.
 *
 *  ⚠️ Deliberately a sibling rather than a widened return, for the reason `savePrefabEditReport`
 *  records about its own split: `{ ok: false, … }` is an always-truthy object, so a caller still
 *  written `if (!(await writePrefabFile(…)))` would compile and never see a failure again. */
export async function writePrefabFileReport(source: string, prefab: PrefabFile): Promise<{ ok: boolean; error?: string }> {
  if (!prefab.id) prefab.id = newGuid();
  // `source` may be a GUID — resolve to the real file path before writing,
  // otherwise the dev-server API would create a file literally named by the guid.
  // A path source (live instance, pre-normalization) is used as-is — routing it
  // through resolveRef would trip its internal-path rejection.
  const path = isGuid(source) ? (resolveRef(source) || source) : source;
  registerAsset(prefab.id, path, 'prefab');
  const content = jsonFileBody(prefab);
  try {
    const res = await postWriteFile(path, content);
    if (res.ok) {
      // Put the bytes just written into the runtime refcounted prefab cache. Without
      // this, opening another scene that uses this prefab re-instantiates from the
      // stale cached copy (e.g. missing flames/ShipShake the user just applied).
      // REPLACE, not evict (#1308): an eviction left every synchronous runtime reader
      // — a pooled scroll view, a timeline spawn — reading nothing until the next
      // scene load, which blanked a UIEntries view on Apply. (An unowned prefab is
      // still just evicted — see replaceCachedPrefab.) The editor's own prefabCache
      // is updated by the caller. `source` may be a GUID or a path (the agent `create`
      // op hands the path); replaceCachedPrefab keys either form correctly.
      // ⚠️ The bytes are ON DISK from here. Anything below that throws must NOT be reported as a
      // failed write (close-out review R4): the catch would answer `{ ok: false, error: <that
      // message> }`, `savePrefabEditReport` would skip `markSceneSaved`, and the editor would stay
      // permanently dirty against a file that saved — now with a confident, wrong reason attached.
      // Its own try/catch, so a cache or logging fault is reported as what it is.
      try {
        replaceCachedPrefab(source, prefab);
        console.log(`[Prefab] Wrote "${prefab.name}" → ${path}`);
      } catch (e) {
        console.error(`[Prefab] wrote "${prefab.name}" → ${path}, but the post-write cache update failed:`, e);
      }
      return { ok: true };
    }
    // ⚠️ READ THE BODY (#1468 close-out review F5). The owner's ruling is refuse-to-SAVE-never-to-
    // LOAD, so a build WILL open a prefab a newer build wrote, edit it, and press Cmd+S — that is
    // the designed-for case, not an edge. The gate answers 409 with the reason in `error`, and this
    // line used to log the status alone and throw the body away, so the save failed silently: the
    // server's own console.error goes to the DEV-SERVER TERMINAL, not the editor console, and
    // `savePrefabEditReport` returns `{saved:false}` with no warning to raise.
    const why = await res.json().then(
      (b: { error?: unknown; reason?: unknown }) => (typeof b?.error === 'string' ? b.error : typeof b?.reason === 'string' ? b.reason : ''),
    ).catch(() => '');
    console.error(`[Prefab] Could not write "${prefab.name}" → ${path} (HTTP ${res.status})${why ? ` — ${why}` : ''}`);
    return { ok: false, ...(why ? { error: why } : {}) };
  } catch (e) {
    console.error('[Prefab] Write failed:', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // No local file-picker fallback: showSaveFilePicker writes to the user's LOCAL
  // disk, not the project working copy (so the prefab would never reach the repo).
  // A prefab always has a real target path here (resolved above), so a failure
  // means a genuine backend error — report it rather than silently misdirecting.
}

/** Install a prefab snapshot as the live source: update the editor cache, persist
 *  the file (which replaces the runtime refcounted cache entry), and preload nested children.
 *  Does NOT touch live instances — the caller rebuilds the scene, which re-instantiates
 *  every instance from this cache. Used by Apply-to-Prefab undo/redo to restore the
 *  prefab base before replaying the scene snapshot. */
export async function installPrefabSnapshot(source: string, prefab: PrefabFile): Promise<void> {
  const snap: PrefabFile = JSON.parse(JSON.stringify(prefab));
  prefabCache.set(source, snap);
  await writePrefabFile(source, snap);
  await preloadNestedPrefabs(snap);
}

/** Scene-form added nodes rewritten into TEMPLATE form (#1387), recursively through `children`, a
 *  reference node's `added` and its `nestedStructure`: `guid` cleared (the bag's copy too), `members`
 *  dropped, and a `key` given — the live entity's own marker when it still has one, else a fresh one.
 *  Promotion is where a scene capture becomes a prefab row, so it is where the two forms meet.
 *
 *  ⚠️ **Every per-instance identity the scene form carries has to be dropped HERE, and the spread
 *  below does not do it for you.** `{ ...n }` passes through anything new on `AddedEntity`, so a field
 *  added to the scene form arrives in the template silently. Two were riding through, both found by
 *  the Phase 2B close-out reviews:
 *
 *  - **`members`** (scene v16, #1468) — a reference node's member rows are live scene guids, and a
 *    template carrying them hands every instance of that prefab the same ones (#1293).
 *  - **`moved`** — `Record<localId, live-parent GUID>`. `captureInstanceStructure`'s `noteMove` already
 *    refuses to write one into a template (*"its values would be live scene guids, which name
 *    nothing in the prefab's own space — nor, in another instance, anything of that instance"*), and
 *    this converter was the way one got in anyway. `promoteReferenceMoves` rescues the TOP promoted
 *    node's moves and `insertAddedSubtree` omits the field from the row it writes, so a reference
 *    node reached through `added`, `children` or a `nestedStructure` slot was the gap.
 *
 *  If you add a field to `AddedEntity`, decide here whether it is per-instance. */
function toTemplateNodes(nodes: AddedEntity[] | undefined): AddedEntity[] | undefined {
  if (!nodes) return nodes;
  return nodes.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    const key = n.key || (live ? templateKeyOf(findEntity(live)) : '') || newGuid();
    const traits = { ...n.traits };
    const ea = traits['EntityAttributes'];
    if (ea && ea !== true && 'guid' in ea) { const { guid: _drop, ...rest } = ea; traits['EntityAttributes'] = rest; }
    const { members: _rows, moved: _moves, ...scene } = n;
    const out: AddedEntity = { ...scene, guid: '', key, traits, children: toTemplateNodes(n.children) ?? [] };
    if (n.added) out.added = toTemplateNodes(n.added);
    if (n.nestedStructure) out.nestedStructure = toTemplateStructure(n.nestedStructure);
    return out;
  });
}

/** {@link toTemplateNodes}, exported for the guard that asserts a TEMPLATE carries no per-instance
 *  identity. Exported rather than made public because the function is an internal step of promotion
 *  and the test is about the invariant, not about the API. */
export const toTemplateNodesForTest = toTemplateNodes;

function toTemplateStructure(paths: NestedStructurePaths | undefined): NestedStructurePaths | undefined {
  if (!paths) return paths;
  const out: NestedStructurePaths = {};
  // `moved` never enters a template: its values are live scene guids (the rule `toTemplateNodes` states).
  for (const [k, { moved: _moves, ...v }] of Object.entries(paths)) out[k] = v.added ? { ...v, added: toTemplateNodes(v.added) } : v;
  return out;
}

/** Insert an added subtree into `prefab` with fresh localIds (continuing the BFS
 *  counter). The subtree root's parentId(localId) is set to `parentLocalId`;
 *  nested children point at their freshly-minted parent localId. guid is cleared
 *  (a prefab is a template). `nextId` is a mutable counter shared across calls. */
function insertAddedSubtree(
  prefab: PrefabFile,
  node: AddedEntity,
  parentLocalId: number,
  nextId: { v: number },
  /** Filled with each promoted node's live guid → the row it became, for a move into it (#1437). */
  rows?: Map<string, number>,
): void {
  const myLocalId = nextId.v++;

  // Reference node (a user-added nested instance) → write a nested-instance ROW,
  // mirroring serializePrefab. Its members come from the child prefab; its diffs
  // ride in the row's overrides/structure. The file becomes v2.
  if (node.prefab) {
    prefab.entities.push({
      localId: myLocalId,
      // A row that did not exist a moment ago: Apply promoted an added node into the template, so it
      // is a genuinely NEW node and mints (#1468). Nothing in the instance it came from held a
      // template identity for it — that is what "added" means.
      nodeGuid: newGuid(),
      name: node.name,
      traits: { EntityAttributes: { name: node.name, parentId: parentLocalId, guid: '' } },
      prefab: node.prefab,
      overrides: node.overrides,
      // The node was captured in SCENE form (live guids); a prefab row is a template (#1387).
      added: toTemplateNodes(node.added),
      removed: node.removed,
      removedTraits: node.removedTraits,
      // Both nested channels travel with the node (#1381): the node was the outermost layer for its
      // own nested rows, and once promoted the ROW is — so its slot becomes the row's.
      nestedOverrides: node.nestedOverrides,
      nestedStructure: toTemplateStructure(node.nestedStructure),
    });
    if (prefab.version < PREFAB_FORMAT_VERSION) prefab.version = PREFAB_FORMAT_VERSION;
    return;
  }

  const traits: Record<string, Record<string, unknown> | boolean> = {};
  for (const [name, data] of Object.entries(node.traits)) {
    if (name === 'PrefabInstance') continue;
    if (data === true) { traits[name] = true; continue; }
    // RE-EXPAND to the full schema on the way INTO a prefab. A scene's `added` bag is COMPACTED
    // (a field at its schema default is omitted — see snapshotAddedTraits), but a prefab FILE is
    // deliberately written FULL by serializePrefab, and the reason is a real consumer rather than
    // taste: Court's `layoutFromPrefabDoc` reads prefab fields BY NAME and its `num()` helper
    // returns null for a missing one, so the caller silently falls back to code constants. An
    // authored value that merely HAPPENS to equal its default would read as "not authored".
    //
    // Promotion is the one place the two conventions meet, so it is the one place that has to
    // convert. Without this, a child promoted out of an instance would land compacted beside
    // members written full — the same prefab file in two shapes, and only the promoted rows
    // misread. (Before compaction existed this was consistent by accident, which is exactly how a
    // change like that introduces a bug two subsystems away.)
    const meta = getTraitByName(name);
    const schema = (meta?.trait as { schema?: Record<string, unknown> } | undefined)?.schema;
    const bag: Record<string, unknown> = schema && typeof schema === 'object'
      ? { ...schema, ...(data as Record<string, unknown>) }   // AoS (function schema) stays as-is
      : { ...(data as Record<string, unknown>) };
    // Then the same two subtractions serializePrefab applies, or promotion would smuggle in what
    // a template must not carry: runtime read-back / scene-only fields, and BLANK asset refs
    // (`authoredAssetRefs.test.ts` fails the build on those, #53).
    if (meta) {
      for (const key of Object.keys(bag)) if (isTemplateExcludedField(meta, key)) delete bag[key];
      for (const field of REF_FIELDS_BY_TRAIT[name] ?? []) if (bag[field] === '') delete bag[field];
    }
    traits[name] = bag;
  }
  let ea = traits['EntityAttributes'];
  if (!ea || ea === true) { ea = {}; traits['EntityAttributes'] = ea; }
  (ea as Record<string, unknown>).parentId = parentLocalId;
  (ea as Record<string, unknown>).guid = '';
  prefab.entities.push({ localId: myLocalId, nodeGuid: newGuid(), name: node.name, traits });
  // A PLAIN row only: a reference node's row is a nested instance, whose children are another frame.
  if (node.guid) rows?.set(node.guid, myLocalId);
  for (const child of node.children) insertAddedSubtree(prefab, child, myLocalId, nextId, rows);
}

/** The members of the instance rooted at `rootId` — its own, and its owned nested instances' — that were moved
 *  OUT of its subtree (#1437), with everything under them. A delete of the subtree leaves them standing, but
 *  whatever respawns the instance respawns them, moved: a promotion must take them too. */
function membersLivingOutside(rootId: number): number[] {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return [];
  const all = getAllEntities();
  const links = all.map((e) => [e.id, e.parentId] as const);
  const inside = new Set(collectSubtreeIds(links, [rootId]));
  const identity = worldIdentityParents(getCurrentWorld());
  const frames = new Set([rootId]);
  const out: number[] = [];
  const frameOf = (id: number, pi: Record<string, unknown>): number => {
    if (pi.rootInstanceId !== id) return (pi.rootInstanceId as number) || 0;
    if (!pi.parentLocalId) return 0;
    return identity.ownerOf(id);
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const e of all) {
      const pi = e.traits.includes('PrefabInstance') ? readTraitData(e.id, piMeta) : null;
      if (!pi) continue;
      if (isOwnedRoot(pi, e.id) && frames.has(frameOf(e.id, pi)) && !frames.has(e.id)) { frames.add(e.id); grew = true; }
      if (inside.has(e.id) || !frames.has(frameOf(e.id, pi)) || e.id === rootId) continue;
      for (const id of collectSubtreeIds(links, [e.id])) inside.add(id);
      out.push(e.id);
      grew = true;
    }
  }
  return out;
}

/** A move made inside an owned NESTED instance of the instance at `rootInstanceId` to a parent outside that
 *  nested instance (#1437, owner's B): its own prefab cannot name the parent, so it is offered to the OUTER
 *  instance. `key` is `~moved.<nested row chain>:<row localId>` — the chain as `nestedStructure` keys it. */
/** `key` is the INTERNAL spelling (row localIds), what Apply/Revert match against once they have turned
 *  a caller's keys into it (`toLocalIdKeys`); `ref` is the one handed OUT, naming each row and the member
 *  by `nodeGuid` where it has one (#1468 Phase 4, `overrideKeyGrammar.ts`). */
export interface NestedFrameMove { key: string; ref: string; chain: number[]; lid: number; memberEcs: number; parentGuid: string; frameRoot: number }

export function nestedFrameMoves(rootInstanceId: number): NestedFrameMove[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return [];
  const all = getAllEntities();
  const identity = worldIdentityParents(getCurrentWorld());
  const piOf = (id: number) => readTraitData(id, piMeta) as { rootInstanceId?: number; parentLocalId?: number; localId?: number; source?: string } | null;
  /** The frame whose row expanded owned nested root `n`: its owner (`identityParents.ts`). */
  const frameAbove = (n: number): number => identity.ownerOf(n);
  const out: NestedFrameMove[] = [];
  const topDoc = getCachedPrefabSync(piOf(rootInstanceId)?.source ?? '');
  for (const e of all) {
    const pi = piOf(e.id);
    if (!pi || !isOwnedRoot(pi, e.id) || e.id === rootInstanceId) continue;
    const chain: number[] = [];
    let f = e.id;
    for (let n = 0; f && f !== rootInstanceId && n < 64; n++) {
      const p = piOf(f);
      if (!p?.parentLocalId) { f = 0; break; }
      chain.unshift(p.parentLocalId);
      f = frameAbove(f);
    }
    const doc = f === rootInstanceId ? getCachedPrefabSync(pi.source ?? '') : null;
    if (!doc) continue;
    const s = captureInstanceStructure(e.id, doc);
    if (!Object.keys(s.moved).length) continue;
    // A parent inside the nested instance — deeper nested ones included — is its own prefab's to record, UNLESS a
    // prefab around it places the member: that prefab's move wins over any the nested one makes, so only it can
    // take the member back (or elsewhere inside).
    const aroundBase = prefabMoveTargets(e.id, { ...doc, moved: undefined });
    const inFrame = new Set<string>();
    for (const [, t] of memberPathIndex(getCurrentWorld(), e.id)) {
      const g = t ? (t.get(eaMeta.trait) as { guid?: string }).guid : '';
      if (g) inFrame.add(g);
    }
    for (const [lidStr, parentGuid] of Object.entries(s.moved)) {
      const lid = Number(lidStr);
      const memberEcs = [...s.ownedNested].find(([, row]) => row === lid)?.[0]
        ?? all.find((m) => piOf(m.id)?.rootInstanceId === e.id && piOf(m.id)?.localId === lid && m.id !== e.id)?.id;
      if (!memberEcs || (inFrame.has(parentGuid) && !aroundBase(memberEcs))) continue;
      const key = `~moved.${chain.join('.')}:${lid}`;
      out.push({ key, ref: topDoc ? nestedMoveRef(topDoc, chain, lid, getCachedPrefabSync) : key, chain, lid, memberEcs, parentGuid, frameRoot: e.id });
    }
  }
  return out;
}

/** Rows of `prefab` whose member lives under another parent: the instance's own moves (`instanceMoved`, keyed by
 *  row) and the prefab's own moves of a ROW (a member path of rows only, ending in that row). */
function movedRowsOf(prefab: PrefabFile, instanceMoved: Record<number, string>): Set<number> {
  const out = new Set(Object.keys(instanceMoved).map(Number));
  const rows = new Map(prefab.entities.map((e) => [e.localId, e]));
  for (const key of Object.keys(prefab.moved ?? {})) {
    // Every step before the last a plain row: the path stays in this prefab's frame, and ends at a row.
    const steps = memberPathSteps(key);
    const last = steps[steps.length - 1];
    // Rows only: a `'+key'` step is a template-added node, not a row, and disqualifies the path — as
    // its `NaN` did before the shared parse (#1468 Phase 1).
    if (typeof last === 'number' && rows.has(last)
      && steps.slice(0, -1).every((st) => typeof st === 'number' && rows.has(st) && !rows.get(st)!.prefab)) out.add(last);
  }
  return out;
}

/** A user-added nested instance's own moves (#1437 P3-c), carried into the prefab it is being promoted into
 *  (as row `rowLid`): each becomes an entry of the prefab's own `moved`, the member addressed through the new
 *  row, its new parent in the promoted instance or in the prefab's frame (`instancePaths`, live guid → path).
 *  Read from the LIVE reference instance, which still stands. A move naming anything else is reported. */
function promoteReferenceMoves(
  prefab: PrefabFile, node: AddedEntity, rowLid: number, localToEcs: Map<number, number>, instancePaths: Map<string, MemberStep[]>,
): void {
  const refRoot = localToEcsGuid(node.guid);
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!refRoot || !piMeta || !eaMeta || !(node.members || node.moved)) return;
  const parentGuid = localToEcs.get(node.parentLocalId) ? guidForEntityId(localToEcs.get(node.parentLocalId)!) : '';
  const rowPath = [...(instancePaths.get(parentGuid) ?? []), rowLid];
  const inRef = new Map<string, MemberStep[]>();
  const byKey = memberPathIndex(getCurrentWorld(), refRoot);
  for (const [k, e] of byKey) {
    const g = e ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) inRef.set(g, memberPathSteps(k));
  }
  // Two sources since Phase 3 (#1468): the MEMBER ROWS, whose key names the member directly, and the
  // legacy `moved` map for the moves no row carries (a pre-v5 template), whose localId has to be
  // re-found — a row of this instance, or one of its owned nested roots stepping by that row.
  const moves = new Map<number, string>();
  for (const [ecsId, key] of memberRowKeysIn(refRoot)) {
    const target = node.members?.[key]?.parent;
    if (target) moves.set(ecsId, target);
  }
  for (const [lidStr, target] of Object.entries(node.moved ?? {})) {
    const lid = Number(lidStr);
    const member = [...byKey.values()].find((e) => {
      const pi = e?.get(piMeta.trait) as { rootInstanceId?: number; localId?: number; parentLocalId?: number } | undefined;
      return !!pi && (pi.rootInstanceId === e!.id() ? pi.parentLocalId === lid : pi.rootInstanceId === refRoot && pi.localId === lid);
    });
    if (member && !moves.has(member.id())) moves.set(member.id(), target);
  }
  for (const [ecsId, target] of moves) {
    const memberPath = inRef.get(guidForEntityId(ecsId));
    const targetPath = inRef.has(target) ? [...rowPath, ...inRef.get(target)!] : instancePaths.get(target);
    if (!memberPath || !targetPath) {
      console.warn(`[Prefab] a move inside the promoted instance "${node.name}" names something outside this prefab; it was not carried`);
      continue;
    }
    prefab.moved = { ...prefab.moved, [memberPathKey([...rowPath, ...memberPath])]: memberToken(0, targetPath) };
  }
}

/** Apply the selected overrides back to the source prefab file. `selectedKeys`
 *  holds a mix of (`<member>`: a nodeGuid, or a localId — `prefabOverrideKeys.ts`; both are
 *  turned into the localId form against this document on entry):
 *   - `"<member>.traitName.fieldName"` — overlay a live field value;
 *   - `"+added.<guid>"`               — insert an added child subtree;
 *   - `"-removed.<member>"`           — delete a prefab member (+ descendants);
 *   - `"-trait.<member>.<name>"`      — delete a component from a member;
 *   - `"~moved.<member>"` / `"~moved.<rows>:<member>"` — a move (#1437).
 *  Unselected diffs stay as per-instance overrides on the live instance. */
/** Outcome of an apply: how many live "added" subtrees were promoted into the
 *  prefab (and thus deleted from the scene). When > 0 the caller must re-save the
 *  current scene — those entities are now prefab members, so the scene's stale
 *  `added` structural overrides would otherwise re-spawn them as duplicates on
 *  the next load. */
export interface ApplyResult {
  promotedAdditions: number;
  /** True iff at least one override/structural change was actually written to the
   *  prefab. False ⇒ no-op apply (not an instance, nothing selected, write failed) —
   *  the caller must NOT push an undo entry. */
  applied: boolean;
  /** Source ref + before/after prefab snapshots, present only when `applied`. Lets
   *  the undo layer record a faithful before/after without re-reading state. */
  source?: string;
  prefabBefore?: PrefabFile;
  prefabAfter?: PrefabFile;
  /** Every `validatePrefabData` warning `warnInertPrefabSizes` reported for the written template (an
   *  inert size is one kind, not the only one), present only when `applied`. The editor Console
   *  already shows them; this is for a caller whose reader is not the Console — the agent `apply` op
   *  answers with them (#1258). */
  warnings?: string[];
  /** True when the apply re-parented a row (#1437: an applied move), which changes member PATHS and so the
   *  guids refs derive: the files on disk were repaired for it, and an undo/redo must repair them back. */
  memberPathsChanged?: boolean;
  /** What the repair of the OTHER files on disk did, when `memberPathsChanged`: the files rewritten, the ones
   *  left because an asset view holds them unsaved, or `null` when the backend could not do it at all. */
  fileRepair?: { rewritten: string[]; held: string[] } | null;
  /** Selected keys the apply could not write, each with the reason (a move it cannot express yet). */
  skipped?: { key: string; reason: string }[];
  /** Set when the apply REFUSED outright, with the reason for a human (#1468). Distinct from
   *  `skipped`, which means "everything else landed, these keys did not" — every reporter words it
   *  as a *move* that was not applied, because that is the only thing that has ever populated it.
   *  A refusal is the opposite shape: nothing landed, and there was no move. Sharing the channel
   *  produced "1 move was not applied: prefab format 6 is newer than 5", which is wrong twice over. */
  refused?: string;
}

/** Shared no-op result so every early return is consistent. */
const NOOP_APPLY: ApplyResult = { promotedAdditions: 0, applied: false };

/** Deep-copy a live trait bag before it is written into a prefab TEMPLATE.
 *  Mirrors `cloneTraitValues`, kept local so this module doesn't grow another
 *  entityUtils import. Falls back to the original bag if a value refuses to
 *  clone (a class instance, a function) — such a field can't be JSON-serialized
 *  into a prefab anyway, so the fallback costs nothing that wasn't already lost. */
function clonePersistable(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return data;
  try {
    return structuredClone(data);
  } catch {
    return data;
  }
}

export async function applyToPrefabSelective(
  rootInstanceId: number,
  selectedKeys: Set<string>,
): Promise<ApplyResult> {
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) {
    console.warn('[Prefab] Selected entity is not a prefab instance');
    return NOOP_APPLY;
  }
  const { source } = ctx;

  const oldPrefab = await getPrefabSource(source);
  if (!oldPrefab) {
    console.warn(`[Prefab] Cannot apply: source prefab not in cache: ${source}`);
    return NOOP_APPLY;
  }

  if (selectedKeys.size === 0) {
    console.log('[Prefab] Nothing selected; aborting apply.');
    return NOOP_APPLY;
  }

  // ⚠️ REFUSE a document a NEWER build wrote (#1468). Apply rewrites the whole file and stamps this
  // serializer's version onto it (below), which on a too-new document is a DOWNGRADE — the stamp
  // then claims a shape this build cannot produce, and the fields it added are attributed to a
  // serializer that never wrote them. `plugins/prefabWriteGuard.ts` would refuse the write anyway,
  // but a 409 arrives after the live world has already been mutated by the promotion pass, leaving
  // the editor holding changes the file rejected. Refusing here is the same verdict, delivered
  // before anything moves. Older documents are unaffected and still stamp forward: this is a
  // one-sided comparison, never `!==` — every authored prefab in the corpus is below the constant.
  if (typeof oldPrefab.version === 'number' && oldPrefab.version > PREFAB_FORMAT_VERSION) {
    console.error(
      `[Prefab] cannot apply to "${source}" — it was written by a newer build (prefab format ` +
      `${oldPrefab.version}; this build writes ${PREFAB_FORMAT_VERSION}). Applying would rewrite ` +
      'the document with this build\'s serializer and re-stamp it downwards, discarding whatever ' +
      'the newer format added. Update this build, or apply from the build that wrote the file.',
    );
    return {
      ...NOOP_APPLY,
      refused: `"${source}" was written by a newer build (prefab format ${oldPrefab.version}; this build writes ${PREFAB_FORMAT_VERSION})`,
    };
  }

  // Warm THIS instance's live subtree before the structural capture below (#1284). The
  // per-root loop further down is a different set and comes far too late: `captureNestedRef`
  // runs inside the capture at `const structure = ...`, and on a cold cache it returns null
  // and the user-added nested subtree is dropped from `added[]` entirely.
  await preloadNestedPrefabsForSubtree(rootInstanceId);

  // Deep-clone the old prefab and overlay selected live values onto it. A second
  // pristine clone is the `before` snapshot for undo (oldPrefab itself isn't mutated,
  // but cloning guards against any aliasing into the cache).
  let newPrefab: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  // Stamp the format version: this rewrites the WHOLE document with today's serializer
  // semantics, so leaving a legacy `1` on it would be the #379 dishonesty in the other
  // direction — a v2-written file claiming v1. Found by the #379 close-out review, which
  // caught that the sweep for writers grepped for the token `version` and so could not see
  // a writer whose defect is that it never mentions it.
  newPrefab.version = PREFAB_FORMAT_VERSION;
  // NOT stamped on the undo snapshot: `installPrefabSnapshot` replays the BEFORE bytes, and
  // those must be what was actually on disk, version included.
  const prefabBefore: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return NOOP_APPLY;
  const eaMetaForApply = getTraitByName('EntityAttributes');

  // Build localId → ecsId map for this instance so we can read live values
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });

  // Live member guid → its path in this instance, for the value overlay below (#1352).
  const instancePaths = new Map<string, MemberStep[]>();
  if (eaMetaForApply) {
    for (const [key, target] of memberPathIndex(getCurrentWorld(), rootInstanceId)) {
      const guid = target ? (target.get(eaMetaForApply.trait) as { guid?: string }).guid : '';
      if (guid) instancePaths.set(guid, memberPathSteps(key));
    }
  }
  const tokenizeForInstance = (v: unknown): unknown => mapStringValues(v, (str) => {
    const p = instancePaths.get(str);
    return p ? memberToken(0, p) : str;
  });

  // Capture the live structural diff so `+added`/`-removed`/`-trait` keys can be
  // resolved to concrete subtrees / localIds.
  const structure = captureInstanceStructure(rootInstanceId, oldPrefab);
  const addedByGuid = new Map<string, AddedEntity>();
  for (const node of structure.added) addedByGuid.set(node.guid, node);

  let writtenCount = 0;
  const liveAddedRootsToDelete: number[] = []; // live ecs roots whose adds were applied
  const nextLocalId = { v: Math.max(0, ...newPrefab.entities.map((e) => e.localId)) + 1 };
  let rowsReparented = false;
  const skipped: { key: string; reason: string }[] = [];
  const movedKeys: string[] = [];
  const promotedRows = new Map<string, number>(); // live guid of a promoted added node → its new row
  // The row a live entity of THIS frame is: the root, a member, or an owned nested root (its row).
  const rowOfEcs = new Map<number, number>([[rootInstanceId, newPrefab.rootLocalId ?? 1]]);
  for (const [lid, ecs] of localToEcs) rowOfEcs.set(ecs, lid);
  for (const [ecs, row] of structure.ownedNested) rowOfEcs.set(ecs, row);
  const ecsOfRow = new Map([...rowOfEcs].map(([ecs, row]) => [row, ecs]));

  // Every key in its localId form against the document this instance was expanded from (#1468 Phase 4,
  // `overrideKeyGrammar.ts`): a key names its member by `nodeGuid` where it can, which survives a template
  // renumber between listing the keys and applying them; from here on a localId is right because it is
  // read against the one document in hand. A key naming a member this document does not have is reported,
  // never guessed at.
  const canon = toLocalIdKeys(selectedKeys, oldPrefab, getCachedPrefabSync);
  selectedKeys = canon.keys;
  for (const key of canon.unresolved) skipped.push({ key, reason: 'it names no member of this prefab — the template has changed since the key was listed' });

  for (const key of selectedKeys) {
    // Structural: a member moved inside its instance (#1437) — after every addition, below, since one of
    // them may be the new parent.
    if (key.startsWith('~moved.')) { movedKeys.push(key); continue; }
    // Structural: insert an added subtree.
    if (key.startsWith('+added.')) {
      const guid = key.slice('+added.'.length);
      const node = addedByGuid.get(guid);
      if (!node) continue;
      if (addedNestsPrefab(node, oldPrefab.id || source)) { skipped.push({ key, reason: 'it holds an instance of this prefab, and a prefab cannot contain itself' }); continue; }
      const rowLid = nextLocalId.v;
      insertAddedSubtree(newPrefab, node, node.parentLocalId, nextLocalId, promotedRows);
      if (node.prefab && (node.members || node.moved)) promoteReferenceMoves(newPrefab, node, rowLid, localToEcs, instancePaths);
      const liveEcs = localToEcsGuid(guid);
      if (liveEcs) liveAddedRootsToDelete.push(liveEcs, ...(node.prefab ? membersLivingOutside(liveEcs) : []));
      writtenCount++;
      continue;
    }
    // Structural: remove a prefab member (and its descendants).
    if (key.startsWith('-removed.')) {
      const localId = Number(key.slice('-removed.'.length));
      // The cascade stops at a MOVED member, as the loader's does (#1437): it lives elsewhere, and so does
      // everything below it. Its row goes up to the nearest row that stays — a re-parent, so its refs follow.
      const moved = movedRowsOf(newPrefab, structure.moved);
      const parentOf = new Map(newPrefab.entities.map((e) => [e.localId, ((e.traits.EntityAttributes as { parentId?: number } | undefined)?.parentId) ?? 0]));
      const drop = new Set<number>();
      const kept: number[] = [];
      const cut = (lid: number) => {
        drop.add(lid);
        for (const [child, parent] of parentOf) {
          if (parent !== lid || drop.has(child)) continue;
          if (moved.has(child)) kept.push(child);
          else cut(child);
        }
      };
      cut(localId);
      const before = newPrefab.entities.length;
      const removedRows = new Map(newPrefab.entities.filter((e) => drop.has(e.localId)).map((e) => [e.localId, e]));
      newPrefab.entities = newPrefab.entities.filter((e) => !drop.has(e.localId));
      // A row the PREFAB's own move places holds a pose relative to that target, not to the removed row — while
      // the target survives: a move whose target this removal takes is dropped, and the row lands as the rows did.
      const rowById = new Map(newPrefab.entities.concat([...removedRows.values()]).map((e) => [e.localId, e]));
      const placedByPrefab = new Set<number>();
      for (const [key, token] of Object.entries(newPrefab.moved ?? {})) {
        const t = parseMemberToken(token);
        const steps = memberPathSteps(key);
        const lid = steps[steps.length - 1];
        if (!t || t.up || typeof lid !== 'number'
          || !movedRowsOf({ ...newPrefab, entities: [...rowById.values()], moved: { [key]: token } }, {}).has(lid)) continue;
        // The target's steps in THIS frame: rows up to and including the first nested one.
        let dead = false;
        for (const st of t.path) {
          if (typeof st !== 'number' || drop.has(st)) { dead = typeof st === 'number'; break; }
          if (rowById.get(st)?.prefab) break;
        }
        if (!dead) placedByPrefab.add(lid);
      }
      const trsOf = (lid: number) => {
        const tf = removedRows.get(lid)?.traits.Transform;
        return mergeTrs(IDENTITY_TRS, tf && tf !== true ? tf : {});
      };
      for (const lid of kept) {
        const row = newPrefab.entities.find((e) => e.localId === lid)!;
        // Its pose was relative to the removed rows: carried through them, so it stays where it was.
        let up = parentOf.get(lid) ?? 0;
        const tf = row.traits.Transform;
        let pose = mergeTrs(IDENTITY_TRS, tf && tf !== true ? tf : {});
        while (drop.has(up)) { if (!placedByPrefab.has(lid)) pose = localToWorldTrs(pose, trsOf(up)); up = parentOf.get(up) ?? 0; }
        if (tf && tf !== true && !placedByPrefab.has(lid)) row.traits.Transform = { ...tf, ...pose };
        row.traits.EntityAttributes = { ...(row.traits.EntityAttributes as Record<string, unknown>), parentId: up };
        rowsReparented = true;
      }
      if (newPrefab.entities.length !== before) writtenCount++;
      continue;
    }
    // Structural: remove a component from a member.
    if (key.startsWith('-trait.')) {
      const [, localIdStr, traitName] = key.split('.');
      const prefabEntity = newPrefab.entities.find((e) => e.localId === Number(localIdStr));
      if (prefabEntity && traitName in prefabEntity.traits) {
        delete prefabEntity.traits[traitName];
        writtenCount++;
      }
      continue;
    }

    // Value override: overlay a live field value.
    const [localIdStr, traitName, fieldName] = key.split('.');
    const localId = Number(localIdStr);
    const ecsId = localToEcs.get(localId);
    if (!ecsId) continue;
    const meta = getTraitByName(traitName);
    if (!meta || meta.category === 'tag') continue;
    // Accept any field the trait PERSISTS, and read the same way. Both used to key
    // on meta.fields, so applying an override over a field owned by a custom
    // Inspector section (Animator.clips/clip) was skipped HERE and would have read
    // undefined anyway — "Apply to Prefab" reported success and changed nothing.
    // See runtime/core/ecs/traitSchema.ts.
    if (!isPersistentTraitField(meta, fieldName)) continue;
    if (isTemplateExcludedField(meta, fieldName)) continue; // read-back / scene-only: never in a template

    // CLONE: readTraitDataFull hands back LIVE references into the trait store, and
    // widening the read above admitted AoS object/array fields (AnimationLibrary's
    // animSets/boneMaps) that the meta.fields gate used to exclude. Storing one in
    // the prefab would alias the template to THIS instance through prefabCache —
    // editing the instance would silently rewrite the template. Scalars are
    // unaffected; the clone is per applied field, not per frame.
    const liveData = clonePersistable(readTraitDataFull(ecsId, meta));
    if (!liveData) continue;
    // A ref to another member of this instance goes into the template as a member token (#1352).
    const liveValue = tokenizeForInstance(liveData[fieldName]);

    const prefabEntity = newPrefab.entities.find((e) => e.localId === localId);
    if (!prefabEntity) continue;
    let traitBag = prefabEntity.traits[traitName];
    if (traitBag === true) continue; // already a tag in the prefab — nothing to set
    if (!traitBag) {
      // Added component: the prefab lacks this trait at this localId, so the user
      // added it on the instance. Seed the prefab with the WHOLE live trait so
      // applying actually persists the new component — without this the trait was
      // silently dropped (the ShipShake bug). Subsequent field keys for the same
      // trait then overlay onto this bag. runtimeOnly fields are dropped: a
      // template must not carry one instance's read-back frame.
      traitBag = {};
      for (const [k, v] of Object.entries(liveData)) {
        if (!isTemplateExcludedField(meta, k)) (traitBag as Record<string, unknown>)[k] = v;
      }
      prefabEntity.traits[traitName] = traitBag;
    }
    (traitBag as Record<string, unknown>)[fieldName] = liveValue;
    writtenCount++;
  }

  // Moves (#1437). The new parent decides how the prefab says it:
  //  - a row of this frame, or a node promoted by this apply: the member's row is RE-PARENTED (its path, and so
  //    its guid and every guid below, change — the ref repair after the write follows them);
  //  - a member of a NESTED instance, which no row of this prefab is: a prefab-level `moved` entry names it by
  //    member token (P3-b), and the row keeps its parent — and the member its identity.
  // Either way the row takes the live Transform, which is relative to the new parent.
  const addedGuids = new Set<string>();
  const collectAdded = (nodes: AddedEntity[]) => { for (const n of nodes) { if (n.guid) addedGuids.add(n.guid); collectAdded(n.children ?? []); } };
  collectAdded(structure.added);
  let nestedMoves: Map<string, NestedFrameMove> | null = null;
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  for (const key of movedKeys) {
    // A NESTED instance's member moved out of it (owner's B): this prefab records it as its own move, by path,
    // and the member's pose as an override on the nested row. The nested prefab is not touched.
    if (key.includes(':')) {
      nestedMoves ??= new Map(nestedFrameMoves(rootInstanceId).map((m) => [m.key, m]));
      const m: NestedFrameMove | undefined = nestedMoves.get(key);
      if (!m) continue;
      const memberPath = instancePaths.get(guidForEntityId(m.memberEcs));
      const targetPath = addedGuids.has(m.parentGuid) ? undefined : instancePaths.get(m.parentGuid);
      if (!memberPath || !targetPath) {
        skipped.push({ key, reason: addedGuids.has(m.parentGuid) ? 'its new parent was added in this scene' : 'its new parent is not part of this prefab instance' });
        continue;
      }
      // Back at the parent it derives from — its template parent (`identityParents.ts`): the outer prefab stops
      // moving it.
      const tpl = (identity ??= worldIdentityParents(getCurrentWorld())).of(m.memberEcs);
      const memberPi = readTraitData(m.memberEcs, PrefabInstanceMeta);
      const pathKey = memberPathKey(memberPath);
      // Back only when nothing was removed between: past a deleted template row, the ancestor it now walks
      // from is a new place, not its row (third-review F3).
      if (!tpl.extra.length && guidForEntityId(tpl.parentId) === m.parentGuid) {
        if (newPrefab.moved) { delete newPrefab.moved[pathKey]; if (!Object.keys(newPrefab.moved).length) delete newPrefab.moved; }
      } else {
        newPrefab.moved = { ...newPrefab.moved, [pathKey]: memberToken(0, targetPath) };
      }
      // The pose, as an override on the instance the member is a member of: a plain member's own frame (by its
      // row), an owned nested ROOT's own instance (by that prefab's root row), below the nested row.
      const tfMeta = getTraitByName('Transform');
      const liveTf = tfMeta ? clonePersistable(readTraitDataFull(m.memberEcs, tfMeta)) : null;
      const nestedRow = newPrefab.entities.find((e) => e.localId === m.chain[0] && e.prefab);
      const ownRoot: boolean = memberPi?.rootInstanceId === m.memberEcs;
      const poseChain = ownRoot ? [...m.chain, m.lid] : m.chain;
      const poseLid = ownRoot ? (getCachedPrefabSync((memberPi?.source as string) || '')?.rootLocalId ?? 1) : m.lid;
      if (tfMeta && liveTf && nestedRow) {
        const bag: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(liveTf)) if (!isTemplateExcludedField(tfMeta, k)) bag[k] = v;
        if (poseChain.length === 1) {
          const ov = { ...nestedRow.overrides };
          ov[poseLid] = { ...ov[poseLid], Transform: { ...ov[poseLid]?.Transform, ...bag } };
          nestedRow.overrides = ov;
        } else {
          const path = poseChain.slice(1).join('.');
          const paths = { ...nestedRow.nestedOverrides };
          const at = { ...paths[path] };
          at[poseLid] = { ...at[poseLid], Transform: { ...at[poseLid]?.Transform, ...bag } };
          paths[path] = at;
          nestedRow.nestedOverrides = paths;
        }
      }
      writtenCount++;
      continue;
    }
    const lid = Number(key.slice('~moved.'.length));
    const parentGuid = structure.moved[lid];
    const row = newPrefab.entities.find((e) => e.localId === lid);
    const memberEcs = ecsOfRow.get(lid);
    if (!parentGuid || !memberEcs) continue;
    if (!row) { skipped.push({ key, reason: 'its row was removed by this apply' }); continue; }
    if (prefabMoveTargets(rootInstanceId, { ...oldPrefab, moved: undefined })(memberEcs)) {
      skipped.push({ key, reason: 'a prefab containing this instance places it — apply the move from that instance' });
      continue;
    }
    // A nested instance's ROOT is a row too, but not one to hang a row under: its children are the nested
    // prefab's frame, whose own rows step by the same localIds — a moved row's path would equal one of theirs,
    // and the two would derive one guid. A move there is the prefab's own `moved`, like any nested member.
    const targetEcs = localToEcsGuid(parentGuid);
    const parentRow = (structure.ownedNested.has(targetEcs) ? undefined : rowOfEcs.get(targetEcs)) ?? promotedRows.get(parentGuid);
    // Never a node the SCENE added: the index lists a user-added instance's root as a target, but no other
    // instance of the prefab has it.
    const token = parentRow === undefined && !addedGuids.has(parentGuid) && instancePaths.has(parentGuid)
      ? memberToken(0, instancePaths.get(parentGuid)!) : '';
    if (parentRow === undefined && !token) {
      const promotedRef = structure.added.some((n) => n.prefab && n.guid === parentGuid) && selectedKeys.has(`+added.${parentGuid}`);
      skipped.push({ key, reason: promotedRef
        ? 'its new parent is a nested instance this apply adds to the prefab — apply the move again afterwards'
        : addedGuids.has(parentGuid)
          ? 'its new parent was added in this scene — apply that addition too'
          : readTraitData(rootInstanceId, PrefabInstanceMeta)?.parentLocalId
            ? 'its new parent is outside this nested instance — apply it from the instance that contains both'
            : 'its new parent is not part of this prefab instance' });
      continue;
    }
    const ea = row.traits.EntityAttributes;
    const eaBag = { ...(ea && ea !== true ? ea : {}) } as Record<string, unknown>;
    const memberPath = memberPathKey(instancePaths.get(guidForEntityId(memberEcs)) ?? []);
    if (parentRow !== undefined) {
      if (eaBag.parentId !== parentRow) rowsReparented = true;
      row.traits.EntityAttributes = { ...eaBag, parentId: parentRow };
      if (newPrefab.moved) delete newPrefab.moved[memberPath];
    } else {
      newPrefab.moved = { ...newPrefab.moved, [memberPath]: token };
    }
    if (newPrefab.moved && !Object.keys(newPrefab.moved).length) delete newPrefab.moved;
    const tfMeta = getTraitByName('Transform');
    const liveTf = tfMeta ? clonePersistable(readTraitDataFull(memberEcs, tfMeta)) : null;
    if (tfMeta && liveTf) {
      const bag: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(liveTf)) if (!isTemplateExcludedField(tfMeta, k)) bag[k] = v;
      const had = row.traits.Transform;
      row.traits.Transform = { ...(had && had !== true ? had : {}), ...bag };
    }
    writtenCount++;
  }

  // Reported in the caller's own spelling, not the internal one it was turned into above.
  for (const x of skipped) x.key = canon.original.get(x.key) ?? x.key;
  for (const { key, reason } of skipped) console.warn(`[Prefab] ${key} was not applied: ${reason}`);
  if (writtenCount === 0) {
    console.log('[Prefab] No applicable overrides to apply.');
    return skipped.length ? { ...NOOP_APPLY, skipped } : NOOP_APPLY;
  }

  // A re-parented row moves the PATH of it and everything below it, which is what a template's member
  // tokens name them by (#1437): the prefab's own tokens follow first, then the guids live refs hold.
  const prefabId = newPrefab.id;
  const readOld: PrefabReader = (g) => (g === prefabId ? oldPrefab : getCachedPrefabSync(g));
  const readNew: PrefabReader = (g) => (g === prefabId ? newPrefab : getCachedPrefabSync(g));
  if (rowsReparented && prefabId) {
    await preloadNestedPrefabs(newPrefab);
    newPrefab = (rewritePrefabMemberTokens(newPrefab as never, prefabId, readOld, readNew) as PrefabFile | null) ?? newPrefab;
  }
  // A move of the prefab's own whose member or new parent this apply removed names nothing now.
  if (newPrefab.moved && prefabId) {
    const paths = new Set(['', ...memberPathRecords({ prefab: prefabId }, readNew).self.keys()]);
    const live = Object.entries(newPrefab.moved).filter(([k, v]) => {
      const t = parseMemberToken(v);
      return paths.has(k) && !!t && !t.up && paths.has(memberPathKey(t.path));
    });
    if (live.length !== Object.keys(newPrefab.moved).length) newPrefab.moved = live.length ? Object.fromEntries(live) : undefined;
    if (!newPrefab.moved) delete newPrefab.moved;
  }

  const warnings = warnInertPrefabSizes(newPrefab, source);
  const ok = await writePrefabFile(source, newPrefab);
  if (!ok) return NOOP_APPLY;

  // Delete the live plain entities for applied additions BEFORE refresh, so the
  // re-instantiated prefab member replaces them instead of duplicating. Non-applied
  // additions stay live and are re-captured + re-spawned by the refresh.
  if (liveAddedRootsToDelete.length) deleteEntities(liveAddedRootsToDelete);

  prefabCache.set(source, newPrefab);
  // Every instance of this source, with NO exclusion — the clicked one goes through
  // capture/restore too, so fields the user just applied drop out of its override set
  // on the next render because they now match the prefab base.
  const rootsToRefresh = collectInstanceRoots(source);
  // refreshInstances re-instantiates synchronously, so warm both halves first: the new
  // file's own reference rows...
  await preloadNestedPrefabs(newPrefab);
  // ...and the LIVE tree of each instance. A user-added nested instance is not a row of
  // newPrefab, so the file walk above never reaches it, and captureNestedInstanceOverrides
  // would then drop its per-copy overrides with no warning at all (#1284).
  for (const rootId of rootsToRefresh) await preloadNestedPrefabsForSubtree(rootId);
  const remap = rowsReparented && prefabId ? liveMemberGuidRemap(prefabId, readOld, readNew, rootsToRefresh) : new Map<string, string>();
  refreshInstances(source, rootsToRefresh, oldPrefab, newPrefab, remap);
  if (remap.size) remapWorldGuidRefs(remap);
  // …and every other file that uses the prefab. The open scene's own file too: its live world is already
  // repaired, and the next save writes that.
  const fileRepair = rowsReparented && prefabId ? await repairPrefabMemberPaths(prefabId, oldPrefab) : undefined;

  // Those promoted additions are now prefab members in the live world, but the
  // scene file on disk still lists them as `added` structural overrides. The
  // caller must re-save the scene so a later load doesn't re-spawn them on top of
  // the now-expanded prefab member (the duplicate-flame bug).
  return {
    promotedAdditions: liveAddedRootsToDelete.length,
    applied: true,
    source,
    prefabBefore,
    prefabAfter: newPrefab,
    warnings,
    ...(rowsReparented ? { memberPathsChanged: true, fileRepair } : {}),
    ...(skipped.length ? { skipped } : {}),
  };
}

/** Old → new guid of every LIVE member of an instance in `roots` whose derived path differs between the
 *  two documents `readOld` and `readNew` give prefab `prefabId` (#1437: an applied move). Members pair by
 *  identity (`memberPathRecords`). A member derives from the anchor the entity above its path gives: a
 *  row's, from its instance root; an ORPHAN row's (parentId 0 or no row, hung off the instance's parent),
 *  from that parent. An entity whose guid is not derived anchors what is below it on its own guid; a
 *  derived one (a member, an owned nested root) hands on its own anchor and path, found by walking up as
 *  `deriveInstanceMemberGuids` did, to the ancestor whose guid derives it. What cannot be recovered maps
 *  nothing. */
function liveMemberGuidRemap(prefabId: string, readOld: PrefabReader, readNew: PrefabReader, roots: readonly number[]): Map<string, string> {
  const remap = new Map<string, string>();
  type Place = { tag: 'self' | 'parent'; path: string };
  const places = (read: PrefabReader): Map<string, Place> => {
    const r = memberPathRecords({ prefab: prefabId }, read, { orphans: 'parent' });
    const out = new Map<string, Place>();
    for (const tag of ['self', 'parent'] as const) for (const [path, id] of r[tag]) if (!out.has(id)) out.set(id, { tag, path });
    return out;
  };
  const before = places(readOld);
  const after = places(readNew);
  const moves: [Place, Place][] = [];
  for (const [id, was] of before) {
    const now = after.get(id);
    if (now && (now.path !== was.path || now.tag !== was.tag)) moves.push([was, now]);
  }
  const piMeta = getTraitByName('PrefabInstance');
  if (!moves.length || !piMeta) return remap;
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const identity = worldIdentityParents(getCurrentWorld());
  const derived = (id: number): boolean =>
    isDerivedMember(readTraitData(id, piMeta) as MemberPi, id, templateKeyOf(findEntity(id)));
  /** The anchor and path prefix what hangs below `id` derives from. */
  const below = (id: number): { anchor: string; prefix: string } | null => {
    const top = byId.get(id);
    if (!top?.guid) return null;
    if (!derived(id)) return { anchor: top.guid, prefix: '' };
    const steps: (number | string)[] = [];
    for (let cur = top, n = 0; n < 10_000; n++) {
      const pi = readTraitData(cur.id, piMeta);
      const key = templateKeyOf(findEntity(cur.id));
      const at = identity.of(cur.id);
      steps.unshift(...at.extra, entityStep(pi as MemberPi, key));
      const up = byId.get(at.parentId);
      if (!up) return null;
      if (up.guid && deriveMemberGuid(up.guid, steps) === top.guid) return { anchor: up.guid, prefix: memberPathKey(steps) };
      cur = up;
    }
    return null;
  };
  for (const rootId of roots) {
    const self = below(rootId);
    // An owned nested root's orphan rows expand under nothing (the loader's rule): only a stored root has them.
    const parent = readTraitData(rootId, piMeta)?.parentLocalId ? null : below(byId.get(rootId)?.parentId ?? 0);
    // ⚠️ A member whose identity is STORED does not move with the row (v16, #1468). This whole
    // function exists because a re-parented row used to change the guid its members DERIVE, so every
    // ref had to be re-pointed; with a row, `restoreInstanceMembers` puts the member's own guid back
    // after the rebuild and it never becomes the new derived value. Remapping it anyway sends every
    // ref to a guid no entity holds — the two repairs fighting, each correct about a different
    // engine. Only a member that still derives is remapped.
    const stored = new Set<string>();
    for (const id of memberRowsToWrite(rootId).keys()) {
      const g = byId.get(id)?.guid;
      if (g) stored.add(g);
    }
    const at = (p: Place): string | null => {
      const ctx = p.tag === 'self' ? self : parent;
      return ctx ? deriveMemberChain(ctx.anchor, ctx.prefix ? `${ctx.prefix}.${p.path}` : p.path) : null;
    };
    for (const [was, now] of moves) {
      const from = at(was);
      const to = at(now);
      if (from && to && from !== to && !stored.has(from)) remap.set(from, to);
    }
  }
  return remap;
}

/** Resolve a live entity id to its stable EntityAttributes.guid ('' if none). Used by
 *  Apply-to-Prefab undo to re-find the selected entity after a scene rebuild (which
 *  mints new ECS ids but preserves guids). */
export function guidForEntityId(id: number): string {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return '';
  const d = readTraitData(id, eaMeta);
  return (d?.guid as string) || '';
}

/** Public alias for guid → live ECS id resolution (0 if none). */
export function entityIdForGuid(guid: string): number { return localToEcsGuid(guid); }

/** Resolve a stable EntityAttributes.guid to its live ECS id, or 0 if none.
 *  O(1) via the maintained guid→entity index (self-heals on miss). */
function localToEcsGuid(guid: string): number {
  if (!guid) return 0;
  const ent = findEntityByGuid(guid);
  return ent ? ent.id() : 0;
}

/** Build a key set of every live override on the instance, then call
 *  applyToPrefabSelective. Kept for the "apply everything" path used by
 *  programmatic callers (and as the legacy menu's behavior). */
export async function applyToPrefab(selectedEntityId: number): Promise<void> {
  const ctx = resolveInstanceContext(selectedEntityId);
  if (!ctx) {
    console.warn('[Prefab] Selected entity is not a prefab instance');
    return;
  }
  const { rootInstanceId, source } = ctx;
  const prefab = await getPrefabSource(source);
  if (!prefab) {
    console.warn(`[Prefab] Cannot apply: source prefab not in cache: ${source}`);
    return;
  }
  // `captureInstanceStructure` below reads nested children from the cache SYNCHRONOUSLY
  // (`captureInstanceOverrides` does not — it only diffs trait bags against the world), and this
  // path builds the key set that applyToPrefabSelective then acts on. So a cold miss here does
  // not just hide a row, it silently drops the subtree from an "apply EVERYTHING" action (#1284).
  await preloadNestedPrefabsForSubtree(rootInstanceId);
  const all = captureInstanceOverrides(rootInstanceId, prefab);
  const keys = new Set<string>();
  for (const [localId, traits] of Object.entries(all)) {
    for (const [trait, fields] of Object.entries(traits)) {
      for (const field of Object.keys(fields)) keys.add(`${localId}.${trait}.${field}`);
    }
  }
  // Structural diffs too — added subtrees, removed members, removed components.
  const structure = captureInstanceStructure(rootInstanceId, prefab);
  for (const node of structure.added) keys.add(`+added.${node.guid}`);
  for (const localId of structure.removed) keys.add(`-removed.${localId}`);
  for (const [localId, names] of Object.entries(structure.removedTraits)) {
    for (const name of names) keys.add(`-trait.${localId}.${name}`);
  }
  for (const localId of Object.keys(structure.moved)) keys.add(`~moved.${localId}`); // #1437
  for (const m of nestedFrameMoves(rootInstanceId)) keys.add(m.key);
  await applyToPrefabSelective(rootInstanceId, keys);
}

/** A live per-copy customization on a NESTED instance, captured before an outer
 *  rebuild so it can be re-applied after re-expansion. `chain` is the sequence of
 *  `parentLocalId`s from the outer root down to this nested root — a stable
 *  address that survives the id churn (the prefab structure is deterministic). */
interface NestedInstanceCapture {
  chain: number[];
  source: string;
  overrides: Record<number, Record<string, Record<string, unknown>>>;
  structure: InstanceStructure;
  /** Template-authored added nodes the scene EDITED: the fresh expansion spawns each one again, so the
   *  re-apply deletes that copy before it spawns the captured one (#1386). `key` is empty for a legacy
   *  node matched by its file guid. */
  replace: { key: string; guid: string }[];
}

/** Capture every NESTED prefab instance inside the live subtree under
 *  `outerRootId` (each captured against its OWN child prefab). Without this an
 *  outer rebuild re-expands nested rows straight from the file, discarding any
 *  per-copy override the user made on a specific nested child (design risk R3).
 *
 *  Each capture is the live instance MINUS what the prefab chain of `baseline` already applies to it
 *  (#1386, #1401) — `baseline` being the outer document the live tree was expanded FROM (a refresh's
 *  old file). The fresh expansion re-produces that part itself, so restating it is wrong both ways: an
 *  `added` node is not idempotent and spawned twice, and a restated row value froze the OLD value over
 *  a refreshed one. What remains is the scene's own edit, which is the only thing the re-apply owes. */
function captureNestedInstanceOverrides(outerRootId: number, baseline: PrefabFile): NestedInstanceCapture[] {
  const outer = expandedFrom;
  expandedFrom = new Map([...(outer ?? []), [outerRootId, baseline]]);
  try { return captureNestedInstanceOverridesIn(outerRootId, baseline); } finally { expandedFrom = outer; }
}

function captureNestedInstanceOverridesIn(outerRootId: number, baseline: PrefabFile): NestedInstanceCapture[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];

  const all = getAllEntities();
  const byId = new Map<number, EntityInfo>();
  const childrenOf = new Map<number, number[]>();
  for (const e of all) {
    byId.set(e.id, e);
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e.id);
  }
  const piOf = (id: number) => readTraitData(id, PrefabInstanceMeta) as Record<string, unknown> | null;
  const rootOf = (id: number) => (piOf(id)?.rootInstanceId as number) ?? 0;
  const isNestedRoot = (id: number) => {
    const pi = piOf(id);
    return !!pi && pi.rootInstanceId === id && id !== outerRootId;
  };
  // parentLocalId path from the outer root down to nested root `n` — or null when the climb does not
  // REACH the outer root (#1383). It stops early at a plain node (an `added[]` node has no
  // PrefabInstance, so `rootOf` answers 0), and the partial chain it held addressed a DIFFERENT
  // instance from the outer root: a stamped instance under a plain node wrote its overrides onto the
  // real row's expansion. Such an instance is not a row expansion of this outer at all — the outer
  // structure capture carries it whole, as a reference node under that plain node.
  const identity = worldIdentityParents(getCurrentWorld());
  const chainOf = (n: number): number[] | null => {
    const chain: number[] = [];
    let cur = n, guard = 0;
    while (cur && cur !== outerRootId && guard++ < 64) {
      const pi = piOf(cur);
      if (!pi) break;
      chain.unshift((pi.parentLocalId as number) || 0);
      // Climb to the parent instance's root by IDENTITY: a nested root moved out of its frame (#1437) is still
      // that frame's row, and a chain read from its live parent addressed a different instance. An OWNED root
      // climbs to its owner — its template parent can be another nested ROOT (a nested row under a nested row),
      // whose own frame is not the one holding the row.
      cur = pi.parentLocalId ? identity.ownerOf(cur) : rootOf(identity.parentOf(cur));
    }
    return cur === outerRootId ? chain : null;
  };
  // guid → template key of each added node hanging directly under a member of nested root `n` (the
  // level a structure capture's `added` lists). The marker first; a node that lost it (Play→Stop, an
  // undo respawn) recovers it from its derived guid.
  const recoverMemo = new Map<number, string>();
  const addedKeysOf = (n: number): Map<string, string> => {
    const out = new Map<string, string>();
    for (const e of all) {
      if (rootOf(e.id) !== n) continue;
      for (const c of childrenOf.get(e.id) ?? []) {
        if (rootOf(c) === n) continue; // a member, not an added node
        const guid = durableGuid(byId.get(c)?.guid);
        const key = templateKeyOf(findEntity(c)) || recoverTemplateKey(c, recoverMemo);
        if (guid && key) out.set(guid, key);
      }
    }
    return out;
  };

  // The chain's member tokens resolved to the live guids they name (`baseTokenResolver`: the nested
  // root's own frame, `^` climbing to the instance whose row expanded it). The loader applies every
  // value an instance receives — its row's, and whatever an outer layer forwarded — in THAT frame.
  // The live capture holds guids, so an unresolved token never compared equal: a token-bearing row
  // value or node read as a scene edit and froze the old template (#1386 review). A REFERENCE node's
  // payload is in its own instance's frame, so it is left whole, as `rebaseAddedTokens` leaves it.
  const resolveNodes = (resolve: (v: unknown) => unknown, nodes: AddedEntity[] | undefined): AddedEntity[] | undefined =>
    nodes?.map((n) => (n.prefab ? n : {
      ...n, traits: resolve(n.traits) as AddedEntity['traits'], children: resolveNodes(resolve, n.children) ?? [],
    }));

  const captures: NestedInstanceCapture[] = [];
  const seen = new Set<number>();
  const stack = [outerRootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    // Only instances reached through a chain of ROW expansions. A `0` in the chain is a user-added
    // (reference-node) instance, and everything under one is carried BY that node: the outer capture's
    // `structure.added` holds it with its own overrides, structure and nested channels (#1369), and
    // `rebuildInstance`'s `applyStructureByRootInstance` re-spawns it whole. Re-applying it here a
    // second time duplicated every subtree it had added — a rebuild turned one Bolt into two.
    const chain = isNestedRoot(id) ? chainOf(id) : null;
    if (chain && !chain.includes(0)) {
      const source = piOf(id)!.source as string;
      const childPrefab = getCachedPrefabSync(source);
      if (childPrefab) {
        const resolve = baseTokenResolver(id);
        const chainStructure = resolveEffectivePrefabStructure(baseline, chain);
        const { structure, replace } = subtractChainStructure(
          captureInstanceStructure(id, childPrefab),
          { ...chainStructure, added: resolveNodes(resolve, chainStructure.added) },
          chainStructure.added?.length ? addedKeysOf(id) : new Map());
        captures.push({
          chain,
          source,
          overrides: subtractChainOverrides(
            captureInstanceOverrides(id, childPrefab), resolve(resolveEffectivePrefabOverride(baseline, chain)) as Record<number, Record<string, Record<string, unknown>>>, childPrefab),
          structure,
          replace,
        });
      }
    }
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return captures;
}

/** Drop every captured field whose live value EQUALS what the prefab chain applies. By value, not by
 *  key presence (`captureNestedSceneDelta`'s rule): a scene that changed a row-set field keeps its
 *  change across the rebuild.
 *
 *  A trait the CHAIN adds (absent from `childPrefab` at that member) is captured whole, schema
 *  defaults included, because the capture sees an added trait. The loader builds it as
 *  `meta.trait(authored)`, so an unauthored field equal to its default is the chain's too; left in,
 *  it kept the trait alive after a refresh that removed it (#1386 review). */
function subtractChainOverrides(
  live: Record<number, Record<string, Record<string, unknown>>>,
  chain: Record<number, Record<string, Record<string, unknown>>>,
  childPrefab: PrefabFile,
): Record<number, Record<string, Record<string, unknown>>> {
  for (const [lid, traits] of Object.entries(live)) {
    const chainTraits = chain[Number(lid)];
    if (!chainTraits) continue;
    const member = childPrefab.entities.find((e) => e.localId === Number(lid));
    for (const [trait, fields] of Object.entries(traits)) {
      const chainFields = chainTraits[trait];
      if (!chainFields || typeof chainFields !== 'object') continue;
      const chainAdded = member?.traits[trait] === undefined;
      const schema = chainAdded ? (getTraitByName(trait)?.trait as { schema?: Record<string, unknown> } | undefined)?.schema : undefined;
      for (const f of Object.keys(fields)) {
        if (hasDocKey(chainFields, f)) {
          if (valuesEqual(fields[f], chainFields[f])) delete fields[f];
        } else if (schema && f in schema) {
          const def = typeof schema[f] === 'function' ? (schema[f] as () => unknown)() : schema[f];
          if (valuesEqual(fields[f], def)) delete fields[f];
        }
      }
      if (Object.keys(fields).length === 0) delete traits[trait];
    }
    if (Object.keys(traits).length === 0) delete live[Number(lid)];
  }
  return live;
}

/** The structural half of the subtraction. `removed`/`removedTraits` lose what the chain lists. An
 *  `added` node the chain authored is recognised by its TEMPLATE KEY (a guid is derived per instance
 *  since #1387; a legacy key-less file node by the durable guid it carried): unchanged, it is dropped,
 *  since the fresh expansion spawns it and a refresh's edit to it must reach this instance; EDITED, it
 *  is kept and listed in `replace`, so the fresh copy gives way to it rather than sitting beside it.
 *
 *  ⚠️ A template node the scene DELETED still comes back: with no live node there is nothing to
 *  match, and "deleted here" cannot be told from "added by the refresh" without the old live key set.
 *  The rebuild did the same before this subtraction existed. */
function subtractChainStructure(
  full: InstanceStructure,
  chain: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
  keysByGuid: Map<string, string>,
): { structure: InstanceStructure; replace: { key: string; guid: string }[] } {
  const byKey = new Map<string, AddedEntity>();
  const byGuid = new Map<string, AddedEntity>();
  for (const n of chain.added ?? []) {
    if (n.key) byKey.set(n.key, n);
    else if (durableGuid(n.guid)) byGuid.set(n.guid, n);
  }
  const added: AddedEntity[] = [];
  const replace: { key: string; guid: string }[] = [];
  for (const node of full.added) {
    const key = node.guid ? keysByGuid.get(node.guid) : undefined;
    const base = (key ? byKey.get(key) : undefined) ?? (node.guid ? byGuid.get(node.guid) : undefined);
    if (!base) { added.push(node); continue; }
    if (sameStructure({ added: [node] }, { added: [base] })) continue;
    added.push(node);
    replace.push({ key: base.key ? key! : '', guid: node.guid });
  }
  const chainRemoved = new Set(chain.removed ?? []);
  const removedTraits: Record<number, string[]> = {};
  for (const [lid, names] of Object.entries(full.removedTraits)) {
    const chainNames = new Set(chain.removedTraits?.[Number(lid)] ?? []);
    const own = names.filter((n) => !chainNames.has(n));
    if (own.length) removedTraits[Number(lid)] = own;
  }
  return {
    structure: { ...full, added, removed: full.removed.filter((l) => !chainRemoved.has(l)), removedTraits },
    replace,
  };
}

/** Re-apply nested-instance captures onto a freshly rebuilt outer instance,
 *  re-locating each nested root by walking its `parentLocalId` chain from the new
 *  outer root (ids changed, the chain didn't). */
function reapplyNestedInstanceOverrides(newOuterRootId: number, captures: NestedInstanceCapture[]): void {
  if (!captures.length) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // The nested instance root produced by row `parentLocalId` of `parentRoot`: the owned root with that stamp
  // whose OWNER is `parentRoot` (`identityParents.ts`). It read "its live parent is a member of parentRoot"
  // before #1468 Phase 6's close-out, which no nested row under a nested row can satisfy — its root hangs under
  // the other nested ROOT — so an edit inside one was dropped by every rebuild.
  const identity = worldIdentityParents(getCurrentWorld());
  const findChildNestedRoot = (parentRoot: number, parentLocalId: number): number => {
    let found = 0;
    getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
      if (found) return;
      const p = pi as Record<string, unknown>;
      const id = entity.id();
      if (p.rootInstanceId !== id) return;                            // must be an instance root
      if (((p.parentLocalId as number) || 0) !== parentLocalId) return;
      if (identity.ownerOf(id) === parentRoot) found = id;
    });
    return found;
  };
  // The fresh copies of `replace`'s nodes under nested root `root`: added nodes directly under a member.
  const freshCopies = (root: number, replace: NestedInstanceCapture['replace']): number[] => {
    const keys = new Set(replace.map((r) => r.key).filter(Boolean));
    const guids = new Set(replace.filter((r) => !r.key).map((r) => r.guid));
    const rootOf = (id: number) => (readTraitData(id, PrefabInstanceMeta)?.rootInstanceId as number) ?? 0;
    const all = getAllEntities();
    const members = new Set(all.filter((e) => rootOf(e.id) === root).map((e) => e.id));
    return all
      .filter((e) => members.has(e.parentId) && !members.has(e.id))
      .filter((e) => keys.has(templateKeyOf(findEntity(e.id))) || guids.has(e.guid ?? ''))
      .map((e) => e.id);
  };

  for (const cap of captures) {
    let cur = newOuterRootId;
    for (const plid of cap.chain) { cur = findChildNestedRoot(cur, plid); if (!cur) break; }
    if (!cur || cur === newOuterRootId) continue;
    if (cap.replace.length) deleteEntities(freshCopies(cur, cap.replace));
    applyOverridesByRootInstance(cur, cap.overrides);
    const childPrefab = getCachedPrefabSync(cap.source);
    if (childPrefab) applyStructureByRootInstance(cur, childPrefab, cap.structure);
    // The respawned node is the scene-form capture, which carries no key: restore the marker, so the
    // next template write keys it as the node it replaced rather than recovering or minting one.
    for (const r of cap.replace) if (r.key) setTemplateKey(findEntityByGuid(r.guid), r.key);
  }
}

/** Tear down a single live prefab instance and re-instantiate it cleanly from
 *  `prefab`, re-applying the given per-field `overrides` and `structure` on top.
 *  Preserves the instance root's scene parent. Returns the NEW instance root ecs
 *  id (ids change across a rebuild). Shared by refresh (the prefab file was
 *  edited) and revert (per-instance reset toward the prefab base).
 *
 *  The teardown set is recomputed LIVE each call — all members plus their
 *  non-member descendants — so kept additions in `structure.added` are re-spawned
 *  rather than duplicated, and re-spawned additions from a PRIOR rebuild are torn
 *  down too instead of accumulating (the frozen `structure.consumedEcsIds` is NOT
 *  used for teardown; see F5). Live per-copy overrides on NESTED children are
 *  captured before teardown and re-applied after, so an outer rebuild doesn't reset
 *  them to the nested prefab base (design risk R3). */
/** Old localId → new localId for every row two versions of one prefab document share, matched by the
 *  minted `nodeGuid` (#1468 Phase 4) — or null when nothing moved, which is every case where `from` and
 *  `to` are the same document or neither carries identity. A row `to` no longer has maps to 0, which no
 *  member holds: an edit to a member the template dropped is DROPPED, never handed to whichever member
 *  inherited its number. A row with no `nodeGuid` (a pre-v5 document) keeps its number — the only answer
 *  there is, and the behaviour this replaces. */
function localIdTranslation(from: PrefabFile, to: PrefabFile): ((lid: number) => number) | null {
  if (from === to) return null;
  const toByGuid = new Map<string, number>();
  for (const pe of to.entities) if (pe.nodeGuid && isGuid(pe.nodeGuid)) toByGuid.set(pe.nodeGuid, pe.localId);
  const map = new Map<number, number>([[from.rootLocalId ?? 1, to.rootLocalId ?? 1]]);
  for (const pe of from.entities) {
    if (pe.nodeGuid && isGuid(pe.nodeGuid) && pe.localId !== (from.rootLocalId ?? 1)) map.set(pe.localId, toByGuid.get(pe.nodeGuid) ?? 0);
  }
  if ([...map].every(([a, b]) => a === b)) return null;
  return (lid) => map.get(lid) ?? lid;
}

/** {@link localIdTranslation} applied to everything a rebuild carries by localId. */
function translateCarried<S extends { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> }>(
  lid: (n: number) => number,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: S,
): { overrides: typeof overrides; structure: S } {
  const keys = <V,>(m: Record<number, V> | undefined): Record<number, V> | undefined => {
    if (!m) return m;
    const out: Record<number, V> = {};
    for (const [k, v] of Object.entries(m)) { const n = lid(Number(k)); if (n) out[n] = v; }
    return out;
  };
  return {
    overrides: keys(overrides)!,
    structure: {
      ...structure,
      removed: structure.removed?.map(lid).filter((n) => n > 0),
      removedTraits: keys(structure.removedTraits),
      // An anchor the template dropped reads as 0 — "merely absent", which `applyStructureCore`
      // re-anchors to the root with a warning, rather than an anchor some other member now holds.
      added: structure.added?.map((n) => ({ ...n, parentLocalId: lid(n.parentLocalId) })),
      ...(structure.moved ? { moved: keys(structure.moved) } : {}),
    },
  };
}

export function rebuildInstance(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; consumedEcsIds?: Set<number>; nestedMoves?: InstanceStructure['nestedMoves'] },
  /** The document the LIVE tree was expanded from, when it is not `prefab` — a refresh's old file. The
   *  nested re-apply subtracts what that document's chain applies (#1386, #1401). */
  baseline: PrefabFile = prefab,
  /** Old → new member guid, when the rebuild changes member paths (#1437): a move's target and a parked
   *  member's parent are looked up by guid AFTER the rebuild, so they are translated first. */
  remap: ReadonlyMap<string, string> = new Map(),
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return rootInstanceId;
  if (remap.size) structure = remapGuidValues(structure, remap) as typeof structure;
  // A localId means something only together with the document it was read from (#1468 Phase 4). What
  // the caller captured is in `baseline`'s numbering, and the respawn below is in `prefab`'s; a template
  // re-save that renumbered them would otherwise hand every edit to whichever member inherited the
  // number. Today's callers (Apply and its undo) are additive and never renumber, so this is the
  // function honouring its own contract — it accepts a baseline other than the document it rebuilds.
  const lidOf = localIdTranslation(baseline, prefab);
  if (lidOf) ({ overrides, structure } = translateCarried(lidOf, overrides, structure));

  // Preserve the instance root's scene placement (its parent is not a member, so
  // it survives the teardown). instantiatePrefab defaults to parentId 0, which
  // would detach a nested instance or any non-root-parented instance.
  const eaMeta = getTraitByName('EntityAttributes');
  const oldRootEa = eaMeta ? readTraitData(rootInstanceId, eaMeta) : null;
  const parentId = (oldRootEa?.parentId as number) ?? 0;

  // The member identity this instance is carrying, read off the live tree before the teardown
  // destroys it (v16, #1468 — see `restoreInstanceMembers`, which puts it back).
  // ⚠️ NO document, and therefore no `parent`: a rebuild re-applies the moves from the STRUCTURE it
  // is handed, which is the REDUCED one on a revert. Carrying `parent` here instead would re-assert
  // the move the revert just took away — measured, as the revert test going red.
  const carriedMembers = captureInstanceMembers(rootInstanceId);
  // Snapshot live per-copy overrides on nested children BEFORE the teardown
  // (they get cascade-destroyed with the outer members and re-expanded fresh).
  const nestedCaptures = remapGuidValues(captureNestedInstanceOverrides(rootInstanceId, baseline), remap) as NestedInstanceCapture[];
  // Only a chain's FIRST link is a row of `baseline`; the rest are rows of child documents this rebuild
  // does not change. (`nestedMoves` keys carry the same first link, and only a Revert — same document
  // on both sides — hands them in.)
  if (lidOf) for (const cap of nestedCaptures) if (cap.chain.length) cap.chain = [lidOf(cap.chain[0]!), ...cap.chain.slice(1)];
  const nm = structure.nestedMoves;
  if (nm) {
    const at = (key: string) => {
      const [chain, lid] = key.slice('~moved.'.length).split(':');
      const cap = nestedCaptures.find((c) => c.chain.join('.') === chain);
      return cap ? { cap, lid: Number(lid) } : null;
    };
    for (const key of nm.drop ?? []) {
      const hit = at(key);
      if (hit) hit.cap.structure = { ...hit.cap.structure, moved: Object.fromEntries(Object.entries(hit.cap.structure.moved ?? {}).filter(([l]) => Number(l) !== hit.lid)) };
    }
    for (const [key, guid] of Object.entries(nm.set ?? {})) {
      const hit = at(key);
      if (hit) hit.cap.structure = { ...hit.cap.structure, moved: { ...hit.cap.structure.moved, [hit.lid]: guid } };
    }
  }

  // Transience is a property of the IDENTITY, not of the id — the same reasoning that carries the
  // durable guid across the respawn below. Read before the teardown, re-applied after (#1301).
  // Belt-and-braces since `collectInstanceRoots` no longer hands a runtime instance to the refresh
  // fan-out; it stands because a rebuild must not be able to make an unserializable entity
  // serializable, whatever route reaches it.
  const wasTransient = !!findEntity(rootInstanceId)?.has(Transient);
  // An OWNED nested root's row stamp is identity too: `instantiatePrefab` spawns the new root
  // unstamped, so a later move out read it as a STORED root, kept it linked, and the save
  // re-anchored its members (a ref to one dangled); the #1355 presence check also went lenient.
  const oldParentLocalId = (readTraitData(rootInstanceId, PrefabInstanceMeta)?.parentLocalId as number) || 0;
  // ⚠️ …and its IDENTITY twin (`parentNodeGuid`, #1468), which this restored only as a number. A
  // nested root's `memberNodeId` IS its `parentNodeGuid`, so a respawn that got the number back and
  // not the guid lost its identity in the outer frame: every member row inside it went unkeyed
  // across a rebuild, the stored rows dangled and its members re-derived. (When this was found,
  // `memberNodeId` still fell back to the child document's `nodeGuid`, so the keys CHANGED instead;
  // the Phase 3 close-out removed that fallback. Either way the restore below is what keeps them.)
  const oldParentNodeGuid = (readTraitData(rootInstanceId, PrefabInstanceMeta)?.parentNodeGuid as string) || '';

  // Recompute the teardown set LIVE: every member of this instance PLUS every
  // non-member descendant (added entities, nested instances, and their subtrees).
  // We deliberately do NOT trust `structure.consumedEcsIds` — that is a frozen
  // snapshot of the FIRST capture's added-entity ids. After the first rebuild those
  // ids are dead, and the additions re-spawned by applyStructureByRootInstance get
  // FRESH ids that aren't in the frozen set; reusing it would leak (and accumulate)
  // a duplicate added subtree on every undo/redo cycle of a revert (F5). Walking the
  // live subtree destroys whatever additions are currently live, regardless of when
  // they were spawned. (deleteEntities also cascades to children, but recomputing
  // here makes teardown correct without depending on that.)
  const members = new Set<number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    if ((pi as Record<string, unknown>).rootInstanceId === rootInstanceId) members.add(entity.id());
  });
  const childrenOf = new Map<number, number[]>();
  for (const e of getAllEntities()) {
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e.id);
  }
  // A member of ANOTHER instance moved in under one of ours (#1437) is not ours to destroy: its own instance
  // records the move, and nothing here would respawn it. It is parked at the scene root for the teardown and
  // put back under the same parent (by guid — our members keep theirs) once the rebuild has derived them.
  const parked: { id: number; parentGuid: string }[] = [];
  // By a walk of the world, not the guid index: rebuild's tests stub the world module by an explicit export list.
  const guidById = new Map(getAllEntities().map((e) => [e.id, e.guid ?? '']));
  // Where each entity's TEMPLATE puts it (`identityParents.ts`) — which of them were moved, and by whom owned.
  const identity = worldIdentityParents(getCurrentWorld());
  const toDestroy = new Set<number>(members);
  const stack = [...members];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf.get(id) ?? []) {
      if (toDestroy.has(c)) continue;
      if (!members.has(c) && readTraitData(c, PrefabInstanceMeta) && identity.moved(c) && guidById.get(id)) {
        parked.push({ id: c, parentGuid: remap.get(guidById.get(id)!) ?? guidById.get(id)! });
        continue;
      }
      toDestroy.add(c);
      stack.push(c);
    }
  }
  // …unless its own instance is torn down here too (a user-added one nested in ours): that rebuild respawns
  // it, moved, from its own record. A MOVED owned nested root's instance is its owner; one that never moved
  // answers 0, as it did when this read a home it did not have (it is inside its owner's subtree anyway).
  const frameOf = (id: number): number => {
    const pi = readTraitData(id, PrefabInstanceMeta);
    if (!pi) return 0;
    if (!isOwnedRoot(pi, id)) return (pi.rootInstanceId as number) || 0;
    return identity.moved(id) ? identity.ownerOf(id) : 0;
  };
  for (let i = parked.length - 1; i >= 0; i--) {
    const frame = frameOf(parked[i]!.id);
    if (frame !== rootInstanceId && !toDestroy.has(frame)) continue;
    toDestroy.add(parked[i]!.id);
    parked.splice(i, 1);
  }
  // The reverse case: an entity of an instance torn down here that was moved OUT of this subtree — a member of
  // a nested instance, or an owned nested root of ours — is respawned, moved, by the rebuild; left alive it
  // would sit beside its own replacement. Fixpoint, since its own members may be further out still.
  for (let grew = true; grew;) {
    grew = false;
    for (const e of getAllEntities()) {
      if (toDestroy.has(e.id) || parked.some((p) => p.id === e.id) || !e.traits.includes('PrefabInstance')) continue;
      const frame = frameOf(e.id);
      if (frame !== rootInstanceId && !toDestroy.has(frame)) continue;
      if (frame === e.id) continue; // a stored root is its own instance, and it is not ours
      const sub = [e.id];
      while (sub.length) {
        const id = sub.pop()!;
        if (toDestroy.has(id)) continue;
        toDestroy.add(id);
        sub.push(...(childrenOf.get(id) ?? []));
      }
      grew = true;
    }
  }
  for (const p of parked) if (eaMeta) writeTraitField(p.id, eaMeta, 'parentId', 0);
  deleteEntities([...toDestroy]);

  const beforeSpawn = new Set(getAllEntities().map((e) => e.id));
  const newRootId = instantiatePrefab(prefab, parentId);
  // Preserve the instance root's stable guid across the teardown+respawn so refs
  // into the instance (UI bindings, guid-based undo) survive the rebuild — the
  // re-instantiated root would otherwise mint a fresh guid. Same identity, so
  // carrying the guid is correct (not a duplicate).
  // Durable only (#1210): a runtime guid belonged to the destroyed root's address row, so copying it
  // would leave the new root answering to nothing; the respawn's own runtime guid stands instead.
  if (eaMeta && durableGuid(oldRootEa?.guid as string)) writeTraitField(newRootId, eaMeta, 'guid', oldRootEa!.guid as string);
  if (wasTransient) findEntity(newRootId)?.add(Transient);
  setPrefabSource(newRootId, source);
  if (oldParentLocalId) writeTraitField(newRootId, PrefabInstanceMeta, 'parentLocalId', oldParentLocalId);
  if (oldParentNodeGuid) writeTraitField(newRootId, PrefabInstanceMeta, 'parentNodeGuid', oldParentNodeGuid);
  applyOverridesByRootInstance(newRootId, overrides);
  applyStructureByRootInstance(newRootId, prefab, structure);
  reapplyNestedInstanceOverrides(newRootId, nestedCaptures);
  // A rebuilt OWNED nested instance re-expands from its own document only: the moves the prefabs around it make
  // of its members are queued again, or an apply or revert on it undid them in every instance (#1437 review).
  // Only for members THIS rebuild respawned: any other member is where the scene's own moves left it, and a
  // base move replayed on it would record its current parent as its home (third-review F1).
  if (oldParentLocalId) {
    const respawned = new Set(getAllEntities().map((e) => e.id).filter((id) => !beforeSpawn.has(id)));
    for (const f of enclosingFrames(newRootId)) {
      if (!f.doc?.moved) continue;
      const index = memberPathIndex(getCurrentWorld(), f.root);
      const mine = Object.fromEntries(Object.entries(f.doc.moved).filter(([key]) => {
        const member = index.get(key);
        return !!member && respawned.has(member.id());
      }));
      if (Object.keys(mine).length) queuePrefabMoves(getCurrentWorld(), f.root, mine, '[Prefab]');
    }
  }
  // Put the identity the instance was carrying back FIRST, refs and all — the same order the loader
  // uses (`applyStoredMemberRows` before `deriveInstanceMemberGuids`), and since Phase 3 it has to be.
  // ⚠️ A queued move names its target BY GUID and drains at the end of the derive below, so a target
  // whose stored guid had not been restored yet was simply "gone" and the member stayed at its row:
  // a move inside a SECOND instance vanished whenever an Apply rebuilt them all. Restoring after the
  // derive was right while every member's guid was derived — there was nothing to restore that the
  // derive had not just computed — and it stopped being right the moment identity was stored.
  restoreInstanceMembers(newRootId, carriedMembers);
  // The respawned members and template-keyed added nodes are guid-less until derived (#1387). Only
  // fills empty guids, so the root's carried guid above and every restored scene guid stand.
  deriveInstanceMemberGuids(getCurrentWorld());
  // Scene OWNERSHIP is identity too (#1431): every respawn — members, nested expansions, the restored
  // added nodes — comes back unstamped, i.e. primary-owned, so a BASE scene's instance left the base
  // file on the next Save All and vanished from every other level using that base. Read off the old
  // ROOT, not derived from the parent: a base instance usually sits at the scene root, with no parent
  // to inherit from. The WHOLE subtree takes it, because that is where a save already puts every
  // node under a base instance (the primary save drops a subtree with a base ancestor). A primary
  // instance's '' is already what the respawn wrote, so only a base stamp is carried. Carrying it does
  // not WRITE the base — the edit routes mark it dirty (`RevertResult.affectedScenes`, apply's undo).
  const sourceScene = (oldRootEa?.sourceScene as string) || '';
  if (eaMeta && sourceScene) {
    const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
    // …and every member moved OUT of the subtree (#1437): it is the instance's, wherever it hangs, and so is
    // what hangs under it. Found through its template parent (`identityParents.ts`), to a fixpoint.
    const stamped = new Set(collectSubtreeIds(links, [newRootId]));
    const rebuilt = worldIdentityParents(getCurrentWorld());
    for (let grew = true; grew;) {
      grew = false;
      for (const e of getAllEntities()) {
        if (stamped.has(e.id) || !rebuilt.moved(e.id) || !stamped.has(rebuilt.parentOf(e.id))) continue;
        for (const id of collectSubtreeIds(links, [e.id])) stamped.add(id);
        grew = true;
      }
    }
    for (const id of stamped) writeTraitField(id, eaMeta, 'sourceScene', sourceScene);
  }
  // After the ownership stamp: a member of ANOTHER instance put back under ours keeps its own scene.
  const after = parked.length ? worldIdentityParents(getCurrentWorld()) : null;
  for (const p of parked) {
    // Its parent gone from the rebuilt instance (the prefab lost that row), it goes back to its template parent —
    // still inside its own instance — rather than being left at the scene root, which is out of every instance.
    const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.id]));
    const back = live.get(p.parentGuid);
    const templateParent = after!.parentOf(p.id);
    const to = back ?? (templateParent && templateParent !== p.id ? templateParent : undefined);
    if (eaMeta && to) writeTraitField(p.id, eaMeta, 'parentId', to);
    if (!to) console.warn(`[Prefab] rebuild: the parent ${p.parentGuid} of a member moved in here is gone, and so is its template parent; it stays at the scene root`);
  }
  return newRootId;
}

/** Tear down each instance in `rootIds`, re-instantiate from `newPrefab`, and
 *  re-apply each instance's per-field overrides (computed against `oldPrefab`).
 *  This preserves deliberate user customizations on every instance. */
function refreshInstances(
  source: string,
  rootIds: number[],
  oldPrefab: PrefabFile,
  newPrefab: PrefabFile,
  /** Old → new member guid (#1437): what the rebuild consumes by guid follows it. */
  remap: ReadonlyMap<string, string> = new Map(),
): void {
  if (rootIds.length === 0) return;

  // Pinned BEFORE the loop, because the loop is what invalidates ids: each rebuild deletes a
  // subtree and spawns a replacement, and a freed id can come straight back.
  const eaMetaForGuid = getTraitByName('EntityAttributes');
  const guidOf = new Map<number, string>();
  for (const id of rootIds) {
    guidOf.set(id, eaMetaForGuid ? ((readTraitData(id, eaMetaForGuid)?.guid as string) || '') : '');
  }

  let refreshed = 0;
  for (const oldRootId of rootIds) {
    // ⚠️ A root can be DEAD by the time the loop reaches it, and `rebuildInstance` does not
    // no-op on one: it reads `parentId` as 0, finds no members, deletes nothing, and then
    // `instantiatePrefab(prefab, 0)` spawns a DUPLICATE instance at the scene root. The shape
    // is `collectInstanceRoots(S)` returning both an instance of S and a second instance of S
    // the author dropped INSIDE it, where the outer teardown destroys the inner root first.
    //
    // ⚠️ TRACED, NOT DRIVEN. Found by reading, in the #1295 review. I could not build a
    // fixture that fires it — with an inner instance nested under an outer one, the refresh
    // loop reached both while still alive ("Refreshed 2 instance(s)"), so the ordering the
    // hazard needs did not occur. Kept because it costs one map lookup and the failure it
    // prevents is a silently duplicated subtree; do NOT read it as a covered case.
    //
    // ⚠️ Checked by GUID, not id — an id-only check is worse than none here. See
    // `isLiveInstanceRoot`.
    if (!isLiveInstanceRoot(oldRootId, guidOf.get(oldRootId) ?? '')) continue;
    refreshed++;
    // Capture this instance's per-field overrides AND structural diffs against
    // the OLD prefab, then tear down + re-instantiate from the NEW prefab and
    // re-apply them. Structure must be captured before the teardown inside
    // rebuildInstance (it walks the live non-member descendants).
    const captured = captureInstanceOverrides(oldRootId, oldPrefab);
    const capturedStructure = captureInstanceStructure(oldRootId, oldPrefab);
    rebuildInstance(oldRootId, source, newPrefab, captured, capturedStructure, oldPrefab, remap);
  }

  // Reports what was REBUILT, not what was listed. The two differ exactly when a root died
  // under another root's teardown, so this line is the only place that case becomes visible.
  console.log(`[Prefab] Refreshed ${refreshed} instance(s) of "${source}"`);
}

/** Re-derive every BASE scene's live instance of `source` from `fromPrefab` to `toPrefab` — the
 *  refresh a prefab save runs, restricted to base-owned roots (#1431). For an undo/redo that swaps
 *  the prefab back and restores only the PRIMARY: a base loaded with it is CARRIED live, so its
 *  instances would stay built from the prefab being undone, and a dirty base would then be saved
 *  against the restored one (a member the apply removed reads as a `removed` nobody authored).
 *  `exceptGuid` names an instance the caller rebuilds itself. */
export function refreshBaseInstances(source: string, fromPrefab: PrefabFile, toPrefab: PrefabFile, exceptGuid = ''): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return;
  const roots = collectInstanceRoots(source).filter((id) => {
    const ea = readTraitData(id, eaMeta);
    return !!ea?.sourceScene && !(exceptGuid && ea.guid === exceptGuid);
  });
  refreshInstances(source, roots, fromPrefab, toPrefab);
}

/** Is `rootId` still the SAME live, self-rooted prefab-instance root it was when the caller
 *  collected it — identified by `expectedGuid`, not by the id?
 *
 *  ⚠️ The guid is what makes this safe, and an id-only version is actively worse than no check
 *  at all (close-out review). koota recycles entity ids LIFO, and the caller's loop deletes a
 *  subtree and then spawns a replacement — so the freed id can be handed straight back to the
 *  NEW root. An id-only check would then report a destroyed instance as live, and the loop
 *  would rebuild the first instance a second time using the overrides and structure captured
 *  for a DIFFERENT one. Comparing the stable guid cannot confuse the two.
 *
 *  An empty expected guid means the caller had nothing stable to pin, so this degrades to the
 *  id check rather than refusing outright — every entity carries a guid since #1210, so that
 *  path is not expected to be reached. */
function isLiveInstanceRoot(rootId: number, expectedGuid: string): boolean {
  const meta = getTraitByName('PrefabInstance');
  if (!meta) return false;
  const pi = readTraitData(rootId, meta);
  if (!pi || pi.rootInstanceId !== rootId) return false;
  if (!expectedGuid) return true;
  const eaMeta = getTraitByName('EntityAttributes');
  const guid = eaMeta ? (readTraitData(rootId, eaMeta)?.guid as string | undefined) : undefined;
  return guid === expectedGuid;
}

/** Collect root entity ids for every instance of a given source. Optionally
 *  exclude one root id. */
function collectInstanceRoots(source: string, excludeRootId?: number): number[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const rootIds: number[] = [];
  // ⚠️ A Transient instance is a RUNTIME artifact — a UIEntries pooled row, a timeline scrub or
  // control-track spawn — and an authoring fan-out must not reach it (#1301). Rebuilding one is
  // wrong twice over: `rebuildInstance` does not carry `Transient` forward, so the rebuilt root
  // becomes serializable and the next save writes a preview artifact into the authored scene; and
  // the pool owns those rows, so tearing them down under it is not ours to do. A STOPPED editor
  // really does hold pooled instance roots that match this query's `source` + `rootInstanceId`
  // filter exactly — measured in docs/prefabs.md § Authoring scope.
  const runtimeIds = collectTransientSubtreeIds(getAllEntities());
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.source !== source) return;
    if (piData.rootInstanceId !== entity.id()) return;
    if (excludeRootId !== undefined && entity.id() === excludeRootId) return;
    if (runtimeIds.has(entity.id())) return;
    rootIds.push(entity.id());
  });
  return rootIds;
}

// ── Revert overrides (per-instance reset toward the prefab base) ─────────

/** Deep-clone a per-field override map (values are JSON-safe trait data). */
function cloneOverrides(
  m: Record<number, Record<string, Record<string, unknown>>>,
): Record<number, Record<string, Record<string, unknown>>> {
  return JSON.parse(JSON.stringify(m));
}

/** Return a copy of `full` with the selected per-field override keys
 *  (`localId.trait.field` — the localId form `revertOverridesSelective` turned them into) removed.
 *  Structural keys are ignored here. Reverting
 *  every field of an added trait empties the trait, which also drops it. */
function subtractRevertedOverrides(
  full: Record<number, Record<string, Record<string, unknown>>>,
  selectedKeys: Set<string>,
): Record<number, Record<string, Record<string, unknown>>> {
  const out = cloneOverrides(full);
  for (const key of selectedKeys) {
    if (key.startsWith('+added.') || key.startsWith('-removed.') || key.startsWith('-trait.')) continue;
    const [localIdStr, traitName, fieldName] = key.split('.');
    const localId = Number(localIdStr);
    const traitMap = out[localId];
    if (!traitMap?.[traitName]) continue;
    delete traitMap[traitName][fieldName];
    if (Object.keys(traitMap[traitName]).length === 0) delete traitMap[traitName];
    if (Object.keys(traitMap).length === 0) delete out[localId];
  }
  return out;
}

/** Return a copy of `full` structure with the selected structural keys removed.
 *  Dropping an `+added` node stops it being re-spawned (its live ids are still in
 *  `consumedEcsIds`, so they are destroyed); dropping a `-removed`/`-trait` entry
 *  lets the fresh instantiation keep that prefab member/component. */
function subtractRevertedStructure(
  full: InstanceStructure,
  selectedKeys: Set<string>,
): InstanceStructure {
  const revertedAdded = new Set<string>();
  const revertedRemoved = new Set<number>();
  const revertedRemovedTraits = new Map<number, Set<string>>();
  const revertedMoved = new Set<number>();
  for (const key of selectedKeys) {
    if (key.startsWith('~moved.')) {
      revertedMoved.add(Number(key.slice('~moved.'.length)));
    } else if (key.startsWith('+added.')) {
      revertedAdded.add(key.slice('+added.'.length));
    } else if (key.startsWith('-removed.')) {
      revertedRemoved.add(Number(key.slice('-removed.'.length)));
    } else if (key.startsWith('-trait.')) {
      const [, lidStr, traitName] = key.split('.');
      const lid = Number(lidStr);
      if (!revertedRemovedTraits.has(lid)) revertedRemovedTraits.set(lid, new Set());
      revertedRemovedTraits.get(lid)!.add(traitName);
    }
  }

  const added = full.added.filter((n) => !revertedAdded.has(n.guid));
  const removed = full.removed.filter((lid) => !revertedRemoved.has(lid));
  const removedTraits: Record<number, string[]> = {};
  for (const [lidStr, names] of Object.entries(full.removedTraits)) {
    const lid = Number(lidStr);
    const drop = revertedRemovedTraits.get(lid);
    const kept = drop ? names.filter((n) => !drop.has(n)) : names;
    if (kept.length) removedTraits[lid] = kept;
  }
  // Every added live entity (reverted or kept) is in consumedEcsIds and gets torn
  // down; kept ones are re-spawned from `added`. So consumedEcsIds is unchanged.
  // `ownedNested` likewise: reverting an add or a removal does not change WHICH instance is a
  // given nested row's own expansion.
  // A reverted move re-expands the member at its row parent (#1437).
  const moved = Object.fromEntries(Object.entries(full.moved).filter(([lid]) => !revertedMoved.has(Number(lid))));
  return { added, removed, removedTraits, moved, consumedEcsIds: full.consumedEcsIds, ownedNested: full.ownedNested };
}

/** Everything the dialog needs to wire undo/redo for a revert. The instance is
 *  rebuilt from the prefab with `reducedOverrides`/`reducedStructure` applied;
 *  undo rebuilds with the `full*` (pre-revert) state, redo with the reduced. */
export interface RevertResult {
  newRootId: number;
  source: string;
  prefab: PrefabFile;
  fullOverrides: Record<number, Record<string, Record<string, unknown>>>;
  fullStructure: InstanceStructure;
  reducedOverrides: Record<number, Record<string, Record<string, unknown>>>;
  reducedStructure: InstanceStructure;
  /** The BASE scene(s) that own the instance — pass as the undo action's `affectedScenes`. A base's
   *  file is written by Save All only when it is dirty, and nothing else marks it: without this a
   *  revert on a base's instance reads saved and is lost on reload (#1431). [] for a primary one. */
  affectedScenes: string[];
}

/** Revert selected overrides on a SINGLE prefab instance back to the prefab base
 *  (the inverse of applyToPrefabSelective, but scoped to this instance only —
 *  the prefab file is never touched). Implemented as a teardown + clean
 *  re-instantiation with only the NON-reverted overrides/structure re-applied, so
 *  every diff category (field, added/removed trait, added/removed entity) reverts
 *  uniformly. Returns the new instance root + the state needed for undo, or null
 *  if the entity is not an instance / the prefab can't be loaded. */
export async function revertOverridesSelective(
  rootInstanceId: number,
  selectedKeys: Set<string>,
): Promise<RevertResult | null> {
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) {
    console.warn('[Prefab] Selected entity is not a prefab instance');
    return null;
  }
  const { source } = ctx;
  if (selectedKeys.size === 0) {
    console.log('[Prefab] Nothing selected; aborting revert.');
    return null;
  }

  const prefab = await getPrefabSource(source);
  if (!prefab) {
    console.warn(`[Prefab] Cannot revert: source prefab not in cache: ${source}`);
    return null;
  }
  // Nested children must be cached for the synchronous re-instantiation.
  await preloadNestedPrefabs(prefab);
  // The file walk above misses a USER-ADDED nested instance (not a row of `prefab`),
  // whose per-copy overrides rebuildInstance captures from the cache (#1284).
  await preloadNestedPrefabsForSubtree(rootInstanceId);
  // The keys in their localId form against this document (#1468 Phase 4) — see the same step in
  // `applyToPrefabSelective`. A key naming a member the document no longer has reverts nothing.
  selectedKeys = toLocalIdKeys(selectedKeys, prefab, getCachedPrefabSync).keys;

  // Capture the instance's current state against the prefab, then subtract the
  // reverted keys to get the state to re-apply after the rebuild.
  const fullOverrides = captureInstanceOverrides(rootInstanceId, prefab);
  let fullStructure = captureInstanceStructure(rootInstanceId, prefab);
  const reducedOverrides = subtractRevertedOverrides(fullOverrides, selectedKeys);
  let reducedStructure = subtractRevertedStructure(fullStructure, selectedKeys);
  // Moves inside nested instances live in what the rebuild captures of THEM (owner's B): dropped for the revert,
  // set back for its undo, which rebuilds from `fullStructure`.
  const revertedNested = nestedFrameMoves(rootInstanceId).filter((m) => selectedKeys.has(m.key));
  if (revertedNested.length) {
    reducedStructure = { ...reducedStructure, nestedMoves: { drop: revertedNested.map((m) => m.key) } };
    fullStructure = { ...fullStructure, nestedMoves: { set: Object.fromEntries(revertedNested.map((m) => [m.key, m.parentGuid])) } };
  }

  const newRootId = rebuildInstance(rootInstanceId, source, prefab, reducedOverrides, reducedStructure);

  return { newRootId, source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure, affectedScenes: resolveAffectedScenes([newRootId]) };
}

