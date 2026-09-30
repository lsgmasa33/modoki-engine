/** The prefab document model: the file shapes (`PrefabEntity`, `PrefabFile`), the fields a template never takes, the
 *  tree walk and the guid ↔ entity-id helpers every prefab module shares. The prefab system itself is split by concern
 *  (#1656 § Plan step 5): cache and file reads `prefabCache.ts`, tokens `prefabTokens.ts`, member rows `prefabMembers.ts`,
 *  field overrides `prefabInstanceOverrides.ts`, capture `prefabCapture.ts`, frame state `prefabFrames.ts`, instantiate
 *  `prefabInstantiate.ts`, the enclosing chain `prefabChain.ts`, rebuild/refresh/rebase `prefabRebuild.ts`, serialize
 *  `prefabSerialize.ts`, Apply `prefabApply.ts` + `prefabApplyStructure.ts`, the instance link `prefabLink.ts`, Revert
 *  `prefabRevert.ts`. docs/prefabs.md § "Core operations" maps them. */

import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { validatePrefabData } from '../../runtime/loaders/sceneValidation';
import { getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { compareSiblings } from '../../runtime/core/ecs/entityOrder';
import { readTraitData, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { isRuntimeOnlyField } from '../../runtime/core/ecs/traitSchema';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';

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
   *  that addresses the same path replaces the entry whole. Since v6 (#1533) written only for a frame
   *  `members` cannot state member by member. */
  nestedStructure?: NestedStructurePaths;
  /** This row's MEMBER ROWS (prefab v6, #1533), keyed from its own expansion exactly as a scene
   *  entry's `members` are: the structure of the nested frames inside it, per member (`removed`,
   *  `traitRemovals`, `own`, the fallback `added`/`removedTraits`) and per template-added node (a node
   *  row, `…/a+<key>`). What lets an outer prefab change one thing in a nested frame without restating
   *  — and so pinning — everything the inner prefabs put there. Structural channels only: a template
   *  carries no member identity (`guid`, `name`, `parent`), and values stay in `nestedOverrides`. */
  members?: Record<string, SceneMemberRow>;
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
  /** The localId high-water mark (v8, #1774): the lowest number a NEW row may take; every localId this document has
   *  ever used is below it, and it never goes down. Absent on a file written before v8 — read through
   *  `localIdCounter`, which derives it from the highest row. See `localIdCounter.ts`. */
  nextLocalId?: number;
  entities: PrefabEntity[];
  /** Members the prefab places under a parent no row relation can express (#1437 P3-b/P3-c) — a member of
   *  one of its NESTED instances, or a nested instance's member placed in this prefab: the member's path →
   *  a member token for its new parent, both in this prefab's frame. Its row keeps its parent, so the
   *  member's identity — its path — is unchanged. Resolved after the derive pass; an instance's own move of
   *  the same member overrides it, and so does the move of a prefab nesting this one. */
  moved?: Record<string, string>;
}

// ── Save as Prefab ──────────────────────────────────────

/** Each parent's children in SIBLING order (`compareSiblings`: sortOrder, then guid), never raw ECS query order (#1796).
 *  Query order is not stable across a reload — koota's slot reuse can invert a pair — so a list written or matched in
 *  it churns: a save → reload → save swapped an instance's `added`/`own`/`children` forever, and Create Prefab's redo
 *  re-tagged by BFS position over a tree whose siblings the reload had reordered, and refused. */
export function childrenBySibling(entities: readonly EntityInfo[]): Map<number, EntityInfo[]> {
  const out = new Map<number, EntityInfo[]>();
  for (const e of entities) {
    const list = out.get(e.parentId);
    if (list) list.push(e); else out.set(e.parentId, [e]);
  }
  const bySibling = compareSiblings<EntityInfo>((e) => e.guid ?? '');
  for (const list of out.values()) list.sort(bySibling);
  return out;
}

/** Collect an entity and all its descendants (flat list, breadth-first, siblings in sibling order) — O(n) via Map lookup */
export function collectTree(entityId: number, allEntities: EntityInfo[]): EntityInfo[] {
  const byParent = childrenBySibling(allEntities);
  const byId = new Map<number, EntityInfo>();
  for (const e of allEntities) byId.set(e.id, e);
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
export function authoringEntitiesFor(selectedEntityId: number, all: EntityInfo[]): { entities: EntityInfo[]; excluded: number } {
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
export function valuesEqual(a: unknown, b: unknown): boolean {
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

/** Warn about the inert-size trap at prefab WRITE time (#42) — a `UIElement` size authored on an
 *  axis the anchor stretches is stored and shown in the Inspector, but never applied.
 *
 *  Why write time rather than load, and why this is only half the fix: docs/scene-loading.md
 *  (pass 4). Warns, never blocks — a dead size is inert, not corrupt.
 *
 *  The one thing that must stay HERE, because it is invisible in the code and looks like an
 *  obvious cleanup: call this from EVERY AUTHORING write (Apply-to-Prefab, Save-as-Prefab, prefab edit
 *  mode save, the agent `create` op — #1251), never from `commitPrefabWrite`. That is the single choke point for prefab writes AND the
 *  undo/redo restore path (Apply's undo), so hooking it warns while someone REVERTS the
 *  value. Guarded by tests/editor/warnInertPrefabSizes.test.ts. */
export function warnInertPrefabSizes(prefab: unknown, source: string, readPrefab?: (guid: string) => unknown): string[] {
  // Name the FILE even when the caller holds the GUID (PrefabInstance.source and prefab edit mode both
  // do) — the same resolution `commitPrefabWrite` applies before it writes.
  const where = isGuid(source) ? (resolveRef(source) || source) : source;
  // `readPrefab`: the nested documents the template-key check walks (#1876); every caller passes the editor cache's.
  const { warnings } = validatePrefabData(prefab, readPrefab);
  for (const w of warnings) {
    console.warn(`[Editor] ${where}: ${w}`);
  }
  // Returned for a caller whose reader is not the editor Console — the agent op answers in its response.
  return warnings;
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
export function localToEcsGuid(guid: string): number {
  if (!guid) return 0;
  const ent = findEntityByGuid(guid);
  return ent ? ent.id() : 0;
}
