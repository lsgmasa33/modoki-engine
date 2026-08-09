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
import { resolveHapticPattern } from './patterns';

let backend: HapticBackend | null = null;
function activeBackend(): HapticBackend {
  if (!backend) backend = pickHapticBackend();
  return backend;
}

/** Test seam — swap in a fake backend, or force a re-pick. */
export function setHapticBackend(b: HapticBackend | null): void { backend = b; }

/** Runtime gates, pushed in from `HapticSettings` by the haptics system each frame. Held as
 *  module state rather than read from the trait at the call site so a play costs no world query —
 *  these fire from inside gesture handling. */
let enabled = true;
let masterIntensity = 1;

/** Apply the live `HapticSettings`. A copy, never a play. */
export function configureHaptics(opts: { enabled: boolean; masterIntensity: number }): void {
  enabled = opts.enabled;
  masterIntensity = Math.max(0, Math.min(1, opts.masterIntensity));
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
export function clearHapticLatency(): void { latencies.length = 0; }

/** Timers for beats not yet fired, so teardown can cancel them rather than buzzing into the next
 *  scene. */
const pending = new Set<ReturnType<typeof setTimeout>>();

function fire(preset: Parameters<HapticBackend['play']>[0], measure: boolean): void {
  // `rawNow`, not `performance.now()` — the determinism guard bans a raw wall-clock read anywhere
  // in engine `runtime/**`, and this is exactly the sanctioned wrapper for a genuine wall-clock
  // measurement. It measures the BRIDGE, never game state, so nothing here feeds the simulation.
  const t0 = measure ? rawNow() : 0;
  // BOTH handlers, deliberately. The stock Capacitor backend swallows its own failures, but a
  // custom backend is free to reject, and a bare `.then()` would leave that as an UNHANDLED
  // rejection — which breaks the "never throws into game code" contract just as surely as a
  // synchronous throw, only later and further away. Caught by the subsystem's own test.
  void activeBackend().play(preset).then(
    () => {
      if (!measure) return;
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
  clearHapticLatency();
  enabled = true;
  masterIntensity = 1;
  backend = null;
}
