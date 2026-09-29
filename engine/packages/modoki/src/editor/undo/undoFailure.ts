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
 *  `moveFileToStatus` reports the status precisely so this need not be guessed.
 *
 *  **Inside a step, the report belongs to the step (#1823).** It is recorded into the open step window
 *  (`stepWindow.ts`), and the step's result says it did not fully apply: the agent's undo op answers PARTIAL, and the
 *  human gets ONE toast for the step (`reportStepShortfall`, owner ruling F1 2026-09-29, which overrides the two levels
 *  above for undo). The two levels still decide a report made with no step open. */

import { useEditorStore } from '../store/editorStore';
import { sha256OfWritten } from '../utils/contentHash';
import { currentStepWindow } from './stepWindow';

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
  // Inside a step, the step's result carries it (#1823): the agent's undo op answers PARTIAL, and `runStep` toasts
  // ONCE for the step (`reportStepShortfall`) however many reports it made. A report with no step open — a forward
  // path that ran a closure directly — keeps the two-level rule below.
  const step = currentStepWindow();
  if (step) {
    step.shortfalls.push({ detail, userFixable: !!userFixable });
    return;
  }
  if (userFixable) useEditorStore.getState().showToast(collisionToast(direction, label), 'warn');
}

function collisionToast(direction: UndoDirection, label: string): string {
  return `${direction} of "${label}" failed — something already exists at the original path (see console)`;
}

/** Tell the human that a step did not fully apply (#1823, owner ruling F1 2026-09-29): one toast per step, whatever
 *  caused the shortfall. This reverses the two-level rule above FOR A STEP only — a partial undo leaves the disk short
 *  of what the history now claims, the same kind of loss `reportUndoThrew` already toasts for. A collision keeps its
 *  own, more useful wording. Other backend failures outside undo keep #291/#308's console-only ruling. */
export function reportStepShortfall(opts: { direction: UndoDirection; label: string; userFixable: boolean }): void {
  const { direction, label, userFixable } = opts;
  useEditorStore.getState().showToast(
    userFixable ? collisionToast(direction, label) : `${direction} of "${label}" did not fully apply — see the console`,
    'warn',
  );
}

/** A step that REFUSED before it changed anything (#1664) — thrown, so `runStep` drops the entry (#310), but reported
 *  as what it is. The generic report below says part of the step may have applied and toasts a bare "FAILED", and
 *  neither is true or useful here: nothing was applied, and `toast` says why, in words the user can act on. */
export class UndoRefusedError extends Error {
  readonly toast: string;
  constructor(message: string, toast: string) {
    super(message);
    this.name = 'UndoRefusedError';
    this.toast = toast;
  }
}

/** The refusal for an undo/redo step whose file precondition failed (#1679): a file it would overwrite or trash no
 *  longer holds the bytes the step's other half wrote (a later save, an edit, or a different file at that path), or
 *  a file it would re-create is already there. The ROUTE refused (`ifMatch`/`createOnly`), so nothing was written or
 *  trashed — which is what makes this a refusal rather than a failure. Since #1868 the one step left that writes a
 *  prefab on undo is Create Prefab's redo of a file deleted since; an Apply's, a Replace's and a rig update's undo refuse
 *  in memory (`prefabRestoreRefusal`). */
export function fileChangedRefusal(paths: readonly string[]): UndoRefusedError {
  const one = paths.length === 1;
  const name = one ? paths[0].split('/').pop() : `${paths.length} files`;
  return new UndoRefusedError(
    `${paths.join(', ')} ${one ? 'is' : 'are'} not what this step left there (changed on disk since, or another file now at that path), so nothing was written or trashed.`,
    `${name} changed on disk since, and ${one ? 'was' : 'were'} left as ${one ? 'it is' : 'they are'}`,
  );
}

/** The `ifMatch` for bytes a step wrote with `content`/`encoding` (`sha256OfWritten`), as a REFUSAL when they cannot
 *  be hashed: `crypto.subtle` exists only in a secure context, and nothing has been written yet at this point — the
 *  same reasoning `commitPrefabWrite` applies to its own hash. */
export async function expectedHash(path: string, content: string, encoding?: 'base64'): Promise<string> {
  try {
    return await sha256OfWritten(content, encoding);
  } catch (e) {
    throw new UndoRefusedError(
      `${path} was left as it is: the bytes this step expects there could not be hashed (${e instanceof Error ? e.message : String(e)}).`,
      `${path.split('/').pop()} could not be checked before changing it (see console)`,
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
 *  interrupting for whatever caused it. An `UndoRefusedError` is the exception: nothing was applied,
 *  so it gets its own wording and toast. */
export function reportUndoThrew(opts: {
  direction: UndoDirection;
  label: string;
  error: unknown;
}): void {
  const { direction, label, error } = opts;
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof UndoRefusedError) {
    console.error(`[undo] ${direction} of "${label}" was REFUSED — ${detail} The entry was dropped from the history; nothing was applied.`);
    useEditorStore.getState().showToast(`${direction} of "${label}" refused: ${error.toast}`, 'warn');
    return;
  }
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
