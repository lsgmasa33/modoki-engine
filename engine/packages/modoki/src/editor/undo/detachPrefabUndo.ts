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
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import type { ContextMenuItem } from '../components/ContextMenu';

/** Why entity `id` cannot be detached, or undefined when it can. A MEMBER of an instance is refused, naming its root
 *  (#1764): Detach unpacks a whole instance from its root, as Unity's Unpack does (U17 — Unity's
 *  `PrefabUtility.UnpackPrefabInstance` throws on a non-root, and its Hierarchy greys Unpack on one). The Hierarchy's
 *  greyed item shows this text and the agent op refuses with it, so the two say the same thing; before, the Hierarchy
 *  quietly detached the root and the agent unpacked only the member. A nested instance's own root is not a member
 *  here: detaching it stays allowed, as U17 records. `rootId` is the root to name in an alternative. */
export function detachRefusal(id: number): { reason: string; rootId: number } | undefined {
  const meta = getTraitByName('PrefabInstance');
  const pi = meta ? readTraitData(id, meta) : null;
  const rootId = pi?.rootInstanceId as number | undefined;
  // 0 is "unset", as everywhere a root is read (a legacy entry loads that way), and a root that is not live cannot be
  // the thing to detach instead: either way nothing names a whole instance to act on, so this one detaches (close-out
  // review — refused, a link neither surface could cut).
  // Live by `findEntity`, not by `getAllEntities`, which drops a parked pooled row (`UIEntry.live:false`) with its subtree:
  // a member of one read as rootless, so its greyed row came back enabled for a Detach that strips nothing (close-out
  // re-review). The list only supplies the names.
  if (!rootId || rootId === id || !findEntity(rootId)) return undefined;
  const names = new Map(getAllEntities().map((e) => [e.id, e.name]));
  const root = names.get(rootId) ?? String(rootId);
  const member = names.get(id) ?? String(id);
  return {
    rootId,
    reason: `Detach the instance root "${root}" instead: "${member}" is a member of it, and Detach unpacks a whole instance from its root, as Unity's Unpack does.`,
  };
}

/** The Hierarchy's "Detach Prefab" row for instance entity `id`: greyed on a member, with `detachRefusal`'s reason as
 *  its hover text — the text the agent op refuses with (#1764). `disabled` is the panel's own reason to grey every row. */
export function detachPrefabMenuItem(id: number, disabled: boolean, onClick: () => void): ContextMenuItem {
  const refused = detachRefusal(id);
  return { label: 'Detach Prefab', onClick, disabled: disabled || !!refused, ...(refused ? { title: refused.reason } : {}) };
}

/** Detach instance `rootId` and record one undo entry. Returns the detach's snapshot; nothing is recorded when it
 *  stripped no link (`rootId` is not an instance). Throws `detachRefusal`'s reason for a member. `logTag` prefixes the warning an unresolved link gives. */
export function detachPrefabInstanceWithUndo(rootId: number, label: string, logTag: string): DetachSnapshot {
  // The one entry both surfaces call, so a caller that skipped the check cannot unpack a member on its own (#1764).
  const refused = detachRefusal(rootId);
  if (refused) throw new Error(refused.reason);
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
