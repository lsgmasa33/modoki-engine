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
 *  depended on the discarded document refuses through its own precondition (the park landing's, `commitPrefabChanges`).
 *
 *  The caller asks whether the world may be rebuilt now (Play, a preview, a landing switch) and defers otherwise; this
 *  holds the world against a switch while it runs, as `rebaseStaleInstancesSoon` does. */

import { rowAt } from '../../runtime/core/prefabRowAt';
import { commitPrefabChanges } from './prefabCommit';
import { preloadNestedPrefabs, getCachedPrefabSync } from './prefabCache';
import { staleFrames, type StaleFrame } from './prefabFrames';
import { rebuildStaleFrames, preloadRebuildEntry } from './prefabRebuild';
import { placeholdersOf, resolvedRef } from './prefabUse';
import { beginWorldBoundOperation } from '../undo/undoManager';
import { getCurrentWorld, destroyEntity } from '../../runtime/core/ecs/world';
import { getAllEntities, markStructureDirty, findEntity, readTraitData, writeTraitField, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { worldHasUnsavedEdits } from './serialize';
import { type PrefabFile } from './prefab';
import { getCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { asSceneEntry } from '../../runtime/loaders/unresolvedPrefabRefs';
import { loadSceneFile, instantiatePrefabIntoWorld, type ExpansionReader, type SceneData } from '../../runtime/loaders/loadSceneFile';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { openScenePath } from '../../runtime/scene/openScenePath';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { isGuid } from '../../runtime/core/assetRefRules';
import { markUIDirty } from '../../runtime/core/uiDirty';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { staleAround } from '../../runtime/prefab/instanceStore';

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

/** Re-read each of `paths` (prefab files whose park was just discarded, or that changed on disk) into both caches and
 *  rebase every live instance of them onto it, in the world as it stands — the prefab step's `'adopt'` landing (#1880 W4,
 *  `commitPrefabChanges`), then the placeholders a put-back can re-expand. See the module comment. `rebase: false`: the
 *  caches only — the world is a prefab-edit template or no scene is open, and nothing there is rebuilt from the file. */
async function reimportPrefabsInPlaceUnmarked(paths: readonly string[], opts: { rebase?: boolean } = {}): Promise<PrefabReimportReport> {
  const release = beginWorldBoundOperation();
  try {
    const world = getCurrentWorld();
    const res = await commitPrefabChanges(paths.map((path) => ({ source: path, doc: null, expected: null, land: 'adopt' as const })), { rebase: opts.rebase });
    const adopted = res.adopted ?? { reimported: [], failed: paths.map((path) => ({ path, reason: res.error ?? 'it was not re-imported' })), deleted: [], unused: [], sources: [] };
    const { sources: seated, ...rest } = adopted;
    const report: PrefabReimportReport = { ...rest, notRebased: [], placeholders: [] };
    const sources = new Set(seated);
    // A world replaced during the reads loaded its frames from these files itself: nothing here is left to rebase.
    if (opts.rebase === false || !sources.size || getCurrentWorld() !== world) return report;
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
      if (rec?.unexpanded?.some((lid) => { const r = rowAt(rows, lid); return !!r?.prefab && names(r.prefab); })) roots.add(entity.id());
    });
    const frames: StaleFrame[] = [];
    for (const root of roots) {
      const handle = findEntity(root);
      const rec = handle ? frameRootDoc(world, handle) : undefined;
      if (!rec) continue;
      await preloadRebuildEntry(root);
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
  await loadSceneFile({ id: 'reimport', version: SCENE_FORMAT_VERSION, name: '', resources: [], entities: [entry] } as unknown as SceneData, {
    world,
    clearMarks: false,
    scenePath: live.sourceScene || openScenePath() || undefined,
    loadModels: false,
    // The editor's cache, which holds a document edited and not yet saved. The load adds the world's copies of missing
    // prefabs to it and expands AND settles with that one reader (#1934 S1): expanded without the copies, a nested frame
    // a copy backs stayed unexpanded while the settle called its rows backed, and the next save dropped them.
    read: getCachedPrefabSync as ExpansionReader,
    // The copies of the scene that holds the placeholder (a base's own guid, or the primary's), as its reload reads them.
    copiesOf: copiesKeyOf(live.sourceScene),
    fetchPrefab: async (r: string) => (getCachedPrefab(r) as object | undefined) ?? (getCachedPrefabSync(r) as object | null) ?? null,
    onInstantiatePrefab: async (source, parentId, rootTf, _old, rootExtraTraits, overrides, structure, nestedOverrides, rootGuid, rootEditorFolder, nestedStructure, load) => {
      const read = load?.read;
      const cached = read?.(source);
      if (!cached) return undefined;
      const rootId = instantiatePrefabIntoWorld(world, cached as never, parentId, rootTf, source, overrides, structure, undefined, nestedOverrides, nestedStructure, { read, frame: load?.frame });
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

/** The key a scene's copies are held under (`loadSceneFile`'s `copiesOf`): a base scene's guid (its entities carry it as
 *  `sourceScene`), else the primary's loaded guid; '' for a file without one. */
function copiesKeyOf(sourceScene: string | undefined): string {
  if (sourceScene) return isGuid(sourceScene) ? sourceScene : '';
  for (const e of sceneManager.getLoadedScenes().values()) if (e.role === 'primary') return isGuid(e.guid) ? e.guid : '';
  return '';
}

/** What an OUTSIDE change to prefabs the open scene uses does (#1873 R1, owner ruling 2026-09-30: the Unity way, reversing
 *  #1164's disk-wins for prefab changes): re-import them in place, keeping the scene's unsaved edits, its dirty flag and
 *  its undo stack. What the in-place path cannot reach (a frame left stale, a placeholder it could not re-expand) is
 *  reloaded from disk only over a CLEAN scene, where a reload loses nothing; over unsaved work it is reported, and the
 *  reload is left to the user. `needsReload` asks the caller for that reload. */
async function reimportOutsidePrefabChangesUnmarked(paths: readonly string[], opts: { rebase?: boolean } = {}): Promise<{ report: PrefabReimportReport; needsReload: boolean }> {
  const report = await reimportPrefabsInPlace(paths, opts);
  const leftover = report.notRebased.length + report.placeholders.length;
  return { report, needsReload: leftover > 0 && !worldHasUnsavedEdits() };
}

// #2001 S4 (#2014): these ops do not maintain the instance list yet (S7 moves them onto records), so each marks the
// store stale once it finishes — wrapped here, at the export, so no return path can skip it (`instanceStore.ts`).
export const reimportOutsidePrefabChanges = staleAround('outsideEdit', reimportOutsidePrefabChangesUnmarked);
export const reimportPrefabsInPlace = staleAround('outsideEdit', reimportPrefabsInPlaceUnmarked);
