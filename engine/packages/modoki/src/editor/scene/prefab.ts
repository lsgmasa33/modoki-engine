/** Prefab system — save, load, and instantiate prefab entity trees. */

import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld, spawnEntity, findEntityByGuid, indexEntityGuid } from '../../runtime/core/ecs/world';
import { hasDocKey, putOwn } from '../../runtime/core/docKeys';
import { validatePrefabData, REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { postWriteFile, jsonFileBody } from '../backend/editorBackend';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, deleteEntities, markStructureDirty, readTraitData, readTraitDataFull, writeTraitField, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { collectTransientSubtreeIds, filterAuthoringVisible, runtimeExcludedMessage } from './authoringScope';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid, registerAsset, getGuidForPath, isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { durableGuid, deriveMemberGuid, memberStepId, addedKeyStep, mapStringValues } from '../../runtime/core/assetRefRules';
import { templateKeyOf, setTemplateKey } from '../../runtime/core/templateIdentity';
import { assertNoRuntimeGuids } from './runtimeGuidTripwire';
import { entityRef, type EntityRef } from '../undo/entityRef';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { invalidatePrefab, replaceCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { markOverride, clearOverrideMarks, getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { isPersistentTraitField, isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import { isTraitDefault } from './traitDefault';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, InstanceStructureData } from '../../runtime/loaders/loadSceneFile';
import { mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, mergeNestedStructurePaths, descendPathKeyed, nestedPathKey, prefabSubtreeLocalIds, deriveInstanceMemberGuids, applyStructureCore, rowPathInPrefab, registerTemplateFrame, memberPathIndex, openTokenScope, closeTokenScope, noteTokens } from '../../runtime/loaders/loadSceneFile';
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
 *  files honest about which serializer touched them, same as every bump before it. */
export const PREFAB_FORMAT_VERSION = 3;

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
function templateTokenizer(rootEcsId: number, all: EntityInfo[], ecsToLocal: Map<number, number>) {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const children = new Map<number, EntityInfo[]>();
  for (const e of all) {
    const list = children.get(e.parentId);
    if (list) list.push(e);
    else children.set(e.parentId, [e]);
  }
  const piOf = (id: number) => (piMeta ? readTraitData(id, piMeta) as { localId?: number; parentLocalId?: number; rootInstanceId?: number } | null : null);
  const pathInRoot = new Map<string, MemberStep[]>();
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
        : key ? addedKeyStep(key)
        : pi ? memberStepId(pi) : null;
      if (step === null) continue;
      const at = [...path, step];
      if (c.guid) pathInRoot.set(c.guid, at);
      const storedRoot = !!pi && pi.rootInstanceId === c.id && !pi.parentLocalId;
      if (!storedRoot || ecsToLocal.has(c.id)) stack.push([c.id, at]);
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
        if (guid) out.set(guid, key ? key.split('.').map((x) => (x.startsWith('+') ? x : Number(x))) : []);
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
   *  (each step a row localId), or 0. */
  const frameAt = (rowRoot: number, pathKey: string): number => {
    let cur = rowRoot;
    for (const step of pathKey.split('.').map(Number)) {
      let next = 0;
      for (const e of all) {
        const pi = piOf(e.id);
        if (!pi || pi.rootInstanceId !== e.id || pi.parentLocalId !== step) continue;
        if (piOf(e.parentId)?.rootInstanceId === cur) { next = e.id; break; }
      }
      if (!next) return 0;
      cur = next;
    }
    return cur;
  };
  return { value, added, frameAt, undeclaredKeys, root: rootEcsId };
}

/** Resolves the member tokens in a prefab BASE value against the live instance rooted at
 *  `rootInstanceId`, so it can be compared with the live value, which holds guids (#1352). A `^`
 *  climbs to the instance whose row expanded this one. A token that names nothing stays as it is. */
export function baseTokenResolver(rootInstanceId: number): (value: unknown) => unknown {
  const world = getCurrentWorld();
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const indexes = new Map<number, ReturnType<typeof memberPathIndex>>();
  const frameUp = (root: number, up: number): number => {
    let r = root;
    for (let i = 0; i < up && r; i++) {
      const pi = piMeta ? readTraitData(r, piMeta) : null;
      if (!pi?.parentLocalId || !eaMeta) return 0; // a stored root is its own frame: nothing above it
      const parent = (readTraitData(r, eaMeta)?.parentId as number) || 0;
      r = parent && piMeta ? ((readTraitData(parent, piMeta)?.rootInstanceId as number) || 0) : 0;
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

  const piMeta = getTraitByName('PrefabInstance');
  const plan = planPrefabRows(tree, selectedEntityId, existingId, opts?.preserveLocalIds);
  if (!plan) return null; // cycle — planPrefabRows already reported it
  const { nestedRefs, flatTree, ecsToLocal } = plan;

  const allTraits = getAllTraits();
  const prefabEntities: PrefabEntity[] = [];
  // A ref from one member of the written tree to another becomes a member TOKEN (#1352): the file is a
  // template, and the live guid it held names the SOURCE entity in every instance.
  const tokens = templateTokenizer(selectedEntityId, allEntities, ecsToLocal);

  for (const entityInfo of flatTree) {
    const localId = ecsToLocal.get(entityInfo.id)!;

    // Nested-instance root → reference row (child prefab + captured diffs). Only
    // EntityAttributes (name + remapped parentId) is written inline; the child's
    // own traits come from the child file, edits ride in `overrides`.
    const nested = nestedRefs.get(entityInfo.id);
    if (nested) {
      const ea = readTraitData(entityInfo.id, piMeta!) && getTraitByName('EntityAttributes')
        ? readTraitData(entityInfo.id, getTraitByName('EntityAttributes')!) : null;
      const parentLocal = ea && ea.parentId !== undefined ? (ecsToLocal.get(ea.parentId as number) || 0) : 0;
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

    const entry: PrefabEntity = { localId, name: entityInfo.name, traits: {} };

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
            const ecsParentId = traitData['parentId'] as number;
            (traitData as Record<string, unknown>)['parentId'] = ecsToLocal.get(ecsParentId) || 0;
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
  };
  assertNoRuntimeGuids(file, 'a serialized prefab');
  return file;
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
    return { ...pe, localId: freshRemap.get(pe.localId)!, traits };
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

  return {
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
  };
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
export async function resolveExistingPrefabId(prefabPath: string): Promise<string | undefined> {
  return resolveExistingDocumentId(prefabPath);
}

/** The id an existing JSON asset document at `docPath` already carries, by the same two-step
 *  lookup as {@link resolveExistingPrefabId} — which is this, for a prefab. Nothing about the
 *  lookup is prefab-specific; the New-asset "Replace" path uses it too, so replacing a material
 *  keeps the refs that point at it (#1215). */
export async function resolveExistingDocumentId(docPath: string): Promise<string | undefined> {
  const known = getGuidForPath(docPath);
  if (known) return known;
  try {
    const res = await fetch(assetUrl(docPath));
    if (!res.ok) return undefined;
    const data = await res.json() as { id?: unknown };
    return typeof data.id === 'string' ? data.id : undefined;
  } catch {
    return undefined;
  }
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
      // instance (used to address scene-level overrides on it).
      if (PrefabInstanceMeta) {
        const childEntity = findEntity(childRoot);
        if (childEntity?.has(PrefabInstanceMeta.trait)) {
          childEntity.set(PrefabInstanceMeta.trait, {
            ...(childEntity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), parentLocalId: pe.localId,
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
  for (const e of child.entities) {
    if (e.prefab && wouldCreateCycle(parentGuid, e.prefab, _seen)) return true;
  }
  return false;
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
      // future instance collide on the same guid.
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
export function captureInstanceOverrides(
  rootInstanceId: number,
  prefab: PrefabFile,
): Record<number, Record<string, Record<string, unknown>>> {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return {};

  const allTraits = getAllTraits();
  const result: Record<number, Record<string, Record<string, unknown>>> = {};
  const resolveBase = baseTokenResolver(rootInstanceId);

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
    const prefabEntity = prefab.entities.find((e) => e.localId === localId);
    for (const [traitName, fields] of Object.entries(diffs)) {
      const prefabData = prefabEntity?.traits[traitName];
      if (prefabData === undefined || prefabData === true) continue; // added trait/tag — keep
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
        if (traitName === 'EntityAttributes' && field === 'guid') continue; // per-instance identity, never an override
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
  consumedEcsIds: Set<number>;
  /** ecsId → the nested-prefab ROW localId it is the expansion of, for the nested instances
   *  directly under this instance's members. This is the AUTHORITATIVE owned/independent split
   *  (#1354): `serializeScene` must route by this rather than re-testing `PrefabInstance.
   *  parentLocalId` itself, or the two disagree and an instance is written by neither — see the
   *  ⚠️ note on the partition in `captureInstanceStructure`. */
  ownedNested: Map<number, number>;
}

/** The ONE compaction an added node's trait bag goes through (#1381 close-out): schema-default fields
 *  dropped, a runtime guid dropped, the live `parentId` dropped (#1377). Shared by the live capture
 *  (`snapshotAddedTraits`) and by `sameStructure`, which runs a FILE-authored bag through it so a
 *  legacy full bag compares equal to the compacted capture of the entity it spawns. Idempotent. */
function compactAddedTraitData(meta: TraitMeta, data: Record<string, unknown>): Record<string, unknown> {
  const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
  const soa = !!schema && typeof schema === 'object';
  const keys = soa ? Object.keys(schema!).filter((k) => k in data) : Object.keys(data);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
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
    if (soa && !meta.fields[key]?.entityId && isTraitDefault(data[key], schema![key])) continue;
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

/** Every template key a prefab document declares — its rows' `added`, their `nestedStructure[*].added`,
 *  and a reference node's own `added`/`nestedStructure`, recursively. Memoised per cached document. */
const templateKeysByDoc = new WeakMap<PrefabFile, string[]>();
function templateKeysOf(doc: PrefabFile): string[] {
  const memo = templateKeysByDoc.get(doc);
  if (memo) return memo;
  const keys: string[] = [];
  const nodes = (list: AddedEntity[] | undefined): void => {
    for (const n of list ?? []) {
      if (n.key) keys.push(n.key);
      nodes(n.children);
      nodes(n.added);
      structure(n.nestedStructure);
    }
  };
  const structure = (paths: NestedStructurePaths | undefined): void => {
    for (const delta of Object.values(paths ?? {})) nodes(delta?.added);
  };
  for (const pe of doc.entities) { nodes(pe.added); structure(pe.nestedStructure); }
  templateKeysByDoc.set(doc, keys);
  return keys;
}

/** The template key a live added node had when it was spawned, recovered from its guid — for when
 *  the marker is gone. Any scene-form round trip drops it: Play→Stop reloads a `serializeScene`
 *  snapshot, and delete→undo respawns from a registry-only snapshot. Minting a fresh key then
 *  re-keyed the node, moved every instance's derived guid, and pinned the inner prefab's untouched
 *  interior into the outer row on a no-op save (the #1381 defect over again — #1387 review).
 *
 *  Both round trips keep the node's GUID, and a keyed node's guid is `deriveMemberGuid(anchor,
 *  [...path, '+' + key])`. So each ancestor is tried as the anchor, with each key the cached prefab
 *  files declare, until the derivation reproduces the live guid. A keyed ancestor that lost its marker
 *  too recovers first. `''` when nothing matches: the node was not spawned from a template key. */
function recoverTemplateKey(ecsId: number, memo = new Map<number, string>()): string {
  const done = memo.get(ecsId);
  if (done !== undefined) return done;
  memo.set(ecsId, ''); // a parent cycle resolves to nothing instead of recursing
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta) return '';
  const guid = durableGuid(readTraitData(ecsId, eaMeta)?.guid as string);
  if (!guid) return '';
  const keys = new Set<string>();
  for (const doc of new Set(prefabCache.values())) for (const k of templateKeysOf(doc)) keys.add(k);
  if (!keys.size) return '';
  const steps: (number | string)[] = [];
  let cur = (readTraitData(ecsId, eaMeta)?.parentId as number) || 0;
  const seen = new Set<number>([ecsId]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const anchor = durableGuid(readTraitData(cur, eaMeta)?.guid as string);
    if (anchor) {
      for (const k of keys) {
        if (deriveMemberGuid(anchor, [...steps, addedKeyStep(k)]) === guid) { memo.set(ecsId, k); return k; }
      }
    }
    // This ancestor is on the path, not the anchor: prepend its step, as the derive pass does. A
    // prefab member steps by its localId. Only a plain node can be a keyed one that lost its marker,
    // and only that case recovers recursively. The memo keeps the whole walk linear in depth (a
    // recursion at every ancestor was 2^depth: measured 1 s per node at depth 14 — #1352 review).
    const ownKey = templateKeyOf(findEntity(cur));
    const pi = piMeta ? readTraitData(cur, piMeta) : null;
    const step = ownKey ? addedKeyStep(ownKey)
      : pi ? memberStepId(pi as { localId?: number; parentLocalId?: number })
      : (() => { const k = recoverTemplateKey(cur, memo); return k ? addedKeyStep(k) : 0; })();
    steps.unshift(step);
    cur = (readTraitData(cur, eaMeta)?.parentId as number) || 0;
  }
  return '';
}

/** Compute the structural diff between a live prefab instance and its source:
 *  child entities the instance added, prefab members it deleted, and prefab
 *  components it removed from surviving members. (Added components are already
 *  captured as added-trait overrides by captureInstanceOverrides.) */
export function captureInstanceStructure(rootInstanceId: number, prefab: PrefabFile, opts: StructureCaptureOpts = {}): InstanceStructure {
  const empty: InstanceStructure = { added: [], removed: [], removedTraits: {}, consumedEcsIds: new Set(), ownedNested: new Map() };
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
  const nestedCandidates: { ecsId: number; key: string; stamp: number }[] = [];
  for (const [memberEcs, memberLocal] of ecsToLocal) {
    for (const child of childrenOf.get(memberEcs) || []) {
      if (!child.traits.includes('PrefabInstance')) continue;
      const pi = readTraitData(child.id, PrefabInstanceMeta);
      if (!pi || pi.rootInstanceId !== child.id) continue;
      nestedCandidates.push({
        ecsId: child.id,
        key: `${memberLocal}:${(pi.source as string) || ''}`,
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
    const channels = captureNestedChannels(source, ref.ownedNested, { template: opts.template });
    for (const c of channels.consumedEcsIds) consumedEcsIds.add(c);
    return {
      parentLocalId, ...addedNodeIdentity(ecsId, opts.template), name: byId.get(ecsId)?.name || '', traits: {}, children: [],
      prefab: source,
      overrides: ref.overrides, added: ref.added, removed: ref.removed, removedTraits: ref.removedTraits,
      nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure,
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
      if (isMember(child.id)) continue;
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
      if (isMember(child.id)) continue;
      const node = captureChild(child.id, localId);
      if (node) added.push(node);
    }
  }

  return { added, removed, removedTraits, consumedEcsIds, ownedNested: ownedByEcs };
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
): { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> } {
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
  let result: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> } = {};
  for (let i = 0; i < path.length; i++) {
    if (!prefab) return result;
    const row = prefab.entities.find((e) => e.localId === path[i] && e.prefab);
    if (!row) return result;
    const { direct, forward } = descendPathKeyed(pending, path[i]!);
    if (i === path.length - 1) {
      // An outer row addressing this path OWNS the interior — all three lists, absent read as empty
      // (the loader's `structDirect` rule).
      result = direct
        ? { added: direct.added ?? [], removed: direct.removed ?? [], removedTraits: direct.removedTraits ?? {} }
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
  a: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> },
  b: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> },
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
  }));
  return norm(a) === norm(b);
}

/** Does this structural delta state nothing at all? */
function emptyStructure(
  v: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> },
): boolean {
  return !v.added?.length && !v.removed?.length && !Object.keys(v.removedTraits ?? {}).length;
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
} {
  const consumedEcsIds = new Set<number>();
  const ownedMemberEcsIds = new Set<number>();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { consumedEcsIds, ownedMemberEcsIds };
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
          return !pi || (pi.rootInstanceId === id && !pi.parentLocalId);
        });
        if (extra.length) console.warn(`[Prefab] nested prefab "${childSource}" not cached; ${extra.length} entit${extra.length === 1 ? 'y' : 'ies'} added inside it not captured`);
        continue;
      }
      const at = [...path, rowLocalId];
      const key = nestedPathKey(at);
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
      const structure = captureInstanceStructure(ecsId, childPrefab, { template: opts.template });
      for (const id of structure.consumedEcsIds) consumedEcsIds.add(id);
      const live = { added: structure.added, removed: structure.removed, removedTraits: structure.removedTraits };
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
  };
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
  structure: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> },
): void {
  if (!structure) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  const localToEcs = new Map<number, number>();
  const nestedRoots: [number, number][] = [];
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    const parentLocalId = (piData.parentLocalId as number) || 0;
    if (parentLocalId && piData.rootInstanceId === entity.id()) nestedRoots.push([parentLocalId, entity.id()]);
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
        if (node.added?.length || node.removed?.length || node.removedTraits) {
          applyStructureByRootInstance(childRoot, child, { added: node.added, removed: node.removed, removedTraits: node.removedTraits });
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
export function tagEntityTreeAsInstance(rootEcsId: number, source: string, writtenPrefab?: PrefabFile): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

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

  /** ⚠️ `piData` must name EVERY field of PrefabInstance. koota's generated setter is a partial
   *  merge (`if ('k' in value) store.k[i] = value.k`), so an omitted field keeps its old value —
   *  and this used to be masked by Create Prefab stripping the trait first. A surviving
   *  `parentLocalId` makes serialize classify the row as an OWNED nested instance of the prefab
   *  it used to belong to (`serialize.ts` `parentIsMember && parentLocalId`), which writes no
   *  scene entry for it at all and loses the new link on the next reload. */
  const applyTag = (ecsId: number, localId: number) => {
    const entity = findEntity(ecsId);
    if (!entity) return;
    const piData = { source: ref, localId, rootInstanceId: rootEcsId, parentLocalId: 0 };
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, piData);
    else entity.add(PrefabInstanceMeta.trait(piData));
  };

  // The same decision procedure the serializer used — but a SECOND read of the world, so it is
  // checked against the file before anything is written. (`planPrefabRows` only returns null for
  // a cycle, which needs `existingId`; this call passes none, so that cannot fire here.)
  const plan = planPrefabRows(tree, rootEcsId)!;
  if (writtenPrefab && !planMatchesFile(plan, writtenPrefab, source)) return;
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
          ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), parentLocalId: localId,
        });
      }
      continue;
    }
    applyTag(info.id, localId);
  }
  markStructureDirty();
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
    entity.remove(PrefabInstanceMeta.trait);
    removed.add(info.id);
  }

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
        ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), parentLocalId: 0,
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
 *  that followed deliberately does not retag them. Detach proper keeps the default. */
