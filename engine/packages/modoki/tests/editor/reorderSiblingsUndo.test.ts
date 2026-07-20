/** reorderSiblingsUndo — sibling sortOrder renumber as one undoable entry (pure).
 *
 *  Guards Hierarchy F1: a drag-reorder among colliding sortOrders used to renumber
 *  the whole sibling group via raw writeTraitField, bypassing undo — Cmd+Z left
 *  every sibling rewritten. The helper snapshots prior sorts and restores them. */

import { describe, it, expect } from 'vitest';
import {
  makeReorderSiblingsAction,
  diffSiblingSorts,
  type SiblingSortChange,
} from '../../src/editor/undo/reorderSiblingsUndo';

describe('diffSiblingSorts', () => {
  it('drops entries whose sort is unchanged', () => {
    const changes: SiblingSortChange[] = [
      { id: 1, oldSort: 0, newSort: 0 }, // unchanged
      { id: 2, oldSort: 0, newSort: 10 },
      { id: 3, oldSort: 20, newSort: 20 }, // unchanged
    ];
    expect(diffSiblingSorts(changes)).toEqual([{ id: 2, oldSort: 0, newSort: 10 }]);
  });

  it('keeps everything when all entries move', () => {
    const changes: SiblingSortChange[] = [
      { id: 1, oldSort: 0, newSort: 0 },
      { id: 2, oldSort: 0, newSort: 10 },
      { id: 3, oldSort: 0, newSort: 20 },
    ];
    // legacy "all sortOrder 0" → id 1 stays at 0, others move
    expect(diffSiblingSorts(changes).map((c) => c.id)).toEqual([2, 3]);
  });
});

describe('makeReorderSiblingsAction', () => {
  function recorder() {
    const writes: Array<[number, number]> = [];
    const live = new Map<number, number>();
    const apply = (id: number, sort: number) => { writes.push([id, sort]); live.set(id, sort); };
    return { writes, live, apply };
  }

  it('redo applies new sorts; undo restores the snapshotted old sorts', () => {
    const { writes, live, apply } = recorder();
    // legacy collision: ids 1,2,3 all at sortOrder 0 → renumber to 0,10,20
    const changes: SiblingSortChange[] = [
      { id: 1, oldSort: 0, newSort: 0 },
      { id: 2, oldSort: 0, newSort: 10 },
      { id: 3, oldSort: 0, newSort: 20 },
    ];
    const action = makeReorderSiblingsAction(diffSiblingSorts(changes), apply, 'Renumber siblings');

    action.redo();
    expect(live.get(2)).toBe(10);
    expect(live.get(3)).toBe(20);

    action.undo();
    expect(live.get(2)).toBe(0);
    expect(live.get(3)).toBe(0);

    // the only ids ever written are the ones that actually moved (id 1 untouched)
    expect(new Set(writes.map((w) => w[0]))).toEqual(new Set([2, 3]));
  });

  it('round-trips across multiple undo/redo cycles', () => {
    const { live, apply } = recorder();
    const changes = diffSiblingSorts([
      { id: 10, oldSort: 5, newSort: 0 },
      { id: 11, oldSort: 5, newSort: 10 },
    ]);
    const action = makeReorderSiblingsAction(changes, apply);

    action.redo();
    action.undo();
    action.redo();
    expect(live.get(10)).toBe(0);
    expect(live.get(11)).toBe(10);
    action.undo();
    expect(live.get(10)).toBe(5);
    expect(live.get(11)).toBe(5);
  });

  it('snapshots defensively — mutating the caller array after build does not affect the action', () => {
    const { live, apply } = recorder();
    const changes: SiblingSortChange[] = [{ id: 1, oldSort: 3, newSort: 30 }];
    const action = makeReorderSiblingsAction(changes, apply);
    changes[0].newSort = 999; // caller mutates after building the action
    action.redo();
    expect(live.get(1)).toBe(30); // used the snapshot, not the mutated 999
  });

  it('defaults the label but accepts an override', () => {
    expect(makeReorderSiblingsAction([], () => {}).label).toBe('Reorder siblings');
    expect(makeReorderSiblingsAction([], () => {}, 'Renumber siblings').label).toBe('Renumber siblings');
  });
});
