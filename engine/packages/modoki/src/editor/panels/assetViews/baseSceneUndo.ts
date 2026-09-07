/** The base-scene set/clear undo entry (#308).
 *
 *  Extracted from `SceneAssetView`'s `commit` for one reason: the closures lived inside
 *  the component, so the only way to cover them was to mount the panel in jsdom — which
 *  this repo forbids, because that asserts the mock rather than the behaviour. Every
 *  other undo builder in this change is a framework-free factory for the same reason
 *  (see `panels/assetUndo.ts`); this makes the tenth site uniform with the other nine
 *  instead of being the one with no test.
 *
 *  `write` is injected rather than imported: it is the component's own state-setting
 *  writer, and keeping it a parameter is what makes this callable — and testable — with no React
 *  instance in sight.
 *
 *  ⚠️ Since #831 `write` does NOT reach disk. The panel applies the ref live (the open scene) or
 *  parks it (any other scene) and Cmd+S is the write, so `fileDirect` is now a parameter rather
 *  than a hardcoded `true` — see its own note below. */

import type { UndoAction } from '../../undo/undoManager';
import { reportUndoFailure } from '../../undo/undoFailure';

export function makeBaseSceneUndo(params: {
  /** The scene asset being edited — named in the failure message. */
  path: string;
  /** The value before this commit (undo restores it). */
  old: string;
  /** The value this commit set (redo re-applies it). */
  next: string;
  /** Applies the value and returns whether it landed. Already console.errors any underlying
   *  failure itself. */
  write: (v: string) => Promise<boolean>;
  /** Whether this action's effect is ALREADY on disk, and so must not contribute an edit-version
   *  bump (see `UndoAction._isFileDirect`).
   *
   *  TRUE for a scene the editor has not loaded: the edit is parked in `pendingBaseScene`, which
   *  `hasUnsavedChanges()` counts on its own — bumping as well would mark the ACTIVE scene dirty
   *  over an edit that has nothing to do with it, and self-block the flush's own scene-mutate via
   *  the "unsaved live changes" guard that route carries.
   *
   *  FALSE for the OPEN scene: there the ref is applied to `setCurrentBaseScene`, live editor
   *  state that only a scene save persists — so the bump is exactly right, and without it Cmd+S
   *  would have nothing telling it the scene changed. */
  fileDirect: boolean;
}): UndoAction {
  const { path, old, next, write, fileDirect } = params;
  const label = next ? 'Set base scene' : 'Clear base scene';
  return {
    label,
    // `write` already logs the backend error naming the path, so this is NOT a second
    // copy of it: the stack still pops and Cmd+Z still reads as done, so the user needs
    // a message about the UNDO specifically. No toast — a rejected scene mutation is a
    // backend failure, which is not something the user can act on.
    undo: async () => {
      if (!await write(old)) reportUndoFailure({ direction: 'Undo', label, detail: `"${path}" was not reverted` });
    },
    redo: async () => {
      if (!await write(next)) reportUndoFailure({ direction: 'Redo', label, detail: `"${path}" was not updated` });
    },
    _isFileDirect: fileDirect,
  };
}
