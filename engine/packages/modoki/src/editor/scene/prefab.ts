/** Prefab system — save, load, and instantiate prefab entity trees. */

import { getCurrentWorld, registerEntity, findEntityByGuid, indexEntityGuid } from '../../runtime/ecs/world';
import { backendFetch } from '../backend/editorBackend';
import { getAllTraits, getTraitByName } from '../../runtime/ecs/traitRegistry';
import { getAllEntities, deleteEntities, markStructureDirty, readTraitData, readTraitDataFull, writeTraitField, findEntity, subtreeIds, type EntityInfo } from '../../runtime/ecs/entityUtils';
import { Transient } from '../../runtime/traits/Transient';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid, registerAsset, getGuidForPath, isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { invalidatePrefab } from '../../runtime/loaders/meshTemplateCache';
import { markOverride, clearOverrideMarks, getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import type { AddedEntity, NestedOverridePaths } from '../../runtime/loaders/loadSceneFile';
import { mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, prefabSubtreeLocalIds, deriveInstanceMemberGuids, applyStructureCore } from '../../runtime/loaders/loadSceneFile';

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
}

export interface PrefabFile {
  /** Stable UUID — written once at save, never changes across renames/moves. */
  id?: string;
  /** v1: flat prefab. v2: may contain nested-instance rows (`PrefabEntity.prefab`).
   *  Both share the same shape — the nested fields are optional, so a v1 file is a
   *  valid v2 file and no migration is needed. */
  version: 1 | 2;
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

/** Serialize selected entity + descendants as a prefab.
 *  Pass `existingId` when re-saving an existing prefab to preserve its UUID.
 *
 *  Nested prefab instances inside the subtree (a self-rooted PrefabInstance below
 *  the selection root) are written as *reference rows* — one row carrying the
 *  child `prefab` GUID + captured overrides/structure — and their members are
 *  excluded from the flat output. The selection root itself is never collapsed
 *  this way (so "save instance as prefab" still flattens the instance). */
export function serializePrefab(selectedEntityId: number, existingId?: string): PrefabFile | null {
  const allEntities = getAllEntities();
  const tree = collectTree(selectedEntityId, allEntities);
  if (tree.length === 0) return null;

  const piMeta = getTraitByName('PrefabInstance');

  // ── Find nested-instance roots and the members they consume ──
  const nestedRefs = new Map<number, { ref: InstanceReference; childPrefab: PrefabFile }>();
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
      const ref = captureInstanceReference(e.id, source, childPrefab);
      nestedRefs.set(e.id, { ref, childPrefab });
      // Exclude the nested instance's members (except the root, which becomes a
      // reference row) and any added subtrees it folded in.
      for (const m of ref.memberEcsIds) if (m !== e.id) skip.add(m);
      for (const c of ref.consumedEcsIds) skip.add(c);
    }
  }

  // Assign stable localIds (1-based, root = 1) over the surviving tree.
  const flatTree = tree.filter((e) => !skip.has(e.id));
  const ecsToLocal = new Map<number, number>();
  flatTree.forEach((e, i) => ecsToLocal.set(e.id, i + 1));

  const allTraits = getAllTraits();
  const prefabEntities: PrefabEntity[] = [];

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
      prefabEntities.push({
        localId,
        name: entityInfo.name,
        traits: { EntityAttributes: { name: entityInfo.name, parentId: parentLocal, guid: '' } },
        prefab: nested.ref.source,
        overrides: nested.ref.overrides,
        added: nested.ref.added,
        removed: nested.ref.removed,
        removedTraits: nested.ref.removedTraits,
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
      // the scene). AoS traits (function/undefined schema, e.g. AnimationLibrary's
      // animSets/boneMaps) need the FULL live-key read so their non-scalar fields
      // persist into the prefab file; SoA traits keep the curated meta.fields read so
      // a prefab stays a clean delta (full-schema serialize is the SCENE path's job).
      const aos = typeof (meta.trait as { schema?: unknown }).schema !== 'object';
      const traitData = aos ? readTraitDataFull(entityInfo.id, meta) : readTraitData(entityInfo.id, meta);

      if (traitData) {
        // Drop pure runtime read-back fields (e.g. Time.elapsed, RigidBody.isSleeping,
        // SkeletalAnimator.activeClip/time/weight) — like the scene serialize path
        // (serialize.ts). Otherwise creating a prefab from a live/animating entity
        // bakes a nondeterministic frame snapshot into the .prefab.json.
        for (const key of Object.keys(traitData)) {
          if (meta.fields[key]?.runtimeOnly) delete (traitData as Record<string, unknown>)[key];
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
        entry.traits[meta.name] = traitData;
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

  return {
    id: existingId ?? newGuid(),
    // v2 only when the prefab actually nests another — keeps flat prefabs at v1
    // (no churn). Both versions share the same shape (nested fields are optional).
    version: nestedRefs.size > 0 ? 2 : 1,
    name: tree[0].name,
    rootLocalId: 1,
    entities: prefabEntities,
  };
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
        if (!(tname in traits)) traits[tname] = tdata;
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
    version: Math.max(fresh.version, existing.version) as 1 | 2,
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
  const known = getGuidForPath(prefabPath);
  if (known) return known;
  try {
    const res = await fetch(assetUrl(prefabPath));
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
): number {
  const stack = _stack ?? new Set<string>();
  if (prefab.id) {
    if (stack.has(prefab.id)) {
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
      const childRoot = instantiatePrefab(child, 0, stack, childNested);
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
      const childOverrides = outerDirect ? mergeOverrideMaps(pe.overrides, outerDirect) : pe.overrides;
      if (childOverrides) applyOverridesByRootInstance(childRoot, childOverrides);
      if (pe.added?.length || pe.removed?.length || pe.removedTraits) {
        applyStructureByRootInstance(childRoot, child, { added: pe.added, removed: pe.removed, removedTraits: pe.removedTraits });
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
        traitArgs.push(meta.trait(data)); // parentId remapped in second pass
      }
    }

    if (PrefabInstanceMeta) {
      traitArgs.push(PrefabInstanceMeta.trait({
        source: '',          // set by the caller who knows the file path
        localId: pe.localId,
        rootInstanceId: 0,   // set after the root is known (second pass)
      }));
    }

    const entity = getCurrentWorld().spawn(...traitArgs);
    registerEntity(entity);
    clearOverrideMarks(entity.id()); // fresh member — drop stale marks on a reused id
    localToEcs.set(pe.localId, entity.id());
    ownMemberIds.push(entity.id());
  }

  const rootEcsId = localToEcs.get(prefab.rootLocalId) || 0;

  // Second pass: remap EntityAttributes.parentId for every row (including the
  // nested-instance root, whose parentId is an OUTER-localId value). Direct
  // findEntity writes — was a full-world query.updateEach per row (O(n²)).
  const attrMeta = getTraitByName('EntityAttributes');
  if (attrMeta) {
    for (const pe of prefab.entities) {
      const ecsId = localToEcs.get(pe.localId);
      if (!ecsId) continue;
      const entity = findEntity(ecsId);
      if (!entity || !entity.has(attrMeta.trait)) continue;
      const ea = entity.get(attrMeta.trait) as Record<string, unknown>;
      const localParent = pe.prefab
        ? ((pe.traits['EntityAttributes'] as Record<string, unknown> | undefined)?.parentId as number ?? 0)
        : (ea.parentId as number);
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
  return rootEcsId;
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
  // Normally a GUID (resolve via manifest). A freshly-instantiated instance can
  // still carry a path before its owning scene is saved + normalized; resolveRef
  // rejects internal asset paths loudly, so fetch a path ref directly instead.
  const url = isGuid(source) ? resolveRef(source) : assetUrl(source);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const prefab: PrefabFile = await res.json();
    prefabCache.set(source, prefab);
    if (prefab.id) registerAsset(prefab.id, url, 'prefab');
    return prefab;
  } catch { return null; }
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
      if (!ea.guid) { rootEntity.set(attrMeta.trait, { ...ea, guid: newGuid() }); indexEntityGuid(rootEntity); }
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
    for (const [field, value] of Object.entries(currentData)) {
      if (field === 'parentId') continue; // parentId is remapped, skip
      // guid is per-instance identity — minted when the instance is created/saved,
      // while prefab files clear it (templates carry no identity). It legitimately
      // differs from the base but must NEVER be treated as an override: applying it
      // back would write one instance's guid into the prefab base and make every
      // future instance collide on the same guid.
      if (traitName === 'EntityAttributes' && field === 'guid') continue;
      const origValue = original[field];
      if (origValue !== undefined && !valuesEqual(value, origValue)) {
        if (!result[traitName]) result[traitName] = {};
        result[traitName][field] = value;
      }
    }
  }

  return result;
}

/** Get overrides: fields that differ from the prefab source.
 *  Returns a set of "traitName.fieldName" strings for overridden fields. */
export function getOverrides(
  entityLocalId: number,
  currentTraits: Record<string, Record<string, unknown>>,
  prefab: PrefabFile,
): Set<string> {
  const overrides = new Set<string>();
  const values = getOverrideValues(entityLocalId, currentTraits, prefab);
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

  // Walk every entity that belongs to this instance via PrefabInstance.rootInstanceId
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (!localId) return;

    // Snapshot live trait data for comparison. AoS traits (function/undefined schema)
    // need the FULL live-key read so their non-scalar fields — AnimationLibrary's
    // animSets/boneMaps, SkinnedMeshRenderer's materials, UIAction's onClickSet —
    // survive the override capture instead of being dropped by the meta.fields-only
    // read (the bone-map-lost-on-save bug). SoA traits keep the curated read (their
    // override deltas are over scalar fields). Tags: both reads return {} for a tag
    // the entity has (null if absent), so an added tag shows up as `{name: {}}`.
    const currentTraits: Record<string, Record<string, unknown>> = {};
    for (const meta of allTraits) {
      if (meta.name === 'PrefabInstance') continue;
      const aos = typeof (meta.trait as { schema?: unknown }).schema !== 'object';
      const data = aos ? readTraitDataFull(entity.id(), meta) : readTraitData(entity.id(), meta);
      if (data) currentTraits[meta.name] = data;
    }

    const diffs = getOverrideValues(localId, currentTraits, prefab);
    const markSet = getOverrideMarkSet(entity.id());

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
        markOverride(ecsId, traitName, '');
        continue;
      }
      // AoS traits (function/undefined schema) carry non-scalar fields NOT in
      // meta.fields (AnimationLibrary.animSets/boneMaps, etc.) — don't drop them on a
      // prefab-refresh re-apply. SoA keeps the guard (skip a stale/renamed scalar).
      const aos = typeof (meta.trait as { schema?: unknown }).schema !== 'object';
      const known: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        // Let EntityAttributes.editorFolder through the SoA guard — it's the editor
        // Hierarchy folder tag, a real per-instance field with no Inspector metadata
        // (so it's absent from meta.fields). Mirrors loadSceneFile.applyOverridesByLocalToEcs.
        const allowed = (field in meta.fields) || (meta.name === 'EntityAttributes' && field === 'editorFolder');
        if (!aos && !allowed) {
          console.debug(`[Prefab] override skipped: unknown field ${traitName}.${field}`);
          continue;
        }
        known[field] = value;
      }
      const entity = findEntity(ecsId);
      if (!entity) continue;
      if (!entity.has(meta.trait)) {
        // Added-trait override (root or child): the instance carries a trait the
        // prefab lacks at this localId. Add it whole so prefab refresh preserves it.
        entity.add((meta.trait as (d: Record<string, unknown>) => unknown)(known));
      } else {
        for (const [field, value] of Object.entries(known)) {
          writeTraitField(ecsId, meta, field, value);
        }
      }
      // Seed explicit marks from the override map so these fields survive a later
      // serialize even if the prefab base is edited to coincide with them.
      for (const field of Object.keys(known)) markOverride(ecsId, traitName, field);
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
    const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const copy: Record<string, unknown> = {};
    for (const key of keys) copy[key] = data[key];
    if (meta.name === 'EntityAttributes') guid = (data.guid as string) || '';
    bag[meta.name] = copy;
  }
  return { bag, guid };
}

/** Compute the structural diff between a live prefab instance and its source:
 *  child entities the instance added, prefab members it deleted, and prefab
 *  components it removed from surviving members. (Added components are already
 *  captured as added-trait overrides by captureInstanceOverrides.) */
export function captureInstanceStructure(rootInstanceId: number, prefab: PrefabFile): InstanceStructure {
  const empty: InstanceStructure = { added: [], removed: [], removedTraits: {}, consumedEcsIds: new Set() };
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return empty;

  // Exclude Transient spawns (scrub/preview/play control-track prefabs) AND their subtree — the
  // same exclusion serializeScene applies — so the structural-diff walk below never classifies one
  // as a `userAdded` child and bakes it into the instance's `added` overrides (review H2). Without
  // this, a control-track prefab spawned under an authored prefab-instance member would round-trip
  // to disk via the structural-capture pass, bypassing the top-level serialize filter.
  const rawEntities = getAllEntities();
  const transientIds = new Set<number>();
  for (const e of rawEntities) {
    if (findEntity(e.id)?.has(Transient)) for (const id of subtreeIds(rawEntities, e.id)) transientIds.add(id);
  }
  const allEntities = transientIds.size ? rawEntities.filter((e) => !transientIds.has(e.id)) : rawEntities;
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
  const eaMeta = getTraitByName('EntityAttributes');
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
  // Owned nested rows declared by THIS prefab, keyed "<parentMemberLocalId>:<source>".
  // The fallback signal when a live instance lacks a stamped parentLocalId (legacy
  // state) — an instance whose (anchor member, source) matches a prefab row is owned.
  const ownedNestedRows = new Set<string>();
  for (const pe of prefab.entities) {
    if (!pe.prefab) continue;
    const ea = pe.traits['EntityAttributes'];
    const memberLocal = ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0;
    ownedNestedRows.add(`${memberLocal}:${pe.prefab}`);
  }
  const nestedRootKind = (ecsId: number): 'owned' | 'userAdded' | 'none' => {
    const info = byId.get(ecsId);
    if (!info?.traits.includes('PrefabInstance')) return 'none';
    const pi = readTraitData(ecsId, PrefabInstanceMeta);
    if (!pi || pi.rootInstanceId !== ecsId) return 'none';
    // Primary signal: a stamped parentLocalId means it expanded from a prefab row.
    if (((pi.parentLocalId as number) || 0) > 0) return 'owned';
    // Fallback (parentLocalId absent — legacy/minimal data): match the parent
    // prefab's own nested rows by (anchor member localId, source).
    const memberLocal = ecsToLocal.get(info.parentId) ?? 0;
    const source = (pi.source as string) || '';
    if (memberLocal && ownedNestedRows.has(`${memberLocal}:${source}`)) return 'owned';
    return 'userAdded';
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
  const removedSet = new Set<number>();
  for (const pe of prefab.entities) {
    // A nested-prefab row (`pe.prefab`) expands into its OWN foreign-instance
    // root — it is never a direct member of THIS instance, so it never appears in
    // localToEcs. Counting it as "removed" falsely strips the nested instance from
    // the parent on every re-serialize (the bug that detached the spaceship's
    // engine flames to scene root). Its presence is tracked by the child instance,
    // not here.
    if (pe.prefab) continue;
    if (!localToEcs.has(pe.localId)) removedSet.add(pe.localId);
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
    const ref = captureInstanceReference(ecsId, source, childPrefab);
    for (const m of ref.memberEcsIds) consumedEcsIds.add(m);
    for (const c of ref.consumedEcsIds) consumedEcsIds.add(c);
    const guid = (eaMeta ? (readTraitData(ecsId, eaMeta)?.guid as string) : '') || '';
    return {
      parentLocalId, guid, name: byId.get(ecsId)?.name || '', traits: {}, children: [],
      prefab: source,
      overrides: ref.overrides, added: ref.added, removed: ref.removed, removedTraits: ref.removedTraits,
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
    const children: AddedEntity[] = [];
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id)) continue;
      const node = captureChild(child.id, 0); // child of a plain added node → tree-shape parent
      if (node) children.push(node);
    }
    return { parentLocalId, guid, name: byId.get(ecsId)?.name || '', traits: bag, children };
  }

  const added: AddedEntity[] = [];
  for (const [ecsId, localId] of ecsToLocal) {
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id)) continue;
      const node = captureChild(child.id, localId);
      if (node) added.push(node);
    }
  }

  return { added, removed, removedTraits, consumedEcsIds };
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
}

