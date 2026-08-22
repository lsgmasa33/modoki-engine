/**
 * Built-in haptic control layer — engine-wide UI actions, so a game wires a haptics button or a
 * settings toggle DECLARATIVELY (a scene-authored `UIAction` binding) instead of hand-driving the
 * service from its `setup.ts`. Registered once app-wide by `registerHapticControls`, alongside
 * `registerAudioControls`.
 *
 * App-tier and event-driven — no per-frame tick, no wall-clock, no randomness — so it never enters
 * the deterministic headless pipeline.
 *
 * Actions:
 *  - `haptics.play`   — play a named pattern (`params: { pattern }`, default `'select'`). The one
 *                       a button uses to give itself a tap feel with zero TS.
 *  - `haptics.toggle` — flip `HapticSettings.enabled`, and persist it (see below).
 *  - `haptics.set`    — set it explicitly (`params: { enabled }`), for a settings screen whose
 *                       control knows the value it wants rather than "the other one".
 *
 * ⚠️ **`play` AND `set` READ `ctx.params`, AND READING `ctx.payload.pattern` MADE THEM DEAD** —
 * fixed 2026-08-11 while building the neighbouring `quality.set` (#188). `UIActionPayload` is
 * `string | number`, so an OBJECT can never arrive from authored scene JSON: `ui/bindings.ts`
 * routes a binding's `params` to `ctx.params` and puts only the live event value (or a single
 * authored `params.payload`) in `ctx.payload`. Destructuring `{ payload }` and reading
 * `payload.pattern` therefore yielded `undefined` for every authorable binding — `haptics.play`
 * silently fell back to `'select'` whatever was authored, and `haptics.set` did nothing at all.
 * Nothing caught it because no scene, test or caller in the repo dispatched either action with an
 * argument; the only thing that pointed at it was a comment in `haptics.test.ts` claiming a
 * pattern name IS reachable from authored data, which was true of the intent and not of the code.
 * `payload` is kept as a fallback so a control emitting `$value` works without a wrapper param.
 *
 * ⚠️ **The toggle writes the TRAIT, and the trait is the live value** — `hapticsSystem` copies it
 * into the service each frame. Nothing here calls `configureHaptics` directly: a second writer
 * would race the system and produce a setting that flickers back a frame later.
 *
 * **Persistence is opt-in and belongs to the game.** These actions do NOT touch PlayerPrefs,
 * because the key namespace and the moment to flush are the game's business — a game that wants
 * the setting to survive a restart reads it at bootstrap and writes it back on change. Baking a
 * key in here would put engine-chosen storage under a game-chosen setting.
 */

import { registerUIAction } from '../core/actionRegistry';
import { getCurrentWorld } from '../core/ecs/worldRegistry';
import { HapticSettings } from '../traits/HapticSettings';
import { playHaptic } from '../haptics/hapticsService';

/** Default for `haptics.play` with no payload — the lightest thing in the vocabulary, which is
 *  what a bare "this button should feel like something" wants. */
const DEFAULT_PATTERN = 'select';

function settingsEntity() {
  return getCurrentWorld().queryFirst(HapticSettings);
}

function setEnabled(next: boolean): void {
  const e = settingsEntity();
  if (!e) return;               // no HapticSettings authored — nothing to toggle, and that is fine
  const s = e.get(HapticSettings);
  if (!s) return;
  e.set(HapticSettings, { ...s, enabled: next });
}

export function registerHapticControls(): void {
  registerUIAction('haptics.play', ({ params, payload }) => {
    const pattern = params?.pattern ?? payload;
    playHaptic(typeof pattern === 'string' && pattern ? pattern : DEFAULT_PATTERN);
  });

  registerUIAction('haptics.toggle', () => {
    const e = settingsEntity();
    const s = e?.get(HapticSettings);
    if (!s) return;
    setEnabled(!s.enabled);
  });

  // ⚠️ NO `payload` FALLBACK HERE, unlike `play` above, and the asymmetry is deliberate:
  // `UIActionPayload` is `string | number`, so a BOOLEAN cannot ride it and a fallback would be a
  // branch that can never fire — the same dead-code shape this handler was just rescued from.
  // `params` is `Record<string, unknown>` and carries a real authored boolean.
  registerUIAction('haptics.set', ({ params }) => {
    const enabled = params?.enabled;
    if (typeof enabled !== 'boolean') return;   // authored scene data — validated, never trusted
    setEnabled(enabled);
  });
}
