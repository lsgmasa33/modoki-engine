/** Returns the singleton Time resource, or null if not spawned.
 *
 *  Per-frame consumers should prefer the `getSimDelta` / `getVisualDelta`
 *  accessors below over reading raw fields — they apply `timeScale` and freeze
 *  to 0 when the sim isn't running, so pause / slow-mo / time-stop "just work"
 *  for render-phase consumers (particles, skeletal) the same way pipeline
 *  systems already get it from the play-state gate. (Phase 1.) */

import type { World } from 'koota';
import { Time } from '../traits';
import { isSimRunning } from './playState';

type TimeData = {
  delta: number; elapsed: number; frame: number; smoothedDelta: number; smoothedElapsed: number;
  timeScale: number;
};

export function getTime(world: World): TimeData | null {
  // Time is a singleton — fetch the one entity directly instead of building a full
  // QueryResult + iterating every match (last-wins) just to grab it. This runs
  // multiple times per frame (animation + rotate3D + each getSimDelta/getVisualDelta
  // accessor), so the closure-free path matters on the hot loop. (ecs-core F2)
  const e = world.queryFirst(Time);
  return e ? (e.get(Time) as unknown as TimeData) : null;
}

/** Gameplay delta for this frame: rawClampedDelta × timeScale (the `Time.delta`
 *  field). 0 when the sim isn't running (editor Stopped/Paused) so render-phase
 *  callers freeze. Use for movement, timers, physics — anything that must be
 *  deterministic/reproducible. */
export function getSimDelta(world: World): number {
  if (!isSimRunning()) return 0;
  return getTime(world)?.delta ?? 0;
}

/** Presentation delta for this frame: smoothedCadence × timeScale (jitter-free) —
 *  i.e. the `Time.smoothedDelta` field. 0 when the sim isn't running. Use for
 *  visual motion — animation, skeletal, particles, procedural wobble, shader time. */
export function getVisualDelta(world: World): number {
  if (!isSimRunning()) return 0;
  return getTime(world)?.smoothedDelta ?? 0;
}

/** Current global time scale (1 = normal, 0 = pause/time-stop, 0.3 = slow-mo). */
export function getTimeScale(world: World): number {
  return getTime(world)?.timeScale ?? 1;
}

/** Set the global time scale on the Time singleton. Pause = 0, slow-mo = 0.3,
 *  bullet-time/fast-forward = 2, etc. Applied next frame by `timeSystem`. */
export function setTimeScale(world: World, scale: number): void {
  world.query(Time).updateEach(([time]: any) => { time.timeScale = scale; });
}