/** Capture an instance as a reference for serialization: overrides + structural
 *  diffs against `prefab`, plus its member/consumed ECS ids. Returns `undefined`
 *  collections when empty so the written JSON stays minimal. */
export function captureInstanceReference(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
): InstanceReference {
  const overrides = captureInstanceOverrides(rootInstanceId, prefab);
  const structure = captureInstanceStructure(rootInstanceId, prefab);
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
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
  });
  if (localToEcs.size === 0) return;

  // Delegate to the world-parameterized shared core (F7) with editor-world ops, so
  // the runtime (applyStructureByLocalToEcs) and editor paths can never drift.
  applyStructureCore(
    {
      logPrefix: '[Prefab]',
      deleteEntities: (ecsIds) => deleteEntities(ecsIds),
      findEntity: (ecsId) => findEntity(ecsId) ?? undefined,
      spawnAdded: (traitArgs) => {
        const entity = getCurrentWorld().spawn(...(traitArgs as Parameters<ReturnType<typeof getCurrentWorld>['spawn']>));
        registerEntity(entity);
        return entity.id();
      },
      // Editor nested-instance expansion: instantiate → tag source → replay
      // overrides → recurse structure. parentLocalId stays 0 on the spawned root so
      // the next capture re-detects it as user-added.
      spawnNestedInstance: (node, parentEcsId) => {
        const child = getCachedPrefabSync(node.prefab!);
        if (!child) { console.warn(`[Prefab] added nested instance "${node.prefab}" not cached`); return; }
        const childRoot = instantiatePrefab(child, parentEcsId);
        if (!childRoot) return;
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
 *  (BFS order, root = 1) so per-localId overrides round-trip correctly. */
export function tagEntityTreeAsInstance(rootEcsId: number, source: string): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // Callers pass the prefab's asset PATH; store a GUID instead when one resolves
  // (callers register the new prefab before tagging). PrefabInstance.source is
  // GUID-only — a raw path bakes a literal into the scene JSON on save and trips
  // resolveRef's hard rejection on load. Mirrors setPrefabSource. Falls back to
  // the given ref only when the manifest can't resolve it yet.
  const ref = isGuid(source) ? source : (getGuidForPath(source) ?? source);

  // Mirror serializePrefab's localId assignment (BFS, root = 1)
  const allEntities = getAllEntities();
  const tree = collectTree(rootEcsId, allEntities);
  const ecsToLocal = new Map<number, number>();
  tree.forEach((e, i) => ecsToLocal.set(e.id, i + 1));

  for (const info of tree) {
    const localId = ecsToLocal.get(info.id)!;
    const entity = findEntity(info.id);
    if (!entity) continue;
    const piData = { source: ref, localId, rootInstanceId: rootEcsId };
    if (entity.has(PrefabInstanceMeta.trait)) {
      entity.set(PrefabInstanceMeta.trait, piData);
    } else {
      entity.add(PrefabInstanceMeta.trait(piData));
    }
  }
  markStructureDirty();
}

/** Inverse of tagEntityTreeAsInstance — strip the PrefabInstance trait off
 *  every entity in the tree rooted at `rootEcsId`. Used for undo when a
 *  newly-created prefab is reverted. */
export function untagEntityTreeAsInstance(rootEcsId: number): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  const allEntities = getAllEntities();
  const tree = collectTree(rootEcsId, allEntities);
  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity) continue;
    if (entity.has(PrefabInstanceMeta.trait)) entity.remove(PrefabInstanceMeta.trait);
  }
  markStructureDirty();
}

