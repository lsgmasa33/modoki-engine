/** Undo/redo for "Remove Unused" overrides (#2001 S9; Unity's Remove Unused Overrides).
 *
 *  Remove Unused takes the instance's removable unused records off its list (`instanceEdits.removeUnused`). Those records
 *  applied nothing when it ran, so the forward step rebuilds nothing. Its undo and redo seat the EXACT records the step
 *  changed (rule 8) and REPROJECT the tree from them (`restoreSideOrNothing`: when the rebuild cannot happen the step refuses and the store is left as it was), as Revert's do: by then a gone target can be back (an
 *  outside edit, a pull, an undo of the template change; plan § 2.6), and a record seated without a rebuild would apply in
 *  the save but not on screen — or, on a redo, leave on screen an override the save no longer writes (#2001 S9 close-out
 *  review 1). The one wrapper for both routes, the dialog and the agent `prefab remove-unused` op (rule 10). */

import { pushAction } from './undoManager';
import { UndoRefusedError } from './undoFailure';
import { entityRef } from './entityRef';
import { refsCheck } from './stepCheck';
import { useEditorStore } from '../store/editorStore';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { resolveAffectedScenes } from '../scene/sceneDirty';
import { preloadRebuildEntry } from '../scene/prefabRebuild';
import { changedSince, copyRecords, restoreSideOrNothing, type RecordsSide } from '../instance/instanceHistory';
import { guidOfEntity, instanceTargetOf } from '../instance/instanceKeys';
import * as instanceEdits from '../instance/instanceEdits';

export type RemoveUnusedOutcome = { removed: number } | { refused: string };

/** Remove instance root `rootInstanceId`'s removable unused overrides AND record one undo entry. `{removed: 0}` when it
 *  has none (no entry pushed); `{refused}` when it is a nested instance inside another's record, or the root holds no
 *  record to edit (the store does not state it: a stale or missing record refuses loud, #2001 S8b). */
export function removeUnusedOverridesWithUndo(rootInstanceId: number): RemoveUnusedOutcome {
  const refuse = (refused: string): RemoveUnusedOutcome => { console.warn(`[Prefab] Remove Unused not done: ${refused}`); return { refused }; };
  // A nested instance's records are its OUTER instance's (one record holds the whole tree): say so, and which, rather than
  // call its record unreadable (#2001 S9 close-out review 3).
  const owner = instanceTargetOf(rootInstanceId);
  if (owner?.kind === 'member' && owner.rootId !== rootInstanceId) {
    return refuse(`it is a nested instance: its unused overrides are held by the instance root ${owner.rootGuid || owner.rootId} — pass that root`);
  }
  const affectedScenes = resolveAffectedScenes([rootInstanceId]);
  const before = copyRecords();
  const removed = instanceEdits.removeUnused(rootInstanceId);
  if (removed === null) return refuse('its override list could not be read — reload its scene');
  if (removed === 0) return { removed };
  // Taken only now: the root holds a record, so it has its durable guid already, and a refusal minted nothing.
  const ref = entityRef(rootInstanceId);
  const rootGuid = guidOfEntity(rootInstanceId);
  const changed = changedSince(before);
  const restore = async (side: RecordsSide) => {
    await preloadRebuildEntry(ref.require());
    ref.require(); // asked again: the await above can span a world swap
    if (!restoreSideOrNothing(side, rootGuid)) {
      throw new UndoRefusedError(
        'the instance these unused overrides belong to cannot be rebuilt from its records (its prefab or one inside it ' +
          'cannot be read), so the step cannot be put back; nothing was changed.',
        'the instance cannot be rebuilt from its records',
      );
    }
    const id = findEntityByGuid(rootGuid)?.id();
    if (id) useEditorStore.getState().selectEntity(id);
  };
  pushAction({
    label: `Remove ${removed} unused override${removed === 1 ? '' : 's'}`,
    affectedScenes,
    undo: () => restore(changed.before),
    redo: () => restore(changed.after),
    check: refsCheck(() => [ref]),
  });
  return { removed };
}
