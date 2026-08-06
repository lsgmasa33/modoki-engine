/** Prefab edit mode — open a prefab *in isolation* in the Scene viewport, edit
 *  its entities directly, and save back to the `.prefab.json`.
 *
 *  Implemented on top of the existing scene-swap machinery: we synthesize an
 *  in-memory scene that contains the prefab's entities expanded as PLAIN entities
 *  (no PrefabInstance trait — you're editing the template itself, not an instance)
 *  plus throwaway lights + an HDR environment so the prefab is visible. On save we
 *  serialize the prefab subtree back out, excluding the scaffold entities. */

import type { PrefabFile } from './prefab';
import { serializePrefab, writePrefabFile, setPrefabCache, getCachedPrefabSync, preloadNestedPrefabs } from './prefab';
import { collectResourceRefs, setCurrentScenePath, setCurrentBaseScene, getCurrentScenePath, saveScene, loadScene, type SerializedEntity } from './serialize';
import { swapHistory } from '../undo/undoManager';
import { sceneManager } from '../../runtime/scene/SceneManager';
import type { SceneData, SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getGuidForPath, resolveRef } from '../../runtime/loaders/assetManifest';

/** Sentinel guid stamped on the prefab root in the synthetic edit scene so the
 *  save path can locate it after the loader reassigns ECS ids. Lives only in the
 *  throwaway edit world; serializePrefab clears guids in the written file. */
export const PREFAB_EDIT_ROOT_GUID = '__prefab_edit_root__';
/** Guid prefix stamped on EVERY member of the synthetic edit scene, carrying that member's
 *  ORIGINAL localId (`__prefab_edit_local__7`).
 *
 *  Why a sentinel guid and not the entity id: the loader reassigns ECS ids densely, so the
 *  file's numbering is already lost by the time the edit world exists (measured — sling's
 *  FieldCorner has `drip` at localId 4 and it loads as ecsId 2). localIds are the address
 *  space a SCENE's prefab-instance `overrides` are keyed in, so letting a re-save renumber
 *  them silently drops those overrides. Riding on `guid` is safe because serializePrefab
 *  CLEARS EntityAttributes.guid on every row it writes — a template carries no per-instance
 *  identity — so the sentinel can never reach the file. */
export const PREFAB_EDIT_LOCAL_GUID_PREFIX = '__prefab_edit_local__';
/** Default HDR for the edit-mode environment (wooden_motel_2k — already in the
 *  asset manifest). Purely scaffolding; never written into the prefab. */
export const PREFAB_EDIT_HDR_GUID = '984275f1-3ebd-4848-927f-012595c76500';
/** Path prefix of the synthetic in-memory scene used for prefab-edit mode. The
 *  live scene being one of these is the ground truth for "am I editing a prefab". */
export const PREFAB_EDIT_SCENE_PREFIX = '/__prefab-edit__/';
/** Scaffold entity ids — far above any prefab localId so they never collide. */
const SCAFFOLD_BASE = 1_000_000;
/** Name prefix marking transient edit-mode scaffolding (lights + HDR). */
export const SCAFFOLD_PREFIX = '__PrefabEdit';

const scaffoldEntities = (): SceneEntityEntry[] => [
  {
    id: SCAFFOLD_BASE + 1,
    name: `${SCAFFOLD_PREFIX}KeyLight`,
    traits: {
      Transform: { x: 5, y: 10, z: 5, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}KeyLight`, isActive: true, sortOrder: 70, parentId: 0, layer: '3d', guid: '' },
      Light: { lightType: 'directional', color: 0xffffff, intensity: 3, targetX: 0, targetY: 0, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
    },
  },
  {
    id: SCAFFOLD_BASE + 2,
    name: `${SCAFFOLD_PREFIX}Ambient`,
    traits: {
      Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}Ambient`, isActive: true, sortOrder: 50, parentId: 0, layer: '3d', guid: '' },
      Light: { lightType: 'ambient', color: 0xffffff, intensity: 1.2, targetX: 0, targetY: 0, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
    },
  },
  // The HDR is purely lighting scaffolding (IBL). Only include it when the guid
  // actually resolves in THIS project's asset manifest — the engine can't assume any
  // specific project ships it, and an unresolvable hdrPath logs a "[MeshCache] Unknown
  // asset guid" warning every time prefab-edit opens. KeyLight + Ambient above still
  // light the preview when the HDR is absent.
  ...(resolveRef(PREFAB_EDIT_HDR_GUID) ? [{
    id: SCAFFOLD_BASE + 3,
    name: `${SCAFFOLD_PREFIX}HDR`,
    traits: {
      EntityAttributes: { name: `${SCAFFOLD_PREFIX}HDR`, isActive: true, sortOrder: 30, parentId: 0, layer: '', guid: '' },
      Environment: { hdrPath: PREFAB_EDIT_HDR_GUID, intensity: 1, showAsBackground: false, backgroundIntensity: 1, backgroundBlurriness: 0 },
    },
  }] : []) as SceneEntityEntry[],
];

