/** keyReach — "if I press this key right now, does it reach ANYTHING?"
 *
 *  Two independent gates decide whether a trusted keypress does something, and naming only
 *  one of them is what QA-PHYS-0003 measured as a confident false negative: a runner drove
 *  `modoki_press_key {key:'d'}` 80 times at a running platformer and reported the character
 *  controller broken. It was not. The keyboard SCOPE was left on `scene` by the previous
 *  case, so `EditorApp`'s input gate suppressed every one of those keys before the game's
 *  sampler saw them — while the route answered `ok:true` each time.
 *
 *    1. DOM focus  — a text field eats the key. Already reported (`gameSwallows`, the
 *       ACTIVE_ELEMENT_PROBE in rendererOps.ts), and the half everybody knew about.
 *    2. Keyboard scope — `focusedPanel` is a panel other than the GameView, so
 *       `inputSources`' gate blocks the runtime sources. Reported by NOBODY until now.
 *
 *  The keymap is consulted as a SUPPRESSOR, not as proof: a chord the registry claims did
 *  something even though the game never saw it (`w` sets the gizmo mode with the scope on
 *  `scene` — correct usage, not a mistake), so the warning stays quiet for it.
 *
 *  ⚠️ `editorBinding: null` is STRONG but not total, and the difference decides how loudly
 *  anything built on this may speak. What it covers (swept 2026-08-19): the registry is the
 *  editor's only window-level CHORD listener — `dispatcher.ts`, plus exactly one other raw
 *  window keydown subscription in the whole editor, SceneView's Shift-snap watcher, which
 *  tracks a modifier and binds no chord. (Both are the documented entries in
 *  `keymapOwnership.test.ts`'s ALLOWED — that guard is what keeps this sentence true, and
 *  spelling the DOM call out here in prose trips its regex, which scans raw source.) What it
 *  does NOT cover: element-level
 *  `onKeyDown` handlers (text inputs, the Add-Component picker, AssetRefField), which fire
 *  only while that element holds DOM focus — so `activeElement`, reported alongside, is the
 *  other half of the answer.
 *
 *  Hence a caller may claim "the key did not reach the running game" (the gate proves that)
 *  but not "this press did nothing at all" (an element handler may have taken it). A first
 *  draft of the warning said the latter. The live run that seemed to disprove it — `ArrowDown`
 *  resolving to null under the Hierarchy scope — actually did NOT: the Hierarchy has no arrow
 *  navigation at all (nor do treeChrome/ScriptTree), so null was the complete and correct
 *  answer there. The wording stays conservative for the element-handler reason above, which is
 *  the one that survives checking.
 *
 *  MEASURED, not restated: `isInputSuppressed()` runs the gate the editor actually
 *  installed, and `resolve()` is the same pure function the dispatcher resolves with. This
 *  module holds no copy of either policy — the alternative (re-deriving `focusedPanel !==
 *  'game'` here) is exactly the shadowing this repo keeps paying for. */

import { normalizeChord, resolve } from './keymap';
import { isTextEditable, topOverlay } from './focusScope';
import { useEditorStore } from '../store/editorStore';
import { isInputSuppressed } from '../../runtime/input/inputSources';
import { isSimRunning } from '../../runtime/core/playState';

/** Electron accelerator name → the DOM `key` the page will actually see.
 *
 *  The INVERSE of `KEYCODE_ALIAS` in engine/electron/rendererOps.ts, which rewrites the
 *  caller's `ArrowUp` into the `Up` that `sendInputEvent` wants. A caller may pass either
 *  spelling (the tool description offers `'ArrowUp'`), so resolution has to see the DOM
 *  form or a bound arrow key reads as unbound and the warning fires on a press that worked.
 *  `keyReach.test.ts` asserts the two maps stay inverses. */
export const DOM_KEY_ALIAS: Record<string, string> = {
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
};

export interface KeyReach {
  /** The editor keyboard scope at probe time (NOT document.activeElement). */
  focusedPanel: string | null;
  /** Command id of the binding that will claim this chord, or null — the dispatcher YIELDS. */
  editorBinding: string | null;
  /** Is the editor's input gate blocking the running game's input sources right now? */
  gameInputSuppressed: boolean;
  /** Is there a running sim to block input FROM? `gameInputSuppressed` is true through most
   *  ordinary editing (any panel but the GameView closes the gate), so on its own it says
   *  nothing interesting — it only becomes a finding once a game is actually running. */
  simRunning: boolean;
  /** The canonical chord resolution ran against. `/api/input/key` echoes it alongside the
   *  scope warning (only there — it is noise on a press that worked), which is what lets a
   *  reader tell "wrong scope" from "wrong key spelling". */
  chord: string;
}

/** Canonical chord for an `/api/input/key` payload (an Electron keyCode + modifier list),
 *  as opposed to `chordFromEvent`, which takes a real KeyboardEvent. Pure. */
export function chordFromElectronKey(key: string, modifiers?: readonly string[]): string {
  return normalizeChord([...(modifiers ?? []), DOM_KEY_ALIAS[key] ?? key].join('+'));
}

/** Keys the dispatcher refuses to treat as a chord at all — it returns before `resolve()`
 *  for these ("a bare modifier press is not a chord"). Mirrored here so the probe cannot
 *  report that the keymap claims a press which physically never reaches resolution in
 *  production; without it, a binding registered with a modifier-only `keys` reads as claimed
 *  by the probe and dead in the real editor. */
const BARE_MODIFIERS = new Set(['Meta', 'Shift', 'Control', 'Alt']);

/** Probe both gates + the keymap for a chord, WITHOUT pressing it. Read-only. */
export function probeKeyReach(key: string, modifiers?: readonly string[]): KeyReach {
  const focusedPanel = useEditorStore.getState().focusedPanel;
  const chord = chordFromElectronKey(key, modifiers);
  if (BARE_MODIFIERS.has(key)) {
    return { focusedPanel, editorBinding: null, gameInputSuppressed: isInputSuppressed(), simRunning: isSimRunning(), chord };
  }
  const binding = resolve(chord, {
    focusedPanel,
    overlay: topOverlay(),
    textEditable: isTextEditable(typeof document !== 'undefined' ? document.activeElement : null),
  });
  return {
    focusedPanel,
    editorBinding: binding?.id ?? null,
    gameInputSuppressed: isInputSuppressed(),
    simRunning: isSimRunning(),
    chord,
  };
}
