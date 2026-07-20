/** inputPrompts — device-appropriate prompt labels for UI ("Press A" vs "Click").
 *
 *  Part B4/Phase 4 of the input-and-ui-focus plan: the LAST piece of the
 *  source-agnostic input model. The `Input` resource already tracks which device
 *  last produced input (`lastInputDevice(world)`); this maps that device + a
 *  digital action to the short glyph/label a menu shows next to a confirm/cancel
 *  affordance, so the same authored button reads "Press A" on a controller,
 *  "Enter" on a keyboard, and "Click"/"Tap" on pointer/touch — with no per-game
 *  branching.
 *
 *  PURE + deterministic: a plain lookup table, no DOM, no world, no wall-clock —
 *  unit-testable in isolation. The reactive wiring (read sources + repaint on
 *  device change) lives in `inputPromptSources.ts` / `inputSystem.ts`; this file
 *  is just the vocabulary.
 *
 *  Labels are plain ASCII words on purpose (no controller glyphs) so they render
 *  in any font — a game that wants glyph icons can build its own map on top of
 *  `lastInputDevice`. */

import type { DigitalAction, InputDevice } from './actions';

/** The digital actions a UI typically surfaces a prompt for. Nav (arrows/d-pad)
 *  is intentionally omitted — it's shown as directional hints, not a single label. */
export const PROMPT_ACTIONS = ['confirm', 'cancel', 'menu', 'pause', 'jump'] as const;
export type PromptAction = (typeof PROMPT_ACTIONS)[number];

/** Per-device label for each promptable action. A device that omits an action
 *  falls back to the keyboard label (a sensible textual default), then to the
 *  Capitalized action name. `none` yields '' (no device seen yet → no prompt). */
const PROMPTS: Record<InputDevice, Partial<Record<PromptAction, string>>> = {
  gamepad: { confirm: 'A', cancel: 'B', menu: 'Menu', pause: 'Start', jump: 'A' },
  keyboard: { confirm: 'Enter', cancel: 'Esc', menu: 'Esc', pause: 'P', jump: 'Space' },
  pointer: { confirm: 'Click', cancel: 'Back', menu: 'Menu', pause: 'Pause', jump: 'Click' },
  native: { confirm: 'Tap', cancel: 'Back', menu: 'Menu', pause: 'Pause', jump: 'Tap' },
  none: {},
};

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The prompt label for a (device, action) pair. Never returns null: an unknown
 *  device or action degrades to the keyboard label, then the Capitalized action
 *  name; `none` (no input seen yet) degrades to '' so a bound `{confirmPrompt}`
 *  renders empty rather than a stray literal. */
export function promptFor(device: InputDevice, action: DigitalAction): string {
  if (device === 'none') return '';
  const forDevice = PROMPTS[device] ?? PROMPTS.keyboard;
  const label = forDevice[action as PromptAction];
  if (label != null) return label;
  // Fall back to the keyboard label for this action, then the action name itself.
  const kbd = PROMPTS.keyboard[action as PromptAction];
  return kbd ?? capitalize(action);
}
