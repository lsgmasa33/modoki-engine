/** Put prefabs back to what their FILES hold without reloading the open scene (#1873 S2) — Unity's reimport: the prefab
 *  is read again and its instances updated in place, and the scene's unsaved work and its undo stack stay.
 *
 *  Why not the watcher's path (`agentBridge.ts` `handleSceneChanged`): that is the owner's disk-wins rule for an OUTSIDE
 *  change (#1164) — it reloads the open scene from ITS file, dropping every unsaved edit and the undo stack with it. A
 *  discard of a parked prefab (#1868) went through it "as if the file had just changed", so dropping one prefab's
 *  pending write silently dropped unrelated scene work too. The scene file did not change, so nothing needs reloading:
 *  the caches take the file's document (`seatCaches` — a REPLACE, not #1308's eviction blank), and every live frame
 *  built from another document is rebuilt onto it by the rebase a write already runs (`rebaseStaleInstances`), which
 *  captures each instance's overrides against the document IT was built from and puts them back.
 *
 *  What it cannot do is SAID, never skipped: a frame the rebase leaves on another document (a stale nested frame it
 *  refuses to guess at) is reported in `notRebased`, whose way out is an explicit scene reload. An undo entry that
 *  depended on the discarded document refuses through its own precondition (`prefabRestoreRefusal`).
 *
 *  The caller asks whether the world may be rebuilt now (Play, a preview, a landing switch) and defers otherwise; this
 *  holds the world against a switch while it runs, as `rebaseStaleInstancesSoon` does. */

