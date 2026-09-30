/** `subscribeUndoRedoStep` — Unity's `UndoRedoPerformed`, the signal a buffered field ends its edit
 *  on (#1905). What it must be that `subscribeUndo` is not: fired by undo/redo STEPS only, never by a
 *  `pushAction` (a field's own keystroke commits push), and only after the step's data has moved, so
 *  a listener reading the store sees the undone value. */
import { describe, it, expect, beforeEach } from 'vitest';
import { setRunMode } from '@modoki/engine/runtime';
import { pushAction, undo, redo, clearHistory, subscribeUndoRedoStep } from '../../packages/modoki/src/editor/undo/undoManager';

beforeEach(() => { setRunMode('stopped'); clearHistory(); });

describe('subscribeUndoRedoStep', () => {
  it('fires once per undo and once per redo, AFTER the step moved the data', async () => {
    let value = 777;
    pushAction({ label: 'max particles', undo: () => { value = 400; }, redo: () => { value = 777; } });
    const seen: number[] = [];
    const off = subscribeUndoRedoStep(() => seen.push(value));
    await undo();
    expect(seen).toEqual([400]);
    await redo();
    expect(seen).toEqual([400, 777]);
    off();
  });

  it('does not fire on pushAction — a field\'s own commits must not end its edit', () => {
    let fired = 0;
    const off = subscribeUndoRedoStep(() => { fired++; });
    pushAction({ label: 'typed 7', undo: () => {}, redo: () => {} });
    pushAction({ label: 'typed 77', undo: () => {}, redo: () => {} });
    expect(fired).toBe(0);
    off();
  });

  it('fires for a step whose action throws — it ran, and the field must still re-sync', async () => {
    pushAction({ label: 'boom', undo: () => { throw new Error('boom'); }, redo: () => {} });
    let fired = 0;
    const off = subscribeUndoRedoStep(() => { fired++; });
    await undo().catch(() => {});
    expect(fired).toBe(1);
    off();
  });

  it('stops after unsubscribe', async () => {
    pushAction({ label: 'a', undo: () => {}, redo: () => {} });
    let fired = 0;
    const off = subscribeUndoRedoStep(() => { fired++; });
    off();
    await undo();
    expect(fired).toBe(0);
  });
});
