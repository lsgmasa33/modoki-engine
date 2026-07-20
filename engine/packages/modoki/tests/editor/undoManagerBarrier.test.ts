/** undoManager — play barrier (undoDepth/truncateUndoTo) + per-context history
 *  (swapHistory). Pure module, no mocks. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushAction, undo, redo, canUndo, canRedo, undoLabel,
  undoDepth, truncateUndoTo, swapHistory, _resetHistoryContexts,
} from '../../src/editor/undo/undoManager';

const noop = () => {};
const act = (label: string) => ({ label, undo: noop, redo: noop });

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
});