/** A captured PrefabInstance trait, used to undo a detach. */
export interface DetachedInstanceTrait { id: number; data: Record<string, unknown>; }

/** Detach a prefab instance — strip the `PrefabInstance` trait off the instance
 *  root and EVERY descendant in its subtree (nested instances included), turning
 *  the live tree into ordinary, unlinked entities. Mirrors Unity's "Unpack
 *  Prefab Completely". The entities, their transforms, and their other traits are
 *  untouched — only the prefab link is severed, so later edits to the source
 *  prefab no longer propagate here and the tree serializes as plain entities.
 *  Returns a snapshot of the removed traits so the action can be undone.
 *
 *  INVARIANT (detach preserves entity ids): this only adds/removes the
 *  `PrefabInstance` trait — it NEVER respawns, reparents, or re-creates entities,
 *  so every snapshot `id` stays valid for `reattachPrefabInstance` (undo) and for
 *  the Hierarchy redo path. The redo there still resolves the root by GUID (so it
 *  survives a Play→Stop world rebuild), but reattach can key the snapshot by raw
 *  numeric id precisely because detach itself is id-stable. If detach is ever made
 *  to re-create entities (e.g. to clear derived per-instance guids), this snapshot
 *  must switch to guid-keyed ids and reattach must resolve through them — see
 *  review F10. */
