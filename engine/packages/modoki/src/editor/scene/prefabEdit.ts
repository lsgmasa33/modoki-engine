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
import { collectResourceRefs, setCurrentScenePath, setCurrentBaseScene, getCurrentScenePath, saveScene, loadScene, markSceneSaved, type SerializedEntity } from './serialize';
import { swapHistory } from '../undo/undoManager';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } from './prefabEditWorld';
import type { SceneData, SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getRunMode } from '../../runtime/core/playState';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getGuidForPath, resolveRef } from '../../runtime/loaders/assetManifest';
import { parseAssetJson } from '../../runtime/loaders/assetFetch';

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
export { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } from './prefabEditWorld';
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
/** Scaffold ids for the 2D host, above the 3D ones so the two sets never collide. */
const SCAFFOLD_CANVAS_ID = SCAFFOLD_BASE + 4;
const SCAFFOLD_STAGE_ID = SCAFFOLD_BASE + 5;

/**
 * Does this prefab draw in the 2D layer? `Renderable2D`/`Text2D` are rendered by a `Canvas2D` HOST
 * and by nothing else, so without one they are perfectly correct in the ECS and invisible on screen.
 */
function hasContent2D(prefab: PrefabFile): boolean {
  return prefab.entities.some((e) => e.traits && ('Renderable2D' in e.traits || 'Text2D' in e.traits));
}

/**
 * The 2D scaffolding: a full-screen `Canvas2D` host plus a centring stage, injected ONLY for a prefab
 * that actually draws in 2D (the 3D lights and HDR above are the mirror image of this).
 *
 * ⚠️ **Without this, a 2D prefab opens completely blank** — every entity present, every trait right,
 * nothing drawn, because `Renderable2D` is only ever rendered by a `Canvas2D` host and edit mode
 * scaffolded a 3D world only. Reported against Court's tray-badge prefab, and it would hit any 2D
 * prefab in any project.
 *
 * **Why a STAGE and not just the canvas.** A `Canvas2D`'s design space has its origin at the TOP-LEFT,
 * while a prefab is authored around its own origin — so parenting the root straight to the canvas puts
 * it in the corner with three quadrants off-screen. The stage is a plain offset entity that moves the
 * content's centre to the canvas's centre, which keeps the prefab's authored transforms untouched.
 * Nudging the ROOT's own Transform instead would be a preview that edits the asset.
 *
 * **Why the reference resolution is derived and not the 1080x1920 default.** A badge ~200 design px
 * across inside a 1080-wide box is 18% of the view — technically visible, useless to tune. Framing the
 * canvas to the content is the 2D equivalent of the 3D preview pointing its camera at the model.
 *
 * ⚠️ **Re-parenting the root is SAFE, and it is worth knowing why rather than trusting it.**
 * `serializePrefab` remaps every `parentId` through `ecsToLocal.get(id) || 0`; a scaffold entity is not
 * part of the prefab, so it is absent from that map and the root's parent normalises back to **0** on
 * save. The stage therefore cannot leak into the file.
 */
