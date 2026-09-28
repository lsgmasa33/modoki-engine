/** Undo/redo for "Apply to Prefab".
 *
 *  Apply mutates TWO things, not one:
 *   1. the prefab FILE — the shared base every instance inherits from; and
 *   2. the live SCENE — every instance is re-instantiated (its override relationship
 *      to the base changes), and a promoted "added" child is deleted from the scene.
 *
 *  So a value-only "swap the prefab base back" undo is WRONG: after applying field V,
 *  the instance you edited now MATCHES the new base, while other instances that merely
 *  inherited it also show V. Reverting the base alone can't tell them apart — the
 *  edited instance must return to an *override* V while the inheritors return to the
 *  old base. The only record that distinguishes them is the pre-apply scene state.
 *
 *  Therefore undo is "record before/after of BOTH, reverse it": snapshot the prefab
 *  file and the serialized scene before and after, and restore by writing the prefab
 *  snapshot back and rebuilding the scene from its snapshot (which re-instantiates
 *  every instance exactly, preserving each one's overrides).
 *
 *  The snapshot is reloaded under the key of the world the undo belongs to when it RUNS: the scene's
 *  path; the prefab editor's synthetic path, since that world has no scene file (#1573); or '' for an
 *  untitled scene, as Stop reloads one (#1575). Same reason, same rule in each: a rebase alone is not a
 *  substitute, and neither is a rebuild from the prefab's document. */

