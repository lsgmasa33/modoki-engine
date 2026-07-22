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

import type { ManagerDef } from '../managers/managerRegistry';
import type { InputFrame } from './actions';
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
let wasSuppressed = false;

/** Install the host's suppression predicate — return true to BLOCK input from reaching
 *  the game. Pass null to clear. */
export function setInputGate(fn: (() => boolean) | null): void {
  inputGate = fn;
  if (!fn) wasSuppressed = false;
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
 *  While the host gate is closed, sources are NOT sampled and their latched state is
 *  dropped on the closing edge. The reset is load-bearing, not tidiness: hold W, click
 *  the Hierarchy, and without it `held` still contains 'w', so the character keeps
 *  walking until you physically release. Same class as the existing blur / play-start
 *  resets in keyboardSource. */
export function sampleAll(out: InputFrame): void {
  const suppressed = isInputSuppressed();
  if (suppressed) {
    if (!wasSuppressed) { wasSuppressed = true; for (const s of sources) s.reset?.(); }
    return;
  }
  wasSuppressed = false;
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