export function detachPrefabInstance(rootEcsId: number): DetachedInstanceTrait[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const tree = collectTree(rootEcsId, getAllEntities());
  const snapshot: DetachedInstanceTrait[] = [];
  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity || !entity.has(PrefabInstanceMeta.trait)) continue;
    const pi = entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    snapshot.push({ id: info.id, data: { source: pi.source, localId: pi.localId, rootInstanceId: pi.rootInstanceId } });
    entity.remove(PrefabInstanceMeta.trait);
  }
  if (snapshot.length) markStructureDirty();
  return snapshot;
}

/** Inverse of detachPrefabInstance — re-add the captured PrefabInstance traits
 *  (undo of a detach). */
export function reattachPrefabInstance(snapshot: DetachedInstanceTrait[]): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta || !snapshot.length) return;
  for (const { id, data } of snapshot) {
    const entity = findEntity(id);
    if (!entity) continue;
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, data);
    else entity.add(PrefabInstanceMeta.trait(data));
  }
  markStructureDirty();
}

/** Seed (or evict) the in-memory prefab cache. Used by save/import flows so
 *  the Inspector's override detection picks up newly-written prefabs without
 *  a re-fetch. */
export function setPrefabCache(source: string, prefab: PrefabFile | null): void {
  if (prefab) prefabCache.set(source, prefab);
  else prefabCache.delete(source);
  // Keep the runtime refcounted prefab cache in sync — every setPrefabCache call
  // follows a prefab file write (save-as-prefab, overwrite, delete/undo), so a
  // later scene load must re-read from disk rather than serve a stale copy.
  invalidatePrefab(source);
}

