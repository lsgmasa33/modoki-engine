/** prefabInstantiateUndo — the shared prefab-instantiate undo entry (pure).
 *
 *  Guards prefab F3: the Assets-panel copy used to close over a `const` root id
 *  while `redo` spawned a fresh instance into a new local id, so after
 *  undo→redo→undo the second undo deleted the dead original and ORPHANED the
 *  redo-spawned instance. The shared helper keeps the live id in one mutable slot
 *  so undo always targets whatever is currently live. */

import { describe, it, expect } from 'vitest';
import { makePrefabInstantiateAction } from '../../src/editor/undo/prefabInstantiateUndo';

describe('makePrefabInstantiateAction', () => {
  it('a second undo (after redo) tears down the REDO-spawned instance, not the dead original', async () => {
    let nextId = 100;
    const removed: number[] = [];
    const spawned: number[] = [];
    const action = makePrefabInstantiateAction({
      label: 'Instantiate "X"',
      initialId: 1, // the first (pre-pushAction) instance
      respawn: async () => { const id = ++nextId; spawned.push(id); return id; },
      remove: (id) => { removed.push(id); },
    });

    await action.undo(); // removes the original
    expect(removed).toEqual([1]);

    await action.redo(); // spawns a fresh instance (101)
    expect(spawned).toEqual([101]);

    await action.undo(); // MUST remove 101 (the live one), not 1 again
    expect(removed).toEqual([1, 101]);
  });

  it('repeated undo/redo cycles never re-delete a stale id (no orphan accrual)', async () => {
    let nextId = 10;
    const removed: number[] = [];
    const action = makePrefabInstantiateAction({
      label: 'i',
      initialId: 1,
      respawn: async () => ++nextId,
      remove: (id) => removed.push(id),
    });

    await action.undo(); // remove 1
    await action.redo(); // spawn 11
    await action.undo(); // remove 11
    await action.redo(); // spawn 12
    await action.undo(); // remove 12

    expect(removed).toEqual([1, 11, 12]);
    expect(new Set(removed).size).toBe(removed.length); // every removal hit a distinct, live id
  });

  it('leaves the live id unchanged when respawn returns null (prefab file gone between undo and redo)', async () => {
    const removed: number[] = [];
    const action = makePrefabInstantiateAction({
      label: 'i',
      initialId: 5,
      respawn: async () => null, // fetch failed — nothing new spawned
      remove: (id) => removed.push(id),
    });

    await action.undo(); // remove 5
    await action.redo(); // respawn fails → no new instance, slot stays 5
    await action.undo(); // still references 5 (a no-op delete on the dead id in real code)
    expect(removed).toEqual([5, 5]);
  });
});
