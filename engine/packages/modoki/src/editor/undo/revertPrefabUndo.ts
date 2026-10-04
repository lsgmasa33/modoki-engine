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
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { preloadRebuildEntry, keptEnclosingSource } from '../scene/prefabRebuild';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { revertOverridesSelective, type RevertResult } from '../scene/prefabRevert';
import { restoreSideOrNothing, type RecordsSide } from '../instance/instanceHistory';

/** Revert the selected overrides on instance `rootInstanceId` AND record one undo entry. Resolves the Revert's result,
 *  or null when nothing was reverted (see `revertOverridesSelective`). Selects the rebuilt root. The caller gives a
 *  stale-instance refusal its own words first (`staleInstanceRefusal`) — Revert's null cannot carry one (#1483).
 *
 *  Undo and redo put back the EXACT records the Revert changed (#2001 S7, rule 8) and rebuild the instance tree from
 *  them, onto the editor's CURRENT documents (#1665): a template change in between reaches the instance as a reload
 *  would show it. Nothing is re-derived from a capture. */
export async function revertOverridesWithUndo(rootInstanceId: number, selectedKeys: Set<string>): Promise<RevertResult | null> {
  const result = await revertOverridesSelective(rootInstanceId, selectedKeys);
  if (!result) return null;
  useEditorStore.getState().selectEntity(result.newRootId);
  const { source, frameGuid, topGuid, before, after, affectedScenes } = result;
  // The tree is rebuilt from the reverted FRAME upward (`projectionRootOf`): the root that held it at the Revert can be a
  // Missing Prefab placeholder by now (its prefab trashed and the scene reloaded), with the frame still shown under it.
  // Both directions rebuild an instance ROOT of `source` (I20). After a world swap its guid can name a Missing Prefab
  // placeholder (the prefab was deleted), or a plain entity, and rebuilding there expanded a second instance on the
  // guid beside it (#1819, I7). A frame inside a frame the rebuild keeps live (#1862) would be left as it is, so the step
  // would change nothing while reporting that it did (#1880 F7d close-out review 1). Each is refused before anything
  // changes, as Apply's undo refuses (#1664): `runStep` drops the entry (#310) and toasts the reason.
  // Both directions rebuild an instance ROOT of `source` (I20), found by the frame's durable guid, which every rebuild
  // keeps — across a world swap too (Play→Stop). `require` refuses a frame that is gone, one that is now a Missing Prefab
  // placeholder (its prefab deleted, #1819: rebuilding there expanded a second instance on its guid), and one that is no
  // instance of `source` any more, each in its own words, before anything changes (#1664): `runStep` drops the entry.
  const ref = entityRef(result.newRootId);
  const expect = {
    check: (id: number) => {
      const meta = getTraitByName('PrefabInstance');
      const pi = meta ? readTraitData(id, meta) as { source?: string; rootInstanceId?: number } | null : null;
      return pi && pi.rootInstanceId === id && pi.source === source ? null : `is no longer an instance of ${source}`;
    },
  };
  const restore = async (side: RecordsSide) => {
    await preloadRebuildEntry(ref.require(expect));
    const frame = ref.require(expect); // asked again: the await above can span a world swap
    // A frame inside a frame the rebuild keeps live (#1862) would be left as it is: the step would change nothing while
    // reporting that it did (#1880 F7d close-out review 1).
    const done = !keptEnclosingSource(frame) ? restoreSideOrNothing(side, frameGuid || topGuid) : null;
    if (!done) {
      throw new UndoRefusedError(
        `the scene entry holding this instance of "${source}" is gone, or its prefab or one around it cannot be read ` +
          '(trashed), so the Revert cannot be put back or re-applied onto it; nothing was changed.',
        'the scene entry holding this instance is gone, or its prefab or one around it cannot be read',
      );
    }
    useEditorStore.getState().selectEntity((frameGuid && findEntityByGuid(frameGuid)?.id()) || done.root);
  };
  pushAction({
    label: 'Revert prefab overrides',
    affectedScenes,
    undo: () => restore(before),
    redo: () => restore(after),
  });
  return result;
}
