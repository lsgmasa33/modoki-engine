/** Undoing back to the saved state reads clean (#1904) — Unity clears a scene's dirty mark when no modifications remain
 *  (issue tracker 6559). The dirty check used to compare a monotonic edit counter that undo/redo bump, so after N edits
 *  and N undos the scene still read unsaved. It now compares world-state tokens (`undo/stateToken.ts`): each entry
 *  records the token before and after it, and a whole undo/redo lands the token back.
 *
 *  Real undo manager, real serialize dirty table, real per-scene tokens. Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pushAction, clearHistory, hasUnsavedChanges, undo, redo, undoStep, getEditVersion } from '@modoki/engine/editor';
import { markSceneSaved, captureWorldDirtyBaseline, restoreWorldDirtyBaseline } from '../../packages/modoki/src/editor/scene/serialize';
import { captureSavePoint, captureSceneSavePoint, settleSavePoint, settleSceneSavePoint, swapHistory, undoDepth, truncateUndoTo, markPlayBarrier, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { UndoRefusedError, reportUndoFailure } from '../../packages/modoki/src/editor/undo/undoFailure';
import { isSceneDirty, clearSceneDirty, clearAllSceneDirty, clearSceneDirtyExcept, sceneStateToken } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const BASE = 'b0000000-0000-4000-8000-000000001904';
const OTHER = 'b0000000-0000-4000-8000-000000001905';

/** An edit, as far as the dirty bookkeeping sees one. `scenes`: the base scenes it touches. */
const edit = (label = 'edit', scenes?: string[], halves: { undo?: () => void | Promise<void>; redo?: () => void | Promise<void> } = {}) =>
  pushAction({ label, undo: halves.undo ?? (() => {}), redo: halves.redo ?? (() => {}), ...(scenes ? { affectedScenes: scenes } : {}) });
/** A completed save of the world as it is now. */
const save = () => markSceneSaved(captureSavePoint());

