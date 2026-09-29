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
  /** The undo's write, when it is not `apply`'s mirror: the Hierarchy's renumber marks by value going forward and
   *  must put back the marks it found coming back (#1709). Defaults to `apply`. */
  revert: (id: number, sort: number) => void = apply,
): UndoAction {
  // Snapshot defensively so later mutation of the caller's array can't corrupt
  // the captured values.
  const snapshot = changes.map((c) => ({ id: c.id, oldSort: c.oldSort, newSort: c.newSort }));
  return {
    label,
    undo: () => { for (const c of snapshot) revert(c.id, c.oldSort); },
    redo: () => { for (const c of snapshot) apply(c.id, c.newSort); },
  };
}

/** A sibling for {@link renumberAround}: `fixed` is one whose `sortOrder` the renumber must leave alone. */
export interface RenumberSibling { id: number; sortOrder: number; fixed?: boolean }

/** Renumber `siblings` (already in display order) to distinct, increasing `sortOrder`s `step` apart, leaving each
 *  `fixed` sibling's value where it is and numbering the rest around it. A Missing Prefab placeholder inside an
 *  instance is fixed: its save cannot keep a `sortOrder` (#1818, `placeholderWriteRefusal`), so writing one would show a
 *  reorder the reload undoes. Where two fixed siblings share a value (a node placeholder loads at 0) with others between
 *  them, those keep the value too: only a drop INTO that span is refused (`planCollidingDrop`), not every drop in the
 *  group. */
export function renumberAround(siblings: readonly RenumberSibling[], step = 10): SiblingSortChange[] {
  // Display order sorts by sortOrder first, so the fixed values never decrease along it. Between two that tie, the even
  // split below is a gap of 0: the siblings there keep the shared value, which is the span no number fits.
  const fixedAt = siblings.flatMap((s, i) => (s.fixed ? [i] : []));
  const next: number[] = siblings.map((_, i) => i * step);
  if (fixedAt.length) {
    const first = fixedAt[0]!, last = fixedAt[fixedAt.length - 1]!;
    for (let j = 0; j < first; j++) next[j] = siblings[first]!.sortOrder - step * (first - j);
    for (let j = last + 1; j < siblings.length; j++) next[j] = siblings[last]!.sortOrder + step * (j - last);
    for (const i of fixedAt) next[i] = siblings[i]!.sortOrder;
    for (let k = 1; k < fixedAt.length; k++) {
      const a = fixedAt[k - 1]!, b = fixedAt[k]!;
      const gap = (siblings[b]!.sortOrder - siblings[a]!.sortOrder) / (b - a);
      for (let j = a + 1; j < b; j++) next[j] = siblings[a]!.sortOrder + gap * (j - a);
    }
  }
  return diffSiblingSorts(siblings.map((s, i) => ({ id: s.id, oldSort: s.sortOrder, newSort: next[i]! })));
}

/** The Hierarchy's drop beside `targetId` when its neighbours' `sortOrder`s collide: the renumber to apply and the value
 *  the dropped entity takes, or `{ stuck }` naming the kept placeholder that leaves no room. Decided BEFORE anything is
 *  written, so a refusal leaves no renumber entry behind (#1818 close-out re-review). `siblings` is the display order
 *  with the mover left out. The value is the midpoint with the renumbered neighbour, not a fixed ±5: `renumberAround`
 *  spaces the siblings between two kept values by less than 10, and ±5 then landed past the neighbour. Two kept
 *  placeholders side by side at one value (a node placeholder loads at 0) leave no number between them. */
export function planCollidingDrop(
  siblings: readonly RenumberSibling[], targetId: number, zone: 'before' | 'after',
): { changes: SiblingSortChange[]; newSort: number } | { stuck: number } {
  const renumbered = renumberAround(siblings);
  const next = new Map(siblings.map((s) => [s.id, s.sortOrder] as [number, number]));
  for (const c of renumbered) next.set(c.id, c.newSort);
  const at = siblings.findIndex((s) => s.id === targetId);
  const target = next.get(targetId) ?? 0;
  const neighbour = at < 0 ? undefined : zone === 'before' ? siblings[at - 1] : siblings[at + 1];
  if (!neighbour) return { changes: renumbered, newSort: zone === 'before' ? target - 5 : target + 5 };
  const other = next.get(neighbour.id)!;
  if (other === target) {
    // Name a real placeholder: the drop's neighbour or its target when fixed, else the nearest fixed sibling (a plain
    // one kept inside a tied span is not one).
    const nb = siblings.indexOf(neighbour);
    const order = [nb, at, ...siblings.map((_, i) => i).sort((x, y) => Math.abs(x - at) - Math.abs(y - at))];
    const named = order.find((i) => siblings[i]!.fixed);
    return { stuck: named !== undefined ? siblings[named]!.id : targetId };
  }
  return { changes: renumbered, newSort: (target + other) / 2 };
}
