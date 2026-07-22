// HMR: `installed` (below) guards a window keydown listener. On a module swap the flag
// resets to false while the OLD listener stays attached, so the editor would end up with
// two dispatchers — the stale one still resolving against a stale keymap instance. The
// installer is called from a []-deps effect that does NOT re-run on Fast Refresh, so a
// dispose-and-reinstall can't self-heal either. Reload; see input/keymap.ts.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload(); });

/** Keymap dispatcher — the ONE keyboard listener the editor should eventually have
 * . Contract: docs/editor-input.md.
 *
 *  BUBBLE PHASE, deliberately. A shell-level CAPTURE listener would preempt five
 *  existing capture-phase claims (AnimationEditor's Cmd+D, SpriteEditor's Cmd+Z, the
 *  SceneView gizmo/2D-pan handlers) and would also fire before RenameInput's
 *  bubble-phase blanket stopPropagation — silently re-breaking inline rename typing.
 *  Only the overlay tier may ever want capture, and it does not have it yet.
 *
 *  THE preventDefault CONTRACT (measured; do not "tidy"):
 *  the renderer sees a key BEFORE the Electron menu, and preventDefault() is what
 *  SUPPRESSES the menu accelerator / native role. Therefore:
 *    - resolve() returned a binding → run it AND preventDefault  (we claim it)
 *    - resolve() returned null      → do NOTHING, no preventDefault (we yield)
 *  Yielding is what lets Cmd+C in a text field reach the native `role:'copy'`, Cmd+R
 *  reach reload, and F12 reach devtools. Calling preventDefault unconditionally here
 *  would break all of them at once, with no error anywhere. */

import { chordFromEvent, resolve } from './keymap';
import { isTextEditable, topOverlay } from './focusScope';
import { useEditorStore } from '../store/editorStore';

let installed = false;

function onKeyDown(e: KeyboardEvent): void {
  // A bare modifier press ('Meta', 'Shift') is not a chord — ignore it outright so a
  // held Cmd doesn't churn through resolution on every repeat.
  const k = e.key;
  if (k === 'Meta' || k === 'Shift' || k === 'Control' || k === 'Alt') return;

  const binding = resolve(chordFromEvent(e), {
    focusedPanel: useEditorStore.getState().focusedPanel,
    overlay: topOverlay(),
    textEditable: isTextEditable(typeof document !== 'undefined' ? document.activeElement : null),
  });
  if (!binding) return; // YIELD — see the contract above

  // Claiming and preventing are SEPARATE decisions (see Binding.preventDefault). A binding
  // may legitimately claim a chord — denying it to every lower scope — while still letting
  // the browser's default action run. Computed before run() so a throwing handler can't
  // leave the key half-processed.
  if (binding.preventDefault?.() ?? true) e.preventDefault();
  binding.run();
}

/** Install the single window-level dispatcher. Idempotent; returns a disposer. */
export function installKeymapDispatcher(): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    installed = false;
  };
}
