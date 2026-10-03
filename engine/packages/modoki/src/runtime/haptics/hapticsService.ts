/**
 * Haptics service — play a named pattern on the device, fire-and-forget.
 *
 * ── Why this does NOT use a per-frame cue queue like audio ──────────────────────
 * `audio/audioCues.ts` queues named cues and drains them once per frame, and that is right for
 * audio: a frame of latency is inaudible and the queue buys ordering. **Haptics must not do
 * that.** The whole feature lives or dies on landing inside the visual effect it accompanies
 * (Court's drop effect is 160ms), and the Capacitor bridge already costs some of that budget.
 * Adding a frame of queueing spends up to 16ms more for nothing. So a call here reaches the
 * backend immediately, and callers are responsible for firing on a state TRANSITION rather than
 * from anything that runs every frame — a haptic hung off a per-frame sync buzzes continuously.
 *
 * ── The contract ───────────────────────────────────────────────────────────────
 *  - Never throws into game code, and never makes a game system await a native call.
 *  - Silent by default off-device (editor, web, headless tests) — the noop backend.
 *  - Emits a tick-stamped `haptic` journal event on every accepted play. That is the ONLY
 *    non-manual verification route: it lets a headless test assert "the win screen fired
 *    `celebrate`" with no hardware attached.
 */

import type { World } from 'koota';
import { emit } from '../core/journal';
import { rawNow } from '../core/clock';
import { getCurrentWorld } from '../core/ecs/worldRegistry';
import { onWorldSwap } from '../core/ecs/world';
import { pickHapticBackend, type HapticBackend } from './backends';
import { resolveHapticPattern, type HapticPreset } from './patterns';
import {
  DEFAULT_ANDROID_EFFECTS, DEFAULT_PLATFORM_EFFECTS, parseAndroidEffect, isAndroidEffectSpecValid, type PlatformHapticEffect,
} from './platformEffects';
import { createTeardownToken } from '../core/liveness';

let backend: HapticBackend | null = null;
function activeBackend(): HapticBackend {
  if (!backend) backend = pickHapticBackend();
  return backend;
}

/**
 * Pick the backend now rather than at the first play. The Android backend asks the vibrator what
 * it supports when it is created, and until that answer arrives every preset takes the old call —
 * so a backend created BY the first play makes the session's first haptic the old buzz (observed
 * on the S22, #2103). `hapticsSystem` calls this every frame; after the first it is a no-op.
 */
export function warmHapticBackend(): void {
  activeBackend();
}

/** Test seam — swap in a fake backend, or force a re-pick. A sample measured through the outgoing
 *  backend must not be attributed to the incoming one, so this invalidates latency liveness too. */
export function setHapticBackend(b: HapticBackend | null): void {
  backend = b;
  latencyLiveness.invalidateAll();
}

/** Runtime gates, pushed in from `HapticSettings` by the haptics system each frame. Held as
 *  module state rather than read from the trait at the call site so a play costs no world query —
 *  these fire from inside gesture handling. */
let enabled = true;
let masterIntensity = 1;
let platformEffects = DEFAULT_PLATFORM_EFFECTS;
let androidEffects: Readonly<Record<HapticPreset, string>> = DEFAULT_ANDROID_EFFECTS;

/** Apply the live `HapticSettings`. A copy, never a play. The two platform fields are optional so
 *  a caller that only knows the gates leaves them at the trait's own defaults. */
export function configureHaptics(opts: {
  enabled: boolean;
  masterIntensity: number;
  platformEffects?: boolean;
  androidEffects?: Readonly<Record<HapticPreset, string>>;
}): void {
  enabled = opts.enabled;
  masterIntensity = Math.max(0, Math.min(1, opts.masterIntensity));
  platformEffects = opts.platformEffects ?? DEFAULT_PLATFORM_EFFECTS;
  androidEffects = opts.androidEffects ?? DEFAULT_ANDROID_EFFECTS;
  // Parse (and so validate) HERE, where the authored value arrives, not at the first play: the
  // editor's backend cannot vibrate and never reaches a play, and the editor is where the value is
  // typed (this runs there while the game is playing; the system is idle when it is stopped). With
  // the switch off too — a typo should not wait for the day it is turned on.
  for (const preset of ANDROID_PRESETS) {
    const text = androidEffects[preset];
    if (typeof text === 'string') parsedEffect(preset, text);
  }
}

/** Parsed mappings, keyed by the authored string — `configureHaptics` runs every frame and a play
 *  fires from gesture handling, so neither may parse. Bounded: typing in the Inspector mints a new
 *  string per keystroke. */
const parsedEffects = new Map<string, PlatformHapticEffect | null>();
const PARSED_EFFECTS_MAX = 64;

const ANDROID_PRESETS = Object.keys(DEFAULT_ANDROID_EFFECTS) as HapticPreset[];

function parsedEffect(preset: HapticPreset, text: string): PlatformHapticEffect | null {
  let parsed = parsedEffects.get(text);
  if (parsed === undefined) {
    parsed = parseAndroidEffect(text);
    if (parsedEffects.size >= PARSED_EFFECTS_MAX) parsedEffects.clear();
    parsedEffects.set(text, parsed);
    // An authored mistake must not pass as "no mapping" in silence — the preset would quietly
    // keep the old feel while the Inspector shows the new one. Once per distinct string.
    if (parsed === null && !isAndroidEffectSpecValid(text)) {
      console.warn(`[haptics] HapticSettings mapping for '${preset}' is not valid: "${text}" — this preset keeps the older call`);
    }
  }
  return parsed;
}

