/** Where a backend refusal is STATED to the human (#1824, R5 of `docs/refusal-reporting.md`).
 *
 *  Owner ruling FA (b), 2026-09-29: **a direct human gesture the backend refuses toasts the route's own sentence**
 *  (`'warn'`) — the human did something and nothing happened, and the reason is one they can act on (save the asset
 *  first, pick another folder name, close the editor holding the file). **Background work stays console-only**, now
 *  carrying the reason: the layout autosave, the post-import convert, the model-import prune, the callers of
 *  `flushPendingMetaFor`. That narrows #291/#308's console-only rule for direct gestures only. Undo-internal failures
 *  go through the step report instead (`reportUndoFailure`'s `detail`, which Owner B's per-step toast carries).
 *
 *  Two functions rather than a flag, so a call site says which kind of work it is by the name it calls, and a test
 *  can hold a background caller to the one that does not toast. */

import { useEditorStore } from '../store/editorStore';

/** A refusal of something the human just did: on screen, and in the console. `message` names what was refused and
 *  carries the route's reason — the caller composes it, since only the caller knows what "it" was. `consoleDetail`
 *  is what does not fit a toast (every item of a batch), for the console line only. */
export function reportGestureRefusal(message: string, consoleDetail?: string): void {
  console.warn(`[refused] ${message}${consoleDetail ? `\n${consoleDetail}` : ''}`);
  useEditorStore.getState().showToast(message, 'warn');
}

/** A refusal of work nobody is watching for (an autosave, a follow-up the editor started itself): the console only,
 *  with the reason. */
export function reportBackgroundRefusal(message: string): void {
  console.warn(`[refused] ${message}`);
}

/** The file name at the end of an asset path — what the human sees in the panel, and what fits a toast. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** Several refused items of one gesture as one sentence's tail: the first few, each with its reason, and a count of
 *  the rest — a toast has room for a few, and the console line the gesture also writes carries all of them. */
export function refusedItemsText(items: readonly string[]): string {
  const NAMED = 2;
  const shown = items.slice(0, NAMED).join('; ');
  return items.length > NAMED ? `${shown}; +${items.length - NAMED} more` : shown;
}
