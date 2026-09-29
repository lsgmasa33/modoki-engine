/** prefabInstantiateUndo — the shared prefab-instantiate undo entry (pure).
 *
 *  Guards prefab F3: the Assets-panel copy used to close over a `const` root id
 *  while `redo` spawned a fresh instance into a new local id, so after
 *  undo→redo→undo the second undo deleted the dead original and ORPHANED the
 *  redo-spawned instance. The shared helper keeps the live id in one mutable slot
 *  so undo always targets whatever is currently live. */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/** The ids alive in the fake world: `require` finds only these (I19 — the undo holds its instance by guid and a miss
 *  REFUSES, #1827; it no longer falls back to the raw id). Each test's respawn/remove keep it current. */
const live = vi.hoisted(() => new Set<number>());
// The real UndoRefusedError, set after the import below (the factory importing it would wait on itself: see
// createPrefabUndo.test.ts).
const err = vi.hoisted(() => ({ Refused: Error as new (m: string, t: string) => Error }));
vi.mock('../../src/editor/undo/entityRef', () => ({
  entityRef: (id: number) => ({
    guid: `g-${id}`, rawId: id, resolve: () => (live.has(id) ? id : null),
    require: () => { if (!live.has(id)) throw new err.Refused(`${id} is gone`, `${id} is no longer in the scene`); return id; },
  }),
}));

import { makePrefabInstantiateAction } from '../../src/editor/undo/prefabInstantiateUndo';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
err.Refused = UndoRefusedError;
beforeEach(() => { live.clear(); });

// Console spies are restored in afterEach, NOT inline: a failing assertion skips the rest
// of the body, so an inline restore never runs and console stays mocked for every later
// test (the trap documented in assetUndo.test.ts).
let spies: Array<{ mockRestore: () => void }> = [];
const spyError = () => {
  const s = vi.spyOn(console, 'error').mockImplementation(() => {});
  spies.push(s);
  return s;
};
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

describe('makePrefabInstantiateAction', () => {
  it('a second undo (after redo) tears down the REDO-spawned instance, not the dead original', async () => {
    let nextId = 100;
    const removed: number[] = [];
    const spawned: number[] = [];
    live.add(1);
    const action = makePrefabInstantiateAction({
      label: 'Instantiate "X"',
      initialId: 1, // the first (pre-pushAction) instance
      respawn: async () => { const id = ++nextId; spawned.push(id); live.add(id); return id; },
      remove: (id) => { removed.push(id); live.delete(id); },
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
    live.add(1);
    const action = makePrefabInstantiateAction({
      label: 'i',
      initialId: 1,
      respawn: async () => { live.add(++nextId); return nextId; },
      remove: (id) => { removed.push(id); live.delete(id); },
    });

    await action.undo(); // remove 1
    await action.redo(); // spawn 11
    await action.undo(); // remove 11
    await action.redo(); // spawn 12
    await action.undo(); // remove 12

    expect(removed).toEqual([1, 11, 12]);
    expect(new Set(removed).size).toBe(removed.length); // every removal hit a distinct, live id
  });

  it('leaves the live id unchanged when respawn returns null (prefab file gone between undo and redo), and the next undo REFUSES', async () => {
    const err = spyError();
    const removed: number[] = [];
    live.add(5);
    const action = makePrefabInstantiateAction({
      label: 'i',
      initialId: 5,
      respawn: async () => null, // fetch failed — nothing new spawned
      remove: (id) => { removed.push(id); live.delete(id); },
    });

    await action.undo(); // remove 5
    await action.redo(); // respawn fails → no new instance, slot stays 5
    // Nothing holds the instance now, so the undo refuses (#1827, I19). It used to delete whatever held the raw id 5 —
    // "a no-op on the dead id" only while nothing else had taken that id.
    expect(() => action.undo()).toThrow(UndoRefusedError);
    expect(removed).toEqual([5]);
    // The no-op redo is still said (#308): redo pops the stack and reads as done, so the failure has to say so.
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('Redo');
  });

  // Mutation: restore `?? currentRef.rawId` in the undo — it removes the raw id, which another entity may hold now.
  it('an undo whose instance is gone refuses rather than removing the raw id', async () => {
    const removed: number[] = [];
    live.add(7);
    const action = makePrefabInstantiateAction({ label: 'i', initialId: 7, respawn: async () => null, remove: (id) => { removed.push(id); } });
    live.delete(7); // a world swap lost it
    expect(() => action.undo()).toThrow(UndoRefusedError);
    expect(removed).toEqual([]);
  });
});
