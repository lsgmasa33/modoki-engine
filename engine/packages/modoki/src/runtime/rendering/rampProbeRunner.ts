/** Boot ramp probe (#188) — the IMPURE half: the renderer, the geometry, and the clock.
 *
 *  The policy and the maths live in `rampProbe.ts` and are pure. This module owns only the three
 *  things that policy refuses to own: something to draw, somewhere to draw it, and a timestamp.
 *  Same split as `tierCalibration` over `qualityTier`, for the same reason — it keeps every
 *  branch of the decision testable without a GPU.
 *
 *  ── IT BLOCKS THE LAUNCH, AND THAT IS THE POINT (owner, 2026-08-09) ───────────────────────
 *  The plan originally forbade the probe from introducing ANY new shader program, because one
 *  program cost ~1.2 s to compile on a Huawei Y6. That constraint made the probe unable to
 *  inform the launch it runs on: with no material of its own it can only draw once the scene
 *  has compiled one, and by then the real renderer exists — and `antialias` is a CONSTRUCTOR
 *  option baked into the swapchain, so a tier decided after renderer creation can never apply
 *  it (`tierCalibration` documents exactly this limitation for live tier changes).
 *
 *  So the constraint was overridden deliberately: the probe compiles its own material FIRST,
 *  awaits that compile, measures, and only then does the real renderer get created with a tier
 *  that is complete. Note what makes this affordable — the ~1.2 s figure is an average over
 *  postfx-demo's 14 programs, which are heavy PBR + NPR graphs. This material is an unlit quad
 *  with no lights, no shadows, no environment and no post-FX, i.e. the cheapest program the
 *  engine can express, and BOTH ramps share it (one geometry, one material, two groups of
 *  objects) so the whole probe costs exactly one compile.
 *
 *  ── WHY THE PROBE GETS ITS OWN RENDERER ───────────────────────────────────────────────────
 *  Because the answer has to exist before the real renderer is constructed. This one is
 *  throwaway and its own `antialias` is irrelevant, so it can be created immediately. Same
 *  pattern, and the same off-screen container trick, as `capsProbeRenderer`.
 *
 *  ── WHAT IT MEASURES AT — CLAMPED, AND WHY THAT IS NOW SAFE ───────────────────────────────
 *  At device pixel ratio 1, capped further by {@link MAX_PROBE_PIXELS}.
 *
 *  It used to run at the full native buffer, on the reasoning that fill cost is per pixel so the
 *  probe should measure the load it intends to impose. That reasoning KILLED A TAB on an iPhone
 *  13 mini: at DPR 3 the last fill step asked for ~190 megapixels in one submit and WebKit
 *  terminated the process — the #156 failure, reproduced by the instrument built to prevent it.
 *
 *  The clamp costs nothing, because `fillMegapixelsPerMs` normalises the result by the buffer
 *  size: throughput in pixels/ms is a property of the GPU, not of the panel, so a device measured
 *  at a small buffer can still be asked whether it affords a large one. Measuring big was never
 *  necessary — only measuring in KNOWN units was. */

// ⚠️ PLAIN `three`, NOT `three/webgpu` — and the distinction is the whole of #203.
//
// `three/webgpu` is dead-code-eliminated by `build.modules.render3d: false`, so importing it here
// made the probe unrunnable on precisely the projects that had no other classifier. `three`'s core
// MATH is a different matter: `runtime/core/ecs/transformPropagationSystem.ts` imports it in every
// project, 2D ones included, so the CPU ramp below costs a 2D bundle nothing AND stays faithful to
// the code it models. The rendering half now goes through `rampWorkloadGL`, which needs no Three
// at all.
import * as THREE from 'three';
import { rawNow } from '../core/clock';
import { targetFPS } from './frameDriver';
import { type GpuClock } from './gpuClock';
import { createGlProbeSurface, type RampWorkload } from './rampWorkloadGL';
import {
  startRamp, rampNextLoad, recordRampFrame, readRamp, estimateIntervalMs,
  RAMP_BOUNDS, PROBE_BUDGET_MS, ESCAPE_MULTIPLE, ABORT_FRAME_MS,
  type ProbeAxes, type ProbeClockKind, type ProbeMeasurement, type RampKind, type RampReading,
} from './rampProbe';

/** Frames rendered at a trivial load before any ramp, to (a) settle the pipeline and (b) measure
 *  the display interval every ramp threshold is expressed against.
 *
 *  ⚠️ EIGHT, not three. Three was measurably not enough: across three iOS devices — all 60 Hz, so
 *  all expecting ~16.7 ms — the estimate came back anywhere from 6.0 to 18.0 ms. Since every ramp
 *  threshold is a multiple of it, a reading of 6.0 dropped the escape bar to 18 ms and the ramp
 *  escaped on noise, reporting throughput figures that were wrong by orders of magnitude.
 *
 *  `estimateIntervalMs` drops the leading `DISCARDED_WARMUP_FRAMES` and takes the median of the
 *  rest, so this must be large enough to leave a real sample behind: 8 leaves 5. The extra frames
 *  cost ~85 ms against a probe whose cold renderer creation alone measured 600-1700 ms on these
 *  phones — a trivial price for the number that every threshold depends on. */
const WARMUP_FRAMES = 8;

/** Ceiling on the RAMP phase's wall clock, measured from the moment the ramps start.
 *
 *  ⚠️ It deliberately excludes setup. It used to run from the top of the probe, and on an iPhone
 *  13 mini's first ever run the renderer took 796 ms to create (3 ms once warm) — so the whole
 *  allowance was gone before any measuring began, both ramps broke out on their first frame, and
 *  the run reported `status: 'running'` with no reading. Setup cost is real, and it IS reported
 *  (`rendererMs`, `compileMs`), but a slow cold start must not be able to starve the measurement
 *  it exists to enable.
 *
 *  The ramps budget themselves separately; this is only the outer guard that stops a pathological
 *  device turning a blocking probe into a hang. */
const HARD_DEADLINE_MS = PROBE_BUDGET_MS * 3;

/** Ceiling on the WHOLE probe — every phase, summed — measured from the moment it starts, ms.
 *
 *  ⚠️ **EVERY PIECE WAS BOUNDED AND THE SUM WAS NOT, WHICH IS NOT THE SAME THING.**
 *  {@link HARD_DEADLINE_MS} is 900 ms and reads like an outer guard, but it was recomputed
 *  FRESH at each use (`rawNow() + HARD_DEADLINE_MS`, once for the cpu ramp and once per GPU ramp),
 *  so it bounded each phase against its own start rather than the probe against its. The GPU
 *  warm-up loop had no deadline at all, and each `awaitCompletion()` is bounded only by the clock's
 *  own 2 s completion timeout. Worst case: 900 + 3 x 2000 + 900 = 7.8 s of blocked launch, with
 *  nothing capping the total.
 *
 *  ⭐ **MEASURED, on a Galaxy A23 running `games/space-invader`: a 4416 ms launch**, against
 *  277-480 ms across nine other wiped launches on the same build and device. Its ramp steps summed
 *  to ~250 ms, so the time was NOT in the measurement — it was in the waits around it, which is
 *  exactly the shape this constant now bounds. Rare (roughly 1 in 10) and therefore the kind of
 *  thing that ships: a 4.4 s hang on a launch is worse for a player than any tier being one band
 *  wrong, and it would never show up in a five-launch test.
 *
 *  The value is a compromise stated rather than assumed. It has to be generous enough
 *  that the SLOWEST device still completes a legitimate measurement — the Huawei Y6 is the device
 *  this whole workstream exists for and it must not be truncated into a worse verdict — while being
 *  far below the ~6 s the owner set as the outside limit for the probe as a whole. Typical runs
 *  measure 232-480 ms, so this is ~5x headroom over the normal case and still cuts the pathological
 *  one by more than half. */
