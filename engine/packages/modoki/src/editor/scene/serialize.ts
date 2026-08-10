/** Serialize the ECS world to scene + materials JSON files.
 *  Uses the trait registry — no hardcoded trait knowledge. */

import { getAllEntities, readTraitData, findEntity, deleteEntities, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { getAuthoredWritesWhileStopped, clearAuthoredWritesWhileStopped } from '../../runtime/core/ecs/authoredWrites';
import { Transient } from '../../runtime/core/traits/Transient';
import { getCurrentWorld, spawnEntity } from '../../runtime/core/ecs/world';
import { Camera } from '../../runtime/traits/Camera';
import { Transform } from '../../runtime/core/traits/Transform';
import { EntityAttributes } from '../../runtime/core/traits/EntityAttributes';
import { Environment } from '../../three/traits/Environment';
import { Light } from '../../three/traits/Light';
import { backendFetch } from '../backend/editorBackend';
import { saveAssetDialog } from '../utils/saveDialog';
import { getAllTraits, getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { isPrefabEditWorld } from './prefabEditWorld';
import { useEditorStore } from '../store/editorStore';
import { setPlayState, getRunMode } from '../../runtime/core/playState';
import { swapHistory, getEditVersion } from '../undo/undoManager';
import { editorEmit } from '../editorJournal';
import { captureInstanceOverrides, captureInstanceStructure, getPrefabSource, getCachedPrefabSync } from './prefab';
import type { AddedEntity, NestedOverridePaths } from '../../runtime/loaders/loadSceneFile';
import { mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, collectResourceRefsFromEntities } from '../../runtime/loaders/loadSceneFile';
import { newGuid, isInternalAssetPath, getGuidForPath, registerAsset } from '../../runtime/loaders/assetManifest';
import { isGuid } from '../../runtime/core/assetRefRules';
import { clearAllSceneDirty, clearSceneDirty, dirtySceneGuidsSnapshot, isSceneDirty } from './sceneDirty';
import { WHITE_HDR_GUID } from '../../runtime/assets/builtinAssets';
import { REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { hasDirtyAssets, getDirtyAssetPaths, flushDirtyAssets, type FlushResult } from './dirtyAssets';

// ── Types ───────────────────────────────────────────────

export interface SerializedEntity {
  /** No longer written (scene-loading.md, Phase 3) — nothing on disk
   *  references it any more (parentId and rootInstanceId are both guids). Kept
   *  optional, not removed, so in-memory callers that still pass a `SerializedEntity`
   *  around (e.g. a carried snapshot's shape, or a caller-held `preloaded` object)
   *  aren't forced to omit it. The loader synthesizes its own key on read regardless. */
  id?: number;
  /** DECORATIVE parity/label only — `EntityAttributes.name` is the SOURCE OF TRUTH.
   *  The loader (`loadSceneFile`) reads name solely from `EntityAttributes.name`; this
   *  top-level copy exists for human-readable scene files and name-based entity refs
   *  (`sceneMutate.entityName` reads it, falling back to `EntityAttributes.name`).
   *  serialize.ts mirrors `EntityAttributes.name` into it so the two never drift. */
  name: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  /** If this is a prefab instance root, the source prefab path */
  prefab?: string;
  /** A prefab-instance root's stable guid. Prefab roots write only their
   *  PrefabInstance trait (everything else flows from the prefab + overrides), and
   *  guid is never an override — so it's persisted here and re-applied on load.
   *  Without it the root (and anything that refs into the instance) is unaddressable
   *  across a re-save. Only set for prefab roots; plain entities keep guid in
   *  EntityAttributes. */
  guid?: string;
  /** Per-localId overrides (only changed fields from prefab source) */
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Child subtrees the instance adds beyond the prefab (see AddedEntity). */
  added?: AddedEntity[];
  /** Prefab member localIds the instance deleted (top-most; descendants cascade). */
  removed?: number[];
  /** Per-localId component (trait) names the instance deleted from prefab members. */
  removedTraits?: Record<number, string[]>;
  /** Scene-level overrides on this instance's NESTED prefab instances (a prefab's
   *  own internal nested instances, e.g. a ship's engine flames). Path-keyed so the
   *  scene can reach a member nested at ANY depth (see NestedOverridePaths). */
  nestedOverrides?: NestedOverridePaths;
}

/** A single resource the scene needs at load time. SceneManager acquires these
 *  in parallel before instantiating entities. Disposed when the scene unloads
 *  unless another scene also holds them. */
export interface ResourceRef {
  type: 'model' | 'riggedModel' | 'mesh' | 'material' | 'texture' | 'prefab' | 'font' | 'environment' | 'particle' | 'animation';
  path: string;
  loader?: string;
  postprocessor?: string;
}

export interface SceneFile {
  /** Stable UUID — written once at save, never changes across renames/moves.
   *  Always populated: `serializeScene` reuses the registered id or mints a fresh
   *  one (never empty), so this is required, not optional. */
  id: string;
  version: number;
  createdAt: string;
  resources: ResourceRef[];
  entities: SerializedEntity[];
  /** v10+: guid of a base scene this scene extends (base-scene persistence).
   *  Omitted when the scene has no base. */
  baseScene?: string;
}

// ── Serialize Scene (generic) ───────────────────────────

/** Capture a nested instance's SCENE-specific override delta: its full per-localId
 *  override (vs the child prefab base) minus the fields the parent prefab's own
 *  nested row already overrides. So the scene stores only what it uniquely changed
 *  on this nested instance — the row's own overrides (e.g. the flames' mirrored
 *  positions) stay owned by the parent prefab and aren't redundantly baked in. */
export function captureNestedSceneDelta(
  nestedRootId: number,
  childPrefab: Parameters<typeof captureInstanceOverrides>[1],
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
      if (rowFields) for (const f of Object.keys(fields)) if (f in rowFields) delete fields[f];
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
function resolveEffectivePrefabOverride(
  topSource: string,
  path: number[],
): Record<number, Record<string, Record<string, unknown>>> {
  let prefab = getCachedPrefabSync(topSource);
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

/** Serialize the live ECS world to a SceneFile.
 *
 *  GUID assignment is a SIDE-EFFECT and is opt-in via `assignGuids`. Every
 *  serialized entity always carries a stable EntityAttributes.guid in the
 *  OUTPUT, but only the save path (`assignGuids: true`) commits a freshly-minted
 *  guid back into the live world so it persists to disk. The Play snapshot path
 *  (`enterPlay`) calls this with no options: it must NOT mutate authored data —
 *  Play/Stop's contract is "Stop throws every play-mode mutation away; authored
 *  data is untouched" — so a missing guid is minted into the output JSON only
 *  (two worktrees Playing the same scene must not mint divergent guids into it).
 *
 *  `opts.scene` (Phase 12, M1 — scene-loading.md) serializes a
 *  NAMED loaded scene instead of the primary: pass `{ path, guid }` for a BASE entry
 *  from `sceneManager.getLoadedScenes()` (the primary always keeps using the no-arg
 *  call — every caller, `saveAll` included, only ever targets a base this way).
 *  Omitted (the default): behaves EXACTLY as before — this is the regression net
 *  every existing caller (enterPlay, timelinePreview, applyPrefabUndo, saveScene)
 *  depends on. */
/** True when a live field value is indistinguishable from its trait's schema default,
 *  and therefore safe to OMIT from the scene file (the loader re-derives it).
 *
 *  Deliberately SCALAR-ONLY. A non-scalar default (array/object) in a koota SoA schema
 *  is a single shared instance handed to every entity, so "equal to the default" is
 *  neither cheap nor safe to decide: a deep compare would omit a live array that merely
 *  happens to match today, and identity compare would omit one the entity is actually
 *  ALIASING. Either way the file would stop recording a real value. Non-scalars are
 *  always written — the diff cost is small (few traits have them) and the semantics stay
 *  obvious. Same reasoning excludes AoS traits wholesale at the call site: their schema
 *  is a *function*, so there is no default to compare against at all.
 *
 *  `Object.is` (not `===`) so `NaN` matches its own default and `-0` does NOT collapse
 *  into `0` — a signed zero is a different authored value in a direction/velocity field.
 *
 *  Exported for unit testing. */
export function isTraitDefault(value: unknown, def: unknown): boolean {
  if (def !== null && (typeof def === 'object' || typeof def === 'function')) return false;
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) return false;
  return Object.is(value, def);
}

export async function serializeScene(opts?: {
  assignGuids?: boolean;
  scene?: { path: string; guid: string };
}): Promise<SceneFile> {
  const targetScene = opts?.scene;
  // TRANSIENCE (preview-mode-refactor, Phase 2): drop every entity SPAWNED during a
  // scrub/preview/play (a `Transient` root) AND its whole subtree from serialization — a
  // preview/scrub mutation must never reach disk. Exclude the subtree up front so ALL passes
  // below (guid pre-pass, prefab-child collection, the main loop) simply never see them, which
  // avoids orphaning a transient prefab-instance's members. See runtime/core/traits/Transient.ts.
  const allInfos = getAllEntities();
  const transientIds = new Set<number>();
  for (const e of allInfos) {
    if (findEntity(e.id)?.has(Transient)) for (const id of subtreeIds(allInfos, e.id)) transientIds.add(id);
  }
  // Base-scene persistence (Phase 6, generalized in Phase 12): never bake an entity
  // that doesn't belong to the scene being saved into that scene's file.
  // EntityAttributes.sourceScene is stamped non-empty ONLY on entities a BASE scene
  // spawned into the chain (SceneManager.loadScene); the primary's own entities keep
  // the schema default '' (Phase 3's load-bearing "empty means primary" rule).
  //
  // - No `targetScene` (the default, every pre-Phase-12 caller): "foreign" = any
  //   non-empty sourceScene — i.e. exclude every base-origin entity, save only the
  //   primary's own. Byte-identical to Phase 6.
  // - `targetScene` given (Phase 12 — saving a NAMED BASE scene, e.g. a base entity
  //   edited in place): "foreign" = this entity's raw sourceScene does not match the
  //   target's guid. A primary-owned entity's sourceScene is '' and no base's guid is
  //   ever '', so it is correctly excluded — only the target base's own entities
  //   survive. (targetScene never names the primary — see the doc comment above.)
  //
  // Subtree walk (either branch): every base-origin entity is independently stamped
  // at spawn time, so this is belt-and-suspenders, not the primary mechanism.
  const foreignIds = new Set<number>();
  for (const e of allInfos) {
    const entity = findEntity(e.id);
    if (!entity?.has(EntityAttributes)) continue;
    const data = entity.get(EntityAttributes) as { sourceScene?: string };
    const isForeign = targetScene ? (data.sourceScene || '') !== targetScene.guid : !!data.sourceScene;
    if (isForeign) for (const id of subtreeIds(allInfos, e.id)) foreignIds.add(id);
  }
  const excludedIds = transientIds.size || foreignIds.size ? new Set<number>([...transientIds, ...foreignIds]) : null;
  const entityInfos = excludedIds ? allInfos.filter((e) => !excludedIds.has(e.id)) : allInfos;
  const allTraits = getAllTraits();
  const piMeta = getTraitByName('PrefabInstance');
  const entities: SerializedEntity[] = [];

  // (Phase 12's A8/A9 SAFETY GUARD lived here and is GONE — both bugs are fixed.
  //  It refused to serialize a targeted base containing any prefab instance, because
  //  two separate defects on the carried-base-scene path could silently drop or
  //  misattribute that instance's data: A8 (`PrefabInstance.rootInstanceId` going
  //  stale across a respawn, fixed in `loadSceneFile.ts`) and A9 (override marks
  //  being wiped by a chain load and never carried across a world rebuild, fixed in
  //  `loadSceneFile.ts` + `SceneManager.ts`). Removing it was gated on a LIVE
  //  acceptance run against sling's real `Base.json`, not merely on the code
  //  landing — see the plan's "A9 — live acceptance gate" section for the record.
  //  The regression tests that replace it are in `baseSceneTargetSerialize.test.ts`
  //  ("a targeted base containing a prefab instance now SERIALIZES"), plus the
  //  defect-level suites in `loadSceneFile.test.ts` and
  //  `sceneManagerBaseSceneChain.test.ts`.)

  // Pre-pass: ensure every entity has a stable EntityAttributes.guid in the
  // OUTPUT. New entities get a freshly-minted UUID; cross-scene refs (prefab
  // override capture, future cross-asset refs) need a non-empty guid. The save
  // path (assignGuids) ALSO commits it to the live world via entity.set() — used
  // over a mutated get() result so koota commits regardless of soa/aos storage —
  // so the guid persists. The snapshot path leaves the world untouched: the
  // minted guid lives only in `mintedGuids` and is injected into the output below.
  const eaMeta = getTraitByName('EntityAttributes');
  const mintedGuids = new Map<number, string>();
  if (eaMeta) {
    for (const info of entityInfos) {
      const entity = findEntity(info.id);
      if (!entity || !entity.has(eaMeta.trait)) continue;
      const data = entity.get(eaMeta.trait) as Record<string, unknown>;
      if (!data.guid || data.guid === '') {
        const guid = newGuid();
        mintedGuids.set(info.id, guid);
        if (opts?.assignGuids) entity.set(eaMeta.trait, { ...data, guid });
      }
    }
  }

  // Resolve a live entity id to its stable guid (live value, else the pre-pass
  // mint). The pre-pass above guarantees every entity has one, so this only
  // returns '' for id 0 (root) or a genuinely un-guidable entity. Used to write
  // EntityAttributes.parentId as a GUID (stable across world rebuilds) instead of a
  // transient koota id — see the loader's resolveParentRef for the inverse.
  const guidForId = (id: number): string => {
    if (!id || !eaMeta) return '';
    const live = findEntity(id)?.get(eaMeta.trait) as { guid?: string } | undefined;
    if (live?.guid) return live.guid;
    return mintedGuids.get(id) || '';
  };

  // Track which entities are children of a prefab instance (skip them); also
  // collect the prefab sources we'll need cached in order to compute per-localId
  // override diffs synchronously below.
  const prefabChildIds = new Set<number>();
  const prefabSources = new Set<string>();
  const prefabRootInfo = new Map<number, { source: string; localId: number }>();
  // Owned nested instances (a prefab's internal nested instances, e.g. a ship's
  // flames): their scene-level overrides are captured onto the OWNING top-level
  // instance entry rather than written as standalone entities.
  const nestedInstances: { rootId: number; source: string; parentLocalId: number; ownerId: number }[] = [];
  const byId = new Map(entityInfos.map((e) => [e.id, e] as const));
  if (piMeta) {
    for (const info of entityInfos) {
      if (!info.traits.includes('PrefabInstance')) continue;
      const piData = readTraitData(info.id, piMeta);
      if (!piData) continue;
      const rootId = piData['rootInstanceId'] as number;
      const source = piData['source'] as string | undefined;
      if (rootId !== info.id && rootId !== 0) {
        prefabChildIds.add(info.id);
      } else if (source) {
        // Instance root. If its parent entity is itself part of a prefab instance,
        // this is a NESTED instance owned by that parent prefab (e.g. the
        // spaceship's engine flames). It expands from the parent prefab — writing
        // it as a standalone scene entity would orphan it at scene root on the next
        // load AND make captureInstanceStructure flag it removed from the parent.
        // Only genuinely top-level instances become their own scene entries; the
        // nested ones' scene edits ride on the owner's nestedOverrides.
        const parentInfo = byId.get(info.parentId);
        const parentLocalId = (piData['parentLocalId'] as number) || 0;
        const parentIsMember = parentInfo?.traits.includes('PrefabInstance');
        if (parentIsMember && parentLocalId) {
          // Owned nested instance (expanded from the parent prefab, so it carries a
          // parentLocalId): its scene-level edits ride on the owner's
          // nestedOverrides — it is NOT written as its own scene entry.
          prefabChildIds.add(info.id);
          const parentPi = readTraitData(info.parentId, piMeta);
          const ownerId = (parentPi?.['rootInstanceId'] as number) || info.parentId;
          nestedInstances.push({ rootId: info.id, source, parentLocalId, ownerId });
          prefabSources.add(source); // preload child prefab for delta capture
        } else if (parentIsMember) {
          // User-added nested instance dragged under a prefab member (parentLocalId
          // === 0 — it did NOT come from the parent prefab's definition). It is
          // captured as an `added` REFERENCE node on the owning top-level instance
          // (captureInstanceStructure handles this), so it round-trips under its
          // EXACT parent member. Skip the standalone write; preload its source so
          // the structural capture can read the child prefab.
          prefabChildIds.add(info.id);
          prefabSources.add(source);
        } else {
          // Genuinely top-level instance, or one parented to a plain (non-prefab)
          // entity whose parentId round-trips normally → its own scene entry.
          prefabSources.add(source);
          prefabRootInfo.set(info.id, { source, localId: piData['localId'] as number });
        }
      }
    }
  }

  // Preload every referenced prefab so captureInstanceOverrides can read from
  // the cache without async I/O during the serialize loop.
  await Promise.all(Array.from(prefabSources).map((src) => getPrefabSource(src)));

  // Structural-override pre-pass: for each prefab root, capture added/removed
  // entities + removed traits, and fold the added entities' live ECS ids into the
  // skip set so they aren't ALSO written as standalone scene entities (which is
  // how they used to leak out and orphan on reload).
  const rootStructure = new Map<number, { added: AddedEntity[]; removed: number[]; removedTraits: Record<number, string[]> }>();
  for (const [rootId, { source }] of prefabRootInfo) {
    const prefab = await getPrefabSource(source);
    if (!prefab) continue;
    const s = captureInstanceStructure(rootId, prefab);
    for (const ecsId of s.consumedEcsIds) prefabChildIds.add(ecsId);
    if (s.added.length || s.removed.length || Object.keys(s.removedTraits).length) {
      rootStructure.set(rootId, { added: s.added, removed: s.removed, removedTraits: s.removedTraits });
    }
  }

  // Nested-instance override pre-pass: for EACH nested instance (at any depth),
  // resolve the path of nested-row localIds up to the owning TOP-level instance,
  // capture the SCENE-specific override delta (its full override minus what the
  // prefab chain already applies to it — so the scene stores only what it uniquely
  // changed and an intermediate prefab change still propagates), and file it under
  // the top instance's nestedOverrides[path]. The path-keyed form (e.g. "2.5")
  // lets the scene override a member nested arbitrarily deep; a one-level path is
  // the legacy single-segment key, so existing scenes round-trip unchanged.
  const nestedById = new Map(nestedInstances.map((ni) => [ni.rootId, ni] as const));
  /** Walk up the owner chain to the top-level instance; returns its id + the path
   *  of nested-row localIds from it down to `rootId`, or null if no top-level owner. */
  const resolvePath = (rootId: number): { topId: number; path: number[] } | null => {
    const path: number[] = [];
    let cur = rootId, guard = 0;
    while (guard++ < 64) {
      const ni = nestedById.get(cur);
      if (!ni) break; // reached a non-nested instance (a top-level root)
      path.unshift(ni.parentLocalId);
      cur = ni.ownerId;
    }
    return prefabRootInfo.has(cur) ? { topId: cur, path } : null;
  };

  const nestedOverridesByTop = new Map<number, NestedOverridePaths>();
  for (const ni of nestedInstances) {
    const resolved = resolvePath(ni.rootId);
    if (!resolved || resolved.path.length === 0) continue;
    const topSource = prefabRootInfo.get(resolved.topId)!.source;
    const childPrefab = await getPrefabSource(ni.source);
    if (!childPrefab) continue;
    // Subtract what the whole prefab chain applies to this instance (not just the
    // immediate row) so a deep scene edit stores only its own delta.
    const effective = resolveEffectivePrefabOverride(topSource, resolved.path);
    const delta = captureNestedSceneDelta(ni.rootId, childPrefab, effective);
    if (Object.keys(delta).length === 0) continue;
    const map = nestedOverridesByTop.get(resolved.topId) ?? {};
    map[resolved.path.join('.')] = delta;
    nestedOverridesByTop.set(resolved.topId, map);
  }

  for (const info of entityInfos) {
    // Skip prefab children + structural additions — re-instantiated from the prefab
    if (prefabChildIds.has(info.id)) continue;

    // No `id` (Phase 3, scene-loading.md) — the loader synthesizes its
    // own per-load key (array index) now that nothing on disk references the old
    // live-ecs-id-derived value (that's exactly what made it churn on every save).
    const entry: SerializedEntity = { name: info.name, traits: {} };
    const rootInfo = prefabRootInfo.get(info.id);
    // True once we've successfully captured overrides for a prefab root — then the
    // entry stores only PrefabInstance and everything else flows through overrides.
    // Stays false if the prefab fetch fails, so we conservatively fall back to
    // writing the full trait snapshot rather than losing data.
    let prefabRootCaptured = false;

    // Prefab instance root: capture full per-localId overrides (field edits AND
    // user-added traits, root or child) so the entry needs only PrefabInstance.
    if (rootInfo) {
      entry.prefab = rootInfo.source;
      const prefab = await getPrefabSource(rootInfo.source);
      if (prefab) {
        const overrides = captureInstanceOverrides(info.id, prefab);
        if (Object.keys(overrides).length > 0) entry.overrides = overrides;
        const struct = rootStructure.get(info.id);
        if (struct) {
          if (struct.added.length) entry.added = struct.added;
          if (struct.removed.length) entry.removed = struct.removed;
          if (Object.keys(struct.removedTraits).length) entry.removedTraits = struct.removedTraits;
        }
        const nested = nestedOverridesByTop.get(info.id);
        if (nested && Object.keys(nested).length) entry.nestedOverrides = nested;
        // Persist the root's stable guid on the node. The trait loop below writes
        // ONLY PrefabInstance for a captured root (EntityAttributes never gets
        // written, and guid is never an override), so this is the only place the
        // root's identity survives. The pre-pass above guaranteed a guid: on save
        // it's live on the entity; on the snapshot path it's in mintedGuids.
        if (eaMeta) {
          const live = findEntity(info.id)?.get(eaMeta.trait) as { guid?: string } | undefined;
          const rootGuid = (live?.guid && live.guid !== '' ? live.guid : undefined) ?? mintedGuids.get(info.id);
          if (rootGuid) entry.guid = rootGuid;
        }
        // Persist the PLACEMENT parent for a REPARENTED instance (parent isn't the
        // scene root). A captured prefab root otherwise writes NO EntityAttributes —
        // name/parent come from the prefab + placement — so without this an instance
        // dragged under another entity re-spawns at the scene ROOT on the next load,
        // losing its parent. The loader reads ONLY parentId off a prefab root's
        // EntityAttributes (loadSceneFile resolves it as the placement parent) and
        // ignores the rest, so a minimal `{ parentId }` is exactly what it needs.
        // editorFolder is the editor Hierarchy grouping tag — without persisting it
        // here a prefab instance in a folder would pop back out to the ungrouped root
        // level on the next load. A folder-tagged instance can sit at the SCENE ROOT
        // (empty parentGuid), so emit EA whenever EITHER field is present.
        const parentGuid = guidForId(info.parentId);
        const minimalEa: Record<string, unknown> = {};
        if (parentGuid) minimalEa.parentId = parentGuid;
        if (info.editorFolder) minimalEa.editorFolder = info.editorFolder;
        if (Object.keys(minimalEa).length) entry.traits.EntityAttributes = minimalEa;
        prefabRootCaptured = true;
      }
    }

    // Save trait data on the entry itself. For non-prefab entities this is the
    // full snapshot. For prefab roots we now write ONLY the PrefabInstance trait —
    // both field edits AND user-added traits (root or child) round-trip through
    // entry.overrides (captureInstanceOverrides above). The prefab's own traits
    // come from the prefab. The old root-only rootExtraTraits write is gone; the
    // loader still reads rootExtraTraits so legacy scenes keep working.
    const entity = findEntity(info.id);
    if (!entity) continue;

    for (const meta of allTraits) {
      if (!info.traits.includes(meta.name)) continue;
      if (prefabRootCaptured && meta.name !== 'PrefabInstance') continue;

      if (meta.category === 'tag') {
        entry.traits[meta.name] = true;
        continue;
      }

      try {
        if (!entity.has(meta.trait)) continue;
        const data = entity.get(meta.trait) as Record<string, unknown>;
        const traitData: Record<string, unknown> = {};
        // Serialize every field the trait defines (from its koota schema), not
        // just the curated Inspector fields in meta.fields. Otherwise any field
        // absent from meta.fields (e.g. UIElement.elementType, UIBinding.inputBinding,
        // UIAction.onChange/onSubmit) is silently dropped on save — which is how a
        // re-serialization wiped the chat inputs in the llm/chess scenes.
        // SoA traits expose a plain-object `schema`; AoS traits (callback form,
        // e.g. UIAction with its onClickSet array) expose a *function* schema, so
        // fall back to the live data's own keys for those.
        const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
        const soa = !!schema && typeof schema === 'object';
        const keys = soa ? Object.keys(schema!) : Object.keys(data);
        for (const key of keys) {
          // Skip pure runtime fields (e.g. Time.elapsed/frame): recomputed each
          // frame, so persisting them bakes a stale snapshot and churns the file
          // on every save. The loader re-derives them from the schema default.
          if (meta.fields[key]?.runtimeOnly) continue;
          // Omit a field that still holds its trait default: the loader
          // reconstructs it from the same schema (`meta.trait(partialData)` — koota
          // fills every absent key), so this is lossless, and it keeps DEFAULTS LIVE.
          // Writing them out instead FREEZES each file at the defaults of the day it
          // was saved, so a later change to a trait default silently stops reaching
          // every already-saved scene — the reason the repo-wide legacy-scene
          // migration was on hold (see docs/scene-loading.md). Owner's call, 2026-07-31.
          // …except a field the passes below REWRITE (parentId + every other
          // `entityId`-flagged ref, guid-ified there). Those are always emitted, so
          // skipping one here would only move it to the END of the object — pure diff
          // noise across a bulk migration. Assigning in schema order now and
          // overwriting in place later keeps key order stable.
          if (soa && !meta.fields[key]?.entityId && isTraitDefault(data[key], schema![key])) continue;
          traitData[key] = data[key];
        }
        // Snapshot path: the world wasn't mutated, so a freshly-minted guid for a
        // never-saved entity lives only in `mintedGuids`. Inject it so the output
        // still carries a stable identity (selection-restore + ref resolution
        // survive a Stop-revert) without having written to the authored world.
        // (Prefab roots route their guid through overrides, not here, and already
        // carry one minted at instantiation — so they never need this.)
        if (meta.name === 'EntityAttributes' && !traitData.guid) {
          const minted = mintedGuids.get(info.id);
          if (minted) traitData.guid = minted;
        }
        // Write parentId as the parent's stable GUID ('' for root) rather than the
        // live koota id, so the hierarchy survives a world rebuild without the
        // load-time idMap remap. The loader resolves it back to a fresh koota id.
        if (meta.name === 'EntityAttributes') {
          const pid = data.parentId as number;
          traitData.parentId = pid ? guidForId(pid) : '';
        }
        // Write every OTHER `entityId`-flagged field (Phase 15's FieldHint;
        // parentId above is the one special case, handled separately since '' means
        // root rather than "unset") as its target's stable GUID instead of the raw
        // live koota id — the same "survives a world rebuild" rationale, generalized
        // via the registry so a future entityId field is guid-ified automatically
        // (scene-loading.md, Phase 2). This is what makes
        // PrefabInstance.rootInstanceId — the last numeric on-disk entity ref —
        // stable across the arrival-path-dependent id churn Phase 0/1 measured: the
        // loader's `resolveEntityIdField` already resolves a guid string via
        // `findEntityByGuid` with no idMap involved, for BOTH a fresh load and a
        // carried respawn.
        for (const [key, hint] of Object.entries(meta.fields)) {
          if (!hint.entityId || (meta.name === 'EntityAttributes' && key === 'parentId')) continue;
          const raw = data[key] as number;
          traitData[key] = raw ? guidForId(raw) : '';
        }
        entry.traits[meta.name] = traitData;
      } catch { /* trait not initialized in world */ }
    }

    entities.push(entry);
  }

  // References are GUID-only. Authoring (inspector + import pipeline) always
  // emits GUIDs, so this should never fire — it's a guard that surfaces a stray
  // internal asset path before it's written to disk, instead of silently
  // healing it (which is how path refs used to slip through unnoticed).
  for (const entry of entities) assertNoPathRefs(entry);

  const resources = collectResourceRefs(entities);

  // This scene's own `loadedScenes` bookkeeping — the one lookup backs the scene's
  // `id`, its `createdAt` preservation (Phase 1, scene-loading.md: reuse the FILE's
  // original stamp instead of unconditionally minting a fresh one on every save)
  // and, for a named target, its own `baseScene` ref below. Absent for a scene that
  // was never loaded (a brand-new scene from `newScene()`) — that's the one case a
  // fresh id + `createdAt` are actually correct.
  //
  // A named target is keyed by GUID (the caller already read it out of
  // `getLoadedScenes()`); the PRIMARY is keyed by PATH, because its guid is what
  // we're trying to recover. Keying the primary by guid was circular — it needed
  // the id it was computing — so a re-minted id silently reset `createdAt` too.
  let ownLoadedEntry: { guid: string; createdAt?: string; baseScene?: string } | undefined;
  for (const entry of sceneManager.getLoadedScenes().values()) {
    const hit = targetScene ? entry.guid === targetScene.guid
      : entry.role === 'primary' && entry.path === _currentScenePath;
    if (hit) { ownLoadedEntry = entry; break; }
  }
  // Scene identity is a fact about the FILE, carried forward from the load — never
  // re-derived. Prefer the loaded-scene entry (what `loadSceneFile` read off disk),
  // which is what `saveAll` already hands a named base. The asset-manifest reverse
  // lookup is only a fallback for a serialize with no live load behind it: it reads
  // a mutable global whose `pathToGuid` entry is EVICTED whenever the same guid is
  // re-registered under a different path string (a scanner rescan is enough), and a
  // miss there mints a fresh guid — which dangles every reference to the scene,
  // `project.config.json`'s included. That is how `tropical-island.json` lost its
  // `4bc54ae4-…` id on a save (see docs/scene-loading.md, 2026-07-30).
  // `LoadedSceneEntry.guid` falls back to a `path:…` tag for a file with no valid
  // guid, so it is only trustworthy when it actually IS a guid.
  const sceneId = targetScene
    ? targetScene.guid
    : (ownLoadedEntry && isGuid(ownLoadedEntry.guid) ? ownLoadedEntry.guid
      : (_currentScenePath ? (getGuidForPath(_currentScenePath) ?? newGuid()) : newGuid()));
  const file: SceneFile = {
    id: sceneId, version: SCENE_FORMAT_VERSION,
    createdAt: ownLoadedEntry?.createdAt ?? new Date().toISOString(),
    resources, entities,
  };
  // A top-level baseScene ref is editor module state (like _currentScenePath) for
  // the PRIMARY — it has no other path back into the serialized output — but a named
  // target reads its OWN baseScene straight from `getLoadedScenes()` (Phase 12, M1's
  // prerequisite: each loaded-scene entry now carries its own base ref, not just the
  // primary's). Emitted only when set — an unset base must not appear as
  // `baseScene: undefined` in the written JSON (A3: this is what Play/Stop and undo
  // round-trip through, one level up for a target scene that is itself nested).
  if (targetScene) {
    if (ownLoadedEntry?.baseScene) file.baseScene = ownLoadedEntry.baseScene;
  } else if (_currentBaseScene) {
    file.baseScene = _currentBaseScene;
  }
  return file;
}

/** Dev guard: console.error if any REF field anywhere in a serialized entity holds an
 *  internal asset PATH instead of a GUID — walks traits, the prefab field, per-localId
 *  `overrides`, recursive `added` subtrees, and path-keyed `nestedOverrides` (F8).
 *  Exported for unit testing the full-coverage walk. */
export function assertNoPathRefs(entry: SerializedEntity): void {
  const flag = (field: string, v: unknown) => {
    if (typeof v === 'string' && isInternalAssetPath(v)) {
      console.error(
        `[serialize] internal asset path in ${field} — references must be GUIDs: ${v}\n` +
        `  (the asset isn't registered in the manifest, or authoring wrote a raw path)`,
      );
    }
  };
  // One trait map: Record<traitName, fields|boolean> — flag any REF field it carries.
  const flagTraits = (traits: Record<string, Record<string, unknown> | boolean>, ctx: string) => {
    for (const [traitName, fields] of Object.entries(REF_FIELDS_BY_TRAIT)) {
      const trait = traits[traitName];
      if (!trait || typeof trait === 'boolean') continue;
      const traitObj = trait as Record<string, unknown>;
      for (const field of fields) flag(`${ctx}${traitName}.${field}`, traitObj[field]);
    }
  };
  // overrides / nested-scene-deltas: Record<localId, Record<traitName, fields>>.
  const flagOverrideMap = (
    map: Record<number, Record<string, Record<string, unknown>>> | undefined, ctx: string,
  ) => {
    if (!map) return;
    for (const [localId, traitMap] of Object.entries(map)) flagTraits(traitMap, `${ctx}[${localId}].`);
  };
  // nestedOverrides: Record<path, Record<localId, Record<traitName, fields>>>.
  const flagNested = (nested: NestedOverridePaths | undefined, ctx: string) => {
    if (!nested) return;
    for (const [path, byLocal] of Object.entries(nested)) flagOverrideMap(byLocal, `${ctx}{${path}}`);
  };
  // An added subtree node (recursive): plain node (traits/children) OR a nested-instance
  // reference node (prefab + overrides/added/nestedOverrides). F8: prefab edits inject
  // refs here, exactly where the old guard was blind.
  const flagAdded = (node: AddedEntity, ctx: string) => {
    flagTraits(node.traits ?? {}, `${ctx}.`);
    flag(`${ctx}.prefab`, node.prefab);
    flagOverrideMap(node.overrides, `${ctx}.overrides`);
    flagNested(node.nestedOverrides, `${ctx}.nestedOverrides`);
    for (let i = 0; i < (node.children?.length ?? 0); i++) flagAdded(node.children[i], `${ctx}.child[${i}]`);
    for (let i = 0; i < (node.added?.length ?? 0); i++) flagAdded(node.added![i], `${ctx}.added[${i}]`);
  };

  flagTraits(entry.traits, '');
  flag('prefab', entry.prefab);
  flagOverrideMap(entry.overrides, 'overrides');
  flagNested(entry.nestedOverrides, 'nestedOverrides');
  for (let i = 0; i < (entry.added?.length ?? 0); i++) flagAdded(entry.added![i], `added[${i}]`);
}

/** Walk serialized entities and extract every resource ref they reference.
 *  Sorted + deduped for stable diffs. Used by serializeScene and as a fallback
 *  for old scene files that don't have an explicit `resources` field.
 *  Refs may be GUIDs or paths — both pass through the resource acquire pipeline.
 *
 *  Delegates to the runtime `collectResourceRefsFromEntities` so the editor and
 *  runtime share ONE ref-walking implementation (they had drifted as two ~80-line
 *  near-duplicates). The runtime version also flattens structural `added` subtrees. */
export function collectResourceRefs(entities: SerializedEntity[]): ResourceRef[] {
  return collectResourceRefsFromEntities(entities) as ResourceRef[];
}

// ── Scene path tracking ────────────────────────────────

let _currentScenePath: string | null = null;

const LAST_SCENE_KEY = 'modoki-last-scene';

/** Per-project localStorage key for the "last opened scene", scoped by project
 *  name so one project's scene path never leaks into another's (which would 404).
 *  Single source of truth for BOTH the writer (setCurrentScenePath) and the reader
 *  (createEditor startup restore). Exported for unit testing. */
export function lastSceneKey(configName: string | undefined): string {
  return `modoki-last-scene:${configName || 'default'}`;
}

// The active project's name, injected at editor init so setCurrentScenePath writes
// the per-project key that createEditor restores from on the next launch.
let _sceneProject: string | undefined;
export function setScenePersistenceProject(name: string | undefined) { _sceneProject = name; }

// Base-scene ref of the currently-loaded scene (base-scene persistence). Mirrors
// _currentScenePath: not a live-world value, so it must be tracked as editor
// module state and re-emitted by serializeScene (A3) or every serializeScene()→
// loadScene({preloaded}) round-trip (Play/Stop, undo, timeline preview) silently
// drops it. Reset alongside the scene path whenever a new scene loads.
let _currentBaseScene: string | undefined;
export function getCurrentBaseScene() { return _currentBaseScene; }
export function setCurrentBaseScene(baseScene: string | undefined) { _currentBaseScene = baseScene; }

export function getCurrentScenePath() { return _currentScenePath; }
export function setCurrentScenePath(path: string | null) {
  _currentScenePath = path;
  if (path) {
    // Global key: legacy readers (SceneView prefab-return, devTestBridge fixtures).
    localStorage.setItem(LAST_SCENE_KEY, path);
    // Per-project key: what createEditor restores on startup. Writing it HERE (on
    // every scene switch, not just at boot) is the fix that makes the editor reopen
    // the scene you were last on, not the project default.
    localStorage.setItem(lastSceneKey(_sceneProject), path);
  }
}

async function writeFileToServer(filePath: string, content: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    return res.ok;
  } catch { return false; }
}

/** Save scene to the current path (via the backend write-file API).
 *  If no path is set yet (first save / Save As), asks for a name and writes the
 *  scene into the project's scenes folder via the backend. */
/** Did the save actually reach disk, and if not, WHY. (C7)
 *
 *  saveScene used to return void, swallowing BOTH a user cancel and a failed write behind a
 *  console line — so the agent op hardcoded `{ok:true}` and reported success for a scene
 *  that was never written. That is the worst possible lie here: every "create live, then edit
 *  the file" flow depends on save_all, so a fake success reproduced the exact bug save_all
 *  exists to fix, with the fix itself confirming it had worked. */
// The edit-version at the last successful save / load / new. Anything past it is work that
// exists ONLY in the live world. (C7)
let _savedAtEditVersion = 0;
/** Mark the live world as matching disk (a successful save, or a fresh load/new). */
export function markSceneSaved(): void { _savedAtEditVersion = getEditVersion(); }
/** Is there live-world work not on disk? Used to stop load_scene/new_scene silently
 *  DESTROYING it — that reported {ok:true} while the entity you just created was gone from
 *  the world, the file, and the undo stack, with nothing anywhere saying why.
 *  Also true while a 'manual'-mode particle/anim/timeline edit is pending a save
 *  (dirtyAssets.ts, mcp-persistence.md Phase 3) — those are asset-shaped work,
 *  not scene-edit-version work, so `getEditVersion()` alone can't see them.
 *
 *  THIRD cause, and the reason it can't be dropped: a still-dirty NON-PRIMARY loaded
 *  scene. `saveScene` calls `markSceneSaved()` the moment the PRIMARY write lands, which
 *  rebaselines the edit version — but `saveAll` writes the bases AFTER that, and a base
 *  that fails keeps its dirty flag (by design, so a later save retries it). Without this
 *  term a partially-failed Save All reported `unsavedChanges:false` while a base-scene
 *  edit existed only in memory, and the game-code-reload gate (CLAUDE.md: an agent checks
 *  this flag before writing a `.ts` that force-reloads the editor) would then discard the
 *  human's work believing there was none. */
export function hasUnsavedChanges(): boolean {
  return getEditVersion() !== _savedAtEditVersion || hasDirtyAssets() || dirtySceneGuidsSnapshot().size > 0;
}

/** WHICH kind of unsaved work exists — the three independent causes above, told apart.
 *
 *  S3.11: the load_scene / new_scene refusal built one fixed string blaming
 *  create_entity/duplicate_entity/prefab, so an agent whose only pending work was a dirty
 *  particle/anim/timeline doc went looking for live entities it had never created. A refusal that
 *  names the wrong cause is worse than a generic one — it sends the reader somewhere specific and
 *  wrong. All three causes are cleared by the same `save_all`, but the caller has to be told what
 *  `force:true` would DISCARD.
 *
 *  `dirtyScenes` is the third cause (see `hasUnsavedChanges`): non-primary loaded scenes
 *  whose edits are still only in memory — typically a base whose write failed in a
 *  partial `saveAll`. It must be reported, or a refusal triggered by it alone would name
 *  no cause at all. */
export function unsavedChangeCauses(): { sceneDirty: boolean; dirtyAssetPaths: string[]; dirtyScenes: string[] } {
  return {
    sceneDirty: getEditVersion() !== _savedAtEditVersion,
    dirtyAssetPaths: getDirtyAssetPaths(),
    dirtyScenes: [...dirtySceneGuidsSnapshot()],
  };
}

export interface SaveResult {
  saved: boolean;
  path: string | null;
  reason: 'ok' | 'cancelled' | 'write-failed' | 'needs-path' | 'playing' | 'prefab-edit';
  /** Other loaded scenes (Phase 12, M3 — a dirty BASE, edited in place) written in
   *  the SAME `saveAll` call, alongside the primary. Absent/empty when nothing else
   *  was dirty. A base is only ever written once the primary's own save succeeded —
   *  `saveScene`'s run-mode refusal sits above both, so neither writes during Play. */
  extraSaved?: { path: string; guid: string }[];
  /** Other loaded scenes that FAILED to save in this call, and why.
   *
   *  These used to be a `console.error` and a `continue` — so a Save All in which a dirty BASE
   *  scene could not be serialized or written still returned the primary's `{saved:true}`, and the
   *  agent op reported `{ok:true}`. The edit stayed only in memory, and a later build (which reads
   *  FILES) shipped without it, with nothing anywhere saying why. Per-scene isolation is right —
   *  one bad scene must not block the others — but isolation must not mean silence
   *  (`docs/mcp-tool-conventions.md` §5: PARTIAL is a failure unless the tool documents otherwise).
   *
   *  Their dirty flags stay SET, so a later save retries them. */
  failed?: { path: string; guid: string; reason: string }[];
  /** Pending particle/anim/timeline writes (Phase 3) flushed alongside this save, if any. */
  assets?: FlushResult;
}

export async function saveScene(opts: {
  /** Save to this path instead of prompting (the scene keeps it for later saves). */
  path?: string;
  /** Allow the native Save-As panel when there's no path yet. TRUE for a human (menu /
   *  Cmd+S). Agents MUST pass false: the panel is modal and only a human can dismiss it, so
   *  an agent-triggered dialog hangs the call ~60s AND blocks every later renderer-bound
   *  call until someone clicks Cancel. Default true to keep the human callers unchanged. */
  allowDialog?: boolean;
} = {}): Promise<SaveResult> {
  const { path: explicitPath, allowDialog = true } = opts;
  // ⚠️ NEVER serialize the prefab-edit world. Its entities are the prefab PLUS throwaway scaffolding
  // (key light, ambient, HDR, and the 2D `Canvas2D` host + centring stage), and its scene path is
  // deliberately null so a normal save cannot target a real file. But "no path" then fell into the
  // Save-As branch below — so Cmd+S offered a native "Save Scene As" panel and, if accepted, would
  // have written the SCAFFOLDING into a brand-new scene file.
  //
  // Observed, not theorised: an exit whose scene reload failed left the world synthetic with the
  // `editingPrefab` flag cleared, `isEditingPrefab()` therefore returned false, and Cmd+S fell
  // through to exactly that dialog ("prefab cannot be saved — it opens a new file dialog").
  //
  // The guard asks the WORLD (`isPrefabEditWorld`) rather than the store flag, which is the whole
  // point: the flag is what was out of sync. `savePrefabEdit()` is the save for this world, and the
  // Cmd+S callers route to it — this refusal is the backstop for every path that does not.
  // ⚠️ Conjunction, not `isPrefabEditWorld()` alone. `newScene()` wipes the ECS world and sets
  // `_currentScenePath` WITHOUT touching sceneManager, so the live path stays SYNTHETIC after
  // "Create Scene" is used from the Assets panel during prefab-edit — and the bare guard then
  // refused to write the brand-new scene, silently (neither `create()` nor `runCreate` checks the
  // result). `_currentScenePath` is the discriminator: prefab-edit deliberately nulls it, while a
  // real save target means the world is no longer the prefab's. Refusing needs BOTH.
  if (isPrefabEditWorld() && !_currentScenePath) return { saved: false, path: null, reason: 'prefab-edit' };
  // TRANSIENCE guard (preview-mode-refactor, Phase 2): only ever WRITE authored data. While
  // scrub/preview/play is live the world holds preview mutations (a signal action moved the
  // camera, `isActive` toggled, a control prefab spawned) — the Transient skip drops spawns, but
  // authored-trait mutations would still leak. Refuse the save until stopped. (Phase 3 replaces
  // this with a mandatory snapshot session so the authored data is always recoverable to save.)
  //
  // This subsumes the earlier Play/Pause-only refusal (C7): run-mode 'playing' ⇒ a live/paused
  // Play, so this also blocks baking the RUNTIME world (physics-settled positions, spawned
  // entities) over the authored scene — and additionally blocks 'scrub'/'preview', where
  // playState is still 'stopped'. modoki_save_all's doc CLAIMED "Blocked during Play" and
  // nothing enforced it; /api/scene-mutate already refuses for the mirror-image reason.
  if (getRunMode() !== 'stopped') {
    console.warn(`[Editor] Save refused — run-mode is '${getRunMode()}', not 'stopped'. Stop preview/play before saving so preview mutations don't reach disk.`);
    return { saved: false, path: explicitPath || _currentScenePath, reason: 'playing' };
  }
  // Saving is the authored write that persists identity — commit minted guids
  // to the live world so subsequent refs resolve and the next save is stable.
  const scene = await serializeScene({ assignGuids: true });
  const content = JSON.stringify(scene, null, 2);

  const knownPath = explicitPath || _currentScenePath;
  if (knownPath) {
    // Save to known path via dev server
    const ok = await writeFileToServer(knownPath, content);
    if (ok) {
      // scene.id is always populated by serializeScene (required field).
      registerAsset(scene.id, knownPath, 'scene');
      if (knownPath !== _currentScenePath) setCurrentScenePath(knownPath);
      editorEmit('!save', { path: knownPath, entities: scene.entities.length }); // Editor Percept (V2)
      console.log(`[Editor] Saved scene: ${scene.entities.length} entities → ${knownPath}`);
      const assets = await flushDirtyAssets(); // Phase 3: pending manual-mode particle/anim/timeline edits
      markSceneSaved();
      return { saved: true, path: knownPath, reason: 'ok', ...(assets.saved.length || assets.failed.length ? { assets } : {}) };
    }
    console.error(`[Editor] Failed to save scene to ${knownPath}`);
    return { saved: false, path: knownPath, reason: 'write-failed' };
  }

  // No path, and no dialog allowed (an agent) — say so instead of opening a modal panel
  // only a human can close.
  if (!allowDialog) return { saved: false, path: null, reason: 'needs-path' };

  // No path yet (first save / Save As) — ask for a name and write the scene INTO
  // the project's scenes folder via the backend, so it persists to the project on
  // disk (dev/Electron). We deliberately do NOT use `showSaveFilePicker`: the File
  // System Access API writes to the user's LOCAL disk, not the project.
  // `saveAssetDialog` uses the native macOS panel where available and an in-app
  // name prompt everywhere else.
  const target = await saveAssetDialog({
    defaultName: 'scene.json',
    ext: '.json',
    defaultFolder: '/assets/scenes',
    prompt: 'Save Scene As',
  });
  if (!target) return { saved: false, path: null, reason: 'cancelled' }; // user cancelled
  const ok = await writeFileToServer(target, content);
  if (ok) {
    registerAsset(scene.id, target, 'scene');
    setCurrentScenePath(target); // persists, so the next Save All goes straight to it
    editorEmit('!save', { path: target, entities: scene.entities.length }); // Editor Percept (V2)
    console.log(`[Editor] Saved scene: ${scene.entities.length} entities → ${target}`);
    const assets = await flushDirtyAssets(); // Phase 3: pending manual-mode particle/anim/timeline edits
    markSceneSaved();
    return { saved: true, path: target, reason: 'ok', ...(assets.saved.length || assets.failed.length ? { assets } : {}) };
  }
  console.error(`[Editor] Failed to save scene to ${target}`);
  return { saved: false, path: target, reason: 'write-failed' };
}

/** Load a scene from a JSON file. Delegates to SceneManager which handles the
 *  full async preload + atomic swap + refcount lifecycle. The editor wrapper
 *  layers on the editor-only concerns: tracking the current scene path and
 *  resetting undo history.
 *
 *  `gameId` activates the project's game-scoped managers. SceneManager normally
 *  derives the game from a `/games/<id>/` path segment, but the editor boots the
 *  canonical working-copy path (`/assets/scenes/x.json`, gap #2) which carries no
 *  such segment — so the editor boot passes the project's game id explicitly.
 *  Subsequent in-editor scene opens omit it and inherit the active game. */
/** Monotonic load counter — the newest `loadScene` call owns the progress modal.
 *  See the epoch guard inside loadScene. */
let _loadEpoch = 0;

export async function loadScene(
  scenePath: string,
  gameId?: string,
  opts?: { probing?: boolean },
): Promise<boolean> {
  // Epoch guard: SceneManager cancels an in-flight load when a newer one starts
  // (boot autoload vs an agent/menu open, or rapid scene switches). The aborted
  // load's `finally` must NOT clear the progress modal the WINNING load is
  // driving, and its late onProgress must not write stale counts — so only the
  // latest epoch touches sceneLoadStatus.
  const epoch = ++_loadEpoch;
  const setSceneLoadStatus = useEditorStore.getState().setSceneLoadStatus;
  try {
    setPlayState('stopped'); // a scene load always returns the editor to edit mode
    setSceneLoadStatus({ active: true, loaded: 0, total: 0 });
    await sceneManager.loadScene(scenePath, {
      ...(gameId !== undefined ? { gameId } : {}),
      // Resources acquire in parallel; each completion (on a cold cache, a finished
      // bake) advances the bar. The SceneLoadModal only shows past a ~400ms delay.
      onProgress: (loaded, total) => {
        if (epoch === _loadEpoch) setSceneLoadStatus({ active: true, loaded, total });
      },
    });
    setCurrentScenePath(scenePath); // persists to localStorage for next editor launch
    setCurrentBaseScene(sceneManager.getCurrentBaseScene());
    // Swap to THIS scene's own undo history (empty on first visit) instead of
    // dropping undo globally — returning to a previously-open scene restores its
    // stack. Per-scene keying also keeps another scene's actions (stale ids) from
    // ever applying here. (Play→Stop does NOT come through here — it reloads via
    // sceneManager directly — so its same-scene history is preserved.)
    swapHistory(scenePath);
    const entityCount = getAllEntities().length;
    markSceneSaved(); // the freshly loaded world matches disk — a new baseline (C7)
    // A stale dirty guid from the PREVIOUS chain (e.g. a base no longer loaded) must
    // not linger — the freshly loaded chain has no unsaved live-world work yet either.
    clearAllSceneDirty();
    // Editor Percept (V2): the human opened a scene — correlate later game/edit events to it.
    editorEmit('!scene-load', { path: scenePath, entityCount });
    console.log(`[Editor] Loaded scene: ${entityCount} entities from ${scenePath}`);
    return true;
  } catch (e) {
    // An AbortError means a newer load superseded this one (by design — see the
    // epoch guard above); it's expected, not a failure worth a red console error.
    if ((e as Error)?.name !== 'AbortError') {
      // `probing`: the caller is walking a CANDIDATE LIST (editor boot) and a miss here is a
      // normal step, not a failure — the next candidate is expected to load. Logging it at
      // `error` made a healthy self-healing boot look broken, and because
      // `smoke-packaged.sh` / `assert-app-renders.sh` fail on ANY renderer console error, a
      // stale remembered scene path could fail a packaging gate for a reason unrelated to the
      // commit under test (#91). The genuine "nothing loaded at all" error is raised ONCE by
      // loadFirstScene after every candidate has missed.
      const msg = `[Editor] Failed to load scene: ${e}`;
      if (opts?.probing) console.warn(`${msg} (trying the next boot candidate…)`);
      else console.error(msg);
    }
    return false;
  } finally {
    // Only the latest load owns the modal — a superseded load must not hide the
    // winner's progress bar (its `finally` can run after the winner set active).
    if (epoch === _loadEpoch) useEditorStore.getState().setSceneLoadStatus({ active: false });
  }
}

/** Start a fresh untitled scene: clear ALL entities and spawn a ready-to-use
 *  starting world — a Camera, an Environment (built-in white.hdr, for reflections),
 *  and default lights (a Directional key + an Ambient fill) so objects are actually
 *  LIT out of the box. The Environment alone does NOT light the scene (the engine
 *  binds the raw equirect HDR to scene.environment without PMREM, so it only reads
 *  as reflections alongside real lights) — without the lights a fresh scene renders
 *  everything black. Then drop the current scene path and swap to the empty
 *  bootstrap undo context (so the previous scene's stack is preserved under its own
 *  key rather than dropped globally). Shared by File → New Scene and the agent
 *  `new-scene` op so both produce the identical starting world. The caller clears
 *  editor selection (this stays free of the editor store). */
export function newScene(): void {
  deleteEntities(getAllEntities().map((e) => e.id));
  const world = getCurrentWorld();
  spawnEntity(world,
    Transform({ x: 0, y: 5, z: 10 }), Camera({ fov: 60 }), EntityAttributes({ name: 'Camera', sortOrder: 0 }),
  );
  spawnEntity(world,
    Environment({ hdrPath: WHITE_HDR_GUID }), EntityAttributes({ name: 'HDR Environment', sortOrder: 1 }),
  );
  spawnEntity(world,
    Transform({ x: 5, y: 10, z: 7 }),
    Light({ lightType: 'directional', color: 0xffffff, intensity: 2 }),
    EntityAttributes({ name: 'Directional Light', sortOrder: 2 }),
  );
  spawnEntity(world,
    Light({ lightType: 'ambient', color: 0xffffff, intensity: 0.6 }),
    EntityAttributes({ name: 'Ambient Light', sortOrder: 3 }),
  );
  setCurrentScenePath(null);
  setCurrentBaseScene(undefined);
  swapHistory('');
  markSceneSaved(); // a fresh untitled scene has no unsaved WORK yet — new baseline (C7)
  clearAllSceneDirty();
  console.log('[Editor] New scene created');
}

/** Report (and reset) the #124 probe: authored entity fields that a SYSTEM rewrote while the
 *  editor was stopped, and which this save therefore just persisted.
 *
 *  One grouped warning, never a refusal. The engine cannot tell a rogue write from an intended
 *  one — a game may legitimately drive an authored entity from a projection — so the honest
 *  move is to name it and let the human judge. The fix on the game's side is usually
 *  `registerProjection(..., { pauseWhileStopped: true })`, which is why the message says so.
 *
 *  Exported for tests; `saveAll` is the only production caller. */
export function warnAuthoredWritesWhileStopped(): void {
  const { records, dropped } = getAuthoredWritesWhileStopped();
  if (records.length === 0) return;
  const lines = records.map(r => `  • ${r.name}.${r.trait}.${r.field}${r.count > 1 ? ` (${r.count}x)` : ''}`);
  if (dropped > 0) lines.push(`  • …and ${dropped} more field(s) not listed`);
  console.warn(
    `[Editor] ${records.length} authored field(s) were changed by a running system while the editor was `
    + `stopped, and this save wrote those values to disk:\n${lines.join('\n')}\n`
    + `  If that is not intended, the projection driving them should be registered with `
    + `{ pauseWhileStopped: true } (see docs/scene-loading.md § Authored vs runtime).`,
  );
  clearAuthoredWritesWhileStopped();
}

/** Save all editor-managed assets: the primary scene file (via `saveScene`), THEN
 *  every OTHER dirty scene in the loaded chain — a base edited in place (Phase 12,
 *  M3, scene-loading.md) — to ITS OWN file. Per-material edits are
 *  persisted separately in their own `.mat.json` files via the Asset Inspector, so
 *  there's nothing else to flush here.
 *
 *  A base is written ONLY after the primary's own save succeeds — `saveScene`'s
 *  run-mode refusal (no writing while playing/previewing) sits above this loop, so it
 *  covers bases too; a cancelled Save-As or a failed primary write means nothing else
 *  gets written either, and the caller sees the primary's own failure reason
 *  unchanged. Silent by design (the owner's call, 2026-07-26) — the dirty-dot on the
 *  Hierarchy scene-group row (Phase 13) is the visibility half that makes a silent
 *  multi-file save legible instead of a surprise. */
export async function saveAll(opts: { path?: string; allowDialog?: boolean } = {}): Promise<SaveResult> {
  const primaryResult = await saveScene(opts);
  if (!primaryResult.saved) return primaryResult;
  // #124, warn-only: name any authored field a system rewrote while the editor was stopped —
  // those values were just written to disk. Reported AFTER the save succeeds so a refused save
  // (playing/previewing) doesn't warn about a file nothing wrote.
  warnAuthoredWritesWhileStopped();

  const extraSaved: { path: string; guid: string }[] = [];
  const failed: { path: string; guid: string; reason: string }[] = [];
  // Snapshot the chain BEFORE iterating — each iteration below `await`s (serialize +
  // write), and a scene swap landing mid-loop would otherwise mutate the live Map
  // out from under a bare `for...of`, skipping or misattributing entries.
  const loadedScenes = [...sceneManager.getLoadedScenes().values()];
  for (const entry of loadedScenes) {
    if (entry.role === 'primary' || !isSceneDirty(entry.guid)) continue;
    // Catch per-scene so one scene that fails to serialize can't block every OTHER
    // dirty scene in the same Save All, and so its dirty flag stays SET (not
    // silently cleared) until it can actually be written. This used to be load-
    // bearing for Phase 12's A8/A9 guard, which threw for a base containing a
    // prefab instance; that guard is gone (both bugs fixed), but the per-scene
    // isolation is worth keeping on its own merits for any future throw.
    let sceneFile;
    try {
      sceneFile = await serializeScene({ scene: { path: entry.path, guid: entry.guid } });
    } catch (e) {
      console.error(`[Editor] Refused to save "${entry.path}": ${(e as Error).message}`);
      failed.push({ path: entry.path, guid: entry.guid, reason: `serialize failed: ${(e as Error).message}` });
      continue;
    }
    const ok = await writeFileToServer(entry.path, JSON.stringify(sceneFile, null, 2));
    if (!ok) {
      console.error(`[Editor] Failed to save scene to ${entry.path}`);
      failed.push({ path: entry.path, guid: entry.guid, reason: 'the write to disk was rejected' });
      continue;
    }
    registerAsset(entry.guid, entry.path, 'scene');
    clearSceneDirty(entry.guid);
    editorEmit('!save', { path: entry.path, entities: sceneFile.entities.length }); // Editor Percept (V2)
    console.log(`[Editor] Saved scene: ${sceneFile.entities.length} entities → ${entry.path}`);
    extraSaved.push({ path: entry.path, guid: entry.guid });
  }
  return {
    ...primaryResult,
    ...(extraSaved.length ? { extraSaved } : {}),
    ...(failed.length ? { failed } : {}),
  };
}
