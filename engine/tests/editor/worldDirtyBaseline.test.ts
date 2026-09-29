/** Stop puts the world's dirty state back as it was at the Play press (#1816 close-out review) — the two halves the
 *  Play-through-the-ops tests in editorSetTraitsOwner.test.ts do not reach: a BASE scene's flag, and a save made
 *  between the press and the Stop (Play's startup awaits allow one), after which disk no longer matches the snapshot
 *  Stop restores. Each case names the mutation that turns it red. */

import { describe, it, expect, beforeEach } from 'vitest';
import { pushAction, clearHistory, hasUnsavedChanges } from '@modoki/engine/editor';
import { captureWorldDirtyBaseline, restoreWorldDirtyBaseline, markSceneSaved } from '../../packages/modoki/src/editor/scene/serialize';
import { markSceneDirty, isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const BEFORE = 'b0000000-0000-4000-8000-000000001816';
const DURING = 'b0000000-0000-4000-8000-000000001817';
/** An edit, as far as the dirty bookkeeping sees one: a pushed entry bumps the edit version. */
const edit = () => pushAction({ label: 'edit', undo: () => {}, redo: () => {} });

beforeEach(() => { clearHistory(); markSceneSaved(); clearAllSceneDirty(); });

describe('restoreWorldDirtyBaseline', () => {
  // Mutation: drop `clearSceneDirtyExcept(baseline.scenes)` — the base marked during Play stays dirty.
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
});
