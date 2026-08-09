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
 *  - `haptics.play`   — play a named pattern (payload `{ pattern }`, default `'select'`). The one
 *                       a button uses to give itself a tap feel with zero TS.
 *  - `haptics.toggle` — flip `HapticSettings.enabled`, and persist it (see below).
 *  - `haptics.set`    — set it explicitly (payload `{ enabled }`), for a settings screen whose
 *                       control knows the value it wants rather than "the other one".
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
  registerUIAction('haptics.play', ({ payload }) => {
    const p = (payload ?? {}) as { pattern?: unknown };
    playHaptic(typeof p.pattern === 'string' && p.pattern ? p.pattern : DEFAULT_PATTERN);
  });

  registerUIAction('haptics.toggle', () => {
    const e = settingsEntity();
    const s = e?.get(HapticSettings);
    if (!s) return;
    setEnabled(!s.enabled);
  });

  registerUIAction('haptics.set', ({ payload }) => {
    const p = (payload ?? {}) as { enabled?: unknown };
    if (typeof p.enabled !== 'boolean') return;   // authored scene data — validated, never trusted
    setEnabled(p.enabled);
  });
}