/** Build a synthetic scene that renders `prefab` in isolation. Prefab entities
 *  become plain scene entities (localId → entity id; parentId is already a
 *  localId). Nested-prefab rows (phase 3) keep their `prefab`/override fields so
 *  the loader expands them as nested instances. */
export function buildPrefabEditScene(prefab: PrefabFile): SceneData {
  const entities: SceneEntityEntry[] = prefab.entities.map((pe) => {
    const traits: Record<string, Record<string, unknown> | boolean> = { ...pe.traits };
    // Stamp the root so save can find it after id reassignment, and EVERY member with its
    // original localId so the save can put it back (see PREFAB_EDIT_LOCAL_GUID_PREFIX). The
    // root carries the root sentinel — findPrefabEditRoot keys off it — and its localId comes
    // from `rootLocalId`, which the save reads back the same way as any other member.
    {
      const ea = (typeof traits.EntityAttributes === 'object' ? traits.EntityAttributes : {}) as Record<string, unknown>;
      traits.EntityAttributes = {
        ...ea,
        guid: pe.localId === prefab.rootLocalId
          ? PREFAB_EDIT_ROOT_GUID
          : `${PREFAB_EDIT_LOCAL_GUID_PREFIX}${pe.localId}`,
      };
    }
    // Forward nested-instance rows (a child prefab reference + its diffs) so the
    // loader expands them as nested instances — you edit the child via its own
    // edit session, not inline here.
    return {
      id: pe.localId, name: pe.name, traits,
      prefab: pe.prefab, overrides: pe.overrides,
      added: pe.added, removed: pe.removed, removedTraits: pe.removedTraits,
    };
  });
  entities.push(...scaffoldEntities());
  // collectResourceRefs takes SerializedEntity[]; SceneEntityEntry is shape-compatible.
  const resources = collectResourceRefs(entities as unknown as SerializedEntity[]);
  return { version: SCENE_FORMAT_VERSION, resources, entities };
}

/** Open `asset` (a prefab) for isolated editing. Remembers the current scene so
 *  exitPrefabEdit can restore it. */
export async function openPrefabForEditing(asset: { path: string; name: string }): Promise<void> {
  let prefab: PrefabFile;
  try {
    const res = await fetch(asset.path);
    if (!res.ok) { console.error(`[PrefabEdit] failed to fetch ${asset.path}`); return; }
    prefab = await res.json();
  } catch (e) {
    console.error('[PrefabEdit] fetch failed:', e);
    return;
  }
  const guid = prefab.id ?? getGuidForPath(asset.path) ?? asset.path;
  // Seed the editor prefab cache so override/apply paths resolve without a refetch,
  // and preload any nested children into the SAME (editor) cache — serializePrefab's
  // sync nested-instance detection reads it, so without this a nested instance would
  // flatten on save instead of round-tripping as a reference row.
  setPrefabCache(guid, prefab);
  await preloadNestedPrefabs(prefab);

  // Entering prefab-edit SWAPS the live world, and exitPrefabEdit reloads the return
  // scene FROM DISK (so its instances re-expand from the just-edited prefab — an
  // in-memory snapshot would defeat that purpose). Any unsaved edits in the current
  // scene would therefore be lost on return — most visibly the in-memory
  // PrefabInstance tags a just-created prefab applied to the live tree. Persist them
  // first so the round trip is non-destructive. Skip when there's no real scene file
  // to write to — an unsaved new scene, or already inside prefab-edit opening a
  // NESTED prefab (both have a null current path) — which would pop a Save-As picker.
  if (getCurrentScenePath()) await saveScene();

  const returnScene = sceneManager.getCurrent()?.path ?? null;
  const sceneData = buildPrefabEditScene(prefab);
  try {
    await sceneManager.loadScene(`${PREFAB_EDIT_SCENE_PREFIX}${guid}`, { preloaded: sceneData });
  } catch (e) {
    console.error('[PrefabEdit] failed to load edit scene:', e);
    return;
  }
  setCurrentScenePath(null); // normal scene-save must not target a real file
  setCurrentBaseScene(undefined); // the prefab-edit scene never carries a baseScene
  // Swap to this prefab-edit context's OWN undo stack (keyed by the synthetic
  // prefab-edit path). The main scene's stack is saved and restored when
  // exitPrefabEdit reloads the return scene (via the serialize.loadScene wrapper).
  swapHistory(`${PREFAB_EDIT_SCENE_PREFIX}${guid}`);
  useEditorStore.getState().openPrefabEditor({ path: asset.path, guid, name: prefab.name }, returnScene);
  console.log(`[PrefabEdit] editing "${prefab.name}"`);
}

/** Locate the live ECS id of the prefab root in the edit world (by sentinel guid). */
function findPrefabEditRoot(): number {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return 0;
  let rootId = 0;
  getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
    if ((ea as Record<string, unknown>).guid === PREFAB_EDIT_ROOT_GUID) rootId = entity.id();
  });
  return rootId;
}

