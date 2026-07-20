import { trait } from 'koota';

/** Time resource — singleton entity updated each frame before pipeline runs.
 *
 *  Two concerns are deliberately separated (see docs/verification-harness.md
 *  "Phase 1 — Time-system redesign"):
 *   - **Smoothing** (jitter absorption) lives in `smoothedDelta` — an EMA of the
 *     real frame cadence, independent of game-time control.
 *   - **Time control** lives in `timeScale` — pause/slow-mo/bullet-time/time-stop
 *     are all this one knob (pause = 0). It is applied AFTER smoothing, so a
 *     time-stop is instant (smooth × 0 = 0) instead of coasting to a halt.
 *
 *  Consumers should read via the accessors `getSimDelta` (gameplay: raw × scale)
 *  and `getVisualDelta` (presentation: smoothed × scale), NOT the raw fields. */
export const Time = trait({
  delta: 0,           // gameplay delta this frame: rawClampedDelta × timeScale (Unity deltaTime)
  elapsed: 0,         // total seconds since start (scaled accumulation)
  frame: 0,           // frame counter
  smoothedDelta: 0,   // presentation delta this frame: smoothedCadence × timeScale (Unity smoothDeltaTime)
  smoothedElapsed: 0, // accumulated smoothed (scaled) deltas
  // ── time control (Phase 1) ──
  timeScale: 1,       // 0 = pause/time-stop, 0.3 = slow-mo, 2 = fast-forward
});
