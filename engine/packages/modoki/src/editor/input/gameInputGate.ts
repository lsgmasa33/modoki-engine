/** Should the editor suppress the RUNNING GAME's input right now? The policy half of the runtime's
 *  input gate (mechanism: `runtime/input/inputSources.ts`), installed by `EditorApp`.
 *
 *  A plain function rather than an inline closure in `EditorApp.tsx`, because the panel carries no
 *  tests (CLAUDE.md § Tests) and this is a decision with two independent reasons to say yes. */

/**
 * @param focusedPanel the editor keyboard scope, or null when nothing is engaged yet
 * @param modalOpen is a modal dialog open anywhere (focusScope.isModalOpen)?
 */
export function suppressesGameInput(focusedPanel: string | null, modalOpen: boolean): boolean {
  // A modal blocks everything underneath it, the running game included (#1270).
  if (modalOpen) return true;
  // null focus (nothing engaged yet) deliberately does NOT suppress: pressing Play and immediately
  // using WASD has to work without first clicking the GameView.
  return focusedPanel !== null && focusedPanel !== 'game';
}