function scaffold2DEntities(prefab: PrefabFile): SceneEntityEntry[] {
  // Content bounds in the prefab's own space. `Renderable2D.width`/`height` are HALF-extents for
  // primitives; a Text2D has no measurable extent headlessly, so its font size stands in for one.
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const e of prefab.entities) {
    const t = (e.traits?.Transform ?? {}) as Record<string, number>;
    const r2 = e.traits?.Renderable2D as Record<string, number> | undefined;
    const tx = e.traits?.Text2D as Record<string, number> | undefined;
    if (!r2 && !tx) continue;
    const x = t.x ?? 0, y = t.y ?? 0;
    const hw = r2 ? (r2.width ?? 0) : (tx?.fontSize ?? 0) / 2;
    const hh = r2 ? (r2.height ?? 0) : (tx?.fontSize ?? 0) / 2;
    minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
    minY = Math.min(minY, y - hh); maxY = Math.max(maxY, y + hh);
  }
  // Pad so the content does not touch the edges, and floor it so a tiny or empty prefab still gets a
  // sane box instead of a degenerate one (a zero reference resolution divides by zero downstream).
  const PAD = 1.6, FLOOR = 64;
  const w = Math.max(maxX - minX, FLOOR), h = Math.max(maxY - minY, FLOOR);
  const refW = Math.round(w * PAD), refH = Math.round(h * PAD);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return [
    {
      id: SCAFFOLD_CANVAS_ID,
      name: `${SCAFFOLD_PREFIX}Canvas2D`,
      traits: {
        RenderableUI: true,
        EntityAttributes: { name: `${SCAFFOLD_PREFIX}Canvas2D`, isActive: true, sortOrder: 10, parentId: 0, layer: 'ui', guid: '' },
        UIElement: { width: 100, height: 100 },
        UIAnchor: {},
        // `contain` so the whole framed box is visible whatever shape the panel is — cropping the
        // thing you opened the editor to look at would defeat the point.
        Canvas2D: { referenceWidth: refW, referenceHeight: refH, scaleMode: 'contain' },
      },
    },
    {
      id: SCAFFOLD_STAGE_ID,
      name: `${SCAFFOLD_PREFIX}Stage`,
      traits: {
        Transform: { x: refW / 2 - cx, y: refH / 2 - cy, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        EntityAttributes: { name: `${SCAFFOLD_PREFIX}Stage`, isActive: true, sortOrder: 11, parentId: SCAFFOLD_CANVAS_ID, layer: '2d', guid: '' },
      },
    },
  ];
}

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
  // 2D content needs a host to render into; 3D content does not. Injected only when the prefab
  // actually draws in 2D, so a 3D prefab's world is byte-for-byte what it was before.
  if (hasContent2D(prefab)) {
    entities.push(...scaffold2DEntities(prefab));
    // Re-parent the ROOT into the centring stage. Only the root: its descendants keep their authored
    // parents, so the subtree's internal layout is untouched.
    const root = entities.find((e) => e.id === prefab.rootLocalId);
    const ea = root && typeof root.traits.EntityAttributes === 'object'
      ? root.traits.EntityAttributes as Record<string, unknown> : undefined;
    if (ea) ea.parentId = SCAFFOLD_STAGE_ID;
  }
  // collectResourceRefs takes SerializedEntity[]; SceneEntityEntry is shape-compatible.
  const resources = collectResourceRefs(entities as unknown as SerializedEntity[]);
  return { version: SCENE_FORMAT_VERSION, resources, entities };
}

/**
 * Which scene should `exitPrefabEditing` go back to, given the currently-loaded scene path and the
 * return path already recorded by an outer prefab-edit session.
 *
 * ⚠️ **The current scene is NOT always a real scene.** Opening a prefab from INSIDE prefab-edit —
 * a nested prefab, or simply double-clicking another prefab in the Assets panel — leaves
 * `sceneManager.getCurrent()?.path` holding the SYNTHETIC `/__prefab-edit__/<guid>`. Recording that
 * as the return scene made exit try to LOAD it, which 404s (`no asset at /__prefab-edit__/… — the
 * dev server answered with index.html`) and strands the editor in the prefab world with no scene
 * path and no way back but opening one by hand. Observed, not theorised.
 *
 * The fix is to prefer the return path the OUTER session already recorded, so a chain of prefab
 * opens still lands on the real scene the chain started from. Note `openPrefabForEditing` already
 * got this distinction right one line above, for the save guard, by asking `getCurrentScenePath()`
 * (null in prefab-edit) instead — two sources for one question, disagreeing.
 */
