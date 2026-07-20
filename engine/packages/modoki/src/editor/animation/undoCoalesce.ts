/** The commit → global-undo coalescing decision, extracted pure so the four guard
 *  conditions can be unit-tested without a live store/undo stack.
 *
 *  A new edit MERGES into the previous undo action (mutating its `_after`) only when
 *  ALL hold: there IS a previous action, it's the SAME semantic group, it happened
 *  within the coalesce window, that action is still the TOP of the undo stack (nothing
 *  else pushed since), and we're not mid undo/redo. Otherwise a fresh action is pushed. */
export interface CoalesceInput {
  hasLastAction: boolean;
  group: string;
  lastGroup: string | undefined;
  now: number;
  lastTime: number;
  coalesceMs: number;
  /** peekUndo() === the last action we pushed. */
  isTopOfUndoStack: boolean;
  isExecutingUndoRedo: boolean;
}

export function shouldCoalesce(i: CoalesceInput): boolean {
  return i.hasLastAction
    && i.group === i.lastGroup
    && i.now - i.lastTime < i.coalesceMs
    && i.isTopOfUndoStack
    && !i.isExecutingUndoRedo;
}