// ⚠️ RAISED 2500 -> 3200 for the discarded warm-up pass below. A Huawei Y6 measured ~2.1 s with a
// single pass, so the old ceiling would have truncated the measured pass on exactly the device
// that must not be truncated. The warm-up carries the smaller `GPU_RAMP_BUDGET_MS` rather than the
// full phase budget, so a slow device spends most of the extra on the pass that counts.
const PROBE_TOTAL_BUDGET_MS = 3_200;

/** Await the GPU clock, but never past `deadline`.
 *
 *  ⚠️ **THE BOUND HAS TO LIVE AT THE WAIT, and this module has learned that once already** — see
 *  `nextFrame`, where a 5 s timeout was added because "`HARD_DEADLINE_MS` is checked AFTER a frame
 *  arrives, so a ramp waiting on a frame that never comes cannot consult it". The identical hole
 *  existed on the clock path: a deadline check between iterations cannot shorten a single
 *  2 s fence wait, and three of those in the warm-up loop is most of a pathological launch.
 *
 *  ⚠️ Racing does not CANCEL the underlying poll — `gpuClock`'s fence loop keeps running until its
 *  own timeout. That is acceptable and bounded (it self-terminates within 2 s, and the probe's GL
 *  surface is disposed in a `finally` regardless), but it is a leak of work rather than of memory
 *  and is worth knowing when reading a log where a late fence result appears after the verdict.
 *
 *  Resolving `null` on expiry deliberately reuses the "clock failed" path the callers already
 *  handle, rather than introducing a third outcome they would each have to learn about. */
