/** The HUMAN's Undo/Redo command — the Cmd+Z chords, Edit ▸ Undo/Redo, and every panel's ↶/↷ button.
 *
 *  `undo()`/`redo()` refuse outside the authoring mode (`undoRefusedReason`, #1148), but a bare
 *  `false` is also "the stack was empty". A human pressing a button needs to hear why nothing
 *  happened, and before this the panel buttons called the manager directly and would have said
 *  nothing at all. One command so the chord, the menu and the buttons cannot drift into saying
 *  different things — the hazard `saveCommand.ts` records for Save.
 *
 *  The toast reads `refused` from the step itself, NOT a pre-check: a step queued behind an in-flight
 *  one is decided when it runs (see `undoStep`), and a pre-check would pass and then stay silent.
 *  The agent `undo`/`redo` ops take the same `undoStep` and report the refusal as a coded result. */

import { useEditorStore } from '../store/editorStore';
import { undoStep } from './undoManager';

export async function runUndoCommand(direction: 'undo' | 'redo'): Promise<boolean> {
  const { did, refused } = await undoStep(direction);
  if (refused !== null) useEditorStore.getState().showToast(refused, 'warn');
  return did;
}