export function resolveReturnScene(currentPath: string | null, recordedReturn: string | null): string | null {
  // Both candidates are filtered, not just the first: an older session could already have banked a
  // synthetic path in the store, and handing it back would recreate the dead end this exists to
  // close. Null is a SAFE answer here (exit simply clears the flag); a synthetic path is not.
  return [currentPath, recordedReturn]
    .find((p): p is string => !!p && !p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) ?? null;
}

/** Open `asset` (a prefab) for isolated editing. Remembers the current scene so
 *  exitPrefabEdit can restore it. */
export async function openPrefabForEditing(asset: { path: string; name: string }): Promise<void> {
  let prefab: PrefabFile;
  try {
    const res = await fetch(asset.path);
    prefab = await parseAssetJson(res, asset.path) as PrefabFile;
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

  const returnScene = resolveReturnScene(
    sceneManager.getCurrent()?.path ?? null,
    useEditorStore.getState().prefabReturnScenePath ?? null,
  );
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
  // TRANSIENCE guard, the prefab twin of `saveScene`'s (serialize.ts). Only ever WRITE authored
  // data: while scrub/preview/play is live the world holds preview mutations (a posed skeleton, a
  // control-spawned prefab, physics-settled positions), and this serializes the prefab subtree
  // straight out of that world — so a save now bakes them into the .prefab.json, and every scene
  // instantiating it inherits the pose.
  //
  // It lives HERE, not in the callers, for the reason the same guard lives inside `saveScene`:
  // every caller inherits it and none can forget. It was in exactly one caller — the Cmd+S
  // handler's `!canEdit()` early return — which meant the AGENT path (`prefab edit-save`) never
  // had it at all, and deleting that early return in #259 (so parked asset docs could still flush
  // during preview) removed the human's too. One guard, both paths.
  if (getRunMode() !== 'stopped') {
    console.error(
      `[PrefabEdit] cannot save "${editingPrefab.name}" — run-mode is '${getRunMode()}', not 'stopped'. ` +
      'Saving now would bake preview/play mutations (a posed rig, a spawned prefab) into the prefab ' +
      'file, and every scene that instantiates it would inherit them. Exit preview / stop first.',
    );
    return false;
  }
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
  // ⚠️ Re-baseline the dirty tracker. Without this the prefab-edit world stayed "unsaved" FOREVER
  // after a successful save: `hasUnsavedChanges()` compares the live edit version against
  // `_savedAtEditVersion`, and every other write path (`saveScene`, `loadScene`, `newScene`) moves
  // that baseline while this one did not.
  //
  // Not cosmetic. `edit-open` and `load_scene` both REFUSE on unsaved changes, so a single prefab
  // save wedged the editor into needing `force` to go anywhere; the dirty indicator never cleared,
  // which teaches the human to ignore it; and an agent reading `unsavedChanges` concluded the file
  // was stale when it was byte-identical to the live world. Reported by the owner — "I think I
  // saved it before you said it's stale, maybe we have a bug" — and confirmed by diffing the file
  // against the world rather than by trusting the flag, which is the only way to see it.
  markSceneSaved();
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
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('modoki-last-scene') : null;
  // ⚠️ A synthetic `/__prefab-edit__/…` path is not a FILE — loading it 404s ("no asset at … the
  // dev server answered with index.html") and strands the editor in the prefab world with no scene.
  // `resolveReturnScene` keeps one out of the store in the first place; this skips it whichever
  // candidate carries it, so the fallback can never reintroduce the same dead end.
  const target = [prefabReturnScenePath, stored]
    .find((p): p is string => !!p && !p.startsWith(PREFAB_EDIT_SCENE_PREFIX)) ?? null;
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
  if (isPrefabEditWorld()) return true;
  useEditorStore.getState().closePrefabEditor(); // stale flag — clear it
  return false;
}

// Dev-only debug handle so tooling can drive prefab-edit mode without the UI.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __prefabEdit?: unknown }).__prefabEdit = { openPrefabForEditing, savePrefabEdit, exitPrefabEditing, isEditingPrefab };
}
