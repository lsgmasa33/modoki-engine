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
 *  every instance exactly, preserving each one's overrides). */

import { pushAction, type UndoAction } from './undoManager';
import { sceneManager } from '../../runtime/scene/SceneManager';
import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { serializeScene, saveScene, getCurrentScenePath, setCurrentScenePath, setCurrentBaseScene } from '../scene/serialize';
import {
  applyToPrefabSelective, installPrefabSnapshot, guidForEntityId, entityIdForGuid,
  resolveInstanceContext, getPrefabSource, captureInstanceOverrides, captureInstanceStructure,
  rebuildInstance, preloadNestedPrefabsForSubtree, refreshBaseInstances,
  type ApplyResult, type PrefabFile,
} from '../scene/prefab';
import { useEditorStore } from '../store/editorStore';
import { repairPrefabMemberPaths } from '../backend/editorBackend';
import { resolveAffectedScenes } from '../scene/sceneDirty';
import { ensureGuid } from './entityRef';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Restore a (prefab, scene) snapshot: install the prefab base, then rebuild the live
 *  world from the scene snapshot (runtime loadScene — no history clear) and persist it.
 *  Re-selects the previously-inspected entity by guid (ids change on rebuild). */
async function restoreSnapshot(
  source: string,
  prefab: PrefabFile,
  scene: SceneData,
  scenePath: string | null,
  selGuid: string,
  /** The prefab document the files on disk were last repaired for, when the apply moved member paths
   *  (#1437): they are repaired from it to `prefab`, the way the apply repaired them the other way. */
  repairFrom?: PrefabFile,
): Promise<void> {
  await installPrefabSnapshot(source, prefab);
  if (repairFrom && prefab.id) await repairPrefabMemberPaths(prefab.id, repairFrom);
  if (scenePath) {
    await sceneManager.loadScene(scenePath, { preloaded: clone(scene) });
    setCurrentScenePath(scenePath);
    // A3: sceneManager.loadScene({preloaded}) records the base ref internally, but
    // the editor's own baseScene tracking (re-emitted by serializeScene) is separate
    // module state — must be re-synced explicitly, same as setCurrentScenePath above.
    setCurrentBaseScene(sceneManager.getCurrentBaseScene());
    await saveScene(); // persist the restored world so disk matches the live state
  }
  const id = selGuid ? entityIdForGuid(selGuid) : 0;
  useEditorStore.getState().selectEntity(id || null);
}

/** A BASE scene's instance, as it stood on one side of the apply (#1431). `restoreSnapshot` rebuilds
 *  only the PRIMARY: a base loaded with it is CARRIED live across `loadScene`, so its instance
 *  would keep its post-apply state against the restored prefab — and since the base is dirty, Save
 *  All would then write that into the base file (a promoted added node was lost exactly so). The
 *  instance is rebuilt from this capture instead, the same way Revert's own undo rebuilds it. */
interface BaseInstanceSide {
  rootGuid: string;
  prefab: PrefabFile;
  overrides: ReturnType<typeof captureInstanceOverrides>;
  structure: ReturnType<typeof captureInstanceStructure>;
}

function captureSide(rootInstanceId: number, rootGuid: string, prefab: PrefabFile): BaseInstanceSide {
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

function makeApplyPrefabAction(opts: {
  source: string;
  prefabBefore: PrefabFile;
  prefabAfter: PrefabFile;
  sceneBefore: SceneData;
  sceneAfter: SceneData;
  scenePath: string | null;
  selGuid: string;
  memberPathsChanged?: boolean;
  affectedScenes: string[];
  baseBefore: BaseInstanceSide | null;
  baseAfter: BaseInstanceSide | null;
}): UndoAction {
  const paths = opts.memberPathsChanged;
  return {
    label: 'Apply to Prefab',
    affectedScenes: opts.affectedScenes,
    // The world restore reaches only the primary; every carried base instance of the prefab is
    // re-derived against the prefab being restored, and the applied one rebuilt from its capture.
    undo: async () => {
      await restoreSnapshot(opts.source, opts.prefabBefore, opts.sceneBefore, opts.scenePath, opts.selGuid, paths ? opts.prefabAfter : undefined);
      refreshBaseInstances(opts.source, opts.prefabAfter, opts.prefabBefore, opts.baseBefore?.rootGuid);
      await restoreBaseInstance(opts.source, opts.baseBefore);
    },
    redo: async () => {
      await restoreSnapshot(opts.source, opts.prefabAfter, opts.sceneAfter, opts.scenePath, opts.selGuid, paths ? opts.prefabBefore : undefined);
      refreshBaseInstances(opts.source, opts.prefabBefore, opts.prefabAfter, opts.baseAfter?.rootGuid);
      await restoreBaseInstance(opts.source, opts.baseAfter);
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
  if (result.promotedAdditions > 0 && scenePath) await saveScene();

  const sceneAfter = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  const liveAfter = baseBefore && rootGuid ? entityIdForGuid(rootGuid) : 0;
  const baseAfter = liveAfter ? captureSide(liveAfter, rootGuid, result.prefabAfter) : null;
  pushAction(makeApplyPrefabAction({
    source: result.source,
    prefabBefore: result.prefabBefore,
    prefabAfter: result.prefabAfter,
    sceneBefore,
    sceneAfter,
    scenePath,
    selGuid,
    memberPathsChanged: result.memberPathsChanged,
    affectedScenes,
    baseBefore: baseBefore && liveAfter ? { ...baseBefore, prefab: result.prefabBefore } : null,
    baseAfter,
  }));
  return result;
}
