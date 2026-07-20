/** Gamepad input source — the browser Gamepad API modality of the source-agnostic
 *  input seam (Part A3, Phase 2 of the input-and-ui-focus plan). This is the payoff:
 *  it validates the whole abstraction on a platform we have TODAY (web/Electron), so
 *  every game built afterward gets controller support for free, and a native console
 *  pad later is "just another source" implementing the same `InputSource`.
 *
 *  Split in two for testability:
 *    - `sampleGamepadInto` — a PURE mapper (no DOM): a W3C "standard gamepad"
 *      snapshot → contributions merged into an `InputFrame`. Unit-tested directly
 *      with fabricated snapshots.
 *    - `gamepadSource` — the thin DOM wrapper: polls `navigator.getGamepads()` and
 *      delegates to the pure mapper. `navigator` is the ONLY thing it touches, and
 *      only inside `sample()` — guarded so importing it headless is inert.
 *
 *  The button/axis→action table is plain read-only config (per the "mapping is config,
 *  not a resource" decision) — a rebindable table is Phase 4. No wall-clock, no RNG. */

import type { InputSource } from './inputSources';
import { applyDeadzone, type InputFrame } from './actions';

/** W3C "standard gamepad" button indices (https://w3c.github.io/gamepad/#remapping). */
const BTN = {
  A: 0, B: 1, /* X: 2, Y: 3, */ START: 9,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
} as const;

/** Standard-mapping axis indices: left stick (0,1), right stick (2,3). Browser
 *  convention is +Y = DOWN, so we negate Y to match our "forward/up = +1" frame. */
const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 } as const;

/** The minimal shape `sampleGamepadInto` needs — a real `Gamepad` satisfies it, and
 *  so does a hand-built test fixture (no DOM required). */
export interface GamepadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

function pressed(pad: GamepadSnapshot, index: number): boolean {
  return pad.buttons[index]?.pressed === true;
}

/** Merge one gamepad's contribution into `out` (OR held flags, ADD axes). Returns
 *  whether the pad showed any activity this frame (a pressed button or a stick/D-pad
 *  past the deadzone) — the caller uses that to set `lastDevice`. Pure: no DOM. */
export function sampleGamepadInto(pad: GamepadSnapshot, out: InputFrame, deadzone = 0.2): boolean {
  let active = false;

  // Left stick → locomotion. Deadzoned; Y negated (browser +Y down → forward = +1).
  const lx = applyDeadzone(pad.axes[AXIS.LX] ?? 0, deadzone);
  const ly = applyDeadzone(pad.axes[AXIS.LY] ?? 0, deadzone);
  if (lx !== 0) { out.axes.moveX += lx; active = true; }
  if (ly !== 0) { out.axes.moveY += -ly; active = true; }

  // Right stick → look/aim. Same sign convention.
  const rx = applyDeadzone(pad.axes[AXIS.RX] ?? 0, deadzone);
  const ry = applyDeadzone(pad.axes[AXIS.RY] ?? 0, deadzone);
  if (rx !== 0) { out.axes.lookX += rx; active = true; }
  if (ry !== 0) { out.axes.lookY += -ry; active = true; }

  // D-pad → UI nav edges AND discrete locomotion (mirrors keyboard arrows, which
  // drive both move axes and nav). So a d-pad-only game still moves the character.
  if (pressed(pad, BTN.DPAD_UP)) { out.held.navUp = true; out.axes.moveY += 1; active = true; }
  if (pressed(pad, BTN.DPAD_DOWN)) { out.held.navDown = true; out.axes.moveY -= 1; active = true; }
  if (pressed(pad, BTN.DPAD_LEFT)) { out.held.navLeft = true; out.axes.moveX -= 1; active = true; }
  if (pressed(pad, BTN.DPAD_RIGHT)) { out.held.navRight = true; out.axes.moveX += 1; active = true; }

  // Face buttons. A = confirm + jump (mirrors keyboard Space); B = cancel;
  // Start = menu + pause.
  if (pressed(pad, BTN.A)) { out.held.confirm = true; out.held.jump = true; active = true; }
  if (pressed(pad, BTN.B)) { out.held.cancel = true; active = true; }
  if (pressed(pad, BTN.START)) { out.held.menu = true; out.held.pause = true; active = true; }

  return active;
}

let connected = 0;
function onConnect(): void { connected += 1; }
function onDisconnect(): void { connected = Math.max(0, connected - 1); }

export const gamepadSource: InputSource = {
  name: 'gamepad',

  attach(): void {
    if (typeof window === 'undefined') return;
    // Some browsers only expose pads via getGamepads() AFTER a connect event, so
    // track connectivity to skip polling (and iterating a nulls array) when idle.
    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    // Seed from the CURRENT pad state. A controller already known to the page does NOT
    // re-emit `gamepadconnected` when listeners are re-registered (HMR, a game swapping
    // the source, any detach→attach), so relying on events alone would leave a live
    // controller gated off (connected === 0) forever after the first re-attach.
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.getGamepads) {
      connected = 0;
      for (const pad of nav.getGamepads()) if (pad && pad.connected) connected += 1;
    }
  },

  detach(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    }
    connected = 0;
  },

  sample(out: InputFrame): void {
    if (connected === 0) return;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (!nav?.getGamepads) return;
    for (const pad of nav.getGamepads()) {
      // First connected pad wins (single-player). Multi-pad merge is a later concern.
      if (pad && pad.connected) {
        if (sampleGamepadInto(pad, out)) out.lastDevice = 'gamepad';
        break;
      }
    }
  },
};
