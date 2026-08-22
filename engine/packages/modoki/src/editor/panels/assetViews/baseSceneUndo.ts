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
 *  writer (`mutateScene` + `setBaseScene`), and keeping it a parameter is what makes this
 *  callable — and testable — with no React instance in sight. */

import type { UndoAction } from '../../undo/undoManager';
import { reportUndoFailure } from '../../undo/undoFailure';

export function makeBaseSceneUndo(params: {
  /** The scene asset being edited — named in the failure message. */
  path: string;
  /** The value before this commit (undo restores it). */
  old: string;
  /** The value this commit set (redo re-applies it). */
  next: string;
  /** Writes the value and returns whether it landed. Already console.errors the
   *  underlying /api/scene-mutate failure itself. */
  write: (v: string) => Promise<boolean>;
}): UndoAction {
  const { path, old, next, write } = params;
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
    // scene-mutate writes straight to the FILE — this edit (and its undo/redo) is
    // ALREADY persisted, unlike a normal trait/entity edit that's genuinely pending
    // a Cmd+S. Without this, pushAction/undo/redo's unconditional edit-version bump
    // would falsely mark the ACTIVE scene dirty and self-block a FOLLOW-UP
    // scene-mutate call via the "unsaved live changes" guard that route carries.
    _isFileDirect: true,
  };
}
