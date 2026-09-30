/** Editor instantiate: spawning a prefab document into the current world, through the runtime's one expansion (#1783),
 *  and applying live structure to an instance. */

import { expandedPrefabRefs } from '../../runtime/loaders/prefabNesting';
import { getCurrentWorld, spawnEntity, indexEntityGuid, findEntityByGuid } from '../../runtime/core/ecs/world';
import { worldIdentityParents } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { deleteEntities, markStructureDirty, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid, isGuid } from '../../runtime/loaders/assetManifest';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { UndoRefusedError } from '../undo/undoFailure';
import { capturePrefabRead, StalePrefabRead } from './prefabRead';
import { adoptParentScene } from './sceneDirty';
import type { AddedEntity, ExpansionReader, NestedOverridePaths, NestedStructureDelta, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { applyStructureCore, deriveInstanceMemberGuids, instantiatePrefabIntoWorld, spawnReferenceNode } from '../../runtime/loaders/loadSceneFile';
import type { StructureLayer as StructLayer } from '../../runtime/loaders/prefabOverrides';
import { type PrefabFile } from './prefab';
import {
  getCachedPrefabSync, prefabNestingReader, preloadNestedPrefabs, primeEditorPrefabCache, setPrefabSource,
} from './prefabCache';
import { instanceRowDomain } from './prefabMembers';

// ── Instantiate Prefab ──────────────────────────────────

/** Spawn entities from a prefab file into the world. Returns the root entity's ECS ID (0 when nothing was spawned).
 *
 *  The EDITOR's call of the one expansion, `instantiatePrefabIntoWorld` (#1783): nested rows expand from the editor's
 *  prefab cache, read synchronously (call `preloadNestedPrefabs` first — an uncached row is skipped, and recorded on the
 *  frame as unexpanded). What stays here is what only the editor does: refusing a stale parent (#1793), and the dirty
 *  marks the Hierarchy and the DOM UI tree rebuild from. */
export function instantiatePrefab(
  prefab: PrefabFile,
  parentId: number = 0,
  /** The cycle stack to expand under: a rebuild's, holding the documents of the frames above it (`frameForward`). */
  stack?: Set<string>,
  /** Overrides an OUTER layer applies to this prefab's nested descendants (path-keyed); outermost layer wins. */
  nestedOverrides?: NestedOverridePaths,
  /** The structural layers the frames ENCLOSING this instance forward into it (a rebuild's `frameForward`, #1737). They
   *  reach its nested rows only: the call hands no `structure` of its own, so their rows at the root's frame fold into
   *  nothing, and the root's own frame comes back through the rebuild's capture. */
  layers?: StructLayer<NestedStructureDelta, SceneMemberRow>[],
): number {
  // ⚠️ A raw parent id that no live entity holds REFUSES, before anything is spawned (#1793 defence in depth, hub
  // 2026-09-29). The placements hand `instantiatePrefabInstance` their parent as a guid ref it resolves after its own
  // awaits (`placePrefabFromPath`, the agent's instantiate), so a dead id here is a new route handing a stale number
  // down, and it must be loud. It cannot see a stale number that is LIVE in a new world — that is what resolving late is
  // for.
  if (parentId > 0 && !findEntity(parentId)) {
    throw new UndoRefusedError(`[Prefab] refusing to instantiate "${prefab.name ?? prefab.id ?? 'a prefab'}" under entity ${parentId}: no live entity holds that id (a stale parent, #1793).`,
      `"${prefab.name ?? 'The prefab'}" was not placed: the entity it was to go under is no longer in the scene.`);
  }
  // …and the SAME entity once the walk has run: nothing in a synchronous spawn destroys it, so a change is a new route.
  // #1793's thrown redo was a DEAD id that koota recycled during the spawn, so the walk parented the root under one of
  // its own members. The handle carries koota's generation, so a recycled index reads as another entity.
  const parentHandle = parentId > 0 ? findEntity(parentId) : null;
  // The source is a guid or nothing (I22): `setPrefabSource`'s rule, for the one document a caller hands in.
  const source = prefab.id && isGuid(prefab.id) ? prefab.id : '';
  const rootEcsId = instantiatePrefabIntoWorld(getCurrentWorld(), prefab, parentId, undefined, source, undefined, undefined,
    stack, nestedOverrides, undefined, { read: getCachedPrefabSync as ExpansionReader, layers });
  if (parentHandle && findEntity(parentId) !== parentHandle) {
    // Refused loudly, with what this call spawned taken back out: parenting the root under whatever holds the id now is
    // how a redo once parented an instance under its own member.
    if (rootEcsId) deleteEntities([rootEcsId]);
    throw new UndoRefusedError(`[Prefab] refusing to parent "${prefab.name ?? prefab.id ?? 'a prefab'}" under entity ${parentId}: it is not the entity the instantiate was handed any more (#1793).`,
      `"${prefab.name ?? 'The prefab'}" was not placed: the entity it was to go under changed while it was being built.`);
  }
  // The Hierarchy refreshes from the remapped parent links, and a UI prefab's entities render only once the DOM UI tree
  // rebuilds (markStructureDirty refreshes the Hierarchy alone).
  markStructureDirty();
  markUIDirty();
  return rootEcsId;
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
 *  and churning the runtime cache on every drag-drop would be pure cost.
 *
 *  ⚠️ A READ, so it carries the read's token (#1752, `prefabRead.ts`). `prefab` is what the caller read BEFORE the
 *  nested preload's await; a write landing in that await (or in the caller's own fetch — which is why a caller that
 *  fetches captures `readAt` before it) seats the newer document, and priming after it put the older one back: the
 *  instance was spawned from the old rows, and every frame expanded from the new ones read as stale, so the next rebase
 *  rebuilt them onto the old document. Now a moved token REFUSES — {@link StalePrefabRead}, thrown after the preload
 *  and BEFORE the spawn, so nothing is added and nothing is primed. Never a re-read: the caller asked to place the
 *  copy it read, and placing another one silently is a re-target. */
export async function instantiatePrefabInstance(
  prefab: PrefabFile, sourcePath: string,
  /** The parent, or a resolver of it (an entity ref's `require`), asked AFTER this function's awaits, right before the
   *  spawn (#1793 review): a parent resolved before them names, after a world rebuild during them, whatever entity holds
   *  that number in the new world, which is usually live, so no liveness check can tell. A number is taken as it is. */
  parent: number | (() => number) = 0,
  /** From `capturePrefabRead(sourcePath)`, taken before the caller's read. Omitted, the window starts here. */
  readAt: () => boolean = capturePrefabRead(sourcePath),
  /** The root guid to mint instead of a fresh one: an undo step's redo putting its instance back (`prefabInstantiateUndo.ts`).
   *  Minted BEFORE the members derive, so they derive from it as a reload derives them. */
  rootGuid?: string,
): Promise<number> {
  // Loaded here, not at the top: the refusal reads the loaded scene through `SceneManager`, and a static import put that
  // whole module under every reader of this one. Before the read-token check, so check → spawn stays synchronous.
  const { assertPrefabEditAllows } = await import('./prefabEditRefusal');
  await preloadNestedPrefabs(prefab);
  if (!readAt()) throw new StalePrefabRead(prefab.name ?? 'the prefab');
  const parentId = typeof parent === 'function' ? parent() : parent;
  // In prefab edit (#1817, #1836): an instance outside the root is dropped by the save, and one of the edited prefab — or
  // of any prefab that contains it — would make the save write a file containing itself. After the preload, so the
  // nested documents it walks are cached; before the spawn, so a refusal adds nothing. Every placement (the Hierarchy
  // drop, the Assets and Inspector Instantiate buttons, the agent `instantiate`) arrives here.
  assertPrefabEditAllows({
    kind: 'add', parentId, read: prefabNestingReader(), // #1866: a trashed prefab is read from its live frames
    prefabs: [...(prefab.id ? [prefab.id] : []), ...expandedPrefabRefs(prefab.entities)],
  });
  // SYNCHRONOUS from the check to the prime (close-out review): with an await between them, a commit whose cache seat was
  // already queued could land in the gap, and the prime put the older document back over it after all.
  const rootId = spawnPrefabInstance(prefab, parentId, rootGuid);
  if (!rootId) return rootId;
  // Under a base entity the new instance belongs to that base (#1429). Every caller's redo re-runs this
  // helper, so the stamp comes back with it.
  adoptParentScene(rootId);
  setPrefabSource(rootId, prefab);
  // The ref setPrefabSource wrote: the document's guid, or nothing when the document has none (refused, logged).
  const piMeta = getTraitByName('PrefabInstance');
  const live = piMeta ? (readTraitData(rootId, piMeta)?.source as string | undefined) : undefined;
  if (live) primeEditorPrefabCache(live, prefab);
  return rootId;
}

/** Async-safe instantiate: preload every nested child into the editor cache, THEN
 *  run the synchronous `instantiatePrefab`. Use this from UI entry points (drag-drop,
 *  Instantiate buttons) — `instantiatePrefab` alone silently skips nested rows whose
 *  child file isn't cached yet, so callers MUST preload first. This makes the
 *  preload contract un-missable for the common case. */
export async function instantiatePrefabAsync(prefab: PrefabFile, parentId: number = 0): Promise<number> {
  await preloadNestedPrefabs(prefab);
  return spawnPrefabInstance(prefab, parentId);
}

/** `instantiatePrefabAsync`'s synchronous half: the nested prefabs are already in the cache. */
function spawnPrefabInstance(prefab: PrefabFile, parentId: number, rootGuid?: string): number {
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
      // A redo's recorded guid, unless another live entity holds it: two entities under one identity is worse than the
      // fresh guid the redo then keeps.
      const restored = rootGuid && durableGuid(rootGuid) && !findEntityByGuid(rootGuid) ? rootGuid : undefined;
      // A runtime guid (#1210) is not an identity: mint over it like an empty one.
      if (restored || !durableGuid(ea.guid as string)) { rootEntity.set(attrMeta.trait, { ...ea, guid: restored ?? newGuid() }); indexEntityGuid(rootEntity); }
    }
  }
  // Stamp stable member GUIDs so the new instance's children are referenceable.
  deriveInstanceMemberGuids(getCurrentWorld());
  return rootId;
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
  /** The expansion's ancestor prefab ids (I16), from a caller inside one (`instantiatePrefab`, a reference node's
   *  spawn). `prefab` joins them here, so a reference node in this structure that contains any of them is refused
   *  instead of recursing until the stack overflows (#1817). Omitted, the expansion starts at `prefab`. */
  stack?: ReadonlySet<string>,
): void {
  if (!structure) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Every ROW of the document, as `instantiatePrefabIntoWorld`'s map holds them on the runtime side: the members,
  // and each nested row mapped to the instance it expanded to — so a `removed` nested row (#1355) is deleted here
  // too, not skipped. From the one row domain (`instanceRowDomain`, #1484): read off "the root's live parent is a
  // member", a nested row under a nested row was never mapped, and a Revert or Apply brought a deleted one back.
  const domain = instanceRowDomain(rootInstanceId, prefab, worldIdentityParents(getCurrentWorld()));
  const localToEcs = new Map(domain.localToEcs);
  if (localToEcs.size === 0) return;
  for (const [id, rowLocalId] of domain.ownedByEcs) if (!localToEcs.has(rowLocalId)) localToEcs.set(rowLocalId, id);

  // Delegate to the world-parameterized shared core (F7) with editor-world ops, so
  // the runtime (applyStructureByLocalToEcs) and editor paths can never drift.
  const ancestors = new Set(stack);
  if (prefab.id) ancestors.add(prefab.id);
  applyStructureCore(editorStructureOps(), localToEcs, prefab, structure, ancestors);
}


/** The editor-world ops `applyStructureCore` runs with. */
function editorStructureOps(): Parameters<typeof applyStructureCore>[0] {
  return {
      logPrefix: '[Prefab]',
      world: getCurrentWorld(),
      deleteEntities: (ecsIds) => deleteEntities(ecsIds),
      findEntity: (ecsId) => findEntity(ecsId) ?? undefined,
      spawnAdded: (traitArgs) => {
        const entity = spawnEntity(getCurrentWorld(), ...(traitArgs as Parameters<ReturnType<typeof getCurrentWorld>['spawn']>));
        return entity.id();
      },
      // A scene-added reference node: the loader's own spawner, reading the editor's cache (#1783). parentLocalId stays 0
      // on the spawned root, so the next capture re-detects it as user-added.
      spawnNestedInstance: (node, parentEcsId, ancestors) => spawnReferenceNode(getCurrentWorld(), node, parentEcsId, ancestors, getCachedPrefabSync as ExpansionReader),
      onComplete: () => {
        markStructureDirty();
        markUIDirty(); // added entities may be UI — rebuild the DOM UI tree
      },
  };
}
