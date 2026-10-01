/** Undo/redo for "Revert Overrides" — the counterpart of `applyToPrefabWithUndo` (applyPrefabUndo.ts).
 *
 *  Revert touches no file: it rebuilds ONE instance with the reverted overrides left out, so its undo rebuilds it with
 *  them put back, and its redo takes them out again. Both rebuild onto the editor's CURRENT copy of the prefab, not
 *  the copy the Revert read (#1665): the template can change in between — a prefab-edit save, an Apply from another
 *  instance — and a rebuild from the Revert's copy undid that change on this one instance, so the next save wrote a
 *  member the template had gained as REMOVED by it. `rebuildFrameFromSide` loads the captured scene entry onto it.
 *
 *  The one wrapper for both routes, the dialog and the agent `prefab revert` op — which each carried a copy of these
 *  closures until #1671 (a fix to one copy had to be made twice). */

import { pushAction } from './undoManager';
import { UndoRefusedError } from './undoFailure';
import { entityRef } from './entityRef';
import { useEditorStore } from '../store/editorStore';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { rebuildFrameFromSide, preloadRebuildEntry } from '../scene/prefabRebuild';
import { revertOverridesSelective, unrecordReverted, type RevertResult } from '../scene/prefabRevert';

/** Revert the selected overrides on instance `rootInstanceId` AND record one undo entry. Resolves the Revert's result,
 *  or null when nothing was reverted (see `revertOverridesSelective`). Selects the rebuilt root. The caller gives a
 *  stale-instance refusal its own words first (`staleInstanceRefusal`) — Revert's null cannot carry one (#1483). */
export async function revertOverridesWithUndo(rootInstanceId: number, selectedKeys: Set<string>): Promise<RevertResult | null> {
  const result = await revertOverridesSelective(rootInstanceId, selectedKeys);
  if (!result) return null;
  // The rebuild assigns new ECS ids but keeps the instance root's guid (`rebuildFromEntry` carries it over), so a
  // guid-based ref re-finds the live root across each rebuild AND across a world rebuild (Play→Stop).
  const ref = entityRef(result.newRootId);
  useEditorStore.getState().selectEntity(result.newRootId);
  const { source, fullSide, reducedSide, reverted, affectedScenes } = result;
  // Both directions rebuild an instance ROOT of `source` (I20). After a world swap its guid can name a Missing Prefab
  // placeholder (the prefab was deleted), and rebuilding from the capture expanded a second instance on the
  // placeholder's guid beside it (#1819, I7). `require` refuses that, and a root that is gone, before anything changes.
  const expect = {
    check: (id: number) => {
      const meta = getTraitByName('PrefabInstance');
      const pi = meta ? readTraitData(id, meta) as { source?: string; rootInstanceId?: number } | null : null;
      return pi && pi.rootInstanceId === id && pi.source === source ? null : `is no longer an instance of ${source}`;
    },
  };
  const rebuildTo = async (side: RevertResult['fullSide'], unrecord: readonly string[] = []) => {
    const cur = ref.require(expect);
    // The rebuild is a sync load of the instance's whole scene entry, and a prefab missing from the cache reads as one it
    // cannot expand (#1284, #1880 F7a). undoManager awaits undo/redo under its own mutex, so awaiting here is supported
    // rather than merely tolerated.
    await preloadRebuildEntry(cur);
    const after = ref.require(expect); // asked again: the await above can span a world swap
    const id = rebuildFrameFromSide(after, side);
    if (id != null) unrecordReverted(id, unrecord);
    // Refused BEFORE anything was rebuilt, as Apply's undo refuses (#1664): `runStep` drops the entry (#310) and, since
    // nothing changed, dirties nothing and toasts the reason rather than a bare "FAILED".
    if (id == null) {
      throw new UndoRefusedError(
        `the scene entry holding this instance of "${source}" is gone, or its prefab or one around it cannot be read ` +
          '(trashed), so the Revert cannot be put back or re-applied onto it; nothing was changed.',
        'the scene entry holding this instance is gone, or its prefab or one around it cannot be read',
      );
    }
    useEditorStore.getState().selectEntity(id);
  };
  pushAction({
    label: 'Revert prefab overrides',
    affectedScenes,
    undo: () => rebuildTo(fullSide),
    redo: () => rebuildTo(reducedSide, reverted),
  });
  return result;
}
