/** Reporting for an undo/redo step whose filesystem operation did not happen (#308).
 *
 *  The class this exists to close: an `undo`/`redo` closure calls a helper that
 *  NEVER throws (`writeAssetFile`, `deleteAssetFile`, `moveFileTo`, `createFolderApi`,
 *  `mutateScene` — each catches and resolves `false`) and discards the boolean.
 *  `undoManager` pops the entry and reports success either way, so Cmd+Z reads as
 *  working while nothing happened. The forward path of the same function usually
 *  checks the return; only the undo/redo closures didn't.
 *
 *  **Why report rather than throw — still true, for a different reason now (#310).**
 *  A throw looks like the stronger answer (leave the entry on the stack so the user can
 *  retry) and it is worse. It used to be worse because `undo()` popped the action BEFORE
 *  awaiting it with no catch, so a throw skipped `redoStack.push`, `notifyEdited`,
 *  `markAffectedScenesDirty`, `notifyUndoChanged` and the `!undo` event, silently losing
 *  the action from BOTH stacks while the UI showed it as completed; `serialize` then handed
 *  the rejection to a caller that did not catch it. **#310 fixed that bookkeeping**: a throw
 *  is now caught, reported via `reportUndoThrew`, and the notify + journal events fire.
 *  But the entry is still DROPPED — deliberately now, not silently — so a throw still costs
 *  the user their way back. The bar remains #291's: report, let the stack pop, and leave the
 *  editor's state consistent with disk.
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

/** Report an undo/redo closure that THREW, and whose action was therefore dropped (#310).
 *
 *  Distinct from `reportUndoFailure` above, which covers the common case: a helper resolved
 *  `false`, the step did not apply, and the entry moved across the stacks normally. This one
 *  is worse in a way the user has to be told about — the action is gone from BOTH stacks, so
 *  there is no way back to that state through the history, and a closure that threw PARTWAY
 *  may have applied some of its work already.
 *
 *  Always toasts, unlike the two-level rule above. That rule distinguishes a failure the user
 *  can fix from one they cannot; this is neither — it is history loss, and it is worth
 *  interrupting for whatever caused it. */
export function reportUndoThrew(opts: {
  direction: UndoDirection;
  label: string;
  error: unknown;
}): void {
  const { direction, label, error } = opts;
  const detail = error instanceof Error ? error.message : String(error);
  const other = direction === 'Undo' ? 'redone' : 'undone';
  console.error(
    `[undo] ${direction} of "${label}" THREW — ${detail}. The entry was DROPPED from the history: ` +
    `it cannot be ${other}, and part of it may already have been applied. Check the scene/files ` +
    'before continuing.',
    error,
  );
  useEditorStore.getState().showToast(
    `${direction} of "${label}" FAILED and was dropped from the history (see console)`,
    'warn',
  );
}
