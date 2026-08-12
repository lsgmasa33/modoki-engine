/** How a frame's simulation delta is split into solver steps — the rule that keeps a RENDER
 *  decision from changing how the game BEHAVES.
 *
 *  ⚠️ **WHY THIS EXISTS.** `frameDriver`'s cap skips the entire callback pass, `PRIORITY_ECS`
 *  included, so a frame cap is not a rendering setting — it changes the rate the whole simulation
 *  ticks at. Both physics systems stepped Rapier once per tick at `timestep = getSimDelta(world)`,
 *  with no accumulator and no substepping, so #202's seeded `low.targetFps: 30` silently doubled
 *  the solver timestep to 1/30 on exactly the devices nobody can inspect: stacks settle
 *  differently, joints soften, and a fast body travels twice as far per step, halving the
 *  effective CCD margin. A live tier DEMOTION changed it mid-play, so a physics puzzle could
 *  behave one way before the demote and another after (review 2026-08-12, R2).
 *
 *  Owner's decision: **physics simulates at 1/60 regardless of the render rate.**
 *
 *  ── WHAT THIS IS, PRECISELY: a CEILING on the step, not a fixed timestep ──────────────────────
 *  The frame's delta is divided into `count` equal steps, each no coarser than
 *  {@link MAX_PHYSICS_STEP_S}. At 60 fps that is one 16.7 ms step — **byte-for-byte today's
 *  behaviour**; at a 30 fps cap it is two 16.7 ms steps, which is the whole point.
 *
 *  A strict fixed-dt accumulator (step exactly 1/60, carry the residue) is the more textbook
 *  answer and was deliberately NOT taken. Without a render-interpolation layer — which this engine
 *  does not have — an accumulator makes a 60 Hz display do 0 steps on one frame and 2 on the next
 *  whenever rAF jitters either side of the boundary, which is visible judder. That would trade a
 *  bug nobody can see on a phone for one every player can see on every device. Dividing the delta
 *  keeps the render and simulation clocks exactly in phase (no residue, no drift, nothing to
 *  interpolate) while still bounding the step. If interpolation is ever built, revisit this.
 *
 *  Since `getSimDelta` is already clamped to `MAX_DELTA = 1/30` (`core/timeSystem.ts`), `count` is
 *  1 or 2 in practice; the loop is written generally so a change to that clamp cannot silently
 *  reintroduce a coarse step.
 *
 *  ⚠️ **CHARACTER CONTROLLERS ARE NOT SUBSTEPPED, and that is deliberate.** `stepCharacters`
 *  compares the body's pose against a per-body teleport baseline (`rec.last*`) that is only
 *  rewritten in the post-step pull-back, so calling it twice inside one frame would make the
 *  second call read the first substep's own motion as an external teleport and hard-set the
 *  character back. It stays at one call per frame with the full delta; only the solver substeps.
 *  Fixing that properly means moving the baseline update, which is a separate change. */

/** The coarsest solver step allowed, seconds. 1/60 — the owner's answer to "what should physics
 *  simulate at when the renderer is capped to 30". */
export const MAX_PHYSICS_STEP_S = 1 / 60;

/** Slack before a delta is split in two, as a multiple of {@link MAX_PHYSICS_STEP_S}.
 *
 *  Without it, a real 60 Hz frame splits into two steps and doubles solver cost across the whole
 *  fleet to buy nothing. A MEASURED delta is never exactly `1/60`: rAF on a 60 Hz panel delivers
 *  16.68 ms, which is `dt / MAX === 1.0008`, and `Math.ceil` takes that to 2. (An exact `1/60`
 *  would be fine — `x / x` is exactly 1 in IEEE 754 — so this is about measurement, not about
 *  float error; an earlier version of this comment claimed the latter and was wrong.) 5% covers
 *  the jitter a display actually produces while still splitting a 30 fps frame in two. The cost of
 *  the slack is that a genuine 57 fps frame takes one 17.5 ms step instead of two 8.75 ms ones,
 *  which is inside the noise of what a 60 fps frame already does. */
const SPLIT_TOLERANCE = 1.05;

/** Split a frame's simulation delta into equal solver steps, none coarser than
 *  {@link MAX_PHYSICS_STEP_S}. Pure.
 *
 *  Returns `count: 0` for a non-positive or non-finite delta — a paused sim (`timeScale: 0`) or a
 *  world with no time yet must not step at all, which is the `dt > 0` guard both physics systems
 *  already apply. `count * h === dt` exactly enough that no simulation time is created or lost. */
export function physicsSubsteps(dt: number): { count: number; h: number } {
  if (!Number.isFinite(dt) || dt <= 0) return { count: 0, h: 0 };
  const count = Math.max(1, Math.ceil(dt / (MAX_PHYSICS_STEP_S * SPLIT_TOLERANCE)));
  return { count, h: dt / count };
}

/** How far through the frame substep `i` (0-based) of `count` ENDS — the fraction a kinematic
 *  body's target must be interpolated to before that step runs.
 *
 *  ⚠️ **A KINEMATIC TARGET SET ONCE PER FRAME IS WRONG THE MOMENT THE FRAME IS SPLIT, and it made
 *  this file's own fix worse than the bug it fixed** (close-out 2026-08-12). Rapier derives a
 *  position-based kinematic body's implicit velocity — the one that resolves contacts against
 *  dynamic bodies — as `(nextTranslation - translation) / world.timestep`, INSIDE the step that
 *  consumes it. Issue the whole frame's target once and then step twice at `h = dt/2` and the body
 *  covers the entire distance in substep 1 at **2x** the real speed, then sits still through
 *  substep 2 at zero. Net position is right; the momentum handed to anything it touches is not.
 *
 *  MEASURED, against raw Rapier, 1 s of simulation, platform travelling exactly 2.000000 m in
 *  every case (the control — an uncontrolled version of this comparison would mean nothing):
 *
 *  | case                                   | box on top: vel | box in the path: vel |
 *  |----------------------------------------|-----------------|----------------------|
 *  | 60 fps, one step                       | 2.0000          | 2.111                |
 *  | 30 fps, one step (pre-substep)         | 2.0000          | 2.135                |
 *  | 30 fps, two substeps, target per FRAME  | **0.0740**     | **4.077**            |
 *  | 30 fps, two substeps, target per SUBSTEP| 2.0000          | 2.111                |
 *
 *  The surge/stall pattern breaks friction grip outright (a carried box keeps 4% of its speed and
 *  slides 1.5 m off the back of the platform) and roughly doubles a push impulse. Interpolating
 *  the target per substep reproduces the 60 fps sequence exactly — identical to the decimal.
 *
 *  So every `setNextKinematic*` issued during a tick is recorded with the pose it started from,
 *  and re-issued at `substepFraction(i, count)` before each step. At `count === 1` the fraction is
 *  1 and the call is byte-for-byte what it was — which is why an uncapped 60 fps frame is
 *  untouched by any of this. */
export function substepFraction(i: number, count: number): number {
  return count > 1 ? (i + 1) / count : 1;
}

/** Linear interpolation, exact at both ends (`f === 1` returns `b` bit-for-bit, which the
 *  `count === 1` path depends on). */
export function substepLerp(a: number, b: number, f: number): number {
  return f >= 1 ? b : a + (b - a) * f;
}
