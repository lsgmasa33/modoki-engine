/** Keyboard input source — the DOM-keyboard modality of the source-agnostic input
 *  seam (Part A3). Refactored out of the former `systems/inputManager.ts`: same
 *  discipline — PASSIVE window listeners (no preventDefault, so it never steals
 *  editor keys), an `editing()` guard that ignores keys while a text field is
 *  focused, and a blur/visibility/play-start reset so a stale held key can't leak
 *  into the first play frame.
 *
 *  It only tracks which keys are HELD; edges (`pressed`/`released`) are derived
 *  centrally by `inputSystem` via `computeEdges`, so this source stays a pure
 *  level-state reporter. This is a deliberate departure from the old inputManager,
 *  which latched the jump edge inside the keydown handler: a press+release that both
 *  land BETWEEN two sim frames (a sub-frame tap, < ~16ms at 60fps) is no longer
 *  latched, so it produces no edge. That window is unreachable by physical tapping
 *  (only a synthetic keydown+keyup burst hits it), and centralizing edge derivation
 *  keeps every source a simple held-reporter — a trade we accept for the abstraction.
 *
 *  `sample()` maps held keys onto the canonical action vocabulary:
 *    - moveX  ← A/D + ←/→   (held analog, ∓1)
 *    - moveY  ← W/S + ↑/↓   (held analog; forward/up = +1)
 *    - nav*   ← the same keys, consumed as edges for UI focus movement
 *    - jump   ← Space
 *    - aim    ← F
 *    - confirm ← Space/Enter    cancel ← Esc    menu ← Esc    pause ← P
 *
 *  Guards `typeof window` so importing it headless is inert; no wall-clock / no RNG. */

import type { InputSource } from './inputSources';
import type { InputFrame } from './actions';
import { getPlayState, onPlayStateChange } from '../systems/playState';

const LEFT = ['a', 'arrowleft'];
const RIGHT = ['d', 'arrowright'];
const UP = ['w', 'arrowup'];
const DOWN = ['s', 'arrowdown'];

const held = new Set<string>();
let attached = false;
let offPlayState: (() => void) | null = null;

function reset(): void { held.clear(); }
function key(e: KeyboardEvent): string { return (e.key || '').toLowerCase(); }

/** Ignore keys while the user is typing in a text field (inspector, name input, …),
 *  so editing never latches movement/nav keys. */
function editing(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onKeyDown(e: KeyboardEvent): void { if (!editing()) held.add(key(e)); }
function onKeyUp(e: KeyboardEvent): void { held.delete(key(e)); }
function onBlur(): void { reset(); }
function onVisibility(): void { if (document.visibilityState === 'hidden') reset(); }

function any(keys: string[]): boolean { return keys.some((k) => held.has(k)); }

export const keyboardSource: InputSource = {
  name: 'keyboard',

  attach(): void {
    if (attached || typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    // Flush stale keys each time the sim (re)starts, so an editor-time keypress (or a
    // key still held from a previous run) can't leak into the first play frame.
    offPlayState = onPlayStateChange(() => { if (getPlayState() === 'playing') reset(); });
    attached = true;
  },

  detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    offPlayState?.(); offPlayState = null;
    reset(); attached = false;
  },

  /** Drop held keys without detaching — used by the host input gate's closing edge
   *  (inputSources.sampleAll) so a key held when focus leaves the game stops driving it. */
  reset(): void { reset(); },

  sample(out: InputFrame): void {
    let active = false;

    // Analog locomotion axes (held level).
    if (any(LEFT)) { out.axes.moveX -= 1; active = true; }
    if (any(RIGHT)) { out.axes.moveX += 1; active = true; }
    if (any(UP)) { out.axes.moveY += 1; active = true; }   // forward/up = +1
    if (any(DOWN)) { out.axes.moveY -= 1; active = true; }

    // The same keys, as digital nav (edges derived by inputSystem → UI focus + 2D jump).
    if (any(UP)) out.held.navUp = true;
    if (any(DOWN)) out.held.navDown = true;
    if (any(LEFT)) out.held.navLeft = true;
    if (any(RIGHT)) out.held.navRight = true;

    if (held.has(' ') || held.has('space')) { out.held.jump = true; out.held.confirm = true; active = true; }
    if (held.has('f')) { out.held.aim = true; active = true; }
    if (held.has('enter')) { out.held.confirm = true; active = true; }
    if (held.has('escape') || held.has('esc')) { out.held.cancel = true; out.held.menu = true; active = true; }
    if (held.has('p')) { out.held.pause = true; active = true; }

    if (active) out.lastDevice = 'keyboard';
  },
};