/** Look up an entity's PrefabInstance source + rootInstanceId. Returns null if
 *  the entity is not part of a prefab instance. */
function resolveInstanceContext(entityId: number): { source: string; rootInstanceId: number } | null {
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
export async function writePrefabFile(source: string, prefab: PrefabFile): Promise<boolean> {
  if (!prefab.id) prefab.id = newGuid();
  // `source` may be a GUID — resolve to the real file path before writing,
  // otherwise the dev-server API would create a file literally named by the guid.
  // A path source (live instance, pre-normalization) is used as-is — routing it
  // through resolveRef would trip its internal-path rejection.
  const path = isGuid(source) ? (resolveRef(source) || source) : source;
  registerAsset(prefab.id, path, 'prefab');
  const content = JSON.stringify(prefab, null, 2);
  try {
    const res = await backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    if (res.ok) {
      // Evict the runtime refcounted prefab cache so the NEXT scene load re-reads
      // the new file from disk. Without this, opening another scene that uses this
      // prefab re-instantiates from the stale cached copy (e.g. missing flames/
      // ShipShake the user just applied). The editor's own prefabCache is updated
      // by the caller. Pass `source` (the GUID), NOT the resolved `path`: the cache
      // is keyed by resolveRef(guid), and resolveRef REJECTS internal asset paths
      // (→ undefined), so invalidatePrefab(path) would silently no-op.
      invalidatePrefab(source);
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
 *  the file (which evicts the runtime refcounted cache), and preload nested children.
 *  Does NOT touch live instances — the caller rebuilds the scene, which re-instantiates
 *  every instance from this cache. Used by Apply-to-Prefab undo/redo to restore the
 *  prefab base before replaying the scene snapshot. */
export async function installPrefabSnapshot(source: string, prefab: PrefabFile): Promise<void> {
  const snap: PrefabFile = JSON.parse(JSON.stringify(prefab));
  prefabCache.set(source, snap);
  await writePrefabFile(source, snap);
  await preloadNestedPrefabs(snap);
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
      added: node.added,
      removed: node.removed,
      removedTraits: node.removedTraits,
      nestedOverrides: node.nestedOverrides,
    });
    if (prefab.version < 2) prefab.version = 2;
    return;
  }

  const traits: Record<string, Record<string, unknown> | boolean> = {};
  for (const [name, data] of Object.entries(node.traits)) {
    if (name === 'PrefabInstance') continue;
    traits[name] = data === true ? true : { ...(data as Record<string, unknown>) };
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
}

/** Shared no-op result so every early return is consistent. */
const NOOP_APPLY: ApplyResult = { promotedAdditions: 0, applied: false };

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

  // Deep-clone the old prefab and overlay selected live values onto it. A second
  // pristine clone is the `before` snapshot for undo (oldPrefab itself isn't mutated,
  // but cloning guards against any aliasing into the cache).
  const newPrefab: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  const prefabBefore: PrefabFile = JSON.parse(JSON.stringify(oldPrefab));
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return NOOP_APPLY;

  // Build localId → ecsId map for this instance so we can read live values
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId !== rootInstanceId) return;
    const localId = piData.localId as number;
    if (localId) localToEcs.set(localId, entity.id());
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
    if (!(fieldName in meta.fields)) continue;

    const liveData = readTraitData(ecsId, meta);
    if (!liveData) continue;
    const liveValue = liveData[fieldName];

    const prefabEntity = newPrefab.entities.find((e) => e.localId === localId);
    if (!prefabEntity) continue;
    let traitBag = prefabEntity.traits[traitName];
    if (traitBag === true) continue; // already a tag in the prefab — nothing to set
    if (!traitBag) {
      // Added component: the prefab lacks this trait at this localId, so the user
      // added it on the instance. Seed the prefab with the WHOLE live trait (all
      // fields) so applying actually persists the new component — without this the
      // trait was silently dropped (the ShipShake bug). Subsequent field keys for
      // the same trait then overlay onto this bag.
      traitBag = { ...liveData };
      prefabEntity.traits[traitName] = traitBag;
    }
    (traitBag as Record<string, unknown>)[fieldName] = liveValue;
    writtenCount++;
  }

  if (writtenCount === 0) {
    console.log('[Prefab] No applicable overrides to apply.');
    return NOOP_APPLY;
  }

  const ok = await writePrefabFile(source, newPrefab);
  if (!ok) return NOOP_APPLY;

  // Delete the live plain entities for applied additions BEFORE refresh, so the
  // re-instantiated prefab member replaces them instead of duplicating. Non-applied
  // additions stay live and are re-captured + re-spawned by the refresh.
  if (liveAddedRootsToDelete.length) deleteEntities(liveAddedRootsToDelete);

  prefabCache.set(source, newPrefab);
  // refreshAllInstances re-instantiates synchronously — make sure any nested
  // children are cached first.
  await preloadNestedPrefabs(newPrefab);
  refreshAllInstances(source, oldPrefab, newPrefab);

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
}