beforeEach(() => {
  setRunMode('stopped'); // undo is refused in Play
  _resetHistoryContexts();
  clearHistory();
  markSceneSaved(); // a fresh load
  clearAllSceneDirty();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the primary scene', () => {
  // Mutation: in runStep, skip `landOn` (always `forgetRecordedStates`) — the undo leaves it unsaved, the #1904 symptom.
  it('undoing every edit reads clean; redoing reads unsaved again', async () => {
    edit('A'); edit('B');
    expect(hasUnsavedChanges()).toBe(true);
    await undo();
    expect(hasUnsavedChanges()).toBe(true); // A is still applied
    await undo();
    expect(hasUnsavedChanges()).toBe(false);
    await redo();
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('the edit version still counts every change — its other readers ask "did anything happen"', async () => {
    const before = getEditVersion();
    edit(); await undo();
    expect(getEditVersion()).toBe(before + 2);
  });

  // A save partway down the stack: the compare is against the state the save wrote, not an empty stack.
  // Mutation: have `landOn` compare nothing and read clean whenever the undo stack is empty — the first undo reads clean.
  it('a save partway down the stack: undo past it is unsaved, redo back to it is clean', async () => {
    edit('A'); save(); edit('B');
    await undo();                                   // back to what the save wrote
    expect(hasUnsavedChanges()).toBe(false);
    await undo();                                   // past it: the file holds A, the world does not
    expect(hasUnsavedChanges()).toBe(true);
    await redo();
    expect(hasUnsavedChanges()).toBe(false);
    await redo();                                   // redo past the saved point
    expect(hasUnsavedChanges()).toBe(true);
  });

  // A coalesced chain is one entry: it keeps the chain's first `before`, and each merged edit is a new `after`.
  // Mutation: in `recordForward`, reset `before` on a coalesce — the undo lands on the middle of the chain.
  it('a coalesced chain undoes to the state before the chain', async () => {
    pushAction({ label: 'x=1', undo: () => {}, redo: () => {}, coalesceKey: 'x' });
    pushAction({ label: 'x=12', undo: () => {}, redo: () => {}, coalesceKey: 'x' });
    await undo();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a save that an edit outran reads unsaved, and undoing that edit reads clean', async () => {
    edit('A');
    const serializedAt = captureSavePoint();       // the save serializes here…
    edit('B');                                      // …an edit lands during its write…
    markSceneSaved(serializedAt);                   // …and the write completes
    expect(hasUnsavedChanges()).toBe(true);
    await undo();
    expect(hasUnsavedChanges()).toBe(false);       // back at the bytes the save wrote
  });
});

describe('a step that did not apply whole (#310, #1823)', () => {
  // Mutation: drop the remap in `forgetRecordedStates` (only mint a fresh world token) — the second undo lands on the
  // saved token again over a world the failed step half-changed.
  it('a step that THREW partway stays unsaved until a save, even when a later undo reaches the saved position', async () => {
    edit('A');
    edit('B', undefined, { undo: () => { throw new Error('half-applied'); } });
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(false);
    expect(hasUnsavedChanges()).toBe(true);
    await undo();                                   // A: the stack's position is the saved one, the world is not
    expect(hasUnsavedChanges()).toBe(true);
    save();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a step that reported a shortfall stays unsaved the same way', async () => {
    edit('A');
    edit('B', undefined, { undo: () => reportUndoFailure({ direction: 'Undo', label: 'B', detail: 'one file not written' }) });
    const r = await undoStep('undo');
    expect(r.shortfall).not.toBeNull();
    await undo();
    expect(hasUnsavedChanges()).toBe(true);
    await redo(); await redo();                      // B's redo is whole, but the world is still not what any token named
    expect(hasUnsavedChanges()).toBe(true);
  });

  // Close-out review F2: a human edit landing during an undo's await is APPLIED but its push is dropped (#1833). The step
  // then landed the world on the saved token over that edit. Mutation: drop `window.droppedEdits === 0` from `runStep` —
  // the world reads saved with the edit in it.
  it('an edit whose push a step dropped keeps the world unsaved', async () => {
    let midStep!: () => void;
    const awaited = new Promise<void>((r) => { midStep = r; });
    edit('A', undefined, { undo: async () => { midStep(); await new Promise((r) => setTimeout(r, 5)); } });
    const step = undo();
    await awaited;
    edit('dropped');                                 // lands inside the step's window: applied, no entry
    await step;
    expect(hasUnsavedChanges()).toBe(true);
  });

  // Re-review finding 2: the drop forgets the recorded states AT the drop, so every kind of step is covered, not only a
  // whole one. Mutation for each: drop `forgetRecordedStates(action, true)` from `pushAction`'s drop branch.
  const midStepDrop = async (entry: Parameters<typeof pushAction>[0], dropped: Parameters<typeof pushAction>[0]) => {
    let midStep!: () => void;
    const awaited = new Promise<void>((r) => { midStep = r; });
    const undoHalf = entry.undo;
    pushAction({ ...entry, undo: async () => { midStep(); await new Promise((r) => setTimeout(r, 5)); await undoHalf(); } });
    save(); // clean at the step: only the dropped edit can make it unsaved (a refused undo leaves the entry's edit applied)
    const step = undoStep('undo');
    await awaited;
    pushAction(dropped);
    return step;
  };
  const sceneEdit = (scenes?: string[]) => ({ label: 'dropped', undo: () => {}, redo: () => {}, ...(scenes ? { affectedScenes: scenes } : {}) });

  it('a drop during a FILE-DIRECT step keeps the world unsaved', async () => {
    await midStepDrop({ label: 'asset edit', undo: () => {}, redo: () => {}, _isFileDirect: true }, sceneEdit());
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a drop during a step REFUSED after its await keeps the world unsaved', async () => {
    const r = await midStepDrop({ label: 'A', undo: () => { throw new UndoRefusedError('refused', 'refused'); }, redo: () => {} }, sceneEdit());
    expect(r.failed?.refused).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a dropped push to a base the step does not touch dirties that base, and a later undo cannot clean it', async () => {
    edit('B', [BASE]);
    clearSceneDirty(BASE, sceneStateToken(BASE)); // B's base saved
    await midStepDrop({ label: 'primary', undo: () => {}, redo: () => {} }, sceneEdit([BASE]));
    expect(isSceneDirty(BASE)).toBe(true);
    await undo(); await redo();                      // B's own entry, back to the base's saved position
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // The accept side: a SELECTION pushed during the step is not a scene edit. Mutation: count every dropped push.
  it('a selection dropped during the step does not cost the clean', async () => {
    let midStep!: () => void;
    const awaited = new Promise<void>((r) => { midStep = r; });
    edit('A', undefined, { undo: async () => { midStep(); await new Promise((r) => setTimeout(r, 5)); } });
    const step = undo();
    await awaited;
    pushAction({ label: 'select', undo: () => {}, redo: () => {}, _isSelection: true });
    await step;
    expect(hasUnsavedChanges()).toBe(false);
  });

  // A REFUSED step moved nothing — so it does not dirty a clean world. Mutation: pass `moved: true` for a refusal (or
  // call the throw path) — the saved world reads unsaved after a refusal that changed nothing.
  it('a refused step on a saved world leaves it clean', async () => {
    edit('A', undefined, { undo: () => { throw new UndoRefusedError('refused', 'refused'); } });
    save();
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(true);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // …but its entry is DROPPED with its edit still applied, so the entries beneath it no longer describe the world.
  // Mutation: drop the refusal's `forgetRecordedStates(action, false)` — redo A lands on the saved token over a world
  // that still has B.
  it('after a refused step, the stack beneath it can no longer reach "saved"', async () => {
    edit('A'); save();
    edit('B', undefined, { undo: () => { throw new UndoRefusedError('refused', 'refused'); } });
    expect((await undoStep('undo')).failed?.refused).toBe(true);
    await undo(); await redo();                      // A's position is the saved one; the world still has B
    expect(hasUnsavedChanges()).toBe(true);
  });
});

/** Play's press and Stop, as `playMode.ts` drives the dirty half: the baseline and the barrier together, then the cut and
 *  the restore once the world is reverted. */
const press = (snapshotVersion?: number) => ({ baseline: captureWorldDirtyBaseline(snapshotVersion), barrier: markPlayBarrier() });
const stop = (at: ReturnType<typeof press>) => { truncateUndoTo(at.barrier); restoreWorldDirtyBaseline(at.baseline); };

describe('Stop puts every token back as it was at the press', () => {
  // Re-review finding 1: the same stack goes on after Stop, so a base dirty at the press keeps its tokens and an undo
  // back to saved still reads clean. Mutation: in `restoreWorldDirtyBaseline`, re-mint the bases
  // (`clearSceneDirtyExcept(dirtySceneGuidsSnapshot())`) instead of `restoreSceneTokens` — the undo reads dirty.
  it('a base dirty at the press: after Stop, undoing its pre-Play edit reads clean', async () => {
    edit('base edit', [BASE]);
    const at = press();
    edit('a Play-time edit', [BASE]);
    stop(at);
    expect(isSceneDirty(BASE)).toBe(true);
    await undo();
    expect(isSceneDirty(BASE)).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // Third review, finding 2 (reproduced): a scene SAVED before Play was re-minted at Stop, so undo then redo back onto the
  // save read unsaved for good. Mutations: replace `restoreWorldStateToken(...)` with `markSceneSaved()` — the primary
  // reads dirty after the redo; the base mutation above — the base does.
  it('scenes saved before Play: after Stop, undo reads unsaved and redo back onto the save reads clean', async () => {
    edit('edit', [BASE]);
    save(); clearSceneDirty(BASE, sceneStateToken(BASE));
    const at = press();
    edit('a Play-time edit', [BASE]);
    stop(at);
    expect(hasUnsavedChanges()).toBe(false);
    expect(isSceneDirty(BASE)).toBe(false);
    await undo();
    expect(hasUnsavedChanges()).toBe(true);
    expect(isSceneDirty(BASE)).toBe(true);
    await redo();
    expect(hasUnsavedChanges()).toBe(false);
    expect(isSceneDirty(BASE)).toBe(false);
  });

  // An edit landing during the snapshot's awaits may be missing from what Stop restores, so the restored world is at no
  // known state — even a save of that edit before the capture does not make it clean. One scene per case, because
  // `hasUnsavedChanges` counts a dirty base too and would hide the primary's answer.
  // Mutation: drop the `beginFreshWorldState()` for an incomplete snapshot (restore the token anyway) — reads clean.
  it('an edit during the snapshot and its save: after Stop the primary reads unsaved, with no Play-time edit', () => {
    const snapshotStart = getEditVersion();
    edit('lands during the snapshot');
    save();
    stop(press(snapshotStart));
    expect(hasUnsavedChanges()).toBe(true);
  });

  // Mutation: pass `unknownState: false` — the base reads clean.
  it('the same for a base scene', () => {
    const snapshotStart = getEditVersion();
    edit('lands during the snapshot', [BASE]);
    clearSceneDirty(BASE, sceneStateToken(BASE));
    stop(press(snapshotStart));
    expect(isSceneDirty(BASE)).toBe(true);
  });
});

describe('Stop: the fourth review', () => {
  // Finding 3 (reproduced): a save after the press recorded the startup world's token, which the early return left live,
  // so Stop read clean over a reverted world lacking an edit that save wrote. Mutation: drop `beginFreshWorldState()`
  // from that return — the primary reads clean; drop `forgetSceneSavedStates()` — the base does.
  it('an edit and a save in Play\'s startup window: after Stop the primary reads unsaved', () => {
    const at = press();
    edit('in the startup window');
    save();
    stop(at);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('the same for a base scene', () => {
    const at = press();
    edit('in the startup window', [BASE]);
    save(); clearSceneDirty(BASE, sceneStateToken(BASE)); // Save All
    stop(at);
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // Fifth review, finding 1 (reproduced): Save All's base loop writes AFTER the primary, so it can land in the startup
  // window whether or not the primary's own save did. Stop restored the base's press-time saved token over a file
  // holding the startup edit. Mutation: drop the saved-since-the-press loop in `restoreSceneTokens` — reads clean.
  it("a base saved in the startup window by Save All's base loop: after Stop it reads dirty", () => {
    edit('saved before the press'); save();          // the primary half ran before the press
    const at = press();
    edit('in the startup window', [BASE]);
    clearSceneDirty(BASE, settleSceneSavePoint(BASE, captureSceneSavePoint(BASE))); // the base loop
    stop(at);
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // …and its accept side: a base saved BEFORE the press keeps its saved token, so it still reads clean after Stop.
  // Mutation: poison every real saved token in that loop (drop `t !== tokens.saved.get(g)`) — reads dirty.
  it('a base saved before the press still reads clean after Stop', () => {
    edit('base', [BASE]); clearSceneDirty(BASE, sceneStateToken(BASE));
    stop(press());
    expect(isSceneDirty(BASE)).toBe(false);
  });

  // Finding 1 (reproduced): a push dropped during a FILE-DIRECT step is applied and moves the world's token with no
  // version bump, so a version-equal "disk holds the snapshot" forced the saved token onto the press's and Stop read
  // clean over the dropped edit. Mutation: restore `if (diskHoldsSnapshot) _savedWorldState = baseline.worldState`.
  it('a push dropped during a file-direct step before Play: after Stop the world reads unsaved', async () => {
    save();
    let midStep!: () => void;
    const awaited = new Promise<void>((r) => { midStep = r; });
    pushAction({ label: 'asset edit', undo: async () => { midStep(); await new Promise((r) => setTimeout(r, 5)); }, redo: () => {}, _isFileDirect: true });
    const step = undoStep('undo');
    await awaited;
    edit('dropped');                                  // applied, no entry, no version bump
    await step;
    expect(hasUnsavedChanges()).toBe(true);
    stop(press());
    expect(hasUnsavedChanges()).toBe(true);
  });

  // Finding 5 (reproduced): Play's press did not end a coalescing chain, so a Play-time edit with the same key merged into
  // the pre-Play top entry, which survives Stop's cut carrying the Play value. Mutation: drop `_coalesce = null` from
  // `markPlayBarrier` — the Play edit merges and the depth does not grow.
  it("a Play-time edit does not coalesce into the press's top entry", () => {
    pushAction({ label: 'x=1', undo: () => {}, redo: () => {}, coalesceKey: 'x' });
    const at = press();
    pushAction({ label: 'x=12 in Play', undo: () => {}, redo: () => {}, coalesceKey: 'x' });
    expect(undoDepth()).toBe(at.barrier + 1);
  });
});

describe('a save settles its point after the serialize (fourth review, finding 2)', () => {
  // The capture sees only a step already running. A step that STARTS during the serialize's awaits, or an edit landing
  // there, may be in the bytes. Mutation: have `settleSavePoint` return `at` — the redo reads clean over the undone bytes.
  it('an undo that ran during the serialize: the redo reads unsaved', async () => {
    edit('A');
    const at = captureSavePoint();
    await undo();                                     // during the serialize's prefab fetch
    markSceneSaved(settleSavePoint(at));              // the bytes lack A
    await redo();
    expect(hasUnsavedChanges()).toBe(true);
  });

  // Mutation: have `settleSceneSavePoint` return `at.state` — the undo reads clean over bytes that hold the edit.
  it('a base edit during the serialize: undoing it reads dirty', async () => {
    const at = captureSceneSavePoint(BASE);
    edit('during the serialize', [BASE]);             // read into the bytes after the await
    clearSceneDirty(BASE, settleSceneSavePoint(BASE, at));
    await undo();
    expect(isSceneDirty(BASE)).toBe(true);
  });
});

describe('a save while an undo step is in flight (third review, finding 1)', () => {
  // The step's closure has changed the world, but the token moves only when the step lands: a save in its await wrote
  // the post-undo bytes under the pre-undo token, and the redo then read clean over a file without the edit
  // (reproduced by the reviewer). Mutations: have `captureSavePoint` ignore `_stepsPending` — the primary case reads
  // clean; the same in `captureSceneSavePoint` — the base case does.
  // One scene per case, because `hasUnsavedChanges` counts a dirty base too and would hide the primary's answer.
  const saveDuringUndo = async (scenes: string[] | undefined, saveNow: () => void) => {
    let applied = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    edit('A', scenes, { undo: () => { applied = true; return gate; } });
    save(); if (scenes) clearSceneDirty(BASE, sceneStateToken(BASE));
    const step = undo();
    await vi.waitFor(() => expect(applied).toBe(true)); // the undo's change is in the world, its await still open
    saveNow();                                          // the bytes lack A
    release(); await step;
    await redo();                                       // A is back in the world, not on disk
  };

  it('a primary save: the redo reads unsaved', async () => {
    await saveDuringUndo(undefined, () => markSceneSaved(captureSavePoint()));
    expect(hasUnsavedChanges()).toBe(true);
  });

  it("Save All's base write: the redo reads the base dirty", async () => {
    await saveDuringUndo([BASE], () => clearSceneDirty(BASE, captureSceneSavePoint(BASE).state));
    expect(isSceneDirty(BASE)).toBe(true);
  });
});

describe('base scenes', () => {
  // Mutation: in `landOn`, skip the per-scene loop — the base stays dirty after the undo.
  it('undoing a base-scene edit clears that scene; redo marks it again', async () => {
    edit('base edit', [BASE]);
    expect(isSceneDirty(BASE)).toBe(true);
    await undo();
    expect(isSceneDirty(BASE)).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
    await redo();
    expect(isSceneDirty(BASE)).toBe(true);
  });

  it('only the scenes an entry touched move: undoing one base leaves the other dirty', async () => {
    edit('other', [OTHER]); edit('base', [BASE]);
    await undo();
    expect(isSceneDirty(BASE)).toBe(false);
    expect(isSceneDirty(OTHER)).toBe(true);
  });

  it('a base saved partway down the stack: undo past its save is dirty, redo back is clean', async () => {
    edit('base 1', [BASE]);
    clearSceneDirty(BASE, sceneStateToken(BASE));
    edit('base 2', [BASE]);
    await undo();
    expect(isSceneDirty(BASE)).toBe(false);
    await undo();
    expect(isSceneDirty(BASE)).toBe(true);
    await redo();
    expect(isSceneDirty(BASE)).toBe(false);
  });

  // Save All reads the token before its awaits. Mutation: have `saveOtherLoadedScenes` pass nothing — the edit that
  // landed during the write reads saved. (Here: `clearSceneDirty` defaulting to now, which is what that would do.)
  it('a base save an edit outran stays dirty', () => {
    edit('base 1', [BASE]);
    const serializedAt = sceneStateToken(BASE);
    edit('base 2', [BASE]);
    clearSceneDirty(BASE, serializedAt);
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // A reload starts a new epoch: an entry recorded before it names the OLD epoch, which must not read as the reloaded
  // file's state. Mutation: drop `_epoch = mintStateToken()` in `clearSceneDirtyExcept` — the undo reads clean against a
  // file that holds the edit.
  it('after the base is reloaded from a file holding the edit, undoing it reads dirty', async () => {
    edit('base edit', [BASE]);
    clearSceneDirty(BASE);                          // Save All wrote it
    clearAllSceneDirty();                           // the world was reloaded; this entry's stack came back with it
    expect(isSceneDirty(BASE)).toBe(false);
    await undo();
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // A KEPT base carries its dirty flag across the swap (#1417) — and its clean one.
  // Mutation: save every kept base as clean in `clearSceneDirtyExcept` — the carried edit reads saved and Save All skips it.
  it('a base kept across a world swap keeps its dirty flag, and a clean one stays clean', () => {
    edit('base edit', [BASE]);
    clearSceneDirtyExcept(new Set([BASE, OTHER]));
    expect(isSceneDirty(BASE)).toBe(true);
    expect(isSceneDirty(OTHER)).toBe(false);
  });

  // Close-out review F1 (reproduced): scenes X and Y share base B. X edits B and saves; Y edits B; back in X with Y's
  // edit discarded from Y's stack but CARRIED in the kept base. X's parked stack then undid/redid B onto its saved token
  // over Y's unwritten edit — Save All skipped B, and the next switch dropped the edit. Mutation: keep a kept base's
  // tokens in `clearSceneDirtyExcept` (the pre-review shape) — the redo reads clean.
  it("a kept base moved by ANOTHER scene's stack never lands on saved through the returning stack", async () => {
    edit('X edits B', [BASE]);                                        // X's stack: E
    clearSceneDirty(BASE, sceneStateToken(BASE));                    // Save All in X
    swapHistory('y.scene.json'); clearSceneDirtyExcept(new Set([BASE])); // open Y: X's stack parks, B is kept
    edit('Y edits B', [BASE]);                                        // Y's stack: F — never saved
    swapHistory('', { discardOutgoing: true }); clearSceneDirtyExcept(new Set([BASE])); // back to X, "Don't Save"
    expect(isSceneDirty(BASE), 'F is still in the kept base').toBe(true);
    await undo(); await redo();                                       // E and back, in X's stack
    expect(isSceneDirty(BASE)).toBe(true);
  });
});