export function detachPrefabInstance(rootEcsId: number, opts?: { strip?: boolean }): DetachedInstanceTrait[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
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
      data: { source: pi.source, localId: pi.localId, rootInstanceId: pi.rootInstanceId, parentLocalId: pi.parentLocalId },
    });
    if (strip) entity.remove(PrefabInstanceMeta.trait);
  }
  if (snapshot.length) markStructureDirty();
  return snapshot;
}

/** Inverse of detachPrefabInstance — re-add the captured PrefabInstance traits
 *  (undo of a detach). */
export function reattachPrefabInstance(
  snapshot: DetachedInstanceTrait[],
  /** The subtree undo is restoring. Given, an unresolved ref is only counted as LOST once the link
   *  is confirmed absent from the world. Omit it and every unresolved ref counts, which is right
   *  for a caller that stripped the whole tree (Detach). */
  opts?: { rootEcsId?: number },
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta || !snapshot.length) return 0;
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
      replaceCachedPrefab(source, prefab);
      console.log(`[Prefab] Wrote "${prefab.name}" → ${path}`);
      return true;
    }
    console.error(`[Prefab] Could not write "${prefab.name}" → ${path} (HTTP ${res.status})`);
  } catch (e) {
    console.error('[Prefab] Write failed:', e);
  }
  // No local file-picker fallback: showSaveFilePicker writes to the user's LOCAL
  // disk, not the project working copy (so the prefab would never reach the repo).
  // A prefab always has a real target path here (resolved above), so a failure
  // means a genuine backend error — report it rather than silently misdirecting.
  return false;
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
 *  reference node's `added` and its `nestedStructure`: `guid` cleared (the bag's copy too) and a `key`
 *  given — the live entity's own marker when it still has one, else a fresh one. Promotion is where a
 *  scene capture becomes a prefab row, so it is where the two forms meet. */
