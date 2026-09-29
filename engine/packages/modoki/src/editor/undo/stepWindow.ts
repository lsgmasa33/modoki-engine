/** The ONE definition of "an undo/redo step is running" (#1823, #1832).
 *
 *  `runStep` (undoManager.ts) opens a window before it awaits a step's closure and closes it after. Everything that
 *  asks "is this happening inside a step?" reads THIS, so there is one notion of step ownership, not one per reader:
 *  `isExecutingUndoRedo()`, `pushAction`'s and `pushSelectionChange`'s guards, and `reportUndoFailure`, which records
 *  a step's shortfall here so the step's result can say it did not fully apply.
 *
 *  ⚠️ **The window is TIME, not ownership.** `serialize` keeps two steps from overlapping, but forward work — a human
 *  gesture, an agent op, a debounced save — still runs while a step awaits a fetch, and the browser has no async
 *  context to tell the step's own calls from it. So anything read here is attributed to the running step by WHEN it
 *  happened. Where the forward work is ours to schedule, it is kept OUT of the window instead: `compositeAction`'s
 *  rollback runs on the step chain (`runOnStepChain`), so no window is open while it reports and none can open under
 *  it. What cannot be scheduled that way is #1832: a forward push inside the window is still read as the step's.
 *  Read docs/refusal-reporting.md § "Steps are serialized against each other, not against the rest of the editor"
 *  before keying anything new on this. */

import type { UndoDirection } from './undoFailure';

/** One `reportUndoFailure` made inside a step. */
export interface StepShortfall {
  detail: string;
  /** The report was a collision the user can fix (`reportUndoFailure`'s `userFixable`). */
  userFixable: boolean;
}

export interface StepWindow {
  readonly direction: UndoDirection;
  readonly label: string;
  readonly shortfalls: StepShortfall[];
}

let _open: StepWindow | null = null;

/** Open the window for a step. Steps never nest (`serialize`), so a window already open is a bug in the caller. */
export function openStepWindow(direction: UndoDirection, label: string): StepWindow {
  if (_open) console.error(`[undo] a step window opened for "${label}" while "${_open.label}"'s was still open`);
  _open = { direction, label, shortfalls: [] };
  return _open;
}

/** Close `w`. A no-op when a later window has already replaced it. */
export function closeStepWindow(w: StepWindow): void {
  if (_open === w) _open = null;
}

/** The step running now, or null. See the TIME note above. */
export function currentStepWindow(): StepWindow | null {
  return _open;
}

/** Test-only: close whatever is open, so a test that threw mid-step cannot leak its window into the next. */
export function _resetStepWindow(): void {
  _open = null;
}
