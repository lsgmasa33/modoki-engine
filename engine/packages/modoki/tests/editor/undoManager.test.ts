/** undoManager unit tests — push, undo, redo, labels, stack limits. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function getUndoManager() {
  return import('../../../src/editor/undo/undoManager');
}

beforeEach(async () => {
  vi.resetModules();
  const { clearHistory } = await getUndoManager();
  clearHistory();
});

describe('undoManager', () => {
  describe('pushAction', () => {
    it('stores an action and enables undo', async () => {
      const { pushAction, canUndo } = await getUndoManager();

      pushAction({ label: 'Test', undo: () => {}, redo: () => {} });

      expect(canUndo()).toBe(true);
    });

    it('clears the redo stack on new action', async () => {
      const { pushAction, undo, canRedo } = await getUndoManager();

      pushAction({ label: 'A', undo: () => {}, redo: () => {} });
      await undo();
      expect(canRedo()).toBe(true);

      pushAction({ label: 'B', undo: () => {}, redo: () => {} });
      expect(canRedo()).toBe(false);
    });

    it('respects MAX_STACK_SIZE', async () => {
      const { pushAction, canUndo, undo } = await getUndoManager();

      // Push 201 actions (MAX_STACK_SIZE is 200)
      for (let i = 0; i < 201; i++) {
        pushAction({ label: `Action ${i}`, undo: () => {}, redo: () => {} });
      }

      // Can still undo, but oldest action was dropped
      expect(canUndo()).toBe(true);

      // Undo 200 times — should work
      for (let i = 0; i < 200; i++) {
        expect(await undo()).toBe(true);
      }

      // 201st undo should fail (oldest was shifted out)
      expect(await undo()).toBe(false);
    });

    it('does not push while executing undo/redo', async () => {
      const { pushAction, undo, isExecutingUndoRedo } = await getUndoManager();

      let pushedDuringUndo = false;
      pushAction({
        label: 'Outer',
        undo: () => {
          expect(isExecutingUndoRedo()).toBe(true);
          pushAction({ label: 'Inner', undo: () => {}, redo: () => {} });
          pushedDuringUndo = true;
        },
        redo: () => {},
      });

      await undo();

      expect(pushedDuringUndo).toBe(true);
      // The inner action should NOT have been pushed
      // After undoing "Outer", canUndo should be false
      const { canUndo } = await getUndoManager();
      expect(canUndo()).toBe(false);
    });
  });

  describe('undo', () => {
    it('executes the undo callback', async () => {
      const { pushAction, undo } = await getUndoManager();

      let state = 'initial';
      pushAction({
        label: 'Change',
        undo: () => { state = 'undone'; },
        redo: () => { state = 'redone'; },
      });

      await undo();
      expect(state).toBe('undone');
    });

    it('returns false when stack is empty', async () => {
      const { undo } = await getUndoManager();

      expect(await undo()).toBe(false);
    });

    it('returns true when undo succeeds', async () => {
      const { pushAction, undo } = await getUndoManager();

      pushAction({ label: 'Test', undo: () => {}, redo: () => {} });

      expect(await undo()).toBe(true);
    });
  });

  describe('redo', () => {
    it('executes the redo callback after undo', async () => {
      const { pushAction, undo, redo } = await getUndoManager();

      let state = 'initial';
      pushAction({
        label: 'Change',
        undo: () => { state = 'undone'; },
        redo: () => { state = 'redone'; },
      });

      await undo();
      await redo();
      expect(state).toBe('redone');
    });

    it('returns false when redo stack is empty', async () => {
      const { redo } = await getUndoManager();

      expect(await redo()).toBe(false);
    });

    it('returns true when redo succeeds', async () => {
      const { pushAction, undo, redo } = await getUndoManager();

      pushAction({ label: 'Test', undo: () => {}, redo: () => {} });
      await undo();

      expect(await redo()).toBe(true);
    });
  });

  describe('labels', () => {
    it('returns undo label', async () => {
      const { pushAction, undoLabel } = await getUndoManager();

      pushAction({ label: 'Delete Entity', undo: () => {}, redo: () => {} });

      expect(undoLabel()).toBe('Delete Entity');
    });

    it('returns redo label after undo', async () => {
      const { pushAction, undo, redoLabel } = await getUndoManager();

      pushAction({ label: 'Reparent', undo: () => {}, redo: () => {} });
      await undo();

      expect(redoLabel()).toBe('Reparent');
    });

    it('returns empty string when no actions', async () => {
      const { undoLabel, redoLabel } = await getUndoManager();

      expect(undoLabel()).toBe('');
      expect(redoLabel()).toBe('');
    });
  });

  describe('pushSelectionChange', () => {
    it('pushes a selection action with _isSelection flag', async () => {
      const { pushSelectionChange, undo, canUndo } = await getUndoManager();

      let selState = 0;
      pushSelectionChange('Selection', () => { selState = -1; }, () => { selState = 1; });

      expect(canUndo()).toBe(true);
      await undo();
      expect(selState).toBe(-1);
    });
  });

  describe('coalescing (coalesceKey + COALESCE_MS window)', () => {
    // Model a field whose value is edited keystroke-by-keystroke. Each edit's
    // undo restores the value captured BEFORE that edit; redo applies the new
    // value — exactly how entityActions builds field actions.
    function makeEditor(pushAction: any, key: string) {
      const cell = { value: 0 };
      return (next: number) => {
        const before = cell.value;
        cell.value = next;
        pushAction({
          label: `Edit x=${next}`,
          undo: () => { cell.value = before; },
          redo: () => { cell.value = next; },
          coalesceKey: key,
        });
        return cell;
      };
    }

    it('merges consecutive same-key edits within the window into ONE entry', async () => {
      const mod = await getUndoManager();
      let t = 1000;
      mod._setUndoClock(() => t);
      const edit = makeEditor(mod.pushAction, 'field:x');

      const cell = edit(1); t += 100;          // "1"
      edit(12); t += 100;                       // "12"
      edit(125);                                // "125"
      expect(cell.value).toBe(125);

      // One undo step reverts the whole typed value to the pre-chain state…
      expect(await mod.undo()).toBe(true);
      expect(cell.value).toBe(0);
      expect(await mod.undo()).toBe(false);     // …because it's a single entry

      // …and one redo restores the latest typed value.
      expect(await mod.redo()).toBe(true);
      expect(cell.value).toBe(125);
      expect(mod.undoLabel()).toBe('Edit x=125'); // label advanced to the latest
    });

    it('starts a new entry once the window elapses', async () => {
      const mod = await getUndoManager();
      let t = 1000;
      mod._setUndoClock(() => t);
      const edit = makeEditor(mod.pushAction, 'field:x');

      const cell = edit(5); t += 600;           // gap > COALESCE_MS (500)
      edit(9);
      expect(cell.value).toBe(9);

      expect(await mod.undo()).toBe(true);
      expect(cell.value).toBe(5);               // first undo: 9 → 5
      expect(await mod.undo()).toBe(true);
      expect(cell.value).toBe(0);               // second undo: 5 → 0 (separate entry)
    });

    it('does not merge edits with different keys', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000);
      const editX = makeEditor(mod.pushAction, 'field:x');
      const editY = makeEditor(mod.pushAction, 'field:y');
      editX(1);
      editY(2);
      expect(await mod.undo()).toBe(true);
      expect(await mod.undo()).toBe(true);      // two separate entries
      expect(await mod.undo()).toBe(false);
    });

    it('breakUndoCoalescing() forces the next same-key edit into a fresh entry', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000);            // same tick → would coalesce
      const edit = makeEditor(mod.pushAction, 'field:x');
      edit(1);
      mod.breakUndoCoalescing();
      edit(2);
      expect(await mod.undo()).toBe(true);
      expect(await mod.undo()).toBe(true);      // not merged
    });

    it('an undo resets the chain so a later same-key edit does not merge into a restored action', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000);
      const edit = makeEditor(mod.pushAction, 'field:x');
      edit(1);
      await mod.undo();                          // pops the entry; chain reset
      edit(2);                                   // same tick + key, but stack changed
      expect(mod.undoLabel()).toBe('Edit x=2');
      expect(await mod.undo()).toBe(true);
      expect(await mod.undo()).toBe(false);      // the edit(2) is its own entry
    });

    it('actions without a coalesceKey never merge (existing behavior)', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000);
      mod.pushAction({ label: 'A', undo: () => {}, redo: () => {} });
      mod.pushAction({ label: 'B', undo: () => {}, redo: () => {} });
      expect(await mod.undo()).toBe(true);
      expect(await mod.undo()).toBe(true);
      expect(await mod.undo()).toBe(false);
    });

    it('a coalesced merge still clears the redo stack', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000);
      const edit = makeEditor(mod.pushAction, 'field:x');
      edit(1);
      await mod.undo();                          // redo now available
      expect(mod.canRedo()).toBe(true);
      // Re-typing (same key, but chain was reset by the undo) clears redo.
      edit(2);
      expect(mod.canRedo()).toBe(false);
    });
  });

  describe('clearHistory', () => {
    it('clears both stacks', async () => {
      const { pushAction, undo, canUndo, canRedo, clearHistory } = await getUndoManager();

      pushAction({ label: 'A', undo: () => {}, redo: () => {} });
      await undo();

      clearHistory();

      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(false);
    });
  });

  // The editor menu memo subscribes to these to recompute only when undo/redo
  // state actually changes (core-store-backend F3). The version must bump on every
  // stack mutation and listeners must fire; getUndoVersion is a stable snapshot.
  describe('subscribeUndo / getUndoVersion', () => {
    it('bumps the version + fires listeners on push, undo, redo, and clear', async () => {
      const { pushAction, undo, redo, clearHistory, subscribeUndo, getUndoVersion } = await getUndoManager();

      let calls = 0;
      const unsub = subscribeUndo(() => { calls++; });
      const v0 = getUndoVersion();

      pushAction({ label: 'A', undo: () => {}, redo: () => {} });
      expect(getUndoVersion()).toBeGreaterThan(v0);
      expect(calls).toBe(1);

      await undo();
      expect(calls).toBe(2);

      await redo();
      expect(calls).toBe(3);

      clearHistory();
      expect(calls).toBe(4);

      // After unsubscribe, further mutations don't call the listener (but still bump).
      unsub();
      const vBefore = getUndoVersion();
      pushAction({ label: 'B', undo: () => {}, redo: () => {} });
      expect(calls).toBe(4);
      expect(getUndoVersion()).toBeGreaterThan(vBefore);
    });

    it('bumps on a coalesced edit so the menu reflects the advanced label', async () => {
      const mod = await getUndoManager();
      mod._setUndoClock(() => 1000); // fixed clock → both edits inside COALESCE_MS

      let calls = 0;
      mod.subscribeUndo(() => { calls++; });
      mod.pushAction({ label: 'x=1', coalesceKey: 'e.T.x', undo: () => {}, redo: () => {} });
      mod.pushAction({ label: 'x=2', coalesceKey: 'e.T.x', undo: () => {}, redo: () => {} }); // merges into top
      // Two notifications: one per push (the second is the coalesce-merge path).
      expect(calls).toBe(2);
      expect(mod.undoLabel()).toBe('x=2');
    });
  });

  // Missing Test 8 (editor-prefab-system.md F6): async undo/redo must be
  // serialized. Push actions whose undo/redo return Promises, fire two calls
  // WITHOUT awaiting (as the keyboard handler does), and assert the stacks stay
  // consistent — the second call must wait for the first to fully resolve
  // (pop + await + push) before it pops.
  describe('async undo/redo serialization (in-flight mutex)', () => {
    /** A deferred whose resolution the test controls. */
    function defer() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    }

    /** Flush enough microtask turns for a promise-chain hop + async-fn entry. */
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    it('does not interleave two un-awaited undo() calls', async () => {
      const { pushAction, undo, canUndo, canRedo } = await getUndoManager();

      const order: string[] = [];
      // Two actions whose undo blocks on a deferred we resolve manually.
      const gateA = defer();
      const gateB = defer();
      // B is on top (pushed last) → first undo pops B, second pops A.
      pushAction({
        label: 'A',
        undo: async () => { order.push('A:start'); await gateA.promise; order.push('A:end'); },
        redo: () => {},
      });
      pushAction({
        label: 'B',
        undo: async () => { order.push('B:start'); await gateB.promise; order.push('B:end'); },
        redo: () => {},
      });

      // Fire both WITHOUT awaiting — mimics rapid Cmd+Z, Cmd+Z.
      const p1 = undo();
      const p2 = undo();

      // The second undo must NOT have popped A yet — it's queued behind the first.
      await flush(); // let microtasks settle
      expect(order).toEqual(['B:start']); // only the first undo has started

      // Resolve B's undo → first call finishes, pushes B to redo, THEN A starts.
      gateB.resolve();
      await flush();
      expect(order).toEqual(['B:start', 'B:end', 'A:start']);

      gateA.resolve();
      expect(await p1).toBe(true);
      expect(await p2).toBe(true);
      expect(order).toEqual(['B:start', 'B:end', 'A:start', 'A:end']);

      // Both undone in order → undo stack empty, redo stack has both, in order.
      expect(canUndo()).toBe(false);
      expect(canRedo()).toBe(true);
    });

    it('serializes an undo() immediately followed by an un-awaited redo()', async () => {
      const { pushAction, undo, redo, undoLabel, redoLabel } = await getUndoManager();

      const order: string[] = [];
      const gate = defer();
      pushAction({
        label: 'A',
        undo: async () => { order.push('undo:start'); await gate.promise; order.push('undo:end'); },
        redo: async () => { order.push('redo:start'); order.push('redo:end'); },
      });

      // Fire undo then redo without awaiting either.
      const pUndo = undo();
      const pRedo = redo();

      await flush();
      // redo must NOT run before undo completes — otherwise it would pop an empty
      // redo stack (A hasn't moved there yet) and corrupt order.
      expect(order).toEqual(['undo:start']);

      gate.resolve();
      expect(await pUndo).toBe(true);
      expect(await pRedo).toBe(true);

      // undo moved A to redo, then redo moved it back to undo — net: A is undoable.
      expect(order).toEqual(['undo:start', 'undo:end', 'redo:start', 'redo:end']);
      expect(undoLabel()).toBe('A');
      expect(redoLabel()).toBe('');
    });

    it('a rejecting undo does not wedge the queue', async () => {
      const { pushAction, undo } = await getUndoManager();

      const order: string[] = [];
      pushAction({ label: 'A', undo: () => { order.push('A'); }, redo: () => {} });
      pushAction({ label: 'B', undo: async () => { order.push('B'); throw new Error('boom'); }, redo: () => {} });

      // First undo (B) rejects; the second (A) must still run.
      const pB = undo();
      const pA = undo();
      await expect(pB).rejects.toThrow('boom');
      expect(await pA).toBe(true);
      expect(order).toEqual(['B', 'A']);
    });
  });
});