async function awaitClockWithin(clock: GpuClock, deadline: number): Promise<number | null> {
  const remaining = deadline - rawNow();
  if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); });
  try {
    return await Promise.race([clock.awaitCompletion(), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hard cap on the probe's drawing buffer, in pixels (~1.05 MP — roughly 1080x970).
 *
 *  Paired with the lowered `RAMP_BOUNDS.fill`, this bounds the worst single submit at
 *  32 x 1.05 MP ≈ 34 megapixels, against the ~190 MP that killed a 13 mini's tab. A tablet at
 *  native resolution is the case this exists for: an iPad Pro's buffer is ~7x an iPhone 8's, so
 *  an uncapped probe is dramatically more dangerous on exactly the hardware most able to survive
 *  it — right up until it isn't. Comparability is preserved by normalising to pixels/ms. */
const MAX_PROBE_PIXELS = 1_050_000;

/** Longest frame interval that can plausibly be a DISPLAY, ms.
 *
 *  ⚠️ **THE INTERVAL IS THE YARDSTICK FOR EVERYTHING, AND IT IS MEASURED AT THE BUSIEST MOMENT OF
 *  THE BOOT.** Escape is `3 x interval`, the ramp budget is `9 x interval` — so if the warm-up
 *  frames were stretched by the game's own asset loading rather than by the display, every
 *  threshold is stretched with them and the ramp is no longer measuring the GPU at all.
 *
 *  MEASURED on a Galaxy S22, native, three launches (2026-08-11): the warm-up estimated **125.6,
 *  167.4 and 167.4 ms** against a true 16.8 ms — 7-10x out. Both consequences are fatal and neither
 *  announces itself:
 *    - escape needs `3 x 167.4` = 502 ms, which is past {@link ABORT_FRAME_MS} (250), so escape is
 *      **unreachable by construction** and every reading degrades to a floor;
 *    - the ramp budget becomes `9 x 167.4` = 1507 ms, past the whole {@link HARD_DEADLINE_MS}, so
 *      the ramp is cut off mid-flight with `status: 'running'` and yields nothing.
 *  The phone paid ~2.5 s of blocked launch on each of three launches and never classified.
 *
 *  40 ms, which is 30 Hz (33.3) plus jitter: a thermally throttled iPhone 8 really does drop to
 *  30 Hz and that case MUST still measure — it is why the interval is measured rather than assumed.
 *  Nothing above this is a panel; it is contention, and the honest response is to decline the pass.
 *
 *  ⚠️ **DECLINE, DO NOT CLAMP.** Clamping to a plausible value looks like the tidier fix and is
 *  actively dangerous: replaying the S22's real steps against a clamped 35 ms interval, the ramp
 *  "escapes" at load 32 on two boot stalls (167 -> 209 ms) and reports 0.14 Mpx/ms — which is
 *  1.5x clear BELOW every boundary, i.e. it would settle a flagship at `weak` on one pass and
 *  cache it. A refused measurement costs a launch; a confident wrong one costs the device. */
const MAX_PLAUSIBLE_INTERVAL_MS = 40;

/** The yardstick a GPU-CLOCK-paced ramp is measured against, ms.
 *
 *  Not a display interval — nothing waits for the display on that path. It exists only so the escape
 *  rules keep their meaning in absolute terms: escape at `3x` = 50 ms of GPU work, the preceding step
 *  at `1.5x` = 25 ms, growth of `0.5x` = 8.4 ms. Those sit comfortably above the ~9-14 ms floor the
 *  clock itself costs (promise delivery on WebGPU, poll granularity on WebGL2), measured on all three
 *  phones — so a reading that clears them is real work rather than delivery latency. */
const GPU_NOMINAL_INTERVAL_MS = 16.7;

/** Wall clock one GPU-paced ramp may spend, ms. Two ramps fit inside {@link HARD_DEADLINE_MS}.
 *
 *  ⚠️ Generous compared with the presentation path's 150 ms, because a slow device spends it in far
 *  fewer steps: a Huawei Y6's very first fill step measured 114-246 ms. The trade is deliberate — on
 *  that hardware the ramp will exhaust this and report a LOWER bound, which is a true and useful
 *  statement about a device whose first step already costs more than a whole frame. */
const GPU_RAMP_BUDGET_MS = 400;

/** Reject if `p` has not settled in `ms`. The timer is CLEARED on the happy path — an uncancelled
 *  one is the bug that made this workstream believe in a phantom 8-second WebGPU timeout for a
 *  whole session (see `gpuDetect.ts`). Same shape as `gpuClock.ts`'s, which is module-private
 *  there.
 *
 *  Exported so a test can assert the timeout MECHANISM rejects a promise that never settles,
 *  rather than only exercising the call sites through a fast mock that proves nothing about a
 *  hang. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Clamp the interval fed to a presentation-paced ramp's escape threshold so it stays in the
 *  relation every ramp assumes: `ESCAPE_MULTIPLE x interval < ABORT_FRAME_MS` (#205 R5.4).
 *  Nothing enforced this before.
 *
 *  `intervalMs` at the raf-path call site is `Math.max(measuredIntervalMs, cappedIntervalMs)` —
 *  the measured half is already bounded by {@link MAX_PLAUSIBLE_INTERVAL_MS}, but the CAPPED half
 *  is a legitimate, authored project setting (a game that targets 20 fps has a real 50 ms
 *  interval), and the plausibility guard deliberately never inspects it — see its call site's
 *  comment. Push that capped interval low enough (roughly 8 fps or slower, a real setting nothing
 *  stops a project authoring) and `ESCAPE_MULTIPLE x interval` clears `ABORT_FRAME_MS` on its
 *  own: the escape bar sits ABOVE the abort bar, so every ramp on that project aborts on its very
 *  first over-budget step and can never escape — the exact inversion this closes.
 *
 *  This clamps only the ESCAPE YARDSTICK a ramp is measured against, not the reported
 *  `intervalMs` field on `ProbeMeasurement` — the project's real target interval is still
 *  honestly reported; only the internal threshold that decides "has this ramp escaped" is
 *  bounded, the same way {@link RAMP_BOUNDS} already bounds load rather than lying about it. */
export function escapableIntervalMs(intervalMs: number): number {
  // Strictly less than: escape firing in the SAME frame that trips ABORT_FRAME_MS is still the
  // inversion, not a guaranteed escape, hence the small margin off the exact ceiling.
  const ceilingMs = ABORT_FRAME_MS / ESCAPE_MULTIPLE;
  return Math.min(intervalMs, ceilingMs - 0.001);
}

/** Renders used to settle the pipeline on the GPU-clock path. No interval is estimated here — that
 *  is the whole point — so this only has to be enough that the first measured step is not also the
 *  first draw the driver has ever seen. */
const GPU_WARMUP_RENDERS = 3;

/** The yardstick the CPU ramp's escape rules are expressed against, ms.
 *
 *  Not a display interval and not the GPU clock's either — `rawNow()` has no quantization, no
 *  presentation and no delivery latency, so its noise floor is ~100 us (the `performance.now`
 *  clamp) rather than the ~10 ms the GPU clock costs. 4 ms puts escape at 12 ms, the preceding step
 *  at 6 ms and the required growth at 2 ms: two orders of magnitude above the clock's resolution,
 *  and comfortably above a young-generation GC pause, while still blocking the main thread for only
 *  ~25 ms across the whole ramp. */
const CPU_NOMINAL_INTERVAL_MS = 4;

/** Wall clock the CPU ramp may spend, ms. Small because it is: the steps double, so a ramp that
 *  escapes at 12 ms has spent ~25 ms in total, and this only has to cover a device slow enough to
 *  need every doubling. */
const CPU_RAMP_BUDGET_MS = 200;

/** How many node transforms the CPU ramp cycles through, and how deep its propagation chain runs
 *  before it restarts from identity.
 *
 *  A power of two, so the index wrap is a mask rather than a modulo — the loop body is the thing
 *  being timed and a division in it would be part of the measurement.
 *
 *  ⚠️ **THE RESTART IS NOT COSMETIC.** Composing world = parent x local without one accumulates
 *  through every iteration, and at half a million of them the translation grows without bound while
 *  the rotation drifts off orthonormal. Denormals and non-finite floats have their own hardware
 *  costs, so a ramp that runs long enough to produce them stops measuring transform propagation and
 *  starts measuring the FPU's slow path. Restarting every 256 levels also happens to be honest about
 *  the thing being modelled: real hierarchies are shallow. */
const CPU_WORKING_SET = 256;

/** Propagations run before the CPU ramp's first timed step.
 *
 *  ⚠️ Not pipeline warm-up — JIT warm-up, and it matters more here than anywhere else in the probe.
 *  A JS loop runs interpreted until the tiering-up threshold, and an un-warmed first step would
 *  measure the interpreter on every device while later steps measured optimised code — i.e. a slope
 *  drawn between two different execution engines. Three passes of 8192 is well past V8's
 *  optimisation threshold and costs a millisecond or two. */
const CPU_WARMUP_ITERATIONS = 8_192;
const CPU_WARMUP_PASSES = 3;

/** Whole cpu ramps run and DISCARDED before the one that classifies.
 *
 *  ⚠️ **NOT the same thing as {@link CPU_WARMUP_PASSES} one line above, and conflating them is the
 *  mistake this constant exists to prevent.** Those three passes of 8192 iterations warm the JIT —
 *  they take a millisecond or two, which is orders of magnitude too little work to move a CPU
 *  governor. A governor needs *sustained* load, and only a full ramp supplies it.
 *
 *  **1 — and ⛔ 2 WAS TRIED ON HARDWARE AND MADE IT WORSE. Do not retry it.** The theory was
 *  reasonable: with one discard the in-game reading was excellent (spreads 1.05-1.17x on three
 *  phones) while the BOOT reading — the one that actually decides a tier — sat 20-30% below it and
 *  still spread 1.38-1.98x, and at boot the process launch has already boosted the CPU, so pass 1
 *  is not cold and one discard has nothing left to warm. A second discard should have bought the
 *  ramp more sustained work. Measured, same 5-boot / 5-in-game protocol, three phones:
 *
 *    | device     | boot 1 discard | boot 2 discards | in-game 1 discard | in-game 2 discards |
 *    |------------|----------------|-----------------|-------------------|--------------------|
 *    | Huawei Y6  | 1.7 (1.83x)    | 2.0 (1.69x)     | 2.1 (1.10x)       | 2.2 (1.15x)        |
 *    | Galaxy A23 | 8.7 (1.38x)    | 9.2 (1.25x)     | 12.1 (1.17x)      | 9.5 (1.09x)        |
 *    | Galaxy S22 | 20.2 (1.98x)   | **19.3 (2.82x)**| 23.8 (1.05x)      | 23.2 (1.19x)       |
 *
 *  The S22's boot spread nearly DOUBLED — worse than the single-pass instrument it replaced — and
 *  its band flipped `middle`/`capable` across the five launches. Everything else moved within
 *  noise. The mechanism is visible in the warm-up sequences the log now prints: an A23 in-game run
 *  read `warm-up 3.6k->13.4k` and then measured **9.8k**. Pass 2 peaks and pass 3 falls back, so
 *  the boost is transient and decays even under continuous load.
 *
 *  ⚠️ **THE S22 BOOT ×2 CELL IS A RE-MEASUREMENT, and the first attempt at it was contaminated.**
 *  The original run (18:17-18:20) overlapped a device lease another clone held on that phone
 *  (`~/.modoki/device-claims.json`, `work-ai`, claimed 18:15:49) and read 16.8 (3.56x). Re-run at
 *  18:58-19:01 with the phone free: **19.3 (2.82x)** — the number in the table. So the confound
 *  was real and it inflated the harm; the DIRECTION is unchanged and now measured cleanly, since
 *  2.82x is still materially worse than the 1.98x the single discard gives, and the band still
 *  flips (`middle` on launch 1, `capable` on 2-5). Two lessons, both cheap: check the claims file
 *  BEFORE a measurement run, and re-measure rather than argue from a claim record.
 *
 *  ⚠️ **So more sustained work is NOT monotonically a warmer reading**, which is the assumption
 *  any "just add another pass" fix rests on. The remaining boot gap needs a different mechanism,
 *  not a bigger count of this one. */
const CPU_WARMUP_RAMPS = 1;

// ── THE CPU RAMP ───────────────────────────────────────────────────────────────────────────

/** Where the CPU ramp's result goes, so that nothing it computes is dead.
 *
 *  ⚠️ A benchmark whose output is unobservable is a benchmark an optimiser may delete. The
 *  propagation below writes into long-lived `Matrix4` objects, which is already heap-observable and
 *  probably enough on its own — but "probably enough" is how a probe ends up measuring an empty
 *  loop, and this workstream has spent three sessions on instruments that lied. One module-level
 *  store removes the question. */
let cpuRampSink = 0;

/** A shallow chain of node transforms for the CPU ramp to propagate through. */
interface CpuNodes {
  pos: THREE.Vector3[];
  quat: THREE.Quaternion[];
  scale: THREE.Vector3[];
  local: THREE.Matrix4[];
  world: THREE.Matrix4[];
  identity: THREE.Matrix4;
}

function makeCpuNodes(): CpuNodes {
  const pos: THREE.Vector3[] = [];
  const quat: THREE.Quaternion[] = [];
  const scale: THREE.Vector3[] = [];
  const local: THREE.Matrix4[] = [];
  const world: THREE.Matrix4[] = [];
  const axis = new THREE.Vector3();
  for (let i = 0; i < CPU_WORKING_SET; i++) {
    const t = i / CPU_WORKING_SET;
    pos.push(new THREE.Vector3(t, 1 - t, t * 2 - 1));
    axis.set(Math.sin(t * 7), Math.cos(t * 5), Math.sin(t * 3) + 2).normalize();
    quat.push(new THREE.Quaternion().setFromAxisAngle(axis, t * Math.PI));
    // ⚠️ EXACTLY 1, on every axis. `Matrix4.compose` multiplies by the scale unconditionally, so a
    // unit scale costs precisely what a varied one costs — while a scale of, say, 1.1 compounds
    // through 256 levels of propagation to 1.1^256 and overflows to Infinity, at which point the
    // ramp is timing the FPU's non-finite path instead of transform propagation.
    scale.push(new THREE.Vector3(1, 1, 1));
    local.push(new THREE.Matrix4());
    world.push(new THREE.Matrix4());
  }
  return { pos, quat, scale, local, world, identity: new THREE.Matrix4() };
}

/** Propagate `iterations` node transforms and return elapsed ms.
 *
 *  ── WHY THIS ARITHMETIC AND NOT A SYNTHETIC BUSY-LOOP ─────────────────────────────────────
 *  `Matrix4.compose` followed by `multiplyMatrices` is LITERALLY what the engine's transform
 *  propagation runs (`core/ecs/transformPropagationSystem.ts` lines 57 and 284) — same three
 *  called methods, same shapes, same allocation-free reuse of preallocated matrices. So the JIT
 *  sees code it has an equivalent of in the real frame, and the number means something about that
 *  frame rather than about a loop nobody runs.
 *
 *  The chain is SERIAL: each world matrix is built from the previous one, so the loop carries a
 *  real data dependency and cannot be reordered, vectorised or hoisted out. That is also what a
 *  hierarchy does. */
function propagate(n: CpuNodes, iterations: number): number {
  const { pos, quat, scale, local, world, identity } = n;
  const mask = CPU_WORKING_SET - 1;
  let prev = identity;
  const started = rawNow();
  for (let k = 0; k < iterations; k++) {
    const i = k & mask;
    // Restart the chain at the top of each pass — see CPU_WORKING_SET for why unbounded
    // accumulation would turn this into an FPU-slow-path benchmark.
    if (i === 0) prev = identity;
    const m = local[i].compose(pos[i], quat[i], scale[i]);
    prev = world[i].multiplyMatrices(prev, m);
  }
  const elapsed = rawNow() - started;
  cpuRampSink += prev.elements[12];
  return elapsed;
}

/** Run the CPU ramp to completion. No renderer, no clock, no frames — just JS and `rawNow()`.
 *
 *  ⚠️ **THIS MEASURES AVAILABLE CPU, NOT PEAK CPU, AND WHICH CLOCK IT CATCHES THE DEVICE AT IS THE
 *  WHOLE STORY.** Two rounds of the boot-vs-in-game A/B were run on 2026-08-13 (#205) — three
 *  Androids, `games/sling`, five boot launches (`pm clear` before each) against five in-game runs
 *  from the debug menu's `Re-run probe (idle)` button. cpu, k xform/ms, median (spread):
 *
 *    | device     | v6 boot     | v6 in-game  | v7 boot     | v7 in-game        |
 *    |------------|-------------|-------------|-------------|-------------------|
 *    | Huawei Y6  | 1.9 (1.18x) | 2.0 (1.44x) | 1.7 (1.83x) | **2.1 (1.10x)**   |
 *    | Galaxy A23 | 7.7 (2.1x)  | 3.8 (1.4x)  | 8.7 (1.38x) | **12.1 (1.17x)**  |
 *    | Galaxy S22 | 18.2 (3.5x) | 19.3 (2.4x) | 20.2 (1.98x)| **23.8 (1.05x)**  |
 *
 *  ⛔ **THE v6 COLUMNS ARE SUPERSEDED — do not quote them, and do not re-derive the conclusion
 *  they supported.** They read "the A23 is 2x higher at boot than in game", which looked like a
 *  device-dependent bias in the unsafe direction. It was an artifact of the INSTRUMENT: v6 ran one
 *  cpu pass, so the in-game reading was taken on a CPU that had settled to a low clock and never
 *  climbed. v7's discarded pass warms it, and the same A23 reads 12.1 in game rather than 3.8 —
 *  the v6 "in-game" number reappears exactly as v7's warm-up pass (3.5-4.8k).
 *
 *  What v7 shows instead:
 *    - **In game the axis is finally an instrument.** All three spreads collapse to 1.05-1.17x,
 *      and the ordering is clean and wide: Y6 2.1 < A23 12.1 < S22 23.8.
 *    - **The warm-up gain is asymmetric, which is what identifies it as the governor** — in game
 *      the A23 gains ~3.1x over its own warm-up pass, the S22 ~1.2x, and the Y6 ~1.0x. A device
 *      already at its ceiling has nothing to gain, the same signature the GPU discard found.
 *    - **Boot is now the WORSE condition**, and it is where the shipped decision is made: spread
 *      1.38-1.98x on the Samsungs, and both read BELOW their in-game figure (A23 8.7 vs 12.1, S22
 *      20.2 vs 23.8). Boot gains scatter around 1.0 because process launch has already boosted the
 *      CPU for pass 1 — so at boot the discard has nothing left to warm and only adds a sample.
 *      The Y6's boot spread got worse, 1.18x -> 1.83x; small absolute numbers, but stated.
 *
 *  ⛔ **TWO THINGS HAVE NOW BEEN TRIED AGAINST THE REMAINING BOOT SPREAD AND BOTH FAILED. Do not
 *  retry either.**
 *    - **Defer the probe out of boot** — refuted by v6: the in-game spread was then no better than
 *      the boot spread, and on the Y6 it was wider.
 *    - **Discard a SECOND cpu pass** — built, installed, measured, reverted. It nearly doubled the
 *      S22's boot spread (1.98x -> 3.56x, worse than the single-pass instrument) and flipped its
 *      band across launches. Full table in {@link CPU_WARMUP_RAMPS}. The reason it cannot work is
 *      in the warm-up sequences the log prints: an A23 in-game run read `warm-up 3.6k->13.4k` and
 *      then measured 9.8k, so the boost is transient and decays even under continuous load. More
 *      sustained work is not monotonically a warmer reading.
 *
 *  ⚠️ And do NOT retune the cpu floors off these numbers: see
 *  docs/plans/low-end-device-support.md § 1, including the S22 band flip the discard caused. */
// Exported for the same reason `runRamp` is: a test must be able to drive it directly, without
// standing up a GL surface it does not need. Its deadline behaviour is the whole of what a test
// has to reach here.
export function runCpuRamp(mark: (stage: string) => void, deadline: number): RampReading {
  // ⚠️ CHECK THE DEADLINE BEFORE DOING ANY WORK — the GPU path added exactly this guard
  // (`${kind}:deadline-before-start`) and the cpu path was left without it. `phaseDeadline` can
  // hand back a time already past when GL setup and the two shader compiles alone exhaust
  // `PROBE_TOTAL_BUDGET_MS`, which is the pathological launch that budget exists for — and this is
  // the one consumer of it that would then run three JIT warm-up passes and a first ramp step
  // before consulting it.
  if (rawNow() > deadline) { mark('cpu:deadline-before-start'); return readRamp(startRamp('cpu', CPU_NOMINAL_INTERVAL_MS)); }
  const nodes = makeCpuNodes();
  for (let i = 0; i < CPU_WARMUP_PASSES; i++) propagate(nodes, CPU_WARMUP_ITERATIONS);
  mark('cpu:warm');

  let state = startRamp('cpu', CPU_NOMINAL_INTERVAL_MS, CPU_RAMP_BUDGET_MS);
  for (;;) {
    const load = rampNextLoad(state);
    if (load === null) break;
    // Marked BEFORE the work, so that if this load is the one that wedges the device, the last
    // stage reported IS the culprit rather than the last one survived.
    mark(`cpu:${load}`);
    state = recordRampFrame(state, propagate(nodes, load));
    if (rawNow() > deadline) break;
  }
  return readRamp(state);
}

/** How long to wait for one animation frame before giving up on the probe entirely.
 *
 *  Generous on purpose — a boot-stalled frame on a Huawei Y6 has been measured past 200 ms and a
 *  cold first frame far beyond that, so this must not fire on a device that is merely slow. It
 *  exists for the case where frames stop arriving ALTOGETHER. */
const FRAME_WAIT_TIMEOUT_MS = 5_000;

/** Resolve on the next animation frame, handing back its timestamp — or `null` if none arrives.
 *
 *  ⚠️ **rAF DOES NOT FIRE WHILE THE PAGE IS NOT VISIBLE, AND THIS PROBE BLOCKS RENDERER CREATION.**
 *  An unconditional `new Promise((resolve) => requestAnimationFrame(resolve))` therefore never
 *  settles when the screen goes off or the app is backgrounded during boot — so `resolveActiveTier`
 *  never returns, the real renderer is never created, and the game shows nothing until the user
 *  comes back. That is the same observable failure as #156 (black for the process lifetime), from
 *  the opposite cause, in the very mechanism built to prevent it.
 *
 *  ⚠️ It is NOT a hypothetical. Hit while measuring (2026-08-11): two of the three phones had their
 *  screens off, and both hung here indefinitely on every launch — the probe emitted no log, took no
 *  deadline, and simply never finished. Note what the existing guard could not do: `HARD_DEADLINE_MS`
 *  is checked AFTER a frame arrives, so a ramp waiting on a frame that never comes cannot consult
 *  it. A wall-clock bound has to live at the wait itself.
 *
 *  Resolving `null` rather than throwing keeps the failure on the ordinary "no measurement" path,
 *  which the caller already handles by falling back to today's behaviour and trying again next
 *  launch. */
function nextFrame(): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FRAME_WAIT_TIMEOUT_MS);
    requestAnimationFrame((t) => finish(t));
  });
}
/** Run one ramp to completion. Returns its reading.
 *
 *  Timing is the interval between successive rAF timestamps — the same metric `frameProfiler`
 *  uses, and the one the escape logic is written against. It is NOT the CPU time around the
 *  submit, which returns before the GPU has done the work and would report a fill-bound device as
 *  infinitely fast.
 *
 *  ⚠️ **Takes a {@link RampWorkload}, not a renderer and a scene (#203).** Everything hard-won in
 *  this function — the warm-up submit, the per-ramp deadline, the escape logic, the load cleanup on
 *  every exit — is about TIMING and is independent of how the pixels are produced. Parameterising
 *  the work is what let the Three renderer be replaced by a raw WebGL2 context without touching any
 *  of it. See `rampWorkloadGL.ts` for why that replacement had to happen.
 *
 *  Exported so a test can drive one ramp directly against fakes, without standing up the whole
 *  probe — needed to prove the warm-up-load cleanup on the `no-frames` exit (#205 R5.4). */
