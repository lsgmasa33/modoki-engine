/** inputPromptSources — wires device prompts into the UI read-source registry.
 *
 *  Bridges the pure `promptFor` table (`inputPrompts.ts`) to UI text templates:
 *  registers named read sources so an authored `UIElement.text` like
 *  "Press {confirmPrompt} to start" (with `UIBinding.textBinding` set) resolves
 *  live against the device that last produced input. Reuses the existing
 *  read-source seam — no new authoring concept, no per-frame store copy.
 *
 *  Registered tokens:
 *    {inputDevice}  → 'gamepad' | 'keyboard' | 'pointer' | 'native' | 'none'
 *    {confirmPrompt}, {cancelPrompt}, {menuPrompt}, {pausePrompt}, {jumpPrompt}
 *
 *  Values are PULLED at resolve time from the live `Input` resource — the
 *  repaint that makes a swap visible the instant a controller is touched comes
 *  from `inputSystem` calling `markUIDirty()` on a device change. Uses
 *  `peekCurrentWorld()` (never lazily allocates a world) and returns '' when
 *  there's no world/Input yet, so a bound token renders empty rather than a
 *  stray literal before the first frame.
 *
 *  LIFECYCLE: app-lifetime, owner-managed — registered from `inputSourcesManager`
 *  init and unregistered via the returned disposer on dispose (read sources are
 *  NOT auto-cleared on world swap; see readSourceRegistry F9). */

import { peekCurrentWorld } from '../ecs/worldRegistry';
import { registerReadSource } from '../ui/readSourceRegistry';
import { lastInputDevice } from '../traits/Input';
import { promptFor, PROMPT_ACTIONS } from './inputPrompts';
import type { InputDevice } from './actions';

function currentDevice(): InputDevice {
  const world = peekCurrentWorld();
  return world ? lastInputDevice(world) : 'none';
}

/** Register the device + prompt read sources. Returns a disposer that removes
 *  exactly the entries it added (identity-safe, via registerReadSource). */
export function registerInputPromptSources(): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(registerReadSource('inputDevice', () => currentDevice()));
  for (const action of PROMPT_ACTIONS) {
    disposers.push(registerReadSource(`${action}Prompt`, () => promptFor(currentDevice(), action)));
  }
  return () => { for (const d of disposers) d(); };
}
