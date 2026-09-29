/** #1857 / #1858: an asset-FILE undo entry is `_isFileDirect`, and one that also rebuilds the live frames is `_rebasesLiveFrames`.
 *
 *  The undo manager's side of those flags, on synthetic entries. (The Assets-panel file operations that first carried
 *  them push no undo entry since #1868, owner ruling D2; the asset-document edits and the rig-prefab writer still do.)
 *  Untagged, such an entry was treated as a SCENE edit: Exit from a preview dropped it (the probe on #1857: a delete pushed in
 *  session 7, then `dropPreviewSceneEdits(7)` → `canUndo()` false, the file left in the OS trash with no undo), Stop
 *  truncated it, its undo marked the scene unsaved, and a step spanning a scene switch was dropped.
 *
 *  A model import is the exception the flag's second role names: each half is one `commitPrefabWrite`, which rebases
 *  every live frame of the prefab. So it outlives a switch and marks nothing unsaved like any file edit (#1858), but
 *  wherever a world is posed or thrown back (the preview gate, Exit, Stop) it counts as a scene edit.
 *
 *  Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  pushAction, clearHistory, canUndo, undoStep, undoRefusedReason, setPreviewUndoSession, dropPreviewSceneEdits,
  getEditVersion, composeUndoActions, type UndoAction,
} from '@modoki/engine/editor';
import { truncateUndoTo, undoDepth, undoLabel } from '../../packages/modoki/src/editor/undo/undoManager';
import { setRunMode } from '@modoki/engine/runtime';

let ran: string[];
const entry = (label: string, flags: Partial<UndoAction> = {}): UndoAction =>
  ({ label, undo: () => { ran.push(`undo ${label}`); }, redo: () => { ran.push(`redo ${label}`); }, ...flags });
const FILE = { _isFileDirect: true } as const;
const REBASING = { _isFileDirect: true, _rebasesLiveFrames: true } as const;

beforeEach(() => { ran = []; setRunMode('stopped'); setPreviewUndoSession(null); clearHistory(); });
afterEach(() => { setPreviewUndoSession(null); setRunMode('stopped'); clearHistory(); });

describe('a preview envelope (#1857 route 1)', () => {
  // The issue's probe. Mutation: make `worldFree` ignore `_isFileDirect` — Exit drops it, canUndo is false.
  it("Exit keeps an asset-file edit made inside the envelope, so it is still undoable", () => {
    setPreviewUndoSession(7);
    setRunMode('scrub');
    pushAction(entry('Edit material', FILE));
    expect(dropPreviewSceneEdits(7)).toBe(0);
    expect(canUndo()).toBe(true);
  });

  // Mutation: make `worldFree` ignore `_rebasesLiveFrames` — the gate lets the import through and Exit keeps it.
  it('a model import is refused inside the envelope, and Exit drops one pushed there, as a scene edit', async () => {
    pushAction(entry('Import Model', REBASING)); // before the envelope
    setRunMode('scrub');
    expect(undoRefusedReason('undo')).toMatch(/Exit the preview/);
    expect((await undoStep('undo')).did).toBe(false);
    expect(ran).toEqual([]);

    setPreviewUndoSession(3);
    pushAction(entry('Import in session', REBASING));
    pushAction(entry('Delete in session', FILE));
    expect(dropPreviewSceneEdits(3)).toBe(1);
    expect(undoLabel()).toBe('Delete in session');
    expect(undoDepth()).toBe(2);
  });
});

describe('the edit version (#1857 route 3, #1858)', () => {
  // #1858, OBSERVED: an asset-file gesture marked the open scene unsaved — Move to Trash, Skin "Make prefab" and a model
  // import — so load_scene / open_project refused with REQUIRES_SAVE over nothing to save. None of them changes what the
  // scene file holds: a model import's rebase re-expands the instances from the new document, and the file holds the
  // instances and their overrides. (The rig's route is pinned in `prefabRebuildOver.test.ts`.)
  // Mutations: make `leavesSceneFile` ignore `_isFileDirect` — the file edit bumps; make the dirty question read
  // `worldFree` (which excludes a rebasing entry) — the rebasing one bumps.
  it('a file edit and a rebasing file edit neither push a bump', async () => {
    const v0 = getEditVersion();
    pushAction(entry('Edit material', FILE));
    pushAction(entry('Update rig prefab', REBASING));
    expect(getEditVersion()).toBe(v0);
  });

  // The undo half, and the accept side: a scene edit still bumps, so a gate that bumped nothing would fail here.
  it('their undo does not bump either; a scene edit does', async () => {
    const v0 = getEditVersion();
    pushAction(entry('Rename', FILE));
    pushAction(entry('Import Model', REBASING));
    expect((await undoStep('undo')).did).toBe(true);
    expect((await undoStep('undo')).did).toBe(true);
    expect(getEditVersion()).toBe(v0);
    pushAction(entry('Move entity'));
    expect(getEditVersion()).toBe(v0 + 1);
  });
});

describe("Stop's truncation (#1857 route 2)", () => {
  // Mutation: restore the plain `undoStack.length = d` — the file edit is truncated with the Play-time scene edits.
  it('keeps the file edits pushed during Play above the barrier, in order; drops scene edits, selections and a model import', () => {
    pushAction(entry('before Play'));
    const barrier = undoDepth();
    pushAction(entry('Play edit'));
    pushAction(entry('Delete A', FILE));
    pushAction(entry('Import Model', REBASING));
    pushAction(entry('select', { _isSelection: true }));
    pushAction(entry('Rename B', FILE));
    truncateUndoTo(barrier);
    expect(undoDepth()).toBe(3);
    expect(undoLabel()).toBe('Rename B');
  });

  // Accept side: a stack with no file edit above the barrier truncates to it exactly, as before.
  it('with no file edit above the barrier, truncates to it', () => {
    pushAction(entry('before Play'));
    const barrier = undoDepth();
    pushAction(entry('Play edit'));
    truncateUndoTo(barrier);
    expect(undoDepth()).toBe(barrier);
  });
});

describe('a batch (#1857)', () => {
  // Mutation: drop the composite's `_rebasesLiveFrames` inheritance — a batch holding an import reads as world-free.
  it('one rebasing sub makes a file-direct batch rebasing; two plain file subs do not', () => {
    const mixed = composeUndoActions([entry('Delete', FILE), entry('Import', REBASING)], { label: 'batch' })!;
    expect(mixed._isFileDirect).toBe(true);
    expect(mixed._rebasesLiveFrames).toBe(true);
    const plain = composeUndoActions([entry('Delete', FILE), entry('Rename', FILE)], { label: 'batch' })!;
    expect(plain._isFileDirect).toBe(true);
    expect(plain._rebasesLiveFrames).toBeFalsy();
  });
});
