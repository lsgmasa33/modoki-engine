/** Updates the Time resource trait each frame.
 *
 *  Separates three concerns (Phase 1 — see docs/verification-harness.md):
 *   1. raw cadence (`rawNow()` from the injectable clock → clamped delta),
 *   2. smoothing (an internal EMA of the cadence — jitter only),
 *   3. time control (`timeScale`), applied AFTER smoothing so pause/time-stop is
 *      instant, not coasting.
 *
 *  Two public deltas, both scaled (Unity-style): `delta` (gameplay, raw × scale)
 *  and `smoothedDelta` (presentation, smoothed × scale). The UNSCALED smoothing
 *  EMA lives in the module-level `smoothedCadence` accumulator — it can't live in
 *  `smoothedDelta` anymore because that field now holds the scaled value. */

import type { World } from 'koota';
import { Time } from '../traits';
import { rawNow } from './clock';
import { setJournalTick } from './journal';

let lastTime = rawNow();
let smoothedCadence = 0; // internal EMA of the raw (unscaled) frame cadence
const MAX_DELTA = 1 / 30; // 33ms cap — prevents teleporting on GC pauses or tab throttle
const SMOOTH_WEIGHT = 0.15; // Unity-style EMA weight for smoothDeltaTime

/** Re-baseline the internal clock + smoothing state to the current clock. Used by
 *  `stepSimulation()` so a deterministic stepped run's first tick yields exactly
 *  the requested dt and a clean EMA seed. */
export function resetTimeBaseline(): void {
  lastTime = rawNow();
  smoothedCadence = 0;
}

export function timeSystem(world: World) {
  const now = rawNow();
  const rawDelta = (now - lastTime) / 1000;
  lastTime = now; // always track real time, only clamp what systems see

  const delta = Math.min(rawDelta, MAX_DELTA);

  world.query(Time).updateEach(([time]) => {
    // Pausing is NOT done here: the editor Pause button calls setPlayState('paused'),
    // and the pipeline skips the TIME tier entirely when the sim isn't running
    // (pipeline.ts) — so this system simply doesn't run while paused, and `lastTime`
    // (advanced above every frame) keeps unpausing from emitting a catch-up delta.
    // The in-pipeline time-stop knob is `timeScale` (0 = freeze, applied AFTER
    // smoothing below so both deltas hit 0 the same frame with no EMA coast).
    // (There is no per-entity `Paused`-tag branch: it had zero producers and was
    // unreachable here once the pipeline gates the whole tier — see ecs-core F1.)

    // 1+2. Smoothed cadence — EMA of the (CLAMPED) frame time, independent of
    // timeScale. smoothed = delta * w + prev * (1 - w). Seed on the first frame.
    // F6: feed `delta` (already capped at MAX_DELTA), not `rawDelta` — both inputs
    // are then ≤ MAX_DELTA so the EMA can't exceed it and the old post-hoc
    // `Math.min` clamp is redundant. After a >33ms stall the smoothed series now
    // EASES from the capped value instead of spiking on the raw delta then pinning
    // to MAX_DELTA — self-consistent with `time.delta`, which also uses `delta`.
    if (smoothedCadence === 0 && time.frame === 0) {
      smoothedCadence = delta;
    } else {
      smoothedCadence = delta * SMOOTH_WEIGHT + smoothedCadence * (1 - SMOOTH_WEIGHT);
    }

    // 3. Apply time control AFTER smoothing. Pause/time-stop = scale 0 → both
    // deltas hit 0 this frame (no EMA coast). Slow-mo/fast-fwd scale linearly.
    const scale = time.timeScale ?? 1;
    time.delta = delta * scale;                   // gameplay (Unity deltaTime)
    time.smoothedDelta = smoothedCadence * scale; // presentation (Unity smoothDeltaTime)

    time.elapsed += time.delta;
    time.smoothedElapsed += time.smoothedDelta;
    time.frame++;
    // Stamp the event journal with this frame so emit() calls downstream this
    // tick are ordered/attributed correctly (Phase 3). Stamp THIS world explicitly
    // (journal is world-scoped, F1) so the tick lands on the world being stepped.
    setJournalTick(time.frame, world);
  });
}
