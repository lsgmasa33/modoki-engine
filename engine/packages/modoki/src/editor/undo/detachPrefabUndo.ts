/** Undo/redo for "Detach Prefab" — the one wrapper the Hierarchy menu and the agent `prefab detach` op share.
 *
 *  Undo reattaches from the snapshot and brings the instance onto the current template (`reattachDetachedInstance`,
 *  #1665's sibling). Redo detaches AGAIN and keeps THAT snapshot: the undo's rebase can rebuild the instance onto a
 *  newer template, so its members are not the ones the first detach stripped. Replaying the first snapshot on the
 *  next undo left a member the rebase had brought in as a plain entity, which the save wrote as an unlinked copy
 *  beside the row it recorded as REMOVED (#1665 close-out review). */

import { pushAction } from './undoManager';
import { entityRef } from './entityRef';
import { detachPrefabInstance, reattachDetachedInstance, type DetachSnapshot } from '../scene/prefab';

/** Detach instance `rootId` and record one undo entry. Returns the detach's snapshot; nothing is recorded when it
 *  stripped no link (`rootId` is not an instance). `logTag` prefixes the warning an unresolved link gives. */
export function detachPrefabInstanceWithUndo(rootId: number, label: string, logTag: string): DetachSnapshot {
  const first = detachPrefabInstance(rootId);
  if (!first.links.length) return first;
  // Resolved by guid: redo detaches the right entity after a world rebuild (Play→Stop). Detach leaves PLAIN
  // entities, whose guids ARE serialized, so these refs survive a Play→Stop where Create Prefab's do not (#1272).
  const ref = entityRef(rootId);
  let snapshot = first;
  pushAction({
    label,
    undo: async () => {
      const unresolved = await reattachDetachedInstance(snapshot);
      // Reported, never discarded — that silence is what hid #1272 for as long as it did.
      if (unresolved > 0) console.warn(`${logTag} Detach undo: ${unresolved} prefab link(s) could not be put back — no longer addressable.`);
    },
    redo: () => {
      const id = ref.resolve(); if (id == null) return;
      const again = detachPrefabInstance(id);
      if (again.links.length) snapshot = again;
    },
  });
  return first;
}