export async function runRamp(
  kind: RampKind,
  workload: RampWorkload,
  intervalMs: number,
  deadline: number,
  mark: (stage: string) => void,
  clock: GpuClock | null,
): Promise<RampReading> {
  // ⚠️ ONE UNRECORDED SUBMIT AT THE START LOAD, BEFORE EVERY RAMP — the fix for a defect that was
  // costing whole devices their verdict.
  //
  // MEASURED, campaign of 2026-08-11, three phones x three launches: EVERY GPU ramp's first step
  // was a 3-6x outlier over its second (Y6 draw `32:272.8` then `64:39.4`; A23 shade `4:140.2` then
  // `8:33.4`; S22 draw `32:15.8` then `64:2.6`). It is a pipeline switch, not a device: each ramp is
  // the first draw of a different program and blend state, and the driver pays for that once.
  //
  // It is not cosmetic, because `readRamp` spans from the EARLIEST supra-pin step to the last — so
  // an inflated first step makes the slope flat or NEGATIVE and the reading comes back `'none'`.
  // That is what produced 4 of the 9 unusable readings, and on the Y6 the outlier was large enough
  // (272 ms) to trip `ABORT_FRAME_MS` outright and end the ramp on step one. That phone classified
  // on ZERO of three launches while being perfectly measurable.
  //
  // The corroboration is that the CPU ramp — the ONLY ramp that already warmed up — is the only one
  // with no first-step outlier anywhere, and it read `escaped/measured` 9 times out of 9.
  //
  // A warm-up SUBMIT rather than a discarded step: a discarded step still costs its (large) time and
  // can still abort the ramp before anything is recorded.
  // ⚠️ CHECK THE DEADLINE BEFORE THE WARM-UP, not only inside the loop. The warm-up is bounded only
  // by the clock's own 2 s completion timeout (or `nextFrame`'s 5 s), neither of which
  // `HARD_DEADLINE_MS` can see — so with three GPU ramps a probe that is already out of time could
  // still spend seconds warming up ramps it will not measure. Found in close-out review.
  if (rawNow() > deadline) { mark(`${kind}:deadline-before-start`); return readRamp(startRamp(kind, intervalMs)); }
  const warmLoad = RAMP_BOUNDS[kind].startLoad;
  workload.setLoad(warmLoad);
  mark(`${kind}:warm`);
  workload.submit();
  if (clock) {
    if (await awaitClockWithin(clock, deadline) === null) mark(`${kind}:warm-clock-failed`);
  } else if (await nextFrame() === null) {
    mark(`${kind}:warm-no-frames`);
  }

  // ── GPU-PACED: no presentation in the loop at all ──────────────────────────────────────
  // Submit, wait for the GPU to finish it, submit the next load. rAF never appears, so the
  // WebView's boot-time backoff cannot reach this measurement.
  if (clock) {
    let gpuState = startRamp(kind, GPU_NOMINAL_INTERVAL_MS, GPU_RAMP_BUDGET_MS);
    for (;;) {
      const load = rampNextLoad(gpuState);
      if (load === null) break;
      workload.setLoad(load);
      mark(`${kind}:${load}`);
      workload.submit();
      const gpuMs = await awaitClockWithin(clock, deadline);
      // The clock failing mid-ramp is not a slow device — it is no measurement. Stop and report
      // whatever the earlier steps already established rather than recording a fabricated time.
      if (gpuMs === null) { mark(`${kind}:gpu-clock-failed`); break; }
      gpuState = recordRampFrame(gpuState, gpuMs, gpuMs);
      if (rawNow() > deadline) break;
    }
    workload.setLoad(0);
    return readRamp(gpuState);
  }

  let state = startRamp(kind, intervalMs);
  let last = await nextFrame();
  // ⚠️ CLEAR THE LOAD ON THIS EXIT TOO (#205 R5.4). The warm-up above already made this ramp's load
  // live, and this early return used to leave it that way — the next ramp's warm-up submit (and its
  // first timed frame) would then be contaminated by a load belonging to a ramp which never got a
  // single measured step. Every other exit from this function already zeroes the load; this was the
  // one that didn't.
  if (last === null) { mark(`${kind}:no-frames`); workload.setLoad(0); return readRamp(state); }

  for (;;) {
    const load = rampNextLoad(state);
    if (load === null) break;
    workload.setLoad(load);
    // Marked BEFORE the submit: if this load is the one that kills the process, the last stage
    // reported IS the culprit. A mark after it would name the last SURVIVED load instead.
    mark(`${kind}:${load}`);
    workload.submit();
    const now = await nextFrame();
    // Frames stopped arriving (the page went invisible mid-ramp). Whatever was recorded stands —
    // `readRamp` reports it as the bound it is — but do not wait forever for the next one.
    if (now === null) { mark(`${kind}:frames-stopped`); break; }
    state = recordRampFrame(state, now - last);
    last = now;
    // The outer guard. A ramp that is somehow neither escaping nor exhausting its own budget
    // must still not hold the launch open — this is a BLOCKING probe.
    if (rawNow() > deadline) break;
  }

  workload.setLoad(0);
  return readRamp(state);
}

