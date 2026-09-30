/** "An undo or redo step just ran" — Unity's `UndoRedoPerformed` (#1905).
 *
 *  `subscribeUndo` (undoManager.ts) cannot stand in for it: it also fires on every `pushAction`,
 *  which includes a buffered field's own keystroke commits, and by the time it fires the step window
 *  is closed, so `isExecutingUndoRedo()` cannot tell the two apart either. A field holding typed text
 *  against the store listens here to END its edit — an undo is the one external change that must
 *  replace the text even while the field is focused (see `nextBufferedEdit` in bufferedEcho.ts).
 *
 *  A leaf module on purpose: `panels/fields.tsx` subscribes, and it is kept free of the store and the
 *  undo manager's transitive deps (its header says why). `undoManager.ts` is the only notifier. */
import { notifyListeners } from '../../runtime/core/notifyListeners';

const listeners = new Set<() => void>();

/** Subscribe to undo/redo STEPS only — called once per step that RAN, after its data moved.
 *
 *  "Ran" includes a step whose closure threw, or refused from inside itself (`UndoRefusedError`,
 *  e.g. "no longer in the scene"): every mounted buffered field then ends its edit even though the
 *  data did not change, dropping uncommitted text. That is deliberate and Unity's rule, since the undo
 *  command was performed. A step refused by the GATE before it runs (Play mode, a scene switch, an
 *  empty stack) never reaches `runStep`, so it does not notify. Returns an unsubscribe fn. */
export function subscribeUndoRedoStep(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by `undoManager`'s `runStep` alone. */
export function notifyUndoRedoStep(): void {
  notifyListeners(listeners, 'undoRedoStep', []);
}