function platformEffectFor(preset: HapticPreset): PlatformHapticEffect | undefined {
  if (!platformEffects) return undefined;
  const text = androidEffects[preset];
  return typeof text === 'string' ? parsedEffect(preset, text) ?? undefined : undefined;
}

export function areHapticsEnabled(): boolean { return enabled; }
export function canDeviceVibrate(): boolean { return activeBackend().canVibrate; }

/** Bridge-latency samples in ms, oldest first — the first beat of a pattern only, since that is
 *  the one a player feels as "late". Read by the debug surface. */
const latencies: number[] = [];
const LATENCY_SAMPLES = 32;
export function hapticLatencySamples(): readonly number[] { return latencies; }
export function hapticLatencyMean(): number | null {
  return latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
}

/** Scopes `latencies` to one backend session. `fire()`'s success handler resolves on the far side
 *  of a bridge round-trip, and `disposeHaptics()` / `clearHapticLatency()` / `setHapticBackend()`
 *  can all land inside that round-trip — without this, the resumed handler pushes a sample it
 *  measured through the OLD backend into an array a new session already owns, and
 *  `hapticLatencyMean()` reports it as the new session's bridge latency. */
const latencyLiveness = createTeardownToken();

export function clearHapticLatency(): void {
  latencies.length = 0;
  latencyLiveness.invalidateAll();
}

/** Timers for beats not yet fired, so teardown can cancel them rather than buzzing into the next
 *  scene. */
const pending = new Set<ReturnType<typeof setTimeout>>();

function fire(preset: Parameters<HapticBackend['play']>[0], measure: boolean): void {
  // `rawNow`, not `performance.now()` — the determinism guard bans a raw wall-clock read anywhere
  // in engine `runtime/**`, and this is exactly the sanctioned wrapper for a genuine wall-clock
  // measurement. It measures the BRIDGE, never game state, so nothing here feeds the simulation.
  const t0 = measure ? rawNow() : 0;
  const b = activeBackend();
  const stillLive = latencyLiveness.capture();
  // BOTH handlers, deliberately. The stock Capacitor backend swallows its own failures, but a
  // custom backend is free to reject, and a bare `.then()` would leave that as an UNHANDLED
  // rejection — which breaks the "never throws into game code" contract just as surely as a
  // synchronous throw, only later and further away. Caught by the subsystem's own test.
  void b.play(preset, platformEffectFor(preset)).then(
    () => {
      if (!measure) return;
      // A teardown/backend-swap landed while this beat was in flight — this sample was measured
      // through a session nobody is scoring any more, so drop it rather than mis-attribute it.
      if (!stillLive()) return;
      latencies.push(rawNow() - t0);
      if (latencies.length > LATENCY_SAMPLES) latencies.shift();
    },
    () => { /* environmental and un-actionable — silent by contract */ },
  );
}

/**
 * Play a named pattern — engine default or game-registered (see `patterns.ts`).
 *
 * `masterIntensity` currently gates rather than scales: below 0.05 nothing plays. Presets carry
 * fixed strengths and no platform in range lets us scale one, so a partial scale would be a lie.
 * The field exists because a player-facing strength slider is the obvious next ask, and it should
 * not require a trait migration when a backend can finally honour it.
 */
export function playHaptic(name: string, world: World = getCurrentWorld()): void {
  if (!enabled || masterIntensity < 0.05) return;
  const pattern = resolveHapticPattern(name);
  if (!pattern || pattern.length === 0) {
    // A missing name is a game bug (a typo, or a pattern never registered), not an environment
    // problem — so unlike a backend failure it is worth saying out loud, once, in the journal.
    emit('haptic.unknown', { name }, world, 'warn');
    return;
  }
  emit('haptic', { name, beats: pattern.length }, world);
  if (!activeBackend().canVibrate) return;   // journal it anyway: headless tests assert on this

  let elapsed = 0;
  pattern.forEach((s, i) => {
    elapsed += s.delayMs;
    if (elapsed === 0) { fire(s.preset, i === 0); return; }
    const id = setTimeout(() => { pending.delete(id); fire(s.preset, false); }, elapsed);
    pending.add(id);
  });
}

/** Cancel every beat still waiting to fire. Call on scene teardown / world dispose — a pattern
 *  mid-flight would otherwise buzz into whatever comes next. */
export function cancelPendingHaptics(): void {
  for (const id of pending) clearTimeout(id);
  pending.clear();
}

// A world swap means the scene that raised those beats is gone — the same reason `videoSystem`
// stops its playback here. Without this the function below existed and NOTHING called it: a
// three-beat pattern raised at the moment of a scene change would keep buzzing into whatever
// loaded next, and its own doc comment ("call on scene teardown") was the only thing that ever
// did. Found by grepping this module's own exports for callers.
onWorldSwap(() => cancelPendingHaptics());

/** Full reset for tests and project swaps: gates back to defaults, timers cancelled, backend
 *  re-picked on next use. Does NOT clear registered patterns — that is `clearHapticPatterns`. */
export function disposeHaptics(): void {
  cancelPendingHaptics();
  clearHapticLatency(); // already invalidates latency liveness — no separate invalidation needed here
  enabled = true;
  masterIntensity = 1;
  platformEffects = DEFAULT_PLATFORM_EFFECTS;
  androidEffects = DEFAULT_ANDROID_EFFECTS;
  parsedEffects.clear();
  backend = null;
}
