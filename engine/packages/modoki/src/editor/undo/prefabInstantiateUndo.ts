/** Undo entry for "instantiate a prefab into the scene".
 *
 *  Shared by the Hierarchy drop-handler and the Assets-panel instantiate path so
 *  the two cannot drift. The Assets copy previously closed over a `const` root id
 *  while its `redo` spawned a fresh instance into a new local id — so after
 *  undo→redo→undo the second undo deleted the dead original and ORPHANED the
 *  redo-spawned instance (prefab F3). Keeping the live instance id in a single
 *  mutable slot here makes that impossible: undo always tears down whatever is
 *  currently live, redo re-instantiates and updates the slot. */
import type { UndoAction } from './undoManager';
import { entityRef, type EntityRef } from './entityRef';

export function makePrefabInstantiateAction(opts: {
  label: string;
  /** Entity id from the initial (pre-`pushAction`) instantiation. */
  initialId: number;
  /** Re-instantiate the prefab; return the new root id, or `null` if it could
   *  not be spawned (e.g. the prefab file was deleted between undo and redo) — in
   *  which case the live id is left unchanged, matching the original
   *  early-return behavior (nothing new exists to track). */
  respawn: () => Promise<number | null>;
  /** Tear down the live instance. Safe to call with a stale id (no-op). */
  remove: (id: number) => void;
}): UndoAction {
  // Track the live instance by a guid-based ref (not a raw id) so undo still
  // tears down the right entity after a world rebuild (Play→Stop). The instance
  // root carries a stable guid from instantiation (prefab.ts mints one).
  let currentRef: EntityRef = entityRef(opts.initialId);
  return {
    label: opts.label,
    // Resolve by guid; fall back to the last-known id if it can't (remove is safe
    // to call on a stale/dead id — a no-op — matching the original contract).
    undo: () => { opts.remove(currentRef.resolve() ?? currentRef.rawId); },
    redo: async () => {
      const id = await opts.respawn();
      if (id != null) currentRef = entityRef(id);
    },
  };
}