/**
 * C7 — the edit-version, which is how load_scene/new_scene learn there is unsaved live work
 * to protect.
 *
 * It must NOT count selection: CLAUDE.md deliberately pushes an undo entry per selection
 * change, so `getUndoVersion` (which bumps on ANY stack mutation) would read as "unsaved
 * work" after a mere click and make load_scene nag constantly. `getEditVersion` counts only
 * real edits.
 */
describe('getEditVersion (C7)', () => {
  const action = (label: string) => ({ label, undo: () => {}, redo: () => {} });

  it('bumps on a real edit', async () => {
    const { pushAction, getEditVersion } = await getUndoManager();
    const before = getEditVersion();
    pushAction(action('Create Cube'));
    expect(getEditVersion()).toBe(before + 1);
  });

  it('does NOT bump on a selection change — a click is not unsaved work', async () => {
    const { pushSelectionChange, getEditVersion, getUndoVersion } = await getUndoManager();
    const before = getEditVersion();
    const undoVersionBefore = getUndoVersion();
    pushSelectionChange('Select Cube', () => {}, () => {});
    expect(getEditVersion()).toBe(before);              // not an edit
    expect(getUndoVersion()).toBeGreaterThan(undoVersionBefore); // but the stack did change
  });

  it('bumps on undo/redo of a real edit — the world moved relative to disk', async () => {
    const { pushAction, undo, redo, getEditVersion } = await getUndoManager();
    pushAction(action('Create Cube'));
    const afterPush = getEditVersion();
    await undo();
    expect(getEditVersion()).toBeGreaterThan(afterPush);
    const afterUndo = getEditVersion();
    await redo();
    expect(getEditVersion()).toBeGreaterThan(afterUndo);
  });

  it('does not bump when there is nothing to undo', async () => {
    const { clearHistory, undo, getEditVersion } = await getUndoManager();
    clearHistory();
    const before = getEditVersion();
    await undo();
    expect(getEditVersion()).toBe(before);
  });

  it('is monotonic — never reused, so a stale snapshot always reads as dirty', async () => {
    const { pushAction, getEditVersion } = await getUndoManager();
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) { pushAction(action(`edit ${i}`)); seen.add(getEditVersion()); }
    expect(seen.size).toBe(5);
  });
});