/** Read the original localIds back out of the edit world: ecsId → the localId that member
 *  had in the file we opened. Members the user ADDED during the edit carry no sentinel and
 *  are simply absent, so serializePrefab allocates them fresh ids above the preserved ones.
 *  `rootLocalId` is passed separately because the root carries the root sentinel instead.
 *
 *  Exported for tests: this is the half of the localId-preservation fix that only a LIVE
 *  editor round-trip would otherwise exercise (buildPrefabEditScene writes the sentinels, a
 *  real scene load reassigns the ecs ids, and only then does this read them back). */
export function collectPreservedLocalIds(rootLocalId: number, rootEcsId: number): Map<number, number> {
  const map = new Map<number, number>();
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return map;
  if (rootEcsId) map.set(rootEcsId, rootLocalId);
  getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
    const guid = (ea as Record<string, unknown>).guid;
    if (typeof guid !== 'string' || !guid.startsWith(PREFAB_EDIT_LOCAL_GUID_PREFIX)) return;
    const localId = Number(guid.slice(PREFAB_EDIT_LOCAL_GUID_PREFIX.length));
    if (Number.isInteger(localId) && localId > 0) map.set(entity.id(), localId);
  });
  return map;
}

/** Save the in-progress prefab edit back to its `.prefab.json`. Serializes the
 *  prefab subtree (scaffold lights/HDR are excluded — they aren't descendants of
 *  the root). Returns true on success. */
export async function savePrefabEdit(): Promise<boolean> {
  const { editingPrefab } = useEditorStore.getState();
  if (!editingPrefab) return false;
  const rootId = findPrefabEditRoot();
  if (!rootId) { console.error('[PrefabEdit] cannot save — prefab root not found'); return false; }

  // The file as it was when we opened it (openPrefabForEditing seeds this cache). It supplies
  // the two things a re-save must NOT re-derive from the live world: the existing localId
  // numbering, and the asset's own name. Refuse rather than fall back to renumbering — a
  // silent renumber drops every localId-keyed override in every scene that instantiates this
  // prefab, which is precisely the damage this path exists to avoid.
  const previous = getCachedPrefabSync(editingPrefab.guid);
  if (!previous) {
    console.error(
      `[PrefabEdit] cannot save "${editingPrefab.name}" — the opened prefab is no longer in the ` +
      'editor cache, so its localId numbering cannot be preserved. Saving now would renumber ' +
      "members and break every scene override keyed to them. Re-open the prefab and try again.",
    );
    return false;
  }

  const prefab = serializePrefab(rootId, editingPrefab.guid, {
    preserveLocalIds: collectPreservedLocalIds(previous.rootLocalId, rootId),
    name: previous.name,
  });
  if (!prefab) { console.error('[PrefabEdit] serialize produced no prefab'); return false; }
  const ok = await writePrefabFile(editingPrefab.guid, prefab);
  if (!ok) return false;
  // Refresh the editor's prefab cache to the just-saved version AND invalidate the
  // runtime refcount cache, so reopening the return scene re-expands from the new file.
  setPrefabCache(editingPrefab.guid, prefab);
  console.log(`[PrefabEdit] saved "${prefab.name}" (${prefab.entities.length} entities)`);
  return true;
}

/** Leave prefab-edit mode: reload the scene the prefab was opened from — that
 *  re-instantiates every instance from the now-saved prefab file — then clear the
 *  edit-mode state. Falls back to the last-opened scene when there is no return
 *  path (entering prefab-edit from a project with no scene loaded).
 *
 *  Returns the scene path we returned to, or null when there was nothing to go
 *  back to (the store flag is cleared either way, so the editor is never left
 *  stuck in a prefab-edit mode with no prefab world). */
export async function exitPrefabEditing(): Promise<string | null> {
  const { prefabReturnScenePath, closePrefabEditor } = useEditorStore.getState();
  const target = prefabReturnScenePath
    ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('modoki-last-scene') : null);
  if (target) await loadScene(target);
  closePrefabEditor();
  return target;
}

/** True when the editor is currently in prefab-edit mode.
 *
 *  Ground truth is the LIVE scene being the synthetic prefab-edit world, not just
 *  the `editingPrefab` store flag — the flag can go stale if we return to a real
 *  scene without an explicit exit (e.g. a hot-reload-driven scene swap). A stale
 *  flag is dangerous: it routes Cmd+S to savePrefabEdit, which then can't find the
 *  prefab-edit root in the real world and errors ("prefab root not found"). When
 *  we detect the mismatch we self-heal by clearing the flag and report not-editing,
 *  so the save falls through to the normal scene save. */
export function isEditingPrefab(): boolean {
  if (useEditorStore.getState().editingPrefab === null) return false;
  const path = sceneManager.getCurrent()?.path ?? '';
  if (path.startsWith(PREFAB_EDIT_SCENE_PREFIX)) return true;
  useEditorStore.getState().closePrefabEditor(); // stale flag — clear it
  return false;
}

// Dev-only debug handle so tooling can drive prefab-edit mode without the UI.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __prefabEdit?: unknown }).__prefabEdit = { openPrefabForEditing, savePrefabEdit, exitPrefabEditing, isEditingPrefab };
}
