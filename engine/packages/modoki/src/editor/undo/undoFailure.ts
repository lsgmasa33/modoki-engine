/** Reporting for an undo/redo step whose filesystem operation did not happen (#308).
 *
 *  The class this exists to close: an `undo`/`redo` closure calls a helper that
 *  NEVER throws (`writeAssetFile`, `deleteAssetFile`, `moveFileTo`, `createFolderApi`,
 *  `mutateScene` — each catches and resolves `false`) and discards the boolean.
 *  `undoManager` pops the entry and reports success either way, so Cmd+Z reads as
 *  working while nothing happened. The forward path of the same function usually
 *  checks the return; only the undo/redo closures didn't.
 *
 *  **Why report rather than throw.** A throw looks like the stronger answer — leave
 *  the entry on the stack so the user can retry — and it is measurably worse here.
 *  `undo()` (undoManager.ts) pops the action BEFORE awaiting `action.undo()`, so on a
 *  throw the `redoStack.push`, `notifyEdited`, `markAffectedScenesDirty` and the
 *  `!undo` journal event are all skipped and the action is lost from BOTH stacks;
 *  `serialize` then hands the rejection to a caller that does not catch it. Making
 *  throwing safe means fixing undoManager's bookkeeping first. So the bar is #291's:
 *  report, let the stack pop, and leave the editor's state consistent with disk.
 *
 *  **Why two levels.** A failure the user CAUSED and can FIX — they recreated
 *  something at the old path, so undoing the rename collides (`/api/move-file` 409s,
 *  "Destination exists") — is worth interrupting them for, because the console is not
 *  a place anyone is looking. A backend failure (a full disk, a restarting server) is
 *  not actionable, so it stays a console error, matching #291 exactly. Pass
 *  `userFixable` only where a 409-shaped collision is what actually happened —
 *  `moveFileToStatus` reports the status precisely so this need not be guessed. */

import { useEditorStore } from '../store/editorStore';

export type UndoDirection = 'Undo' | 'Redo';

/** HTTP status `/api/move-file` answers when the destination is already occupied. */
export const COLLISION_STATUS = 409;

export function reportUndoFailure(opts: {
  /** Which half ran — the message says so, because "undo did nothing" and "redo did
   *  nothing" leave the file in opposite states and the user needs to know which. */
  direction: UndoDirection;
  /** The undo action's own label, so the message names the command the user invoked. */
  label: string;
  /** What did not happen, naming the paths. This is the whole value of the log —
   *  it is the only hand-recovery path the user gets. */
  detail: string;
  /** True only for a collision the user can resolve (a 409). Adds a toast on top of
   *  the console error; see the two-levels note above. */
  userFixable?: boolean;
}): void {
  const { direction, label, detail, userFixable } = opts;
  console.error(`[undo] ${direction} of "${label}" did not fully apply — ${detail}`);
  if (userFixable) {
    useEditorStore.getState().showToast(
      `${direction} of "${label}" failed — something already exists at the original path (see console)`,
      'warn',
    );
  }
}
