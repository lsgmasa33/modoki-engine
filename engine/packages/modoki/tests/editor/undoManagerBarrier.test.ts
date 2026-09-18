/** undoManager — play barrier (undoDepth/truncateUndoTo) + per-context history
 *  (swapHistory). Pure module, no mocks. */

import { describe, it, expect, beforeEach } from 'vitest';
import { setRunMode } from '../../src/runtime/core/playState';
import {
  pushAction, undo, redo, canUndo, canRedo, undoLabel,
  undoDepth, truncateUndoTo, swapHistory, _resetHistoryContexts,
} from '../../src/editor/undo/undoManager';

const noop = () => {};
const act = (label: string) => ({ label, undo: noop, redo: noop });

// Undo/redo refuse outside the authoring mode (#1148), and the runtime defaults to 'playing'.
beforeEach(() => { setRunMode('stopped'); });

beforeEach(() => { _resetHistoryContexts(); });

describe('play barrier — undoDepth / truncateUndoTo', () => {
  it('truncates only entries pushed after the barrier, and clears redo', async () => {
    pushAction(act('a'));
    pushAction(act('b'));
    const barrier = undoDepth(); // 2 — simulates Play-enter
    pushAction(act('during-play-1'));
    pushAction(act('during-play-2'));
    await undo(); // moves one during-play entry to redo
    expect(canRedo()).toBe(true);

    truncateUndoTo(barrier); // simulates Stop
    expect(undoDepth()).toBe(2);
    expect(undoLabel()).toBe('b'); // pre-Play history intact
    expect(canRedo()).toBe(false); // redo cleared
  });

  it('depth >= length is a no-op for undo; depth < 0 clamps to 0', () => {
    pushAction(act('a'));
    pushAction(act('b'));
    truncateUndoTo(5);
    expect(undoDepth()).toBe(2);
    truncateUndoTo(-3);
    expect(undoDepth()).toBe(0);
  });
});

describe('per-context history — swapHistory', () => {
  it('saves the active stack and restores it when swapping back', () => {
    swapHistory('sceneA');
    pushAction(act('a1'));
    pushAction(act('a2'));
    expect(undoDepth()).toBe(2);

    swapHistory('sceneB'); // first visit — empty
    expect(undoDepth()).toBe(0);
    expect(canUndo()).toBe(false);
    pushAction(act('b1'));
    expect(undoDepth()).toBe(1);

    swapHistory('sceneA'); // restored
    expect(undoDepth()).toBe(2);
    expect(undoLabel()).toBe('a2');

    swapHistory('sceneB'); // restored
    expect(undoDepth()).toBe(1);
    expect(undoLabel()).toBe('b1');
  });

  it('is a no-op when swapping to the already-active key', () => {
    swapHistory('sceneA');
    pushAction(act('a1'));
    swapHistory('sceneA');
    expect(undoDepth()).toBe(1);
  });

  // #1409: a parked stack is only valid on a world matching the one it was recorded against.
  it('discardOutgoing on the SAME key drops the stack — the no-op must not keep discarded work', async () => {
    swapHistory('sceneA');
    pushAction(act('a1'));
    pushAction(act('a2'));
    await undo(); // leaves a1 to undo AND a2 to redo — both must go
    expect(canUndo() && canRedo()).toBe(true);
    swapHistory('sceneA', { discardOutgoing: true });
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('discardOutgoing on a DIFFERENT key parks nothing, so returning finds an empty stack', () => {
    swapHistory('sceneA');
    pushAction(act('a1'));
    swapHistory('sceneB', { discardOutgoing: true });
    pushAction(act('b1'));
    swapHistory('sceneA');
    expect(canUndo()).toBe(false);
    swapHistory('sceneB'); // B left clean → its stack was parked as before
    expect(undoLabel()).toBe('b1');
  });

  it('freshIncoming ignores a stack parked under the incoming key, including the active one', () => {
    swapHistory('');
    pushAction(act('untitled1'));
    swapHistory('sceneA');
    swapHistory('', { freshIncoming: true });
    expect(canUndo()).toBe(false);
    pushAction(act('untitled2'));
    swapHistory('', { freshIncoming: true }); // same key
    expect(canUndo()).toBe(false);
  });

  it('freshIncoming still restores asset-document entries parked under the key', () => {
    swapHistory('');
    pushAction(act('untitled world edit'));
    pushAction({ ...act('Material color'), _isFileDirect: true });
    swapHistory('sceneA');
    swapHistory('', { freshIncoming: true });
    expect(undoDepth()).toBe(1);
    expect(undoLabel()).toBe('Material color');
  });
});
