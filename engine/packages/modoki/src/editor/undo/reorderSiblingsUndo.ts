/** Undo entry for a sibling `sortOrder` renumber.
 *
 *  The Hierarchy drag-reorder, when neighboring siblings have colliding
 *  sortOrders (the legacy "everyone is sortOrder 0" case), renumbers the whole
 *  sibling group so it can compute a unique drop midpoint. That renumber used to
 *  go through raw `writeTraitField`, bypassing undo entirely — so Cmd+Z restored
 *  the dragged entity but left every sibling at its rewritten value, and redo
 *  never re-applied it (Hierarchy F1).
 *
 *  This builds (but does not push) a single combined undo entry that snapshots
 *  every sibling's prior sortOrder and restores them on undo. The actual ECS
 *  write is injected so the helper stays pure/testable. */
import type { UndoAction } from './undoManager';

export interface SiblingSortChange {
  id: number;
  oldSort: number;
  newSort: number;
}

/** Returns the entries that actually change (oldSort !== newSort). Callers can
 *  skip pushing an undo entry when nothing moves. */
export function diffSiblingSorts(changes: SiblingSortChange[]): SiblingSortChange[] {
  return changes.filter((c) => c.oldSort !== c.newSort);
}

/** Build an undo entry for the renumber. `redo` applies the new sortOrders,
 *  `undo` restores the old ones — both via the injected `apply` write. The
 *  renumber is NOT applied as a side effect of building the action; call
 *  `action.redo()` once to apply it, then `pushAction(action)`. */
export function makeReorderSiblingsAction(
  changes: SiblingSortChange[],
  apply: (id: number, sort: number) => void,
  label = 'Reorder siblings',
): UndoAction {
  // Snapshot defensively so later mutation of the caller's array can't corrupt
  // the captured values.
  const snapshot = changes.map((c) => ({ id: c.id, oldSort: c.oldSort, newSort: c.newSort }));
  return {
    label,
    undo: () => { for (const c of snapshot) apply(c.id, c.oldSort); },
    redo: () => { for (const c of snapshot) apply(c.id, c.newSort); },
  };
}
