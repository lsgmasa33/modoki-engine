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

/** Merge every attached source into `out`, in registration order. */
export function sampleAll(out: InputFrame): void {
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
