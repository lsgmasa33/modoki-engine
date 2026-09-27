/** Undo/redo for "Revert Overrides" — the counterpart of `applyToPrefabWithUndo` (applyPrefabUndo.ts).
 *
 *  Revert touches no file: it rebuilds ONE instance with the reverted overrides left out, so its undo rebuilds it with
 *  them put back, and its redo takes them out again. Both rebuild onto the editor's CURRENT copy of the prefab, not
 *  the copy the Revert read (#1665): the template can change in between — a prefab-edit save, an Apply from another
 *  instance — and a rebuild from the Revert's copy undid that change on this one instance, so the next save wrote a
 *  member the template had gained as REMOVED by it. `rebuildInstanceFromCapture` carries the captured state across.
 *
 *  The one wrapper for both routes, the dialog and the agent `prefab revert` op — which each carried a copy of these
 *  closures until #1671 (a fix to one copy had to be made twice). */

import { pushAction } from './undoManager';
import { UndoRefusedError } from './undoFailure';
import { entityRef } from './entityRef';
import { useEditorStore } from '../store/editorStore';
import {
  revertOverridesSelective, rebuildInstanceFromCapture, preloadNestedPrefabsForSubtree,
  type RevertResult,
} from '../scene/prefab';

/** Revert the selected overrides on instance `rootInstanceId` AND record one undo entry. Resolves the Revert's result,
 *  or null when nothing was reverted (see `revertOverridesSelective`). Selects the rebuilt root. The caller gives a
 *  stale-instance refusal its own words first (`staleInstanceRefusal`) — Revert's null cannot carry one (#1483). */
export async function revertOverridesWithUndo(rootInstanceId: number, selectedKeys: Set<string>): Promise<RevertResult | null> {
  const result = await revertOverridesSelective(rootInstanceId, selectedKeys);
  if (!result) return null;
  // The rebuild assigns new ECS ids but keeps the instance root's guid (rebuildInstance carries it over), so a
  // guid-based ref re-finds the live root across each rebuild AND across a world rebuild (Play→Stop).
  const ref = entityRef(result.newRootId);
  useEditorStore.getState().selectEntity(result.newRootId);
  const { source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure, affectedScenes } = result;
  const rebuildTo = async (overrides: RevertResult['fullOverrides'], structure: RevertResult['fullStructure']) => {
    const cur = ref.resolve(); if (cur == null) return;
    // rebuildInstance -> captureNestedInstanceOverrides is a sync cache read with NO warning on a miss, so a cold cache
    // silently resets a nested instance's per-copy overrides to the child prefab base (#1284). undoManager awaits
    // undo/redo under its own mutex, so awaiting here is supported rather than merely tolerated.
    await preloadNestedPrefabsForSubtree(cur);
    const after = ref.resolve(); if (after == null) return;
    const id = rebuildInstanceFromCapture(after, source, prefab, overrides, structure);
    // Refused BEFORE anything was rebuilt, as Apply's undo refuses (#1664): `runStep` drops the entry (#310) and, since
    // nothing changed, dirties nothing and toasts the reason rather than a bare "FAILED".
    if (id == null) {
      throw new UndoRefusedError(
        `a prefab nested in this instance of "${source}" has changed since it was built, so the Revert cannot be put ` +
          'back or re-applied onto it; nothing was changed. Reload the scene to update it.',
        'a prefab nested in this instance changed since it was built — reload the scene',
      );
    }
    useEditorStore.getState().selectEntity(id);
  };
  pushAction({
    label: 'Revert prefab overrides',
    affectedScenes,
    undo: () => rebuildTo(fullOverrides, fullStructure),
    redo: () => rebuildTo(reducedOverrides, reducedStructure),
  });
  return result;
}
