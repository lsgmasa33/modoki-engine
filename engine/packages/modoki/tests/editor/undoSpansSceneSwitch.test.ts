/** An undo/redo step that awaits ACROSS a history swap drops its entry (#1575 close-out review).
 *
 *  `swapHistory` refills the live stacks IN PLACE, so a step whose closure was still awaiting when a scene load, an
 *  Exit from prefab edit or a Create Scene swapped the history pushed its entry onto the INCOMING world's stack. A
 *  later redo there ran it against a world it was never recorded on: Apply's redo loaded the old world's snapshot
 *  under the new scene's key and saved it into that scene's file. The entry is now dropped, since the world it
 *  belongs to is gone. An `_isFileDirect` entry edits an asset file, which outlives the swap, so it is kept.
 *  Mutations: in `runStep`, push whenever `ok` (ignore the liveness capture) — the three drop cases go red, the controls stay
 *  green; drop the `_isFileDirect` exemption — the asset-file control goes red; mark edited regardless — the first
 *  case goes red; mark the named scenes dirty regardless — the dirty/journal case goes red. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushAction, undo, redo, canUndo, canRedo, swapHistory, getEditVersion, _resetHistoryContexts, type UndoAction,
} from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';
import { isSceneDirty, clearAllSceneDirty } from '../../src/editor/scene/sceneDirty';
import { readEditorJournal, clearEditorJournal } from '../../src/editor/editorJournal';

const A = '/scenes/A.json';
const B = '/scenes/B.json';
const quietWarn = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

/** An action whose undo and redo each run `during` in the middle of an await, the way an Apply's undo awaits the
 *  prefab file install. */
function spanning(during: () => void, extra: Partial<UndoAction> = {}): UndoAction {
  const step = async () => { await Promise.resolve(); during(); await Promise.resolve(); };
  return { label: 'Spanning', undo: step, redo: step, ...extra };
}

beforeEach(() => {
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory(A);
  clearAllSceneDirty();
  clearEditorJournal();
});

const BASE = 'cccccccc-0000-4000-8000-000000001575';

describe('a step that spans a history swap', () => {
  it('an undo does not land on the incoming world\'s redo stack, nor go back to its own', async () => {
    pushAction(spanning(() => swapHistory(B)));
    const edits = getEditVersion();
    const restore = quietWarn();
    try { await undo(); } finally { restore(); }
    expect(canRedo()).toBe(false); // B's stacks are B's
    expect(getEditVersion()).toBe(edits); // B is not marked edited by a step on A's world
    swapHistory(A);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('a redo does not land on the incoming world\'s undo stack', async () => {
    let swap = false;
    pushAction(spanning(() => { if (swap) swapHistory(B); }));
    await undo();
    expect(canRedo()).toBe(true); // precondition: no swap on the undo
    swap = true;
    const restore = quietWarn();
    try { await redo(); } finally { restore(); }
    expect(canUndo()).toBe(false);
    swapHistory(A);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('the scenes it names are not marked dirty, and its journal event says it was dropped', async () => {
    pushAction(spanning(() => swapHistory(B), { affectedScenes: [BASE] }));
    clearAllSceneDirty(); // the push marked it; the load that swaps B in clears every flag
    const restore = quietWarn();
    try { await undo(); } finally { restore(); }
    expect(isSceneDirty(BASE)).toBe(false); // a base of the world that left; the incoming one would read as unsaved
    const events = readEditorJournal({ type: '!undo' });
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).dropped).toBe(true);
  });

  it('a Create Scene\'s fresh swap under the SAME key counts too', async () => {
    swapHistory('');
    pushAction(spanning(() => swapHistory('', { freshIncoming: true })));
    const restore = quietWarn();
    try { await undo(); } finally { restore(); }
    expect(canRedo()).toBe(false);
  });
});

describe('controls', () => {
  it('an awaiting step with no swap lands on the other stack as usual', async () => {
    pushAction(spanning(() => {}, { affectedScenes: [BASE] }));
    clearAllSceneDirty(); // the push marked it
    const edits = getEditVersion();
    await undo();
    expect(canRedo()).toBe(true);
    expect(getEditVersion()).toBe(edits + 1);
    expect(isSceneDirty(BASE)).toBe(true);
    expect((readEditorJournal({ type: '!undo' })[0].payload as Record<string, unknown>).dropped).toBeUndefined();
  });

  it('an asset-file edit spanning a swap is kept: the file outlives the world', async () => {
    pushAction(spanning(() => swapHistory(B), { _isFileDirect: true }));
    await undo();
    expect(canRedo()).toBe(true);
  });
});
