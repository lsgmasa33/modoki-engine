/** Undo/redo for "Detach Prefab" — the one wrapper the Hierarchy menu and the agent `prefab detach` op share.
 *
 *  Undo reattaches from the snapshot and brings the instance onto the current template (`reattachDetachedInstance`,
 *  #1665's sibling). Redo detaches AGAIN and keeps THAT snapshot: the undo's rebase can rebuild the instance onto a
 *  newer template, so its members are not the ones the first detach stripped. Replaying the first snapshot on the
 *  next undo left a member the rebase had brought in as a plain entity, which the save wrote as an unlinked copy
 *  beside the row it recorded as REMOVED (#1665 close-out review). */

import { pushAction } from './undoManager';
import { reportUndoFailure } from './undoFailure';
import { entityRef, buildGuidIndex, requireWith, renamesOf, requireDetachedMembers, isInstanceRootCheck } from './entityRef';
import { detachPrefabInstance, reattachDetachedInstance, type DetachSnapshot } from '../scene/prefabLink';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { isSuppliedByPrefab, outermostPrefabRoot } from '../scene/restructureRefusal';
import type { ContextMenuItem } from '../components/ContextMenu';

/** Why entity `id` cannot be detached, or undefined when it can. Detach unpacks an instance from its OUTERMOST root, as
 *  Unity's Unpack does (U17): `PrefabUtility.UnpackPrefabInstance` throws unless `IsOutermostPrefabInstanceRoot`
 *  (UnityCsReference `PrefabUtility.cs`), and its Hierarchy greys Unpack elsewhere. So anything the prefab supplies is
 *  refused: a MEMBER (#1764), and since #1792/#1869 a nested root too — an owned one, or a template reference node the
 *  outer prefab added. Unpacking a prefab nested in an instance restructures that instance, and its Revert then respawned
 *  the row beside the unpacked copy on one guid. A stored root the scene put there is its own outermost root and
 *  detaches. The refusal names the outermost root (`rootId`) to act on instead, and the Hierarchy's greyed item shows it
 *  as hover text while the agent op refuses with it, so the two say the same thing. */
export function detachRefusal(id: number): { reason: string; rootId: number } | undefined {
  const meta = getTraitByName('PrefabInstance');
  const pi = meta ? readTraitData(id, meta) as { rootInstanceId?: number } | null : null;
  // Only an instance entity is detached at all; one the prefab does not supply (a stored root; a member whose root is not
  // live, or an owned root nothing owns that hangs under no instance root — each links to nothing a save could write it into) detaches itself.
  // Live by `findEntity` (inside the predicate), not by `getAllEntities`, which drops a parked pooled row
  // (`UIEntry.live:false`) with its subtree: a member of one read as rootless, so its greyed row came back enabled for a
  // Detach that strips nothing (close-out re-review). The list only supplies the names.
  if (!pi?.rootInstanceId || !isSuppliedByPrefab(id)) return undefined;
  // No outermost root to name (a member whose root carries no `PrefabInstance`, a supplier chain that loops): nothing is
  // offered to detach instead, so this one detaches — refused, its link could be cut on neither surface (#1764's rule).
  const outer = outermostPrefabRoot(id);
  if (!outer || outer === id) return undefined;
  const names = new Map(getAllEntities().map((e) => [e.id, e.name]));
  const root = names.get(outer) ?? String(outer);
  const self = names.get(id) ?? String(id);
  const what = pi.rootInstanceId === id ? 'a prefab nested inside it' : 'a member of it';
  return {
    rootId: outer,
    reason: `Detach the instance root "${root}" instead: "${self}" is ${what}, and Detach unpacks a whole instance from its outermost root, as Unity's Unpack does.`,
  };
}

/** The Hierarchy's "Detach Prefab" row for instance entity `id`: greyed on a member, with `detachRefusal`'s reason as
 *  its hover text — the text the agent op refuses with (#1764). `disabled` is the panel's own reason to grey every row. */
export function detachPrefabMenuItem(id: number, disabled: boolean, onClick: () => void): ContextMenuItem {
  const refused = detachRefusal(id);
  return { label: 'Detach Prefab', onClick, disabled: disabled || !!refused, ...(refused ? { title: refused.reason } : {}) };
}

/** Detach's undo, before it puts back any link (#1819, I19/I20): every entity the snapshot relinks, and every root it
 *  names, must still be live and PLAIN, which is what the Detach left them. After a world swap one can be gone, a
 *  Missing Prefab placeholder, or an instance again; putting `PrefabInstance` back on it would make a placeholder an
 *  instance of a prefab that does not load, or re-link a member under a root that is not the one it was stripped from.
 *  Throws `UndoRefusedError`. */
export function requireDetachedLinks(detached: DetachSnapshot): void {
  const pi = getTraitByName('PrefabInstance');
  const check = (id: number) => (pi && findEntity(id)?.has(pi.trait) ? 'is a prefab instance again, so its detached links cannot be put back' : null);
  const idx = buildGuidIndex();
  // Through the rename the Detach's frame-ending made (a promoted orphan's members, #1447): `reattachPrefabInstance`
  // reverses it only when it relinks the orphans, after this, and every ref here was taken before it.
  const renames = renamesOf(detached.orphans);
  // Plain is what the Detach left the entities it STRIPPED, each asked as its own link's `ref`. A root OUTSIDE that set
  // (by capture-time id, which a guid-less root has too) is one the Detach left an instance: an owned nested root the
  // frame-ending promoted (#1447), or a stored root it left alone. It must still be an instance root of the link's
  // source; a root that turned plain, or into another prefab's instance, would be relinked over.
  const stripped = new Set(detached.links.map((l) => l.ref.rawId));
  for (const link of detached.links) {
    requireWith(link.ref, idx, { kind: 'entity', check }, renames);
    if (stripped.has(link.rootRef.rawId)) continue;
    const source = link.data.source as string | undefined;
    requireWith(link.rootRef, idx, {
      kind: 'entity',
      check: (id) => isInstanceRootCheck(id)
        ?? ((pi && (readTraitData(id, pi) as { source?: string } | null)?.source) === source ? null : `is no longer an instance of ${source}`),
    }, renames);
  }
  requireDetachedMembers(detached.orphans, idx, renames);
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
      requireDetachedLinks(snapshot);
      const unresolved = await reattachDetachedInstance(snapshot);
      // Reported, never discarded — that silence is what hid #1272 for as long as it did. Into the step (#1823), so
      // the undo answers PARTIAL rather than `did:true`.
      if (unresolved > 0) reportUndoFailure({ direction: 'Undo', label, detail: `${logTag} ${unresolved} prefab link(s) could not be put back — no longer addressable` });
    },
    redo: () => {
      const id = ref.require(); // I19: a root that is gone refuses, rather than reading as detached
      const again = detachPrefabInstance(id);
      if (again.links.length) snapshot = again;
    },
  });
  return first;
}
