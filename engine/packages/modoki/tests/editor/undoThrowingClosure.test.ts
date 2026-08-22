/** A THROWING undo/redo closure (#310) — the bookkeeping `undo()`/`redo()` used to skip.
 *
 *  BEFORE: the action was popped, then `await action.undo()` ran with only `_executing` in a
 *  try/finally. A throw skipped everything after it — `redoStack.push`, `notifyEdited`,
 *  `markAffectedScenesDirty`, `notifyUndoChanged` and the `!undo` event — so the action was
 *  lost from BOTH stacks with no report, the panel kept rendering the pre-throw history, and
 *  `serialize` handed the rejection to a caller that does not catch it. `undo()` still
 *  resolved... never, in fact: it REJECTED, and `agentEditorOps`' MCP op awaited it.
 *
 *  AFTER (owner's policy, 2026-08-21): the action is still DROPPED — deliberately, and loudly.
 *  These tests pin the four halves of that: dropped from both stacks, reported, subscribers
 *  notified, and a journal event carrying `failed: true`. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function getUndoManager() {
  return import('../../src/editor/undo/undoManager');
}
async function getJournal() {
  return import('../../src/editor/editorJournal');
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { clearHistory } = await getUndoManager();
  clearHistory();
  const { clearEditorJournal } = await getJournal();
  clearEditorJournal();
});
afterEach(() => { errorSpy.mockRestore(); });

const boom = () => { throw new Error('disk on fire'); };

describe('a throwing undo closure', () => {
  it('does not reject — the caller gets `false`, not an unhandled rejection', async () => {
    const { pushAction, undo } = await getUndoManager();
    pushAction({ label: 'Explode', undo: boom, redo: () => {} });

    // If this rejected, the await would throw and the test would fail here rather than assert.
    await expect(undo()).resolves.toBe(false);
  });

  it('drops the action from BOTH stacks', async () => {
    const { pushAction, undo, canUndo, canRedo } = await getUndoManager();
    pushAction({ label: 'Explode', undo: boom, redo: () => {} });

    await undo();

    expect(canUndo()).toBe(false);   // popped, and not put back
    expect(canRedo()).toBe(false);   // and NOT pushed across as if it had worked
  });

  it('reports the throw, naming the action and saying the entry was dropped', async () => {
    const { pushAction, undo } = await getUndoManager();
    pushAction({ label: 'Explode', undo: boom, redo: () => {} });

    await undo();

    expect(errorSpy).toHaveBeenCalled();
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('Undo');
    expect(msg).toContain('Explode');
    expect(msg).toContain('disk on fire');
    expect(msg).toContain('DROPPED');
  });

  // The stack really did change (the entry is gone), so a panel that isn't notified keeps
  // rendering history that no longer exists — the failure the user actually SEES.
  it('notifies subscribers, so the panel re-renders the shortened history', async () => {
    const { pushAction, undo, subscribeUndo, getUndoVersion } = await getUndoManager();
    pushAction({ label: 'Explode', undo: boom, redo: () => {} });
    const listener = vi.fn();
    const unsub = subscribeUndo(listener);
    const before = getUndoVersion();

    await undo();

    expect(listener).toHaveBeenCalled();
    expect(getUndoVersion()).toBeGreaterThan(before);
    unsub();
  });

  it('emits the journal event with failed: true — never a bare `!undo` claiming success', async () => {
    const { pushAction, undo } = await getUndoManager();
    const { readEditorJournal } = await getJournal();
    pushAction({ label: 'Explode', undo: boom, redo: () => {} });

    await undo();

    const events = readEditorJournal({ type: '!undo' });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.failed).toBe(true);
    expect(payload.label).toBe('Explode');
  });

  // A closure may legitimately throw a falsy value; a sentinel-based catch would read that
  // as success and push the action across.
  it('treats a thrown `undefined` as a failure, not a success', async () => {
    const { pushAction, undo, canRedo } = await getUndoManager();
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    pushAction({ label: 'Falsy', undo: () => { throw undefined; }, redo: () => {} });

    await expect(undo()).resolves.toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('a rejected promise is caught the same as a synchronous throw', async () => {
    const { pushAction, undo, canRedo } = await getUndoManager();
    pushAction({ label: 'Async boom', undo: async () => { throw new Error('async'); }, redo: () => {} });

    await expect(undo()).resolves.toBe(false);
    expect(canRedo()).toBe(false);
  });
});

describe('a throwing redo closure', () => {
  it('drops the action from both stacks and reports the REDO direction', async () => {
    const { pushAction, undo, redo, canUndo, canRedo } = await getUndoManager();
    pushAction({ label: 'Explode', undo: () => {}, redo: boom });

    await undo();               // succeeds — the action moves to the redo stack
    expect(canRedo()).toBe(true);

    await expect(redo()).resolves.toBe(false);

    expect(canRedo()).toBe(false);
    expect(canUndo()).toBe(false);
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('Redo');
    expect(msg).toContain('cannot be undone');   // the direction-specific recovery line
  });
});

describe('the queue survives a throw', () => {
  // `serialize` chains every undo/redo through one promise. A rejection used to propagate out
  // of it; the chain itself was already isolated, but the CALLER's await was not — so an agent
  // op or a keybinding handler saw an exception where the contract promises a boolean.
  it('a later undo still runs normally after an earlier one threw', async () => {
    const { pushAction, undo, canUndo } = await getUndoManager();
    const good = vi.fn();
    pushAction({ label: 'Good', undo: good, redo: () => {} });
    pushAction({ label: 'Bad', undo: boom, redo: () => {} });

    await undo();                       // Bad — throws, dropped
    await expect(undo()).resolves.toBe(true);   // Good — unaffected

    expect(good).toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
  });
});

/** The reporter itself is guarded (#310 close-out review). `reportUndoThrew` reaches into the
 *  editor store to toast; if it threw, an unguarded call would skip the very bookkeeping this
 *  fix exists to guarantee and reject out through `serialize` — #310, one level up. */
describe('a throwing REPORTER cannot skip the bookkeeping', () => {
  it('still notifies, still journals, still resolves false', async () => {
    vi.resetModules();
    vi.doMock('../../src/editor/undo/undoFailure', () => ({
      reportUndoThrew: () => { throw new Error('the reporter itself is broken'); },
      reportUndoFailure: () => {},
      COLLISION_STATUS: 409,
    }));

    const { pushAction, undo, clearHistory, getUndoVersion, canUndo, canRedo } = await getUndoManager();
    const { readEditorJournal, clearEditorJournal } = await getJournal();
    clearHistory();
    clearEditorJournal();

    pushAction({ label: 'Explode', undo: boom, redo: () => {} });
    const before = getUndoVersion();

    await expect(undo()).resolves.toBe(false);

    expect(getUndoVersion()).toBeGreaterThan(before);   // notified
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);                       // still dropped
    const events = readEditorJournal({ type: '!undo' });
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).failed).toBe(true);

    vi.doUnmock('../../src/editor/undo/undoFailure');
  });
});
