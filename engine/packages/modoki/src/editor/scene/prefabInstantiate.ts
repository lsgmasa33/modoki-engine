/** Editor instantiate: spawning a prefab document into the current world and applying live structure to an instance.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandsToRoot, refuseCyclicReferenceNode, stackForReferenceNode } from '../../runtime/loaders/prefabRoot';
import { expandedPrefabRefs } from '../../runtime/loaders/prefabNesting';
import { getCurrentWorld, spawnEntity, indexEntityGuid } from '../../runtime/core/ecs/world';
import { worldIdentityParents, noteFrameDoc, noteNodeMoves } from '../../runtime/core/ecs/identityParents';
import { getAllTraits, getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { deleteEntities, markStructureDirty, readTraitData, writeTraitField, findEntity } from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { setTemplateKey } from '../../runtime/core/templateIdentity';
import { UndoRefusedError } from '../undo/undoFailure';
import { capturePrefabRead, StalePrefabRead } from './prefabRead';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { clearOverrideMarks } from '../../runtime/loaders/overrideMarks';
import { adoptParentScene } from './sceneDirty';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, NestedStructureDelta, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { spawnUnresolvedReference } from '../../runtime/loaders/unresolvedPrefabRefs';
import { mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, mergeNestedStructurePaths, descendPathKeyed, deriveInstanceMemberGuids, applyStructureCore, rowPathInPrefab, registerTemplateFrame, openTokenScope, closeTokenScope, noteTokens, queuePrefabMoves } from '../../runtime/loaders/loadSceneFile';
import { descendStructureLayers, foldStructureLayers, type StructureLayer as StructLayer } from '../../runtime/loaders/prefabOverrides';
import { rebaseMemberTokens, type MemberStep } from '../../runtime/core/templateRefs';
import { type PrefabFile } from './prefab';
import {
  getCachedPrefabSync, prefabNestingReader, preloadNestedPrefabs, primeEditorPrefabCache, setPrefabSource,
} from './prefabCache';
import { applyOverridesByRootInstance } from './prefabInstanceOverrides';
import { instanceRowDomain } from './prefabMembers';

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
  /** The structural LAYERS reaching this frame, innermost first — the loader twin's parameter (#1533).
   *  A top call has one, the outer layer's slots; each nested row adds its own. */
  _layers?: StructLayer<NestedStructureDelta, SceneMemberRow>[],
  /** What each of `_layers` forwarded to this frame's nested roots when the caller folded it here. */
  _forwardRoots: readonly (ReadonlyMap<number, SceneMemberRow> | undefined)[] = [],
): number {
  // ⚠️ A raw parent id that no live entity holds REFUSES, before anything is spawned (#1793 defence in depth, hub
  // 2026-09-29). The placements hand `instantiatePrefabInstance` their parent as a guid ref it resolves after its own
  // awaits (`placePrefabFromPath`, the agent's instantiate), so a dead id here is a new route handing a stale number
  // down, and it must be loud. It cannot see a stale number that is LIVE in a new world — that is what resolving late is
  // for. Asked HERE, not in the
  // second pass: #1793's thrown redo was a DEAD id that koota recycled during this call's own first-pass spawn, so the
  // second pass saw it live (one of this instance's members) and parented the root under itself.
  if (parentId > 0 && !findEntity(parentId)) {
    throw new UndoRefusedError(`[Prefab] refusing to instantiate "${prefab.name ?? prefab.id ?? 'a prefab'}" under entity ${parentId}: no live entity holds that id (a stale parent, #1793).`,
      `"${prefab.name ?? 'The prefab'}" was not placed: the entity it was to go under is no longer in the scene.`);
  }
  // …and the SAME entity at the second pass: nothing in a synchronous spawn destroys it, so a change there is a new route.
  // The handle carries koota's generation, so a recycled index reads as another entity (`captureEntityIdentity`'s test).
  const parentHandle = parentId > 0 ? findEntity(parentId) : null;
  const sameParent = parentHandle ? () => findEntity(parentId) === parentHandle : null;
  // The loader twin's rule (#1768): a document with no root to expand spawns nothing.
  if (!expandsToRoot(prefab, getCachedPrefabSync, _stack)) {
    console.warn(`[Prefab] prefab ${prefab.id ?? '(unnamed)'} expands to no root; nothing spawned`);
    return 0;
  }
  const segments = _segments ?? [];
  const layers = _layers ?? [{ slots: _nestedStructure }];
  // The loader twin's token scope: a tree holding no member token registers no frame (#1352 review).
  const outerScope = _segments ? null : openTokenScope();
  // A top call notes every value it is handed, as the loader's twin does. `_layers` from outside is a rebuild's forwarded
  // state (#1737) or a reference node's own slots and rows; a nested call's layers are the top call's, descended.
  noteTokens(prefab.entities, _nestedOverrides, _nestedStructure, _segments ? undefined : _layers);
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
  // Nested rows this expansion could not expand — recorded on the frame, as the loader twin does (#1812).
  const unexpanded: number[] = [];

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
        if (pe.localId) unexpanded.push(pe.localId);
        continue;
      }
      // Overrides an OUTER layer addressed at this nested row: `direct` hits this
      // child's own members; `forward` reaches deeper. The row's own deep overrides
      // (pe.nestedOverrides) are merged under the outer layer (outer wins).
      const { direct: outerDirect, forward: outerForward } = descendNestedOverrides(_nestedOverrides, pe.localId);
      const childNested = mergeNestedOverridePaths(pe.nestedOverrides, outerForward);
      // The structural split, as the loader does it, per LAYER (#1533): an outer layer that addresses this
      // row OWNS its interior (all three lists, an absent one read as empty), and the rows of every layer
      // it does not replace fold over that, inner first. `structForward` reaches deeper.
      const { layers: childLayers, direct: structDirect, foldFrom } = descendStructureLayers(layers, pe, _forwardRoots);
      const { forward: outerStructForward } = descendPathKeyed(_nestedStructure, pe.localId);
      // The row's OWN deep structure (#1381) sits under the outer layer's — the loader's rule.
      const structForward = mergeNestedStructurePaths(pe.nestedStructure, outerStructForward);
      const childOverrides = outerDirect ? mergeOverrideMaps(pe.overrides, outerDirect) : pe.overrides;
      const base = structDirect
        ? { overrides: childOverrides, added: structDirect.added ?? [], removed: structDirect.removed ?? [], removedTraits: structDirect.removedTraits ?? {} }
        : { overrides: childOverrides, added: pe.added, removed: pe.removed, removedTraits: pe.removedTraits };
      // Folded BEFORE the recursion, unlike the lists' application below: what a row forwards to a nested
      // root of the child has to reach the child's own expansion of that root.
      const { channels: childStructure, forwardRoots: childForwardRoots } = foldStructureLayers(child, childLayers, foldFrom, base);
      const childSegments = [...segments, rowPathInPrefab(prefab, pe.localId)];
      const childRoot = instantiatePrefab(child, 0, stack, childNested, structForward, childSegments, childLayers, childForwardRoots);
      if (!childRoot) { if (pe.localId) unexpanded.push(pe.localId); continue; } // expanded to no root (#1768)
      setPrefabSource(childRoot, child, pe.prefab);
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
      // A row's `traits` fold into the overrides as the loader folds them.
      const folded = childStructure.overrides;
      if (folded) applyOverridesByRootInstance(childRoot, rebaseMemberTokens(folded, childSegments) as typeof folded);
      // The frame's MOVES too, as the loader hands them to its child (#1707): a slot owning the frame states them by localId
      // (a pre-v5 member no row can key), and the OUTERMOST layer's member rows by `parent`. This apply is where the frame's
      // removals run, and its cascade stops at a member it is told has moved. Without them a pre-v5 member moved inside a
      // scene-added reference node went back to its row on every rebuild of the instance around it, and a member moved OUT
      // from under a member the same frame removes was deleted with it (close-out review 2). The move a row states is
      // queued here and again by the caller's top frame, whose `memberRowsIn` reaches this frame; the drain keeps one.
      const members = childLayers[childLayers.length - 1]!.rows;
      if (structDirect || childStructure !== base || pe.added?.length || pe.removed?.length || pe.removedTraits || members) {
        applyStructureByRootInstance(childRoot, child, {
          added: rebaseAddedMemberTokens(childStructure.added, childSegments), removed: childStructure.removed, removedTraits: childStructure.removedTraits,
          moved: structDirect?.moved, members,
        }, stack);
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
  if (prefab.id && rootEcsId) noteFrameDoc(getCurrentWorld(), prefab.id, prefab, findEntity(rootEcsId) ?? undefined, unexpanded);

  // Second pass: remap EntityAttributes.parentId for every row (including the
  // nested-instance root). Every row reads its parent from the FILE entry — the
  // first pass spawned them all parentless (#1247). Direct findEntity writes — was
  // a full-world query.updateEach per row (O(n²)).
  const attrMeta = getTraitByName('EntityAttributes');
  if (sameParent && !sameParent()) {
    // Refused loudly, with what this call spawned taken back out (#1793 defence in depth): parenting the root under
    // whatever holds the id now is how a redo once parented an instance under its own member.
    deleteEntities([...localToEcs.values()]);
    if (outerScope) closeTokenScope(outerScope);
    throw new UndoRefusedError(`[Prefab] refusing to parent "${prefab.name ?? prefab.id ?? 'a prefab'}" under entity ${parentId}: it is not the entity the instantiate was handed any more (#1793).`,
      `"${prefab.name ?? 'The prefab'}" was not placed: the entity it was to go under changed while it was being built.`);
  }
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
  const rootId = spawnPrefabInstance(prefab, parentId);
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
function spawnPrefabInstance(prefab: PrefabFile, parentId: number): number {
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

/** Spawn scene-form `nodes` under the live entity `parentEcsId` — the editor spawn `applyStructureByRootInstance`
 *  uses, anchored at one entity instead of a member. For a v17 node row's `own` children (#1516), which hang under
 *  a template-added node rather than a member. */
export function spawnAddedUnder(parentEcsId: number, nodes: readonly AddedEntity[], stack?: ReadonlySet<string>): void {
  if (!nodes.length) return;
  const ANCHOR = 1;
  applyStructureCore(editorStructureOps(), new Map([[ANCHOR, parentEcsId]]), { entities: [], rootLocalId: ANCHOR } as never,
    { added: nodes.map((n) => ({ ...n, parentLocalId: ANCHOR })) }, stack);
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
      // Editor nested-instance expansion: instantiate → tag source → replay
      // overrides → recurse structure. parentLocalId stays 0 on the spawned root so
      // the next capture re-detects it as user-added.
      spawnNestedInstance: (node, parentEcsId, ancestors) => {
        // A node re-entering a self-containing prefab above it is the one endless shape (I16, #1817): refused, and named.
        if (refuseCyclicReferenceNode(ancestors, node, getCachedPrefabSync, '[Prefab]')) return;
        const child = getCachedPrefabSync(node.prefab!);
        // One that loads but expands to no root is kept the same way (#1768).
        if (!child || !expandsToRoot(child, getCachedPrefabSync)) {
          console.warn(`[Prefab] added nested instance "${node.prefab}" not cached, or expands to no root`);
          // The loader's twin: a placeholder carrying the node, so a rebuild keeps what the save writes back (#1699).
          spawnUnresolvedReference(getCurrentWorld(), node, parentEcsId);
          return;
        }
        // The node's own `overrides`/`added` are applied AFTER the expansion below closes its token scope,
        // so this scope wraps the whole node: the loader's twin hands them INTO its top call, which notes
        // them there (#1352 close-out review).
        const scope = openTokenScope();
        noteTokens(undefined, node.overrides, node.added, node.members);
        // The node is the OUTERMOST structural layer of its instance, as the loader's twin makes it: its whole-frame
        // slots and its member rows, whose direct rows fold over its own lists here and whose deeper rows descend with
        // the expansion. A template reference node carries rows since #1538; a scene-form transport (a rebuild, Apply,
        // Revert) carries none, and folds to its own lists unchanged.
        const layers: StructLayer<NestedStructureDelta, SceneMemberRow>[] = [{ slots: node.nestedStructure, rows: node.members }];
        const own = { overrides: node.overrides, added: node.added, removed: node.removed, removedTraits: node.removedTraits };
        const { channels, forwardRoots } = foldStructureLayers(child, layers, 0, own);
        // The node's nested channels expand with it, as the loader's twin does (#1369).
        // The self-containing ancestors carried on, so a loop through two or more documents still meets its own start and
        // is refused above (#1817).
        const childRoot = instantiatePrefab(child, parentEcsId, stackForReferenceNode(ancestors, getCachedPrefabSync), node.nestedOverrides, node.nestedStructure, undefined, layers, forwardRoots);
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
        }
        // A TEMPLATE reference node has no guid to restore; its root derives one from the key (#1387). A node carrying
        // both (a rebuild's kept row) keeps both: the key is its template identity, not a stand-in for the guid (#1567).
        if (node.key) setTemplateKey(findEntity(childRoot), node.key);
        setPrefabSource(childRoot, child, node.prefab);
        // The node's own moves, queued after its prefab's (`instantiatePrefab` just queued those), so they win (#1543).
        if (node.templateMoved) {
          queuePrefabMoves(getCurrentWorld(), childRoot, node.templateMoved, '[Prefab]');
          const root = findEntity(childRoot);
          if (root) noteNodeMoves(getCurrentWorld(), root, node.prefab!, child, node.templateMoved);
        }
        if (channels.overrides) applyOverridesByRootInstance(childRoot, channels.overrides);
        if (channels.added?.length || channels.removed?.length || channels.removedTraits || node.moved || node.members) {
          applyStructureByRootInstance(childRoot, child, { added: channels.added, removed: channels.removed, removedTraits: channels.removedTraits, moved: node.moved, members: node.members }, ancestors);
        }
      },
      onComplete: () => {
        markStructureDirty();
        markUIDirty(); // added entities may be UI — rebuild the DOM UI tree
      },
  };
}