/** Run the boot probe. Resolves `null` when the probe cannot run at all (no DOM, no WebGL2), which
 *  callers must treat as "no information" — i.e. today's behaviour — and never as a verdict.
 *
 *  ⚠️ THIS BLOCKS THE LAUNCH BY DESIGN. Everything it costs happens before the real renderer is
 *  created, because a tier decided any later cannot apply `antialias`. It is first-launch-only; the
 *  caller caches the verdict.
 *
 *  ⭐ **`only2D` selects the FILL ramp as the deciding GPU axis** (owner, 2026-08-13). A 2D
 *  project's only tier-controlled GPU knob is `pixiPixelRatioCap`, which is purely fill-rate bound
 *  — so `shade` (a stand-in for IBL and shadow taps a 2D project will never issue) is measuring the
 *  wrong thing there, and paying for it in blocked launch. The `draw` ramp goes too: a 2D scene's
 *  submit cost is Pixi's batcher's, not one draw per sprite. So a 2D-only project runs `fill` + `cpu`
 *  and a 3D one runs `shade` + `cpu`, and both are the SAME instrument on the same context — which
 *  is what keeps a phone's two readings comparable. */
export async function runBootRampProbe(
  onProgress?: (stage: string) => void,
  only2D = false,
): Promise<ProbeMeasurement | null> {
  const mark = (stage: string) => { try { onProgress?.(stage); } catch { /* never fail the probe */ } };
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return null;
  mark('start');

  const started = rawNow();

  // Sized from the viewport but CLAMPED to MAX_PROBE_PIXELS — not 2px (which would report every
  // device on earth as fill-infinite) and not the native buffer either (that killed a tab; see the
  // module header). Aspect is preserved so the shape of the work resembles a real frame.
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const scale = Math.min(1, Math.sqrt(MAX_PROBE_PIXELS / (vw * vh)));
  const cw = Math.max(1, Math.round(vw * scale));
  const ch = Math.max(1, Math.round(vh * scale));

  // ⚠️ NO RENDERER IS CONSTRUCTED HERE ANY MORE, and three separate hazards left with it: the
  // re-entrancy that killed an iPhone 13 mini's tab, the GPU context leaked by the creation
  // timeout, and the 600-1700 ms of cold renderer creation that used to be able to consume the
  // entire ramp allowance on a first launch. See `rampWorkloadGL.ts`.
  const surface = createGlProbeSurface(cw, ch, mark);
  if (!surface) { mark('no-gl-surface'); return null; }
  const { workloads, clock, bufferPixels, shadeRegionPixels, compileMs, shadeCompileMs } = surface;
  const rendererMs = 0;

  // Which GPU axis decides, and which is simply not run. `shade` is absent from a 2D probe and
  // `fill`/`draw` from a 3D one; `classifyDevice` already treats an absent reading as no evidence
  // rather than as a zero.
  const axes: ProbeAxes = only2D ? '2d' : '3d';
  const gpuKinds: RampKind[] = only2D ? ['fill'] : ['shade'];

  // ⭐ ONE DEADLINE FOR THE WHOLE PROBE, computed ONCE — see {@link PROBE_TOTAL_BUDGET_MS}. Every
  // phase below clamps its own budget against this, so a phase that overruns eats into what the
  // next one may spend instead of adding to it. `started` rather than `rawNow()`: the GL surface
  // and its shader compiles are part of what the player is waiting through, so they belong inside
  // the budget rather than before it.
  const probeDeadline = started + PROBE_TOTAL_BUDGET_MS;
  /** A phase's own budget, never past the probe's. */
  const phaseDeadline = (budgetMs: number) => Math.min(rawNow() + budgetMs, probeDeadline);
  mark(`gl-ok ${cw}x${ch} axes=${gpuKinds.join('+')}+cpu`);

  try {
    // ── THE CPU RAMP RUNS FIRST, AND THE ORDER IS DELIBERATE ──────────────────────────────
    // It needs no GPU, so no GPU ramp's deadline can starve it (which is exactly how the Y6's draw
    // ramp came back empty, twice, before each ramp got its own); nothing has been submitted yet,
    // so it is not being timed against a queue draining underneath it; and it is the cheapest, so
    // paying for it first guarantees every launch yields at least one axis even when the GPU side
    // produces nothing at all.
    // ⭐ **THE CPU RAMP RUNS {@link CPU_WARMUP_RAMPS}+1 TIMES AND CLASSIFIES THE LAST**, for the
    // same governor reason the GPU ramps discard theirs — see the shade discard below, and
    // `runCpuRamp`'s own header for the two rounds of boot-vs-in-game measurement behind the
    // count. `CPU_WARMUP_PASSES` warms the JIT (three passes of 8192, ~1-2 ms); it cannot warm a
    // CPU governor, which needs sustained work and only a full ramp supplies it.
    //
    // ⚠️ The discarded readings are KEPT, not thrown away, and that is the one place this differs
    // from the GPU discard. The cpu axis is the half still under investigation, and the pass-to-
    // pass progression IS the governor signal — reporting it on every probe means the next person
    // can read a device's DVFS behaviour straight off its boot log instead of building a
    // diagnostic to ask. They vote on nothing: `readingOf` and every threshold read `cpu`.
    //
    // Cheap enough not to need a budget bump: a cpu ramp escapes in ~25-40 ms (Huawei Y6, the
    // slowest device here, measured ~35 ms), so even three passes cost ~105 ms against a
    // `PROBE_TOTAL_BUDGET_MS` of 3200 that the same phone completes inside ~2.15 s. Each warm-up
    // carries the smaller `CPU_RAMP_BUDGET_MS` so a pathological device spends its remaining
    // allowance on the pass that counts.
    const cpuWarmups: RampReading[] = [];
    for (let i = 0; i < CPU_WARMUP_RAMPS; i++) {
      cpuWarmups.push(runCpuRamp(() => {}, phaseDeadline(CPU_RAMP_BUDGET_MS)));
    }
    const cpu = runCpuRamp(mark, phaseDeadline(HARD_DEADLINE_MS));
    // ⚠️ No `=== 1 ? '' : 'es'` pluralisation here, and that is not a style choice: `const x = 1`
    // gives TypeScript the LITERAL type `1`, so comparing it against any other literal is an
    // "unintentional comparison" ERROR — i.e. the moment someone retunes `CPU_WARMUP_RAMPS` the
    // build breaks in a file they did not touch. Worse than the error is how it presents:
    // `build-web.mjs` fails, `cap sync` copies the STALE `dist/`, gradle reports BUILD SUCCESSFUL,
    // and the phone runs the previous instrument while you measure it. Hit exactly that on
    // 2026-08-13 while re-measuring the S22 — the first probe line was the giveaway.
    mark(`cpu-ok ${cpu.status}/${cpu.bound} (after ${CPU_WARMUP_RAMPS}x discarded warm-up ramp)`);

    const readings: Partial<Record<RampKind, RampReading>> = {};

    // ── THE GPU-CLOCK PATH, PREFERRED WHENEVER IT IS AVAILABLE (#188 (ii)) ────────────────
    // It waits for the GPU, never for the display, so the WebView's boot-time rAF backoff cannot
    // touch it — and there is consequently no interval to estimate and nothing to declare
    // implausible. The presentation path below stays as the fallback for a context with no fence.
    mark(`gpu-clock ${clock ? clock.kind : 'unavailable'}`);
    if (clock) {
      // ⚠️ THE WARM-UP IS THE PHASE THAT HAD NO DEADLINE AT ALL, and on the evidence it is where
      // the pathological launch went: three fence waits, each bounded only by the clock's own 2 s,
      // before a single measured step. Both halves are needed — the loop consults the deadline
      // BETWEEN renders, and `awaitClockWithin` bounds each individual wait, since a check between
      // iterations cannot shorten the wait it is standing after.
      for (let i = 0; i < GPU_WARMUP_RENDERS; i++) {
        if (rawNow() > probeDeadline) { mark(`gpu-warmup-deadline at ${i}`); break; }
        workloads[gpuKinds[0]].submit();
        if (await awaitClockWithin(clock, probeDeadline) === null) { mark(`gpu-warmup-failed at ${i}`); break; }
      }
      for (const kind of gpuKinds) {
        // ⚠️ A DEADLINE EACH, not one shared between them. Shared, a GPU-paced fill ramp consumed
        // the whole allowance and the next ramp reported `running` with no reading — measured on
        // the Y6, twice. Each ramp's own `GPU_RAMP_BUDGET_MS` normally stops it long before this
        // fires; a guard one ramp can spend on behalf of the other is not a guard for the second.
        // ⭐ **THE FIRST PASS IS DISCARDED — A FLAGSHIP AT IDLE CLOCKS READS LIKE A BUDGET
        // PHONE.** This is the fix for an inversion that survived two other explanations: the
        // shade axis ranked a Galaxy S22 BELOW a Galaxy A23, which is impossible, and neither the
        // GPU-clock latency floor (raising `startLoad` changed nothing) nor the per-submit clear
        // (the S22's buffer is the SMALLER of the two, 0.27 vs 0.31 Mpx) accounted for it.
        //
        // Running the same ramp twice in one launch named the cause (2026-08-13, `games/sling`,
        // two launches per device):
        //
        //     device   pass 1        pass 2        gain
        //     A23      12.13 11.74   15.61 15.50   ~1.3x
        //     S22       7.49  7.71   19.92 11.48   1.5-2.7x
        //
        // The flagship gains far more, and on pass 2 it finally reads ABOVE the A23 — the ordering
        // was never wrong about the hardware, the probe was measuring a GPU that had not clocked
        // up. A weak device is already at its ceiling and gains little, which is why this asymmetry
        // is the governor rather than caching or warm shaders.
        //
        // ⚠️ `GPU_WARMUP_RENDERS` does NOT cover this and is not the same thing: three submits at
        // the START load settle the pipeline, which is what they were added for. A governor needs
        // sustained work, and only a full ramp supplies it.
        //
        // The pass is bounded like any other and its reading is thrown away — no marks, so the
        // stage breadcrumbs still describe the measured pass.
        //
        // ⚠️ **CLOCK PATH ONLY, and that is a real asymmetry.** The presentation/rAF fallback below
        // (taken when `makeGpuClock` returns null) still runs ONE un-warmed pass, and
        // `classifyReading` does not read `clockKind` — so a fallback reading and a clock reading
        // are judged by the same thresholds while having been taken at different GPU clocks. The
        // exposure is narrow (WebGL2 `fenceSync` is core, so the fallback is rare) and it is why
        // this is documented rather than fixed: warming the presentation path costs whole rAF
        // frames, not submits. If a device population ever lands on that path, this is the first
        // thing to suspect about its numbers.
        await runRamp(
          kind, workloads[kind], GPU_NOMINAL_INTERVAL_MS, phaseDeadline(GPU_RAMP_BUDGET_MS), () => {}, clock);
        readings[kind] = await runRamp(
          kind, workloads[kind], GPU_NOMINAL_INTERVAL_MS, phaseDeadline(HARD_DEADLINE_MS), mark, clock);
        mark(`${kind}-ok ${readings[kind]!.status}/${readings[kind]!.bound} (after a discarded warm-up pass)`);
      }
      return {
        intervalMs: GPU_NOMINAL_INTERVAL_MS, clockKind: clock.kind, axes,
        fill: readings.fill, draw: readings.draw, shade: readings.shade, cpu, cpuWarmups,
        totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
        bufferPixels, shadeRegionPixels,
      };
    }

    const warmup: number[] = [];
    let last = await nextFrame();
    if (last === null) { mark('no-frames — the page is not visible'); return null; }
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      workloads[gpuKinds[0]].submit();
      const now = await nextFrame();
      if (now === null) { mark(`warmup-frames-stopped after ${i}`); return null; }
      warmup.push(now - last);
      last = now;
    }
    // ⚠️ THE GAME'S FRAME INTERVAL, NOT THE rAF CADENCE — they are not the same number, and the
    // probe must measure at the cadence the game will actually run at.
    //
    // `frameDriver` caps rendering at `targetFPS` (60 by default) by SKIPPING rAF callbacks, while
    // this runner drives its own rAF loop and so sees every tick. Measured natively on a Galaxy
    // S22: rAF ticks every 8.4 ms (~119 Hz) and the game renders every other one at 16.8 ms / 60
    // fps. Feeding 8.4 into the ramp halves both derived thresholds — escape becomes 25 ms instead
    // of 50, the budget 75 ms instead of 150 — so that phone was pushed to a different operating
    // point on its load curve than a 60 Hz phone, ran out of budget before escaping, and produced
    // nothing but lower bounds. It never settled on a tier at all.
    //
    // MAX, not the target outright: the measured value still has to win when the DISPLAY is the
    // slower of the two. A thermally throttled iPhone 8 really does drop to 30 Hz, and the probe
    // has to see 33 ms there rather than assume 16.7 — that case is why the interval is measured
    // in the first place (see `estimateIntervalMs`). A game cannot render faster than either its
    // own cap or the display, so the effective interval is whichever is longer.
    const measuredIntervalMs = estimateIntervalMs(warmup);
    const cappedIntervalMs = targetFPS > 0 ? 1000 / targetFPS : 0;
    const intervalMs = Math.max(measuredIntervalMs, cappedIntervalMs);
    mark(`warmup-ok interval=${intervalMs.toFixed(1)} (rAF ${measuredIntervalMs.toFixed(1)}, cap ${cappedIntervalMs.toFixed(1)})`);
    if (intervalMs <= 0) return null;
    // ⚠️ THE PLAUSIBILITY TEST IS ON THE MEASURED VALUE ONLY, never on `intervalMs`. The cap is a
    // deliberate project choice and a game that targets 20 fps has a legitimate 50 ms interval;
    // it is the MEASUREMENT that can be contaminated, and only the measurement is being doubted.
    const intervalImplausible = measuredIntervalMs > MAX_PLAUSIBLE_INTERVAL_MS;
    if (intervalImplausible) {
      mark(`interval-implausible ${measuredIntervalMs.toFixed(1)}ms `
        + `[${warmup.map((f) => f.toFixed(0)).join(' ')}] — the warm-up timed the boot, not the display`);
    }

    // ⚠️ RETURN THE CPU AXIS EVEN HERE, and note this is NOT a softening of the decline. The
    // plausibility guard exists because every PRESENTATION-paced threshold is a multiple of the
    // interval, so a contaminated interval poisons the GPU ramps — it says nothing about a ramp
    // that never consulted the display. Those are reported as the empty readings they are
    // (`bound: 'none'`, which `classifyDevice` already refuses to classify), so the verdict is
    // exactly as declined as it was before; what changes is that the launch stops throwing away the
    // one measurement it did legitimately take.
    if (intervalImplausible) {
      const declined = (kind: RampKind) => readRamp(startRamp(kind, 0));
      return {
        intervalMs, clockKind: 'raf' satisfies ProbeClockKind, axes,
        fill: only2D ? declined('fill') : undefined,
        shade: only2D ? undefined : declined('shade'),
        cpu,
        totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
        bufferPixels, shadeRegionPixels,
      };
    }
    // ⚠️ A DEADLINE EACH HERE TOO — see the GPU-clock path above for the measurement that forced it.
    //
    // ⚠️ `escapableIntervalMs(intervalMs)`, NOT the raw `intervalMs` — see its doc (#205 R5.4). A
    // large enough authored `targetFPS` pushes `intervalMs` past `ABORT_FRAME_MS / ESCAPE_MULTIPLE`,
    // at which point escape becomes unreachable before abort. `intervalMs` itself is still what
    // gets reported below; only the ramps' own escape yardstick is bounded.
    const rampIntervalMs = escapableIntervalMs(intervalMs);
    for (const kind of gpuKinds) {
      readings[kind] = await runRamp(
        kind, workloads[kind], rampIntervalMs, phaseDeadline(HARD_DEADLINE_MS), mark, null);
      mark(`${kind}-ok ${readings[kind]!.status}`);
    }

    return {
      intervalMs, clockKind: 'raf' satisfies ProbeClockKind, axes,
      fill: readings.fill, draw: readings.draw, shade: readings.shade, cpu, cpuWarmups,
      totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
      bufferPixels, shadeRegionPixels,
    };
  } catch (e) {
    // A probe failure must never block rendering — the caller falls back to today's behaviour,
    // which starts low. Same policy as a failed `getDeviceCaps()`.
    mark(`threw ${String(e).slice(0, 160)}`);
    return null;
  } finally {
    // Dispose in full: this context exists only to answer one question, and a leaked GL context is
    // a real cost on exactly the low-memory hardware being characterised.
    surface.dispose();
  }
}
