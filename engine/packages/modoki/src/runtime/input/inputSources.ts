/** Input source interface + registry (Part A3 of the input-and-ui-focus plan).
 *
 *  An `InputSource` owns one physical input modality (keyboard, pointer, gamepad,
 *  later a native console pad). It attaches its own listeners / polling on the
 *  session, and each frame merges its contribution into the shared `InputFrame`.
 *  The `inputSystem` (app pipeline) drives them: `attachAll` on session start,
 *  `sampleAll` every frame, `detachAll` on teardown.
 *
 *  Sources are the ONLY sanctioned place in the engine that reads `window` /
 *  `document` / `navigator.getGamepads` — the guardrail test enforces that the rest
 *  of the engine + game runtime trees go through the `Input` resource instead.
 *  Registered as an app-scope Manager (`inputSourcesManager`) so they attach/detach
 *  with the session and never load in the headless harness (keeping it deterministic). */

import type { ManagerDef } from '../core/managerTypes';
import type { InputFrame } from '../core/inputActions';
import { keyboardSource } from './keyboardSource';
import { gamepadSource } from './gamepadSource';
import { pointerSource } from './pointerSource';
import { registerInputPromptSources } from './inputPromptSources';

export interface InputSource {
  readonly name: string;
  /** Begin listening / polling. Idempotent — safe to call when already attached. */
  attach(): void;
  /** Stop listening and drop any latched state. Idempotent. */
  detach(): void;
  /** Merge this source's contribution into `out` (OR held flags, add axes, set
   *  `lastDevice` on activity). Never clears another source's contribution. */
  sample(out: InputFrame): void;
  /** Drop latched state WITHOUT detaching. Called when the input gate closes, so a key
   *  held at that moment can't keep driving the game. Optional; a stateless source
   *  (one that derives everything in `sample`) needs none. */
  reset?(): void;
}

// ── Host input gate ─────────────────────────────────────────────────────────
//
// The HOST decides when input should stop reaching the game; the runtime only provides
// the mechanism. Mirrors the injectable clock: mechanism here, policy outside.
//
// The editor uses it for focus scoping — while an editor panel other than the GameView
// owns the keyboard, WASD must not latch into the running game. That policy CANNOT live
// in a source: `keyboardSource` ships inside every game and must never know what a
// "panel" is.
//
// A shipped game never calls setInputGate, so the gate stays null and behaviour is
// unchanged. The headless harness never registers sources at all.
//
// Why here and not in keyboardSource: all three built-in sources leak, and only one has
// any guard. keyboardSource has `editing()`; pointerSource listens on window with NO
// guard (a pointerdown in the Hierarchy feeds the game during play); gamepadSource polls
// with NO guard (a controller drives the game while you type in the Inspector). One gate
// at the registry covers all three and anything a game registers later.

let inputGate: (() => boolean) | null = null;

/** Install the host's suppression predicate — return true to BLOCK input from reaching
 *  the game. Pass null to clear. */
export function setInputGate(fn: (() => boolean) | null): void {
  inputGate = fn;
}

/** Is input currently suppressed by the host? A throwing gate fails OPEN — a broken
 *  editor predicate must never make a game permanently uncontrollable. */
export function isInputSuppressed(): boolean {
  if (!inputGate) return false;
  try { return inputGate() === true; }
  catch { return false; }
}

const sources: InputSource[] = [];

/** Register an input source. De-duplicates by `name` (last wins) so a hot-reload or
 *  a game replacing a source doesn't stack duplicates. Attaches immediately if the
 *  registry is already attached. */
export function registerSource(source: InputSource): void {
  const idx = sources.findIndex((s) => s.name === source.name);
  if (idx >= 0) { sources[idx].detach(); sources[idx] = source; }
  else sources.push(source);
  if (attached) source.attach();
}

export function unregisterSource(name: string): void {
  const idx = sources.findIndex((s) => s.name === name);
  if (idx >= 0) { sources[idx].detach(); sources.splice(idx, 1); }
}

export function getSources(): readonly InputSource[] { return sources; }

let attached = false;

export function attachAll(): void {
  if (attached) return;
  attached = true;
  for (const s of sources) s.attach();
}

export function detachAll(): void {
  if (!attached) return;
  attached = false;
  for (const s of sources) s.detach();
}

/** Merge every attached source into `out`, in registration order.
 *
 *  While the host gate is closed, sources are NOT sampled and every frame DRAINS them.
 *  The drop is load-bearing, not tidiness, and it answers two different problems:
 *
 *    - latched LEVEL state: hold W, click the Hierarchy, and without a reset `held` still
 *      contains 'w', so the character keeps walking until you physically release. Same
 *      class as the existing blur / play-start resets in keyboardSource.
 *    - QUEUED discrete events: a source's raw listeners are never detached by the gate —
 *      only `sample()` is skipped — so pointerSource's press/release FIFO keeps filling
 *      with every click made in an editor panel while the game is unfocused. Left alone,
 *      reopening replays that whole backlog into the game, one entry per frame.
 *
 *  ⚠️ DRAIN CONTINUOUSLY, NEVER ON THE REOPENING EDGE (#264). This used to reset on both
 *  edges — closing, then again on reopening to clear the backlog — and the reopening reset
 *  ate the very input that OPENED the gate. `PanelFocusHost` moves the keyboard scope on
 *  CAPTURE-phase pointerdown, before any panel handler and before pointerSource's own
 *  window listener enqueues the press. So a click into the Game panel flips the gate open
 *  and lands in the queue within the same tick, and the next frame — still carrying
 *  `wasSuppressed` from before — reset it away. Not just its pressed edge: `reset()` clears
 *  `activeId`, so the gesture's later move/up fall through pointerSource's
 *  `pointerId !== activeId` checks too, and a drag-to-aim died whole. The second click
 *  worked, which is what made it read as flaky rather than broken.
 *
 *  Draining every suppressed frame keeps the backlog property (nothing survives to replay)
 *  while leaving the reopened frame untouched, so a press that arrives AFTER the gate opens
 *  is delivered. It also removes the edge bookkeeping entirely — there is no `wasSuppressed`
 *  any more, and no way to get its two edges out of step.
 *
 *  This runs only while a host gate is installed AND closed — i.e. in the editor, with the
 *  sim playing and a non-game panel focused. A shipped game installs no gate and never
 *  reaches it. `reset()` must stay CHEAP for that reason: it is now per-frame, not per-edge. */
export function sampleAll(out: InputFrame): void {
  if (isInputSuppressed()) {
    for (const s of sources) s.reset?.();
    return;
  }
  for (const s of sources) s.sample(out);
}

// Built-in sources. Keyboard + gamepad + pointer are always registered (all inert
// until they see input / a controller connects / the pointer goes down).
registerSource(keyboardSource);
registerSource(gamepadSource);
registerSource(pointerSource);

/** App-scope Manager: attaches all sources on register, detaches on unregister.
 *  Replaces the old keyboard-only `inputManagerDef`. */
// Disposer for the device-prompt read sources ({confirmPrompt} etc.), registered
// alongside the sources so device-appropriate UI prompts are available app-lifetime.
let disposePromptSources: (() => void) | null = null;

export const inputSourcesManager: ManagerDef = {
  name: 'Input',
  scope: 'app',
  init: () => {
    attachAll();
    disposePromptSources = registerInputPromptSources();
  },
  dispose: () => {
    detachAll();
    disposePromptSources?.();
    disposePromptSources = null;
  },
};