import { pushAction, beginWorldBoundOperation, isWorldSwitchInProgress, type UndoAction } from './undoManager';
import { UndoRefusedError, reportUndoFailure } from './undoFailure';
import { commitPrefabWrite } from '../scene/prefabCommit';
import { sha256OfWritten } from '../utils/contentHash';
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { sceneManager } from '../../runtime/scene/SceneManager';
import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { serializeScene, saveScene, lastWrittenSceneBytes, getCurrentScenePath, isSceneLoadSwapping } from '../scene/serialize';
import { withAdoption, adoptionsSettled } from '../scene/sceneAdoption';
import {
  applyToPrefabSelective, guidForEntityId, entityIdForGuid,
  resolveInstanceContext, getPrefabSource, captureInstanceOverrides, captureInstanceStructure,
  rebuildInstance, preloadNestedPrefabsForSubtree, refreshBaseInstances, rebaseStaleInstances, getCachedPrefabSync,
  type ApplyResult, type PrefabFile,
} from '../scene/prefab';
import { rewriteNodeMoves } from '../../runtime/core/ecs/identityParents';
import { rewriteFrameMoves } from '../../runtime/loaders/memberPaths';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { useEditorStore } from '../store/editorStore';
import { repairPrefabMemberPaths } from '../backend/editorBackend';
import { resolveAffectedScenes } from '../scene/sceneDirty';
import { ensureGuid } from './entityRef';
import { PREFAB_EDIT_SCENE_PREFIX } from '../scene/prefabEditWorld';
import { currentSceneKey } from '../scene/authoredSnapshot';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The scene half of an Apply's undo and redo (#1695). The forward Apply saves the scene only when a promotion
 *  restructured it, and then the undo and redo save it too — but only while the file holds what the EDITOR last wrote
 *  there (`lastWrittenSceneBytes`, `ifMatch`), like the prefab half (#1664). The scene file is reachable from outside while
 *  its history is parked (leave the scene, change it with `modoki_mutate_scene`, a hand edit or a `git pull`, come back,
 *  Cmd+Z), and an unconditional save wrote the in-memory snapshot over that change for good. Keyed on the editor's LAST
 *  write, not on the other half's: the user's own Cmd+S in between is not an outside change (close-out review). Without
 *  a promotion nothing is saved: the undo dirties the scene as every undo does, and Unity does the same. */
/** Restore a (prefab, scene) snapshot: install the prefab base, then rebuild the live
 *  world from the scene snapshot (runtime loadScene — no history clear) and persist it when `sceneSave` says the
 *  Apply did. Re-selects the previously-inspected entity by guid (ids change on rebuild). Resolves `false` when the
 *  world it belongs to is no longer live, having restored the prefab file only.
 *
 *  ONE `commitPrefabWrite` (#1692): the write goes only over `expected`, the other side of the Apply (#1664), and
 *  THROWS a refusal before anything else runs when it does not land; the world reload below is its rebuild.
 *
 *  The snapshot goes back to the world this undo stack belongs to NOW — `currentSceneKey()`, the key Stop restores
 *  under — not to a path captured at the Apply (#1575). An untitled world has no path at all, and one saved with
 *  Save As since keeps its history under a path the Apply never saw. */
async function restoreSnapshot(
  source: string,
  prefab: PrefabFile,
  /** The document the file must hold now — the other side of the Apply — or the write refuses and this throws, before
   *  anything else here runs (#1664). */
  expected: PrefabFile,
  scene: SceneData,
  selGuid: string,
  /** The prefab document the files on disk were last repaired for, when the apply moved member paths
   *  (#1437): they are repaired from it to `prefab`, the way the apply repaired them the other way. */
  repairFrom: PrefabFile | undefined,
  label: string,
  direction: 'Undo' | 'Redo',
  /** The Apply saved the scene, so this side saves it too (#1695). */
  sceneWasSaved: boolean,
): Promise<boolean> {
  // Read before the first await: the file write and the member-path repair below are a window a scene load, an
  // Exit or a Create Scene can land in, and the snapshot must not be loaded over whatever world that put in.
  const key = currentSceneKey();
  const world = getCurrentWorld();
  let restored = false;
  const where = isGuid(source) ? (resolveRef(source) || source) : source;
  // A copy: the editor cache keeps what it is handed, and this entry replays `prefab` again on the next redo/undo.
  const committed = await commitPrefabWrite(source, clone(prefab), {
    expected,
    // The reload below rebases what it carries itself.
    rebase: false,
    rebuild: async () => {
      if (repairFrom && prefab.id) {
        // The live records of each template reference node's moves go back as the apply re-pointed them (#1564): the world
        // swap below CARRIES a Persistent or base root with its record whole, and the rebase then rebuilds it against
        // `prefab` — with the apply's paths, which name nothing there. Before the await, as the apply does it before its
        // refresh: nothing that rebuilds in the meantime can read the old paths.
        const id = prefab.id;
        const read = (doc: PrefabFile) => (g: string) => (g === id ? doc : getCachedPrefabSync(g));
        rewriteNodeMoves(getCurrentWorld(), (moved, src) => rewriteFrameMoves(moved, src, read(repairFrom), read(prefab)));
        await repairPrefabMemberPaths(prefab.id, repairFrom);
      }
      // Still THAT world? An Exit swaps a real scene in under the edit world's undo (#1573 close-out re-review), where
      // loading the synthetic world would leave it under a real path for `saveScene` to write into that file. Every
      // untitled world shares the key `null`, so a Create Scene there is told apart by the world itself (#1575). The
      // world is compared for EVERY key: a scene load swaps the world first and sets its path only in its tail, after
      // awaiting the scene managers, so for that window the key still reads as this scene's (#1575 close-out
      // re-review). And a load still in flight is not raced: loading this snapshot over it would leave its tail setting
      // the other scene's path and history over this world.
      // Since #1579 every user world switch waits for this step before it swaps, so these are defence in depth, for a
      // route that swaps through `sceneManager` directly. `isSceneLoadSwapping`, not `isSceneLoadInFlight`: the latter
      // also counts a load still WAITING for this very step, and skipping on it recreated the window #1579 closed.
      if (currentSceneKey() !== key || getCurrentWorld() !== world || isSceneLoadSwapping() || sceneManager.getNext() !== null) {
        console.warn(`[ApplyPrefab] ${key ?? 'the untitled scene'} is no longer the live world; restored the prefab file only`);
        return;
      }
      // The world call is one pending adoption (#1698) — registered only around it, AFTER the prefab file write (this is
      // the write's rebuild step), so a prefab write that waits for adoptions to settle cannot wait on this step's own. Its
      // world is adopted only while it is still the one on screen; otherwise the switch that replaced it adopts its own,
      // and this step restored the file only.
      const adopted = await withAdoption('prefab-undo-restore', async (adoption) => {
        if (key === null) {
          // An untitled world: reloaded under '' as Stop reloads it (`restoreAuthoredSnapshot`) — no file is read and none
          // is marked loaded, and the editor's scene path stays null, so Save still asks where. Not saved: there is no
          // file, and the undo itself dirties the scene. Not rebuilt through `replaceWorldContent`, whose populate is
          // synchronous and cannot instantiate a prefab (#1575). A restore under the same key: it writes nothing.
          const { world: w } = await sceneManager.loadScene('', { preloaded: clone(scene) });
          return adoption.restored(w);
        }
        if (key.startsWith(PREFAB_EDIT_SCENE_PREFIX)) {
          // The prefab-edit world has no scene file, so before #1573 the world stayed built from the applied document. It
          // is a scene loaded at a synthetic path, so the same snapshot restores it — with the live guids every other undo
          // entry addresses its entities by, which a rebuild from the edited prefab's document would re-mint (review of
          // the first #1573 fix). Not saved, and no scene path set: the apply never wrote the edited prefab, and that world
          // reaches its file through Save alone. A restore under the same key: it writes nothing, the edit session included.
          const { world: w } = await sceneManager.loadScene(key, { preloaded: clone(scene) });
          return adoption.restored(w);
        }
        // A3: sceneManager.loadScene({preloaded}) records the base ref internally, but the editor's own baseScene tracking
        // (re-emitted by serializeScene) is separate module state — re-synced with the path. No history write: this runs
        // INSIDE the undo history.
        const { world: w } = await sceneManager.loadScene(key, { preloaded: clone(scene) });
        return adoption.offer({ world: w, path: key, baseScene: 'loaded' });
      });
      if (!adopted) {
        console.warn(`[ApplyPrefab] ${key ?? 'the untitled scene'} was replaced while it was restored; restored the prefab file only`);
        return;
      }
      restored = true;
      // The load CARRIES `Persistent` roots flat, still built from the document being undone; rebuild them against the one
      // just restored before anything captures them — the save below included (#1483 review 3).
      await rebaseStaleInstances();
      // A scene file, when the Apply saved it: only over what the editor last wrote there (#1695).
      if (sceneWasSaved && key !== null && !key.startsWith(PREFAB_EDIT_SCENE_PREFIX)) await saveSceneOverOtherHalf(key, label, direction);
    },
  });
  if (!committed.ok) {
    throw committed.conflict
      ? new UndoRefusedError(
        `${where} changed on disk since the Apply (a later save of the prefab, another Apply, or an outside edit), so it was left as it is rather than overwritten.`,
        `the prefab changed on disk since the Apply, and was left as it is`,
      )
      : new UndoRefusedError(
        `${where} could not be written${committed.error ? ` (${committed.error})` : ''}, so the prefab and the scene were left as they are.`,
        `the prefab file could not be written (see console)`,
      );
  }
  // The world was replaced during the write (a swap that bypassed the #1579 barrier): the rebuild did not run, but the
  // files on disk were repaired for the apply's paths and must follow the prefab that is on disk now.
  if (committed.worldLeft && repairFrom && prefab.id) await repairPrefabMemberPaths(prefab.id, repairFrom);
  if (!restored) return false;
  const id = selGuid ? entityIdForGuid(selGuid) : 0;
  useEditorStore.getState().selectEntity(id || null);
  return true;
}

/** Save the restored scene only over what the editor last wrote there (#1695). A refusal leaves the file alone and the
 *  restored world unsaved — the world has already followed the step, so it is reported (#308), not thrown. */
async function saveSceneOverOtherHalf(path: string, label: string, direction: 'Undo' | 'Redo'): Promise<void> {
  const bytes = lastWrittenSceneBytes(path);
  if (bytes === undefined) {
    reportUndoFailure({ direction, label, detail: `${path} was not saved: the editor has no record of what it last wrote there, so it cannot tell an outside change from its own. The scene is restored in the editor and unsaved.` });
    return;
  }
  let ifMatch: string;
  try { ifMatch = await sha256OfWritten(bytes); } catch (e) {
    reportUndoFailure({ direction, label, detail: `${path} was not saved: the bytes it should hold could not be hashed (${e instanceof Error ? e.message : String(e)}). The scene is restored and unsaved.` });
    return;
  }
  const saved = await saveScene({ ifMatch, allowDialog: false });
  if (saved.saved) return;
  reportUndoFailure({
    direction, label, userFixable: saved.reason === 'conflict',
    detail: saved.reason === 'conflict'
      ? `${path} changed on disk since the editor last saved it (an outside edit, a scene tool, a git pull), so it was not overwritten. The scene is restored in the editor and unsaved; saving it will replace that change with this state.`
      : `${path} was not saved (${saved.reason}). The scene is restored in the editor and unsaved.`,
  });
}

/** A BASE scene's instance, as it stood on one side of the apply (#1431). `restoreSnapshot` rebuilds
 *  only the PRIMARY: a base loaded with it is CARRIED live across `loadScene`, so its instance
 *  would keep its post-apply state against the restored prefab — and since the base is dirty, Save
 *  All would then write that into the base file (a promoted added node was lost exactly so). The
 *  instance is rebuilt from this capture instead, the same way Revert's own undo rebuilds it. */
export interface BaseInstanceSide {
  rootGuid: string;
  prefab: PrefabFile;
  overrides: ReturnType<typeof captureInstanceOverrides>;
  structure: ReturnType<typeof captureInstanceStructure>;
}

export function captureSide(rootInstanceId: number, rootGuid: string, prefab: PrefabFile): BaseInstanceSide {
  return {
    rootGuid, prefab,
    overrides: captureInstanceOverrides(rootInstanceId, prefab),
    structure: captureInstanceStructure(rootInstanceId, prefab),
  };
}

/** After `restoreSnapshot`: rebuild the carried base instance to `side`. Its root guid survives
 *  every rebuild, so it is found by guid; one that is gone (the base was unloaded) is left alone. */
async function restoreBaseInstance(source: string, side: BaseInstanceSide | null): Promise<void> {
  if (!side) return;
  const id = side.rootGuid ? entityIdForGuid(side.rootGuid) : 0;
  if (!id) return;
  await preloadNestedPrefabsForSubtree(id);
  const newId = rebuildInstance(id, source, side.prefab, side.overrides, side.structure);
  useEditorStore.getState().selectEntity(newId);
}

/** After the prefab is swapped from `fromPrefab` to `toPrefab`: rebuild the applied base instance from its
 *  capture, THEN re-derive every other base instance of the prefab (#1431). In that order (#1483 review 3):
 *  the applied instance can sit INSIDE another base instance, whose refresh captures it through
 *  `captureNestedRef` against the cache — so it must already be built from `toPrefab`, or the enclosing
 *  one reads it as a stale nested frame and is skipped, keeping a member the restored prefab lost. The
 *  enclosing rebuild re-creates it with fresh ids, so it is re-selected by guid last. */
export async function rederiveBaseInstances(source: string, fromPrefab: PrefabFile, toPrefab: PrefabFile, side: BaseInstanceSide | null): Promise<void> {
  await restoreBaseInstance(source, side);
  refreshBaseInstances(source, fromPrefab, toPrefab, side?.rootGuid);
  const id = side?.rootGuid ? entityIdForGuid(side.rootGuid) : 0;
  if (id) useEditorStore.getState().selectEntity(id);
}

const worldLeft = () => new Error('the scene changed while it ran, so only the prefab file was restored — the instances were not');

function makeApplyPrefabAction(opts: {
  source: string;
  prefabBefore: PrefabFile;
  prefabAfter: PrefabFile;
  sceneBefore: SceneData;
  sceneAfter: SceneData;
  selGuid: string;
  memberPathsChanged?: boolean;
  affectedScenes: string[];
  baseBefore: BaseInstanceSide | null;
  baseAfter: BaseInstanceSide | null;
  /** The forward Apply saved the scene (a promotion) — see {@link saveSceneOverOtherHalf}. */
  sceneSaved: boolean;
}): UndoAction {
  const paths = opts.memberPathsChanged;
  const label = 'Apply to Prefab';
  return {
    label,
    affectedScenes: opts.affectedScenes,
    // The world restore reaches only the primary; every carried base instance of the prefab is
    // re-derived against the prefab being restored, and the applied one rebuilt from its capture.
    // Not when the restore found its world gone: the rederive rebuilds every base instance of the prefab in whatever
    // world is live, which is then a scene this Apply never touched (#1575 close-out re-review). And the step THROWS
    // then, because it applied only half — the file, not the world. `runStep` drops a throwing step with a loud report
    // (#310), rather than pushing it to the other stack as if the world had followed.
    undo: async () => {
      if (!await restoreSnapshot(opts.source, opts.prefabBefore, opts.prefabAfter, opts.sceneBefore, opts.selGuid, paths ? opts.prefabAfter : undefined, label, 'Undo', opts.sceneSaved)) throw worldLeft();
      await rederiveBaseInstances(opts.source, opts.prefabAfter, opts.prefabBefore, opts.baseBefore);
    },
    redo: async () => {
      if (!await restoreSnapshot(opts.source, opts.prefabAfter, opts.prefabBefore, opts.sceneAfter, opts.selGuid, paths ? opts.prefabBefore : undefined, label, 'Redo', opts.sceneSaved)) throw worldLeft();
      await rederiveBaseInstances(opts.source, opts.prefabBefore, opts.prefabAfter, opts.baseAfter);
    },
  };
}

/** Apply the selected overrides to the prefab AND record one undo entry.
 *  Captures the scene snapshot before the mutation, applies, persists the scene when a
 *  promotion restructured it, captures the after snapshot, and pushes the action. */
export async function applyToPrefabWithUndo(
  rootInstanceId: number,
  selectedKeys: Set<string>,
): Promise<ApplyResult> {
  // ⚠️ Lands WHOLE, in the world it began in (I11, #1667). Its write, its refresh, its scene save and its undo entry
  // are separated by awaits, and a Play, a scene open or entering prefab edit in one of them ran the rest in the
  // incoming world: Play snapshotted the pre-refresh world and Stop restored it over the applied prefab, and a scene
  // open took the undo entry onto ITS stack. So every world switch waits for this, as for an undo step (#1579), and
  // an Apply does not start while one is under way. Taken synchronously, before the first await.
  if (isWorldSwitchInProgress()) {
    return { promotedAdditions: 0, applied: false, refused: 'a scene switch is in progress — apply again once it has landed.' };
  }
  const release = beginWorldBoundOperation();
  try {
    return await applyHeld(rootInstanceId, selectedKeys);
  } finally {
    release();
  }
}

async function applyHeld(rootInstanceId: number, selectedKeys: Set<string>): Promise<ApplyResult> {
  // …and not over a world an editor route is still adopting (#1698): its snapshot, its scene save and its undo entry
  // would describe a world whose history and path are about to change under them.
  const settling = adoptionsSettled();
  if (settling) await settling;
  const scenePath = getCurrentScenePath();
  // assignGuids so every entity (incl. the selection) has a stable guid the snapshot
  // and selection-restore can key on.
  const sceneBefore = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  // Anchor selection-restore to the INSTANCE being applied (its root guid), not the
  // editor's transient selection — the scene rebuild on undo/redo mints new ECS ids,
  // and the instance root is the entity the user was working on. Falls back to the
  // current selection if the root has no guid yet.
  const selGuid = guidForEntityId(rootInstanceId) || (() => {
    const selId = useEditorStore.getState().selectedEntityId;
    return selId != null ? guidForEntityId(selId) : '';
  })();

  // A BASE scene's instance (#1431): the apply rebuilds it and consumes its overrides/additions into
  // the prefab, so the base's file is stale too — and `saveScene` below writes only the primary.
  // Carried as the action's `affectedScenes`, so push, undo and redo each dirty the base for Save All.
  // Read BEFORE the apply: it tears the instance down.
  const affectedScenes = resolveAffectedScenes([rootInstanceId]);
  // …and the undo needs the base instance itself, which `sceneBefore` (primary-only) does not hold.
  // Found again by a DURABLE guid: a runtime one is not carried by the rebuild nor across the carry,
  // and a miss would silently drop back to saving the post-apply instance. Warmed first, as Revert
  // does: a cold cache drops a user-added nested instance from the capture (#1284).
  const ctx = affectedScenes.length ? resolveInstanceContext(rootInstanceId) : null;
  const rootGuid = ctx ? ensureGuid(rootInstanceId) : '';
  if (ctx) await preloadNestedPrefabsForSubtree(rootInstanceId);
  const prefabNow = ctx ? await getPrefabSource(ctx.source) : null;
  const baseBefore = prefabNow && rootGuid ? captureSide(rootInstanceId, rootGuid, prefabNow) : null;
  const result = await applyToPrefabSelective(rootInstanceId, selectedKeys);
  if (!result.applied || !result.source || !result.prefabBefore || !result.prefabAfter) {
    return result; // no-op apply — nothing to undo
  }

  // A promotion deletes the live "added" entity and restructures the scene — persist
  // it (mirrors the dialog's old behavior) so the AFTER snapshot matches disk.
  const sceneSaved = result.promotedAdditions > 0 && scenePath ? await saveScene() : null;

  const sceneAfter = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  const liveAfter = baseBefore && rootGuid ? entityIdForGuid(rootGuid) : 0;
  const baseAfter = liveAfter ? captureSide(liveAfter, rootGuid, result.prefabAfter) : null;
  pushAction(makeApplyPrefabAction({
    source: result.source,
    prefabBefore: result.prefabBefore,
    prefabAfter: result.prefabAfter,
    sceneBefore,
    sceneAfter,
    selGuid,
    memberPathsChanged: result.memberPathsChanged,
    affectedScenes,
    baseBefore: baseBefore && liveAfter ? { ...baseBefore, prefab: result.prefabBefore } : null,
    baseAfter,
    sceneSaved: !!sceneSaved?.saved,
  }));
  return result;
}
