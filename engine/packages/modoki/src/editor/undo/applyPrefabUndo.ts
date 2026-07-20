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
import { serializeScene, saveScene, getCurrentScenePath, setCurrentScenePath } from '../scene/serialize';
import {
  applyToPrefabSelective, installPrefabSnapshot, guidForEntityId, entityIdForGuid,
  type ApplyResult, type PrefabFile,
} from '../scene/prefab';
import { useEditorStore } from '../store/editorStore';

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
): Promise<void> {
  await installPrefabSnapshot(source, prefab);
  if (scenePath) {
    await sceneManager.loadScene(scenePath, { preloaded: clone(scene) });
    setCurrentScenePath(scenePath);
    await saveScene(); // persist the restored world so disk matches the live state
  }
  const id = selGuid ? entityIdForGuid(selGuid) : 0;
  useEditorStore.getState().selectEntity(id || null);
}

function makeApplyPrefabAction(opts: {
  source: string;
  prefabBefore: PrefabFile;
  prefabAfter: PrefabFile;
  sceneBefore: SceneData;
  sceneAfter: SceneData;
  scenePath: string | null;
  selGuid: string;
}): UndoAction {
  return {
    label: 'Apply to Prefab',
    undo: () => restoreSnapshot(opts.source, opts.prefabBefore, opts.sceneBefore, opts.scenePath, opts.selGuid),
    redo: () => restoreSnapshot(opts.source, opts.prefabAfter, opts.sceneAfter, opts.scenePath, opts.selGuid),
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

  const result = await applyToPrefabSelective(rootInstanceId, selectedKeys);
  if (!result.applied || !result.source || !result.prefabBefore || !result.prefabAfter) {
    return result; // no-op apply — nothing to undo
  }

  // A promotion deletes the live "added" entity and restructures the scene — persist
  // it (mirrors the dialog's old behavior) so the AFTER snapshot matches disk.
  if (result.promotedAdditions > 0 && scenePath) await saveScene();

  const sceneAfter = (await serializeScene({ assignGuids: true })) as unknown as SceneData;
  pushAction(makeApplyPrefabAction({
    source: result.source,
    prefabBefore: result.prefabBefore,
    prefabAfter: result.prefabAfter,
    sceneBefore,
    sceneAfter,
    scenePath,
    selGuid,
  }));
  return result;
}