/** Capture every NESTED prefab instance inside the live subtree under
 *  `outerRootId` (each captured against its OWN child prefab). Without this an
 *  outer rebuild re-expands nested rows straight from the file, discarding any
 *  per-copy override the user made on a specific nested child (design risk R3).
 *  The captured set is a superset of the file's row overrides, so re-applying it
 *  after the rebuild is idempotent for those and additive for the live edits. */
function captureNestedInstanceOverrides(outerRootId: number): NestedInstanceCapture[] {
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
  // parentLocalId path from the outer root down to nested root `n`.
  const chainOf = (n: number): number[] => {
    const chain: number[] = [];
    let cur = n, guard = 0;
    while (cur && cur !== outerRootId && guard++ < 64) {
      const pi = piOf(cur);
      if (!pi) break;
      chain.unshift((pi.parentLocalId as number) || 0);
      cur = rootOf(byId.get(cur)?.parentId ?? 0); // climb to the parent instance's root
    }
    return chain;
  };

  const captures: NestedInstanceCapture[] = [];
  const seen = new Set<number>();
  const stack = [outerRootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (isNestedRoot(id)) {
      const source = piOf(id)!.source as string;
      const childPrefab = getCachedPrefabSync(source);
      if (childPrefab) {
        captures.push({
          chain: chainOf(id),
          source,
          overrides: captureInstanceOverrides(id, childPrefab),
          structure: captureInstanceStructure(id, childPrefab),
        });
      }
    }
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return captures;
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

  for (const cap of captures) {
    let cur = newOuterRootId;
    for (const plid of cap.chain) { cur = findChildNestedRoot(cur, plid); if (!cur) break; }
    if (!cur || cur === newOuterRootId) continue;
    applyOverridesByRootInstance(cur, cap.overrides);
    const childPrefab = getCachedPrefabSync(cap.source);
    if (childPrefab) applyStructureByRootInstance(cur, childPrefab, cap.structure);
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
  const nestedCaptures = captureNestedInstanceOverrides(rootInstanceId);

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
  if (eaMeta && oldRootEa?.guid) writeTraitField(newRootId, eaMeta, 'guid', oldRootEa.guid as string);
  setPrefabSource(newRootId, source);
  applyOverridesByRootInstance(newRootId, overrides);
  applyStructureByRootInstance(newRootId, prefab, structure);
  reapplyNestedInstanceOverrides(newRootId, nestedCaptures);
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

  for (const oldRootId of rootIds) {
    // Capture this instance's per-field overrides AND structural diffs against
    // the OLD prefab, then tear down + re-instantiate from the NEW prefab and
    // re-apply them. Structure must be captured before the teardown inside
    // rebuildInstance (it walks the live non-member descendants).
    const captured = captureInstanceOverrides(oldRootId, oldPrefab);
    const capturedStructure = captureInstanceStructure(oldRootId, oldPrefab);
    rebuildInstance(oldRootId, source, newPrefab, captured, capturedStructure);
  }

  console.log(`[Prefab] Refreshed ${rootIds.length} instance(s) of "${source}"`);
}

/** Collect root entity ids for every instance of a given source. Optionally
 *  exclude one root id. */
function collectInstanceRoots(source: string, excludeRootId?: number): number[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const rootIds: number[] = [];
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.source !== source) return;
    if (piData.rootInstanceId !== entity.id()) return;
    if (excludeRootId !== undefined && entity.id() === excludeRootId) return;
    rootIds.push(entity.id());
  });
  return rootIds;
}

/** Refresh every prefab instance of a given source (no exclusion). Used by the
 *  selective-apply path so the clicked instance also goes through capture/restore —
 *  fields the user just applied naturally drop out of the override set on next
 *  render because they now match the prefab base. */
function refreshAllInstances(
  source: string,
  oldPrefab: PrefabFile,
  newPrefab: PrefabFile,
): void {
  refreshInstances(source, collectInstanceRoots(source), oldPrefab, newPrefab);
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
  return { added, removed, removedTraits, consumedEcsIds: full.consumedEcsIds };
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

  // Capture the instance's current state against the prefab, then subtract the
  // reverted keys to get the state to re-apply after the rebuild.
  const fullOverrides = captureInstanceOverrides(rootInstanceId, prefab);
  const fullStructure = captureInstanceStructure(rootInstanceId, prefab);
  const reducedOverrides = subtractRevertedOverrides(fullOverrides, selectedKeys);
  const reducedStructure = subtractRevertedStructure(fullStructure, selectedKeys);

  const newRootId = rebuildInstance(rootInstanceId, source, prefab, reducedOverrides, reducedStructure);

  return { newRootId, source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure };
}