function toTemplateNodes(nodes: AddedEntity[] | undefined): AddedEntity[] | undefined {
  if (!nodes) return nodes;
  return nodes.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    const key = n.key || (live ? templateKeyOf(findEntity(live)) : '') || newGuid();
    const traits = { ...n.traits };
    const ea = traits['EntityAttributes'];
    if (ea && ea !== true && 'guid' in ea) { const { guid: _drop, ...rest } = ea; traits['EntityAttributes'] = rest; }
    const out: AddedEntity = { ...n, guid: '', key, traits, children: toTemplateNodes(n.children) ?? [] };
    if (n.added) out.added = toTemplateNodes(n.added);
    if (n.nestedStructure) out.nestedStructure = toTemplateStructure(n.nestedStructure);
    return out;
  });
}

function toTemplateStructure(paths: NestedStructurePaths | undefined): NestedStructurePaths | undefined {
  if (!paths) return paths;
  const out: NestedStructurePaths = {};
  for (const [k, v] of Object.entries(paths)) out[k] = v.added ? { ...v, added: toTemplateNodes(v.added) } : v;
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
): void {
  const myLocalId = nextId.v++;

  // Reference node (a user-added nested instance) → write a nested-instance ROW,
  // mirroring serializePrefab. Its members come from the child prefab; its diffs
  // ride in the row's overrides/structure. The file becomes v2.
  if (node.prefab) {
    prefab.entities.push({
      localId: myLocalId,
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
  prefab.entities.push({ localId: myLocalId, name: node.name, traits });
  for (const child of node.children) insertAddedSubtree(prefab, child, myLocalId, nextId);
}

/** Apply the selected overrides back to the source prefab file. `selectedKeys`
 *  holds a mix of:
 *   - `"localId.traitName.fieldName"` — overlay a live field value;
 *   - `"+added.<guid>"`              — insert an added child subtree;
 *   - `"-removed.<localId>"`         — delete a prefab member (+ descendants);
 *   - `"-trait.<localId>.<name>"`    — delete a component from a member.
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

  // Warm THIS instance's live subtree before the structural capture below (#1284). The
  // per-root loop further down is a different set and comes far too late: `captureNestedRef`
  // runs inside the capture at `const structure = ...`, and on a cold cache it returns null
  // and the user-added nested subtree is dropped from `added[]` entirely.
  await preloadNestedPrefabsForSubtree(rootInstanceId);

  // Deep-clone the old prefab and overlay selected live values onto it. A second
  // pristine clone is the `before` snapshot for undo (oldPrefab itself isn't mutated,
  // but cloning guards against any aliasing into the cache).
  const newPrefab: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
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
      if (guid) instancePaths.set(guid, key ? key.split('.').map((x) => (x.startsWith('+') ? x : Number(x))) : []);
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

  for (const key of selectedKeys) {
    // Structural: insert an added subtree.
    if (key.startsWith('+added.')) {
      const guid = key.slice('+added.'.length);
      const node = addedByGuid.get(guid);
      if (!node) continue;
      insertAddedSubtree(newPrefab, node, node.parentLocalId, nextLocalId);
      const liveEcs = localToEcsGuid(guid);
      if (liveEcs) liveAddedRootsToDelete.push(liveEcs);
      writtenCount++;
      continue;
    }
    // Structural: remove a prefab member (and its descendants).
    if (key.startsWith('-removed.')) {
      const localId = Number(key.slice('-removed.'.length));
      const drop = new Set(prefabSubtreeLocalIds(newPrefab, localId));
      const before = newPrefab.entities.length;
      newPrefab.entities = newPrefab.entities.filter((e) => !drop.has(e.localId));
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

  if (writtenCount === 0) {
    console.log('[Prefab] No applicable overrides to apply.');
    return NOOP_APPLY;
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
  refreshInstances(source, rootsToRefresh, oldPrefab, newPrefab);

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
  };
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
  const chainOf = (n: number): number[] | null => {
    const chain: number[] = [];
    let cur = n, guard = 0;
    while (cur && cur !== outerRootId && guard++ < 64) {
      const pi = piOf(cur);
      if (!pi) break;
      chain.unshift((pi.parentLocalId as number) || 0);
      cur = rootOf(byId.get(cur)?.parentId ?? 0); // climb to the parent instance's root
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
  chain: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]> },
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
  const eaMeta = getTraitByName('EntityAttributes');
  if (!PrefabInstanceMeta) return;

  // The nested instance root produced by row `parentLocalId` of `parentRoot`.
  const findChildNestedRoot = (parentRoot: number, parentLocalId: number): number => {
    let found = 0;
    getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
      if (found) return;
      const p = pi as Record<string, unknown>;
      const id = entity.id();
      if (p.rootInstanceId !== id) return;                            // must be an instance root
      if (((p.parentLocalId as number) || 0) !== parentLocalId) return;
      const eaParentId = eaMeta ? ((readTraitData(id, eaMeta)?.parentId as number) ?? 0) : 0;
      const parentPi = readTraitData(eaParentId, PrefabInstanceMeta); // its EA parent must be a member of parentRoot
      if (parentPi && parentPi.rootInstanceId === parentRoot) found = id;
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
export function rebuildInstance(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; consumedEcsIds?: Set<number> },
  /** The document the LIVE tree was expanded from, when it is not `prefab` — a refresh's old file. The
   *  nested re-apply subtracts what that document's chain applies (#1386, #1401). */
  baseline: PrefabFile = prefab,
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return rootInstanceId;

  // Preserve the instance root's scene placement (its parent is not a member, so
  // it survives the teardown). instantiatePrefab defaults to parentId 0, which
  // would detach a nested instance or any non-root-parented instance.
  const eaMeta = getTraitByName('EntityAttributes');
  const oldRootEa = eaMeta ? readTraitData(rootInstanceId, eaMeta) : null;
  const parentId = (oldRootEa?.parentId as number) ?? 0;

  // Snapshot live per-copy overrides on nested children BEFORE the teardown
  // (they get cascade-destroyed with the outer members and re-expanded fresh).
  const nestedCaptures = captureNestedInstanceOverrides(rootInstanceId, baseline);

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
  const toDestroy = new Set<number>(members);
  const stack = [...members];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf.get(id) ?? []) {
      if (toDestroy.has(c)) continue;
      toDestroy.add(c);
      stack.push(c);
    }
  }
  deleteEntities([...toDestroy]);

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
  applyOverridesByRootInstance(newRootId, overrides);
  applyStructureByRootInstance(newRootId, prefab, structure);
  reapplyNestedInstanceOverrides(newRootId, nestedCaptures);
  // The respawned members and template-keyed added nodes are guid-less until derived (#1387). Only
  // fills empty guids, so the root's carried guid above and every restored scene guid stand.
  deriveInstanceMemberGuids(getCurrentWorld());
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
    rebuildInstance(oldRootId, source, newPrefab, captured, capturedStructure, oldPrefab);
  }

  // Reports what was REBUILT, not what was listed. The two differ exactly when a root died
  // under another root's teardown, so this line is the only place that case becomes visible.
  console.log(`[Prefab] Refreshed ${refreshed} instance(s) of "${source}"`);
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
 *  (`localId.trait.field`) removed. Structural keys are ignored here. Reverting
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
  for (const key of selectedKeys) {
    if (key.startsWith('+added.')) {
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
  return { added, removed, removedTraits, consumedEcsIds: full.consumedEcsIds, ownedNested: full.ownedNested };
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

  // Capture the instance's current state against the prefab, then subtract the
  // reverted keys to get the state to re-apply after the rebuild.
  const fullOverrides = captureInstanceOverrides(rootInstanceId, prefab);
  const fullStructure = captureInstanceStructure(rootInstanceId, prefab);
  const reducedOverrides = subtractRevertedOverrides(fullOverrides, selectedKeys);
  const reducedStructure = subtractRevertedStructure(fullStructure, selectedKeys);

  const newRootId = rebuildInstance(rootInstanceId, source, prefab, reducedOverrides, reducedStructure);

  return { newRootId, source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure };
}