import { seatCaches } from './prefabCommit';
import { fetchPrefabSource, preloadNestedPrefabs } from './prefabCache';
import { notePrefabFileChanged } from './prefabRead';
import { rebaseStaleInstances } from './prefabRebuild';
import { staleFrames } from './prefabFrames';
import { parkedPrefab } from './dirtyAssets';
import { beginWorldBoundOperation } from '../undo/undoManager';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { parseAssetJson, assetIsAbsent } from '../../runtime/loaders/assetFetch';
import { resolveRef, isGuid, getGuidForPath, lastKnownPathOf } from '../../runtime/loaders/assetManifest';
import { evictDeletedPrefabs, invalidatePrefab, acquirePrefab, replaceCachedPrefab, type SceneId } from '../../runtime/loaders/meshTemplateCache';
import { evictDeletedEditorPrefabs, seatEditorPrefabCache } from './prefabCache';
import { UnresolvedPrefabRef, unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { worldHasUnsavedEdits } from './serialize';
import { type PrefabFile } from './prefab';
import { rebuildStaleFrames } from './prefabRebuild';
import { type StaleFrame } from './prefabFrames';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from './prefabCache';
import { getCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { asSceneEntry } from '../../runtime/loaders/unresolvedPrefabRefs';
import { loadSceneFile, instantiatePrefabIntoWorld, type ExpansionReader, type SceneData } from '../../runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { openScenePath } from '../../runtime/scene/openScenePath';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { destroyEntity } from '../../runtime/core/ecs/world';
import { markStructureDirty, findEntity, readTraitData, writeTraitField, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/core/uiDirty';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { frameRootDoc } from '../../runtime/core/ecs/identityParents';

export interface PrefabReimportReport {
  /** Each path whose file document both caches now hold, its instances rebased onto it. */
  reimported: string[];
  /** A path whose file could not be read, or is still parked: the editor keeps what it held. */
  failed: { path: string; reason: string }[];
  /** A path whose file is GONE (#1873 R1 r2): both caches evicted as the in-editor delete evicts them, and its live
   *  instances kept expanded (#1738's evicted state; a save writes them from their frame records, I18). */
  deleted: string[];
  /** A path nothing in the open scene uses — no live frame, no placeholder, no loaded scene's ref (#1702's case): only
   *  the caches were brought up to date. Said as the #1702 gate says it, so an unused prefab is never reported as a
   *  re-import or a delete of instances it does not have. */
  unused: string[];
  /** A Missing Prefab placeholder of a re-imported prefab that is still a placeholder (#1873 R1 r3). */
  placeholders: { entity: string; guid?: string; source: string }[];
  /** A live instance still built from another document than its file's after the rebase. */
  notRebased: { entity: string; guid?: string; source: string; reason: string }[];
}

/** Re-read each of `paths` (prefab files whose park was just discarded) into both caches and rebase every live instance
 *  of them onto it, in the world as it stands — see the module comment. */
export async function reimportPrefabsInPlace(paths: readonly string[]): Promise<PrefabReimportReport> {
  const report: PrefabReimportReport = { reimported: [], failed: [], deleted: [], unused: [], notRebased: [], placeholders: [] };
  const release = beginWorldBoundOperation();
  try {
    const world = getCurrentWorld();
    const sources = new Set<string>();
    for (const path of paths) {
      // A park still there is what every editor read takes in place of the file (#1868): re-importing it would re-seat
      // the park, not the file. The caller discards first.
      if (parkedPrefab(path) !== undefined) { report.failed.push({ path, reason: 'it is still parked, so its file was not read' }); continue; }
      // Any read of it in flight read the discarded document (#1752): it must not prime the caches after this does.
      notePrefabFileChanged(path);
      const keysBefore = [path, ...(getGuidForPath(path) ? [getGuidForPath(path)!] : [])];
      const held = keysBefore.map((k) => getCachedPrefabSync(k));
      const doc = await fetchPrefabSource(path, { cache: 'no-store' });
      // An editor write that landed during the read (an Apply, a Replace) seated a newer document than these bytes, and
      // rebased the instances onto it: it is not overwritten (the refresh's rule).
      if (keysBefore.some((k, i) => getCachedPrefabSync(k) !== held[i])) {
        report.failed.push({ path, reason: 'an editor write landed while its file was read, and the editor keeps that write' });
        continue;
      }
      if (!doc) {
        // Gone, rather than unreadable (a half-typed hand edit keeps the document the editor held): the in-editor delete's
        // cache repair (`applyAssetPathMoves`' delete branch), and the live instances stay expanded, as there (#1862).
        // Asked BEFORE any "is it used" rule (#1873 R1 review F2): the dev editor loads the delete's PRUNED manifest before
        // this event, so the path resolves to no guid by now — the eviction finds the guid keys itself (`lastKnownPathOf`).
        if (await fileIsAbsent(path)) {
          // Used by what? By the guids that LIVED at this path too — the pruned manifest no longer maps them here.
          const gone = new Set([...keysBefore, ...liveSourcesOnceAt(path)]);
          const usedBefore = usedLive(gone) || scenesReferencing(gone).length > 0;
          evictDeletedEditorPrefabs(path);
          evictDeletedPrefabs(path);
          (usedBefore ? report.deleted : report.unused).push(path);
        } else {
          report.failed.push({ path, reason: 'its file could not be read as a prefab, so the editor keeps the document it held' });
        }
        continue;
      }
      const guid = getGuidForPath(path) ?? doc.id;
      const keys = new Set([...keysBefore, ...(guid ? [guid] : []), ...(doc.id ? [doc.id] : [])]);
      // The LOADER's copy (#1873 R1 review F1): every loaded scene that references the prefab keeps owning it, with the
      // file's document — a timeline spawn, an empty pool or a game trait's ref reads it synchronously, and the reload
      // this replaced re-acquired it. Acquired by its GUID (the loader resolves only a guid ref), which the manifest maps to
      // the path the file has NOW — so an outside rename (unlink + add) seats it under the new path. Replaced, never left
      // evicted (#1308).
      const owners = scenesReferencing(keys);
      if (guid) for (const sid of owners) await acquirePrefab(sid, guid);
      // …and asked again after it (R1 review): an acquire of a path the loader does not hold is a real fetch, a window an
      // editor write can land in as it can in the read above.
      if (keysBefore.some((k, i) => getCachedPrefabSync(k) !== held[i])) {
        report.failed.push({ path, reason: 'an editor write landed while its file was read, and the editor keeps that write' });
        continue;
      }
      const used = usedLive(keys);
      if (!used) {
        // Nothing live to rebase: the editor keys somebody read are brought up to date, and the rest stay cold
        // (`refreshPrefabSourceForPath`'s rule); the loader's copy is the file's, or gone when no scene owns it.
        keysBefore.forEach((k, i) => { if (held[i]) seatEditorPrefabCache(k, doc); });
        if (owners.length) replaceCachedPrefab(path, doc); else invalidatePrefab(path);
        (owners.length ? report.reimported : report.unused).push(path);
        continue;
      }
      seatCaches(path, guid ?? path, guid, doc);
      await preloadNestedPrefabs(doc);
      sources.add(path);
      if (guid) sources.add(guid);
      if (doc.id) sources.add(doc.id);
      report.reimported.push(path);
    }
    // A world replaced during the reads loaded its frames from these files itself: nothing here is left to rebase.
    if (!sources.size || getCurrentWorld() !== world) return report;
    await rebaseStaleInstances({ sources });
    const names = new Map(getAllEntities().map((e) => [e.id, e]));
    await reexpandPlaceholders(sources);
    for (const { entity: e, source } of placeholdersOf(sources)) {
      report.placeholders.push({ entity: e.name || String(e.id), ...(e.guid ? { guid: e.guid } : {}), source });
    }
    for (const s of staleFrames({ sources })) {
      const e = names.get(s.root);
      report.notRebased.push({
        entity: e?.name ?? String(s.root), ...(e?.guid ? { guid: e.guid } : {}), source: s.source,
        reason: 'it is still built from another document than its file holds — the in-place rebuild did not reach it (a prefab nested in it changed since it was built, or its rebuild was refused; see the console)',
      });
    }
    return report;
  } finally {
    release();
  }
}

/** Whether anything in the live world is built from, or waits for, a prefab named by one of `keys`: a frame of it, a frame
 *  whose record could not expand a row naming it, or a Missing Prefab placeholder of it. */
function usedLive(keys: ReadonlySet<string>): boolean {
  const names = (ref: string | undefined) => !!ref && (keys.has(ref) || keys.has(resolvedRef(ref) ?? ''));
  const world = getCurrentWorld();
  const pi = getTraitByName('PrefabInstance');
  let used = false;
  if (pi) {
    world.query(pi.trait).updateEach(([data], entity) => {
      if (used) return;
      const d = data as { source?: string; rootInstanceId?: number };
      if (names(d.source)) { used = true; return; }
      if (d.rootInstanceId !== entity.id()) return;
      const rec = frameRootDoc(world, entity);
      const rows = (rec?.doc as PrefabFile | undefined)?.entities ?? [];
      if (rec?.unexpanded?.some((lid) => names(rows.find((r) => r.localId === lid)?.prefab))) used = true;
    });
  }
  return used || placeholdersOf(keys).length > 0;
}

/** The guids of live frames and placeholders whose prefab lived at `path` before the manifest dropped it (a delete's
 *  prune, `lastKnownPathOf`). */
function liveSourcesOnceAt(path: string): string[] {
  const out = new Set<string>();
  const at = (ref: string | undefined) => { if (ref && isGuid(ref) && lastKnownPathOf(ref) === path) out.add(ref); };
  const pi = getTraitByName('PrefabInstance');
  if (pi) getCurrentWorld().query(pi.trait).updateEach(([d]) => at((d as { source?: string }).source));
  getCurrentWorld().query(UnresolvedPrefabRef).forEach((e) => at(unresolvedRefOf(e)?.source));
  return [...out];
}

/** The loaded scenes whose prefab refs name one of `keys` (a ref, or the path it resolved to at load). A scene whose
 *  entry does not know what it uses counts as using it, as the #1702 gate reads it. */
function scenesReferencing(keys: ReadonlySet<string>): SceneId[] {
  const out: SceneId[] = [];
  for (const [sid, entry] of sceneManager.getLoadedScenes()) {
    if (!entry.prefabRefs || [...entry.prefabRefs].some((r) => keys.has(r) || keys.has(resolvedRef(r) ?? ''))) out.push(sid);
  }
  return out;
}

/** Where a prefab ref resolves: a guid through the manifest, a path as itself. `resolveRef` handed a path refuses it
 *  loudly (GUID-only refs), and a loaded scene's `prefabRefs` holds the paths its refs resolved to beside the refs. */
function resolvedRef(ref: string): string | undefined {
  return isGuid(ref) ? resolveRef(ref) : ref;
}

/** Whether the file at `path` is genuinely not there (not merely unreadable, #896). */
async function fileIsAbsent(path: string): Promise<boolean> {
  const url = isGuid(path) ? resolveRef(path) : assetUrl(path);
  if (!url) return true;
  try {
    await parseAssetJson(await fetch(url, { cache: 'no-store' }), path);
    return false;
  } catch (e) {
    return assetIsAbsent(e);
  }
}

/** Every Missing Prefab placeholder (entry or node, `UnresolvedPrefabRef`) whose prefab is one of `sources` — by its ref or
 *  by where that ref resolves. */
function placeholdersOf(sources: ReadonlySet<string>, _viaResolve = true): { entity: { id: number; name: string; guid?: string }; source: string; kind: 'entry' | 'node' }[] {
  const out: { entity: { id: number; name: string; guid?: string }; source: string; kind: 'entry' | 'node' }[] = [];
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  getCurrentWorld().query(UnresolvedPrefabRef).forEach((entity) => {
    const ref = unresolvedRefOf(entity);
    if (!ref || !(sources.has(ref.source) || sources.has(resolvedRef(ref.source) ?? ''))) return;
    const e = byId.get(entity.id());
    out.push({ entity: { id: entity.id(), name: e?.name ?? '', ...(e?.guid ? { guid: e.guid } : {}) }, source: ref.source, kind: ref.kind });
  });
  return out;
}

/** Turn what a prefab's return can re-expand back into live instances IN PLACE (#1873 R1 r3; Unity reconnects a Missing
 *  Prefab instance when an asset with its guid returns). Two shapes, each by the mechanism that already expands it:
 *  - an ENTRY placeholder (a scene entry the load could not expand): its entry, built exactly as a save builds it from the
 *    live placeholder (`asSceneEntry`, so a rename, a move or a reorder made on the placeholder is kept), is loaded into
 *    the live world by the one per-entry expansion (`loadSceneFile`), and the placeholder's own children are put under
 *    the new root;
 *  - a NODE placeholder (a reference node inside an instance) and a row a frame recorded as `unexpanded`: the enclosing
 *    frame is rebuilt from the document it was built from (#1864's re-expansion, which #1868 removed with the delete
 *    undo that drove it) — its capture writes the node back as an added node, and the respawn expands it.
 *  Whatever is still a placeholder after this is reported by the caller. */
async function reexpandPlaceholders(sources: ReadonlySet<string>): Promise<void> {
  const world = getCurrentWorld();
  const names = (ref: string) => sources.has(ref) || sources.has(resolvedRef(ref) ?? '');
  // Frames first: an entry placeholder never sits inside one (a scene entry is a stored root).
  const pi = getTraitByName('PrefabInstance');
  if (pi) {
    const byId = new Map(getAllEntities().map((e) => [e.id, e]));
    const isFrameRoot = (id: number) => (readTraitData(id, pi) as { rootInstanceId?: number } | null)?.rootInstanceId === id;
    const roots = new Set<number>();
    for (const { entity, kind } of placeholdersOf(sources, true)) {
      if (kind !== 'node') continue;
      for (let c = byId.get(entity.id)?.parentId; c; c = byId.get(c)?.parentId) if (isFrameRoot(c)) { roots.add(c); break; }
    }
    world.query(pi.trait).updateEach(([data], entity) => {
      const d = data as { source?: string; rootInstanceId?: number };
      if (!d.source || d.rootInstanceId !== entity.id()) return;
      const rec = frameRootDoc(world, entity);
      const rows = (rec?.doc as PrefabFile | undefined)?.entities ?? [];
      if (rec?.unexpanded?.some((lid) => { const r = rows.find((x) => x.localId === lid); return !!r?.prefab && names(r.prefab); })) roots.add(entity.id());
    });
    const frames: StaleFrame[] = [];
    for (const root of roots) {
      const handle = findEntity(root);
      const rec = handle ? frameRootDoc(world, handle) : undefined;
      if (!rec) continue;
      await preloadNestedPrefabsForSubtree(root);
      frames.push({ root, source: rec.source, from: rec.doc as PrefabFile, to: rec.doc as PrefabFile });
    }
    if (getCurrentWorld() !== world) return;
    if (frames.length) rebuildStaleFrames(frames);
  }
  for (const { entity } of placeholdersOf(sources, true).filter((p) => p.kind === 'entry')) {
    if (getCurrentWorld() !== world) return;
    await reexpandEntryPlaceholder(entity.id);
  }
}

/** One entry placeholder back into a live instance — see {@link reexpandPlaceholders}. Left as it is when the expansion
 *  spawns nothing (the prefab still does not expand), so the caller reports it. */
async function reexpandEntryPlaceholder(id: number): Promise<void> {
  const world = getCurrentWorld();
  const handle = findEntity(id);
  const ref = unresolvedRefOf(handle);
  const eaMeta = getTraitByName('EntityAttributes');
  if (!handle || !ref || ref.kind !== 'entry' || !eaMeta) return;
  const all = getAllEntities();
  const info = all.find((e) => e.id === id)!;
  const live = handle.get(eaMeta.trait) as { guid?: string; sortOrder?: number; isActive?: boolean; editorFolder?: string; sourceScene?: string };
  const guid = live.guid;
  if (!guid) return;
  const placement: Record<string, unknown> = {};
  const parentGuid = info.parentId ? all.find((e) => e.id === info.parentId)?.guid : undefined;
  if (parentGuid) placement.parentId = parentGuid;
  if (live.editorFolder) placement.editorFolder = live.editorFolder;
  const entry = asSceneEntry('entry', ref.record, ref.source, { name: info.name, guid, placement, order: { sortOrder: live.sortOrder ?? 0, isActive: live.isActive ?? true } });
  const doc = getCachedPrefabSync(ref.source);
  if (!doc) return;
  await preloadNestedPrefabs(doc);
  if (getCurrentWorld() !== world || findEntity(id) !== handle) return;
  const children = all.filter((e) => e.parentId === id).map((e) => e.id);
  // Its guid is the new root's: the placeholder goes first, or the load's own pass-1 entity collides with it.
  destroyEntity(handle, world);
  const read = getCachedPrefabSync as ExpansionReader;
  await loadSceneFile({ id: 'reimport', version: SCENE_FORMAT_VERSION, name: '', resources: [], entities: [entry] } as unknown as SceneData, {
    world,
    clearMarks: false,
    scenePath: live.sourceScene || openScenePath() || undefined,
    loadModels: false,
    fetchPrefab: async (r: string) => (getCachedPrefab(r) as object | undefined) ?? (read(r) as object | null) ?? null,
    onInstantiatePrefab: async (source, parentId, rootTf, _old, rootExtraTraits, overrides, structure, nestedOverrides, rootGuid, rootEditorFolder, nestedStructure) => {
      const cached = read(source);
      if (!cached) return undefined;
      const rootId = instantiatePrefabIntoWorld(world, cached as never, parentId, rootTf, source, overrides, structure, undefined, nestedOverrides, nestedStructure, { read });
      const root = rootId ? findEntity(rootId) : undefined;
      if (!root) return undefined;
      if (rootGuid || rootEditorFolder) root.set(eaMeta.trait, { ...(root.get(eaMeta.trait) as object), ...(rootGuid ? { guid: rootGuid } : {}), ...(rootEditorFolder ? { editorFolder: rootEditorFolder } : {}) });
      for (const [name, data] of Object.entries(rootExtraTraits ?? {})) {
        const meta = getTraitByName(name);
        if (!meta) continue;
        const isTag = meta.category === 'tag' || data === true;
        if (root.has(meta.trait)) { if (!isTag) root.set(meta.trait, data as Record<string, unknown>); }
        else root.add((isTag ? (meta.trait as () => unknown)() : (meta.trait as (d: Record<string, unknown>) => unknown)(data as Record<string, unknown>)) as never);
      }
      return rootId;
    },
    onDeletePlaceholder: (pid: number) => { const e = findEntity(pid); if (e) destroyEntity(e, world); },
  });
  const now = getAllEntities();
  const newRoot = now.find((e) => e.guid === guid && !unresolvedRefOf(findEntity(e.id)));
  if (newRoot) {
    // A base scene's instance: its subtree keeps the scene that owns it, as a rebuild stamps it — the INSTANCE's subtree,
    // taken before the placeholder's own children join it (they keep their own scene). Not "entities that are new": koota
    // recycles ids, so an id diff misses members (R1 review).
    if (live.sourceScene) for (const id of subtreeIds(now, newRoot.id)) writeTraitField(id, eaMeta, 'sourceScene', live.sourceScene);
    for (const c of children) if (findEntity(c)) writeTraitField(c, eaMeta, 'parentId', newRoot.id);
  }
  markStructureDirty();
  markUIDirty();
}

/** What an OUTSIDE change to prefabs the open scene uses does (#1873 R1, owner ruling 2026-09-30: the Unity way, reversing
 *  #1164's disk-wins for prefab changes): re-import them in place, keeping the scene's unsaved edits, its dirty flag and
 *  its undo stack. What the in-place path cannot reach (a frame left stale, a placeholder it could not re-expand) is
 *  reloaded from disk only over a CLEAN scene, where a reload loses nothing; over unsaved work it is reported, and the
 *  reload is left to the user. `needsReload` asks the caller for that reload. */
export async function reimportOutsidePrefabChanges(paths: readonly string[]): Promise<{ report: PrefabReimportReport; needsReload: boolean }> {
  const report = await reimportPrefabsInPlace(paths);
  const leftover = report.notRebased.length + report.placeholders.length;
  return { report, needsReload: leftover > 0 && !worldHasUnsavedEdits() };
}
