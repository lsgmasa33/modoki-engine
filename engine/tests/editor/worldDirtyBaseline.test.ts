/** Stop puts the world's dirty state back as it was at the Play press (#1816 close-out review) — the two halves the
 *  Play-through-the-ops tests in editorSetTraitsOwner.test.ts do not reach: a BASE scene's flag, and a save made
 *  between the press and the Stop (Play's startup awaits allow one), after which disk no longer matches the snapshot
 *  Stop restores. Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach } from 'vitest';
import { pushAction, clearHistory, hasUnsavedChanges } from '@modoki/engine/editor';
import { captureWorldDirtyBaseline, restoreWorldDirtyBaseline, markSceneSaved } from '../../packages/modoki/src/editor/scene/serialize';
import { captureSavePoint } from '../../packages/modoki/src/editor/undo/undoManager';
import { markSceneDirty, isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const BEFORE = 'b0000000-0000-4000-8000-000000001816';
const DURING = 'b0000000-0000-4000-8000-000000001817';
/** An edit, as far as the dirty bookkeeping sees one: a pushed entry bumps the edit version. */
const edit = () => pushAction({ label: 'edit', undo: () => {}, redo: () => {} });

beforeEach(() => { clearHistory(); markSceneSaved(); clearAllSceneDirty(); });

describe('restoreWorldDirtyBaseline', () => {
  // Mutation: drop `restoreSceneTokens(baseline.scenes, …)` — the base marked during Play stays dirty.
  it('a base scene dirtied during Play is clean again; one dirty at the press stays dirty', () => {
    markSceneDirty(BEFORE);
    const baseline = captureWorldDirtyBaseline();
    markSceneDirty(DURING);
    restoreWorldDirtyBaseline(baseline);
    expect(isSceneDirty(BEFORE)).toBe(true);
    expect(isSceneDirty(DURING)).toBe(false);
  });

  // The primary half, and its accept side.
  it('a clean primary is clean again; a dirty one stays dirty', () => {
    const clean = captureWorldDirtyBaseline();
    edit();
    expect(hasUnsavedChanges()).toBe(true);
    restoreWorldDirtyBaseline(clean);
    expect(hasUnsavedChanges()).toBe(false);
    edit();
    const dirty = captureWorldDirtyBaseline();
    edit();
    restoreWorldDirtyBaseline(dirty);
    expect(hasUnsavedChanges()).toBe(true);
  });

  // A save after the press wrote a world the snapshot does not hold, so Stop's restored world differs from disk: nothing
  // is cleared. Mutation: drop the `_savedAtEditVersion !== baseline.savedAt` return — the primary reads clean.
  it('a save made after the press clears nothing', () => {
    const baseline = captureWorldDirtyBaseline();
    edit();
    markSceneSaved();              // a save landing during Play's startup awaits
    edit();                        // a Play-time edit
    markSceneDirty(DURING);
    restoreWorldDirtyBaseline(baseline);
    expect(hasUnsavedChanges()).toBe(true);
    expect(isSceneDirty(DURING)).toBe(true);
  });

  // …but a save that serialized at the capture's own version and landed after it wrote the snapshot itself: disk equals
  // what Stop restores, so it is clean. Mutation: drop `diskHoldsSnapshot` — a false "unsaved" after Stop.
  it('a save of exactly the capture\'s version, landing after the press, still clears', () => {
    edit();                                            // unsaved at the press
    const baseline = captureWorldDirtyBaseline();
    markSceneSaved(captureSavePoint());                // its write lands now, stamped with what it serialized at the press
    edit();                                            // a Play-time edit
    restoreWorldDirtyBaseline(baseline);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // …and only when the snapshot saw every edit up to that version: one landing during the snapshot's own awaits may be
  // missing from it, so a save of the capture's version no longer matches what Stop restores. Mutation: record
  // `editVersion: v` whatever `snapshotVersion` says — the restore reads clean over a world the save outran.
  it('an edit during the snapshot\'s awaits: a save of the capture\'s version clears nothing', () => {
    const atSnapshotStart = (captureWorldDirtyBaseline()).editVersion;
    edit();                                            // lands while the snapshot is being taken
    const afterEdit = captureSavePoint();
    const baseline = captureWorldDirtyBaseline(atSnapshotStart);
    markSceneSaved(afterEdit);                         // a save of the capture's version (the one after the edit)
    edit();
    restoreWorldDirtyBaseline(baseline);
    expect(hasUnsavedChanges()).toBe(true);
  });

  // The same holds for "clean at the press": an edit during the snapshot's awaits, saved before the capture, makes the
  // primary read clean at capture — but the snapshot may lack the edit disk holds. Mutation: restore the press's token
  // for an incomplete snapshot too (drop the `beginFreshWorldState()` branch) — Stop marks the reverted world clean.
  it('an edit and its save during the snapshot\'s awaits: the restore leaves the scene unsaved', () => {
    const atSnapshotStart = captureWorldDirtyBaseline().editVersion;
    edit();                                            // lands during the snapshot's awaits
    markSceneSaved();                                  // and a save of it completes before the capture
    const baseline = captureWorldDirtyBaseline(atSnapshotStart);
    edit();                                            // a Play-time edit
    restoreWorldDirtyBaseline(baseline);
    expect(hasUnsavedChanges()).toBe(true);
  });
});
