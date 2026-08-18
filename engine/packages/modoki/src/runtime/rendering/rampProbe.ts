/** Boot ramp probe (#188) — the PURE half: ramp policy and the throughput maths.
 *
 *  This module renders nothing, reads no clock and touches no DOM. It is a state machine the
 *  renderer-side runner drives: ask it for the next load, render that load, hand back the frame
 *  time, repeat. Every branch is therefore reachable in a headless test with a fabricated
 *  sequence of frame times — which is the whole reason the policy lives apart from the runner.
 *
 *  ── WHY A PROBE AT ALL ────────────────────────────────────────────────────────────────────
 *  The tier was promoted by `evaluateTierChange`'s `hasHeadroom()`, which asks whether the CPU
 *  is using under 40% of the frame interval. That is measurably wrong in BOTH directions on one
 *  phone (a Galaxy A23): forest-camp has the GPU budget for IBL there and can never earn it,
 *  while `3d-test` runs the GPU at 84% and the CPU rule sees nothing wrong. Feeding real GPU
 *  time in does not fix it — timestamp queries report `unsupported` on WebGL2 without
 *  `EXT_disjoint_timer_query_webgl2`, i.e. on most low-end Android, which is the population the
 *  tier system exists for. See docs/rendering.md § "Quality tiers" → "The boot ramp probe".
 *
 *  ── WHAT MAKES A PROBE ABLE TO ANSWER WHERE LIVE STATS CANNOT ─────────────────────────────
 *  `frameMs` is PINNED at the display interval whenever the renderer finishes early, so it
 *  reports "barely making 60" and "trivially making 60" identically (`FrameProfile.vsyncBound`
 *  exists to say so). A ramp escapes that by construction: it increases load until the frame is
 *  no longer vsync-bound, at which point `frameMs` is a real throughput number on EVERY backend
 *  — no GPU timer extension required.
 *
 *  ⚠️ **BUT VSYNC QUANTIZES.** A frame that misses its slot does not land at 1.1x the interval;
 *  it lands at exactly 2x, then 3x. So "over the interval" is not yet a measurement — the
 *  reading carries up to a full interval of quantization error. Two things follow, and they are
 *  the reason this module is shaped the way it is:
 *
 *    1. Escape is declared at {@link ESCAPE_MULTIPLE}x the interval, not at 1x, so the
 *       quantization error is a bounded fraction of the reading rather than all of it.
 *    2. Throughput comes from the SLOPE between two supra-vsync steps, never from one absolute
 *       frame time. Over a doubling, `(f2 - f1) / (l2 - l1)` cancels the fixed per-frame
 *       overhead — present cost, browser bookkeeping, the constant part of the scene — which is
 *       unknown and is otherwise indistinguishable from the load-dependent part we want.
 *
 *  This buys a COARSE number — right to about a factor of two, not to 10%. That is the accuracy
 *  a device CLASS needs, and claiming better would be false precision.
 *
 *  ── THE CONSTRAINT THAT SHAPED THIS, AND WHY IT NO LONGER HOLDS ───────────────────────────
 *  ⚠️ **HISTORY, NOT CURRENT LAW — this paragraph described a two-ramp probe that varied nothing
 *  but draw count and overdraw, and both halves of that are now false.** The rule was: one distinct
 *  program costs ~1.2 s to compile on a Huawei Y6 (16 479 ms for postfx-demo's 14 programs, against
 *  2 928 ms on an A23), so a probe with its own material would spend 4x its budget before drawing a
 *  pixel, on exactly the hardware being profiled.
 *
 *  It was overridden twice, deliberately, and measurement is what retired it. First so the probe
 *  could inform the launch it runs on (`antialias` is baked at renderer construction). Then because
 *  overdraw on a material the frame already compiled cannot measure fragment work AT ALL: a
 *  tile-based GPU resolves which fragment survives before shading, so the load never reaches a
 *  shader. The heavy program the ban forbade is the only thing that measures the axis the tiers
 *  actually gate — and it costs 420-425 ms on an iPhone 7, not 1.2 s. There are now FOUR ramp
 *  kinds and one of them varies shading. See {@link RampKind}.
 *
 *  ── IT MUST RAMP, NEVER START HEAVY ───────────────────────────────────────────────────────
 *  A fixed heavy probe risks the failure that started this workstream: a 6.4 s submit trips the
 *  GPU watchdog, the WebGL context is lost, and the screen stays black for the process lifetime
 *  (#156). Start tiny, double, and abort on the first frame past {@link ABORT_FRAME_MS} — which
 *  is ~25x below the submit that actually killed that device. */

/** Which bottleneck a ramp leans on. They are separate because the strongest finding in this
 *  workstream is that three projects had three DIFFERENT bottlenecks: a fill-heavy probe would
 *  not have predicted forest-camp being CPU-bound on per-object submit.
 *
 *  ── WHY FOUR, WHEN TWO WERE SUPPOSED TO BE ENOUGH ─────────────────────────────────────────
 *  ⚠️ **`fill` DOES NOT RANK MODERN MOBILE GPUs, AND THAT IS MEASURED, NOT SUSPECTED.** Timed on
 *  the GPU clock during boot, a Galaxy A23's fill time does not move with load at all — eight
 *  times the work, the same ~11 ms — because 297 Mpx of dumb overdraw costs it less than the
 *  clock's own ~10 ms floor. Every phone this workstream can reach is adequate at raw fill, so no
 *  amount of pacing or batching makes a fill ramp separate them.
 *
 *  And raw fill is not what the tiers gate. `TIER_SETTINGS` turns off IBL lookups, NPR post-FX and
 *  shadow sampling — all texture-sampling and ALU cost. The probe was measuring an axis that does
 *  not predict the decision it feeds. `shade` measures that axis directly; `cpu` covers the third
 *  bottleneck nothing here has ever measured (forest-camp's, and it was the CPU).
 *
 *  ⚠️ **THIS IS AN INSTRUMENT SHAPE, NOT THE SHIPPING ONE.** Four ramps cost more blocked launch
 *  than two, and the point of running all four at once is to find out which of them discriminate
 *  — on one build, in one campaign, because two overlapping campaigns on the same phones already
 *  voided a session's worth of counts. The ones that do not discriminate come OUT again; see
 *  docs/rendering.md § "Quality tiers". Do not read the presence of a ramp here as a claim that
 *  it is load-bearing. */
// ⛔ **`draw` REMOVED 2026-08-13 by owner decision (#221 W2 item 4)** — the per-object-submit
// ramp. It had not been measured by EITHER probe shape since 2026-08-11: `gpuKinds` in
// `rampProbeRunner.ts` names only `fill` (2D) or `shade` (3D), so `draw` never ran and no
// threshold ever read it. When it did run, it failed outright on the weakest hardware this probe
// exists for (Huawei Y6 0/6 launches produced a reading, iPhone 7 0/3). Dead weight in a
// launch-blocking probe.
//
// The ramp and its GL workload (`rampWorkloadGL.ts`) are recoverable from git if a future project
// turns out to be per-object-submit bound — forest-camp measured 0.14 ms/call on the Y6, which is
// the case that would justify bringing it back.
//
// `CLASSIFIER_VERSION` is NOT bumped for this removal: `draw` never entered `ProbeReading` (it was
// evidence-only on `ProbeMeasurement`), so there is no persisted sample and no threshold whose
// meaning changed. Do not "fix" this.
export type RampKind = 'fill' | 'shade' | 'cpu';

/** One rendered step: how much was drawn, and how long that frame took. */
export interface RampStep {
  load: number;
  frameMs: number;
  /** Submit-to-GPU-completion time for this step, when a `GpuClock` was available (#188). It is
   *  module-local to `rendering/gpuClock.ts` and not imported here, so a `{@link}` would silently
   *  fail to resolve in the generated API reference — same reason `ABORT_FRAME_MS` is plain above.
   *
   *  Recorded ALONGSIDE `frameMs` rather than replacing it, deliberately: the two are different
   *  clocks with different failure modes, and the whole question this field exists to answer is
   *  whether GPU-completion timing survives the boot conditions under which presentation timing
   *  demonstrably does not. Policy still runs on `frameMs`; this is evidence, not yet a decision. */
  gpuMs?: number;
}

/** How a ramp ended. Only `escaped` yields a measured throughput; the rest are honest failures
 *  or bounds, and each maps to a different confidence downstream. */
export type RampStatus =
  /** Still ramping — more steps to render. */
  | 'running'
  /** Two consecutive supra-vsync steps, so a slope is available. The good outcome. */
  | 'escaped'
  /** Reached the ceiling load while still vsync-bound. The device never broke a sweat, so
   *  throughput is a LOWER BOUND, not a measurement — and that is a perfectly useful answer. */
  | 'ceiling'
  /** Ran out of frames before escaping or reaching the ceiling. Still yields a LOWER BOUND —
   *  whatever it did render, it rendered — so this is a weaker answer, not a missing one. */
  | 'budget'
  /** A single frame exceeded `ABORT_FRAME_MS`. Stop immediately — see the watchdog note.
   *  (Plain code span, not `{@link}`: the constant is module-local to `rampProbe.ts` and not
   *  re-exported from the package index, so TypeDoc cannot resolve it from this PUBLIC type and
   *  emitted an unresolved-link warning. Widening the API surface for a doc link is the wrong
   *  trade.) */
  | 'aborted';

/** Frame time, as a multiple of the display interval, at which a reading stops being dominated
 *  by vsync quantization and starts being a throughput number. See the header.
 *
 *  3, not 1.5: at 1.5x a single missed slot (which lands at exactly 2x) is indistinguishable
 *  from real load, so the ramp would "escape" on a hiccup and measure a slope from noise. */
export const ESCAPE_MULTIPLE = 3;

/** How far off the vsync pin the PRECEDING step must be for the slope to mean anything.
 *
 *  ⚠️ Both escape steps once had to clear {@link ESCAPE_MULTIPLE}, and that was measurably too
 *  strict — it discarded a measurement the probe had already paid for. On an iPhone 8 the draw
 *  ramp ran 512 calls in ~38 ms then 1024 in ~76 ms: a clean doubling with 2x growth, the exact
 *  signal this module exists to capture. But 38 ms is only 2.2x a 17 ms interval, so the pair was
 *  rejected, and reaching a step where BOTH frames exceed 3x would have cost more wall clock than
 *  the entire ramp budget. The rule was unaffordable precisely on the slowest hardware — the
 *  hardware the probe exists for.
 *
 *  1.5x is the weaker thing actually needed: far enough above the interval that the reading is not
 *  a vsync-pinned frame, which is all the slope requires of the earlier point. The LAST step still
 *  has to clear the full 3x, so a single spike out of a pinned frame is still rejected (its
 *  predecessor sits at 1.0x), and two consecutive missed slots still are (neither reaches 3x). */
export const ESCAPE_PRIOR_MULTIPLE = 1.5;

/** Leading warm-up frames dropped before the display interval is estimated. See
 *  {@link estimateIntervalMs}. */
export const DISCARDED_WARMUP_FRAMES = 3;

/** Steps a ramp must record before escape may be declared at all.
 *
 *  ⚠️ Measured: an iPhone 7 "escaped" the FILL ramp at LOAD 2, reporting 0.014 Mpx/ms — three
 *  orders of magnitude off, from two slow frames immediately after the shader compile. The early
 *  ramp is where the pipeline is still settling, and it is also where the load is far too small
 *  to explain a long frame; a long frame there is evidence of noise, not of throughput.
 *
 *  Three, so escape can only be declared once the load has doubled a few times and the frames
 *  either side of it are being driven by the ramp rather than by whatever the device was still
 *  finishing. Costs nothing on a real escape, which happens far up the ramp by construction. */
export const MIN_STEPS_BEFORE_ESCAPE = 3;

/** Growth required across the escape doubling, as a fraction of the display interval.
 *
 *  ⚠️ **A LONG FRAME IS NOT AN ESCAPED FRAME.** A device with a large fixed per-frame overhead
 *  sits past {@link ESCAPE_MULTIPLE} from the very first step while its frame time does not move
 *  at all with load — the cost is real, but it is not the cost the ramp is trying to measure,
 *  and stopping there hands the slope estimator two identical points. So escape additionally
 *  requires the frame to have GROWN across the doubling; until it does, the load is still not
 *  the bottleneck and the honest move is to keep ramping.
 *
 *  Half an interval, because quantization delivers growth in whole-interval steps: under vsync
 *  this means "at least one quantum", and on an unquantized surface it still means solidly
 *  measurable rather than noise. */
export const ESCAPE_GROWTH_RATIO = 0.5;

/** A frame this long ends the ramp on the spot. The GPU watchdog that bricked a Y6 fired at
 *  ~6.4 s; this is ~25x below it, and a device producing a quarter-second frame at a probe load
 *  has already given the only answer the probe was going to get. */
export const ABORT_FRAME_MS = 250;

/** Total wall-clock the probe may spend, owner-set. First launch only — the result is cached
 *  against a device fingerprint, so later boots pay nothing. */
export const PROBE_BUDGET_MS = 300;

/** Per-ramp allowance, in FRAMES rather than milliseconds.
 *
 *  ⚠️ It was wall-clock (half of {@link PROBE_BUDGET_MS}), and that unit is wrong. What a ramp
 *  needs is DOUBLINGS — enough steps to climb from its start load to a load that strains the
 *  device. How long a step takes is set by the display, not by the ramp.
 *
 *  Measured, on one iPhone 8, twenty minutes apart: at 60 Hz the interval read 17 ms and 150 ms
 *  bought ~9 frames, enough to escape both ramps. Warm, its refresh dropped to 30 Hz — 33 ms per
 *  frame — and the same 150 ms bought ~4. Not one ramp escaped, at any load, and every reading
 *  degraded to `peakLoad / vsync-pinned frame`: a restatement of the probe's own ceiling wearing
 *  a convincingly tight error bar (draw sat at 15.1-15.5 across ten runs, which is just 512/33).
 *  A budget that cannot buy enough frames does not return a worse measurement; it returns none,
 *  while still looking like one.
 *
 *  NINE frames, which is exactly today's behaviour at 60 Hz (9 x 16.7 = 150 ms) and adapts on its
 *  own elsewhere. The trade to be aware of: on a genuinely 30 Hz display this spends ~300 ms per
 *  ramp instead of 150. That is the honest price of getting an answer there at all. */
export const RAMP_BUDGET_FRAMES = 9;

/** Where each ramp starts and stops. Tiny start for the watchdog reason above; the ceiling is
 *  the point past which "it never escaped" is already conclusive. */
/** Where each ramp starts and stops.
 *
 *  ── A CEILING THAT IS TOO LOW PRODUCES A CONFIDENT NON-ANSWER ─────────────────────────────
 *  ⚠️ These were briefly HALVED, on the theory that the ramp's peak submit had crashed an iPhone
 *  13 mini. **That diagnosis was wrong** — the crash was unbounded recursion between the probe and
 *  tier resolution (see `probeReentrancy.ts`), and load had nothing to do with it. Measured on
 *  real hardware afterwards, the lowered ceilings were actively harmful:
 *
 *    iPhone 13 mini (A15)  fill ceiling@32 → 0.48 Mpx/ms      draw ceiling@1024 → 48.8/ms
 *    iPad mini 5   (A12)   fill ceiling@32 → 0.93 Mpx/ms (!)  draw budget@1024  → 25.6/ms
 *
 *  The A12 tablet "beat" the A15 phone on fill by 2x. It did not: NEITHER escaped, so both figures
 *  are `peakLoad / frameMs` with the frame pinned at vsync — i.e. `ceiling x buffer / interval`,
 *  a restatement of the probe's own parameters and of the panel's refresh rate. A ceiling low
 *  enough that every device reaches it does not measure devices at all; it measures the ceiling.
 *
 *  So they are raised past what real hardware reached. The draw ramp shows the target: the A12's
 *  1024-call frame took ~40 ms, genuinely straining, but never hit the 3x-interval escape bar.
 *  One more doubling gets there.
 *
 *  What DOES guard against a lethal submit is the doubling itself — the worst frame can only be
 *  ~2x the last one, which was measured and survived — plus `ABORT_FRAME_MS`. Note the honest
 *  limit: abort fires only AFTER a frame completes, so it bounds the ramp, not any single submit.
 *  The doubling is what makes that sufficient. */
export const RAMP_BOUNDS: Record<RampKind, { startLoad: number; maxLoad: number }> = {
  /** Large overlapping quads — fragment throughput. 256x screen overdraw is far past anything a
   *  shipping frame does, which is the point: it must be out of reach for a STRONG device, or the
   *  strong device reports the ceiling instead of itself. */
  // ⚠️ **maxLoad RAISED 1024 -> 65536 (2026-08-13, #221) because TWO devices topped it out.** An
  // iPhone Air and a Galaxy S22 both returned `ceiling/lower` — they exhausted the ramp without
  // ever reaching the escape bar, their last step still ~15 ms against a bar of 50 ms — so both
  // "measurements" were lower bounds and the axis could not rank anything above ~24 Mpx/ms. That
  // is the failure this whole block warns about two paragraphs down, arrived at from the other
  // direction: a ceiling low enough that strong devices reach it measures the ceiling.
  //
  // **THE HEADROOM IS FREE AGAINST THE RAMP BUDGET.** A first attempt at 8192 was measured on a
  // Galaxy S22 and escaped on its VERY LAST STEP (3 wiped launches, escape at 8192 / 83.9 ms against
  // a bar of 50.1) — one device-generation from being clipped again. A bigger ceiling is cheap
  // because a ramp always ends on the first step past the escape bar, so the step times at the END
  // are ~50-100 ms on EVERY device: a faster GPU simply spends more doublings getting there, and its
  // early steps sit on the GPU-clock latency floor (~4.2 ms on the S22, ~8 ms on an iPhone Air —
  // iOS quantizes to 1 ms, which is why an Air's step table is all integers) rather than on real
  // work. Measured sum for the S22's full 11-step ramp: ~200 ms, against `GPU_RAMP_BUDGET_MS` 400.
  //
  // ⚠️ **IT IS NOT FREE AGAINST BLOCKED LAUNCH, AND THIS COMMENT SAID IT WAS FOR ONE COMMIT.**
  // MEASURED on the iPhone Air, same build, ceiling the only change: **blocked launch 264 ms -> 486
  // ms**. The three added steps cost ~104 ms and the discarded warm-up pass renders them again, so
  // the true price is ~2x the visible steps. That is the honest cost of the change and it is worth
  // paying — the alternative is a fast unrecognised device being ranked by the ramp's ceiling — but
  // it lands squarely on the launch time W2 exists to cut, and a device only pays it while it is
  // still refining (`PROBE_SAMPLE_TARGET` launches) and never once recognised by GPU identity.
  //
  // So: 65536, which is four doublings past where an S22 escapes, with `ABORT_FRAME_MS` (250) as
  // the backstop against a device that somehow stalls rather than escapes. Escape is tested BEFORE
  // the ceiling, so weak hardware never renders any of it — a Huawei Y6 escapes in its first steps
  // and pays nothing at all.
  fill: { startLoad: 8, maxLoad: 65536 },
  /** Overdraw of a HEAVY fragment shader over a FIXED small region — the axis the tiers actually
   *  gate (IBL lookups, shadow taps, post-FX), all of it texture-sampling and ALU.
   *
   *  Load is an instance count, so one step is `load x SHADE_REGION_PX^2` heavy fragments. Two
   *  properties fall out of holding the REGION fixed rather than the screen, and both are the
   *  reason this ramp is shaped this way: the panel size stops mattering (no `fillMegapixelsPerMs`
   *  normalisation, so the reading is already comparable across devices), and memory traffic is
   *  bounded by construction — which is exactly the safety property the 190 Mpx submit that killed
   *  an iPhone 13 mini's tab did not have.
   *
   *  4 to 4096: at 16 dependent taps over 100x100 px, load 4 is ~0.6 M taps (sub-millisecond on a
   *  flagship, a few ms on a Y6) and the escape bar sits ~250x above the former, ~20x above the
   *  latter. Both ends therefore land inside the ramp instead of against a bound. */
  // ⛔ **RAISING `startLoad` TO 32 WAS TRIED ON HARDWARE AND REFUTED — do not retry it**
  // (2026-08-13, `games/sling`, three wiped launches per device on Y6 / A23 / S22).
  //
  // The theory was sound and the data killed it. This axis INVERTS at the top — a Galaxy S22
  // derives less shading throughput than a Galaxy A23, which is impossible — and the S22's step
  // table looked like it named the cause:
  //     shade [4:4.2 8:4.2 16:4.2 32:8.6 64:12.7 ...]
  //             ^^^^^^^^^^^^^^^^ flat across a 4x load change: a ~4.2 ms GPU-clock latency floor.
  // Three of eight fitted points carrying no signal, and a fixed cost weighs heaviest on the
  // FASTEST device, so removing them should have lifted the S22 specifically. Measured, medians:
  //
  //     startLoad  4    A23 0.15 / 0.12      S22 0.08 / 0.07     (two sessions)
  //     startLoad 32    A23 0.13             S22 0.07            <- inversion UNCHANGED
  //
  // The floor is real and is not the cause. The surviving explanation, UNTESTED: 16 DEPENDENT
  // texture reads are LATENCY-bound, and a fixed 100x100 px region cannot supply a wide GPU with
  // enough parallel fragments to hide that latency. A flagship's advantage is throughput, which a
  // 10k-fragment workload never asks for, while the A23's narrower GPU keeps its fewer lanes busy.
  // If that is right the REGION is the knob, not the load — and enlarging it trades against the
  // bounded-submit safety property the fixed region exists to provide. Measure before changing it.
  //
  // ⚠️ Third ramp to fail this way (fill measured submit; shade measures latency): **a synthetic
  // ramp measures whatever is scarcest, which is not necessarily what it is named after.** Check a
  // new axis against hardware it should rank obviously before trusting its ordering.
  shade: { startLoad: 4, maxLoad: 4096 },
  /** Transform propagations per synchronous loop — pure main-thread CPU, no GPU at all.
   *
   *  ⚠️ **THE THIRD AXIS, AND NOTHING IN THIS WORKSTREAM HAD EVER MEASURED IT.** Every reading
   *  before this one was GPU. But its own strongest finding is that three P5 projects had three
   *  different bottlenecks and forest-camp's was the CPU — per-object submit at 0.14 ms/call on the
   *  Y6, transform propagation measured at 2.2 -> 0.75 ms. A device can be GPU-fine and CPU-poor,
   *  and a GPU-only probe calls it capable.
   *
   *  4096 to 2097152: one propagation is a `Matrix4.compose` plus a `multiplyMatrices` (~150
   *  flops), so the start is a few tenths of a millisecond on a flagship — comfortably above
   *  `performance.now`'s 100 us clamp, which a smaller start would be inside.
   *
   *  ⚠️ The ceiling is two doublings above where an M-series Mac escapes (it did so on its very LAST
   *  step, 524288 at 15.7 ms), and the headroom is free: escape is tested before the ceiling, so a
   *  device that escapes early never renders the extra steps. Only hardware faster than that Mac
   *  pays for them, and without them that hardware would report a floor instead of a slope. */
  cpu: { startLoad: 4096, maxLoad: 2_097_152 },
};

export interface RampState {
  readonly kind: RampKind;
  /** Measured display interval, ms. See {@link estimateIntervalMs}. */
  readonly intervalMs: number;
  readonly maxLoad: number;
  readonly budgetMs: number;
  /** Every step rendered so far, in order. */
  readonly steps: readonly RampStep[];
  /** Load for the NEXT frame to render. Meaningless once `status !== 'running'`. */
  readonly nextLoad: number;
  /** Wall-clock consumed, ms — the sum of the frame times recorded. */
  readonly elapsedMs: number;
  readonly status: RampStatus;
}

/** Estimate the display interval from a handful of warm-up frames rendered at a trivial load.
 *
 *  The median, not the mean: one long warm-up frame (first-frame allocation, a texture upload)
 *  would drag a mean upward and inflate the escape threshold, which would then hide a slow
 *  device behind its own slow warm-up. Returns 0 for no samples, which callers must treat as a
 *  failed probe rather than as an infinitely fast display. */
export function estimateIntervalMs(warmupFrameMs: readonly number[]): number {
  const usable = warmupFrameMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (usable.length === 0) return 0;
  // Median of the SETTLED tail. Measured on three iOS devices, all 60 Hz, this estimate ranged
  // 6.0-18.0 ms from three warm-up frames — and since every ramp threshold is a multiple of it, a
  // reading of 6.0 dropped the escape bar to 18 ms and the ramp "escaped" on noise (an iPad
  // reported 42.7 calls/ms off one such frame; an iPhone 7 escaped the FILL ramp at load 2).
  // Early frames are irregular — rAF coalescing, the compile settling — so the first few are
  // dropped outright rather than merely out-voted.
  if (usable.length > DISCARDED_WARMUP_FRAMES + 2) usable.splice(0, DISCARDED_WARMUP_FRAMES);
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param budgetMsOverride Spend this many ms instead of `RAMP_BUDGET_FRAMES` frames' worth.
 *
 *  ⚠️ For the GPU-CLOCK path only, and the unit change is the point: a ramp paced by
 *  submit-to-completion has no frames to budget in. `RAMP_BUDGET_FRAMES` exists because a
 *  PRESENTATION-paced ramp needs doublings and the display decides how long one costs (see its
 *  comment — it was moved off wall clock precisely because 150 ms bought ~4 frames at 30 Hz). Neither
 *  argument survives when nothing waits for a frame, so that path budgets in ms again. */
export function startRamp(
  kind: RampKind,
  intervalMs: number,
  budgetMsOverride?: number,
  /** Begin at this load instead of the kind's authored `startLoad`.
   *
   *  ⚠️ **A TEST SEAM, and it exists to protect RECORDED EVIDENCE from a production tuning
   *  change.** `readRamp`'s outlier tests replay exact step tables captured off real phones —
   *  `[8.3, 10.5, 11.1, 13.6, 17.5, 26.1, 37.7, 49.9, 188.7]` is one Galaxy A23 launch. Those
   *  frame times belong to the loads they were MEASURED at, so when `RAMP_BOUNDS.shade.startLoad`
   *  moved from 4 to 32 the recordings silently re-attached to loads that never produced them and
   *  three tests went red. The recordings are not stale — they are evidence about the FITTING
   *  logic, which is what those tests are about, and that logic does not care where the ramp
   *  starts. Pinning them here keeps the evidence intact and lets the production constant move.
   *
   *  Never pass this from production code: the authored `startLoad` is the measurement decision. */
  startLoadOverride?: number,
): RampState {
  const { startLoad: authoredStart, maxLoad } = RAMP_BOUNDS[kind];
  const startLoad = startLoadOverride ?? authoredStart;
  return {
    kind,
    intervalMs,
    maxLoad,
    // Derived from the MEASURED interval — see RAMP_BUDGET_FRAMES for why frames, not ms.
    budgetMs: budgetMsOverride ?? intervalMs * RAMP_BUDGET_FRAMES,
    steps: [],
    nextLoad: startLoad,
    elapsedMs: 0,
    status: intervalMs > 0 ? 'running' : 'budget',
  };
}

/** The load to render next, or `null` when the ramp is finished. */
export function rampNextLoad(s: RampState): number | null {
  return s.status === 'running' ? s.nextLoad : null;
}

/** Record the frame time measured at `s.nextLoad` and decide what happens next. Pure — returns
 *  a new state, never mutates.
 *
 *  Order matters here and is deliberate: an ABORT wins over everything (it is the watchdog
 *  guard), then escape (the outcome we want), then the budget, then the ceiling. Checking the
 *  budget before escape would throw away a ramp that escaped on its very last affordable
 *  frame — which is exactly what a slow device does. */
export function recordRampFrame(s: RampState, frameMs: number, gpuMs?: number): RampState {
  if (s.status !== 'running') return s;

  const step: RampStep = { load: s.nextLoad, frameMs, ...(gpuMs === undefined ? {} : { gpuMs }) };
  const steps = [...s.steps, step];
  const elapsedMs = s.elapsedMs + Math.max(0, frameMs);
  const next = { ...s, steps, elapsedMs };

  // ⚠️ `frameMs < 0` ends the ramp too. A negative elapsed time is not a fast frame, it is a
  // non-monotonic clock — and left unrejected it is finite and under the abort bar, so it records
  // as an ordinary step and can become a fit endpoint: `[-50, 24, 80]` yielded a confident
  // `'measured'` reading built on a physically impossible input. This module already defends
  // against exotic clock behaviour in the other direction (iOS quantizing to whole milliseconds);
  // this is the same care applied to a clock that runs backwards.
  if (!Number.isFinite(frameMs) || frameMs < 0 || frameMs >= ABORT_FRAME_MS) {
    return { ...next, status: 'aborted' };
  }
  if (hasEscaped(steps, s.intervalMs)) return { ...next, status: 'escaped' };
  if (elapsedMs >= s.budgetMs) return { ...next, status: 'budget' };
  if (s.nextLoad >= s.maxLoad) return { ...next, status: 'ceiling' };

  return { ...next, nextLoad: Math.min(s.nextLoad * 2, s.maxLoad) };
}

/** Has this ramp produced a measurable slope?
 *
 *  Three conditions, each rejecting a specific way of being fooled:
 *   - the LAST step is past {@link ESCAPE_MULTIPLE} — so the reading is a throughput number and
 *     not a vsync-quantized one;
 *   - the step BEFORE it is past {@link ESCAPE_PRIOR_MULTIPLE} — off the pin too, so the slope is
 *     drawn between two real measurements rather than from one;
 *   - the frame GREW by {@link ESCAPE_GROWTH_RATIO} of an interval across the doubling — the cost
 *     tracks the load, rather than being fixed overhead wearing a long frame time.
 *
 *  A single hiccup out of a pinned frame fails the second (its predecessor sits at 1.0x). Two
 *  consecutive missed slots fail the first (neither reaches 3x). An overhead-bound device fails
 *  the third. Only the last two steps are consulted, so a spike early in the ramp can never pair
 *  with a genuine reading much later, whose slope would span several doublings and mean nothing. */
function hasEscaped(steps: readonly RampStep[], intervalMs: number): boolean {
  if (steps.length < MIN_STEPS_BEFORE_ESCAPE) return false;
  const b = steps[steps.length - 1];
  const a = steps[steps.length - 2];
  if (b.frameMs < intervalMs * ESCAPE_MULTIPLE) return false;
  if (a.frameMs < intervalMs * ESCAPE_PRIOR_MULTIPLE) return false;
  return b.frameMs - a.frameMs >= intervalMs * ESCAPE_GROWTH_RATIO;
}

/** How much to trust a throughput figure. */
export type ThroughputBound =
  /** A slope between two supra-vsync steps. Coarse (see the header) but real. */
  | 'measured'
  /** The ramp never escaped, so the device is at least this fast. A useful answer, not a
   *  failure — it is what a strong device produces. */
  | 'lower'
  /** Nothing usable. */
  | 'none';

export interface RampReading {
  kind: RampKind;
  status: RampStatus;
  /** Load units per millisecond. 0 when `bound` is `'none'`. */
  unitsPerMs: number;
  bound: ThroughputBound;
  /** Highest load that was actually rendered. */
  peakLoad: number;
  steps: readonly RampStep[];
}

/** How much a step may exceed its predecessor before it is a SPIKE rather than load.
 *
 *  The ramp DOUBLES, so a perfectly linear ramp grows at most 2x per step and a ramp with any fixed
 *  overhead grows less. 3x therefore cannot be the load; it is a hitch — a compositor stall, a GC, a
 *  thermal step. Measured examples that this rejects: a Galaxy A23 shade step of `1024:188.7` after
 *  `512:49.9` (3.8x), and an iPhone 8's `4:26` opening a ramp whose next step is 9. */
const SPIKE_RATIO = 3;

/** How far above the ramp's own cheapest step a point must sit to count as load-dependent.
 *
 *  A ramp whose first steps are all the same time regardless of load is sitting on a FIXED FLOOR —
 *  measured on an iPad mini 5, whose shade ramp read 28/27/27/25 ms across an eightfold load
 *  increase before finally moving. 25% is deliberately loose: it only has to exclude "did not move",
 *  not to judge how much movement is enough. */
const GROWTH_OVER_FLOOR = 1.25;

/** How much MORE than its successor a step may cost before it is read as a transient rather than
 *  as load.
 *
 *  The ramp DOUBLES its load each step, so a step costing meaningfully more than the next one did
 *  not measure load — nothing about the workload got cheaper. The tolerance is for measurement
 *  noise (iOS quantizes `performance.now()` to 1 ms, and a vsync-pinned pair can straddle an
 *  interval), not for a real drop. Kept small deliberately: this guards the OVERSTATING direction,
 *  where the cost of a false negative is a device promoted into a GPU it cannot afford, and the
 *  cost of a false positive is one skipped candidate for `a`. */
const NON_MONOTONE_RATIO = 1.2;

/** Did this step cost disproportionately more than the one before it? See {@link SPIKE_RATIO}.
 *
 *  ⚠️ **ONE-DIRECTIONAL, AND THE OTHER DIRECTION IS THE DANGEROUS ONE.** This flags a step that
 *  costs MORE than expected, which inflates `dMs` and so UNDERSTATES the device — the recoverable
 *  mistake. Throughput is `dLoad/dMs`, so it is an anomalously SMALL `dMs` that overstates, and
 *  overstating is what costs a GPU context. Nothing here detects a suspiciously fast step; the
 *  guards against that live where the overstatement can actually reach a verdict — the `Math.max`
 *  on the lower-bound divisor, and the `bi < 2` refusal — both added after a close-out review
 *  pointed out that every guard written first defended only the safe direction. */
function isSpike(steps: readonly RampStep[], i: number): boolean {
  if (i <= 0) return false;
  const prev = steps[i - 1].frameMs;
  return prev > 0 && steps[i].frameMs > prev * SPIKE_RATIO;
}

/** Turn a finished ramp into a throughput reading.
 *
 *  THE SLOPE, NOT THE RATIO. `load / frameMs` at one point silently attributes the fixed
 *  per-frame overhead to the load, which on a probe whose whole point is small loads is the
 *  dominant term. `(l2 - l1) / (f2 - f1)` over a doubling cancels it. If the frame did not grow
 *  across that doubling the reading is noise, not a fast device, and reports `'none'`. */
export function readRamp(s: RampState): RampReading {
  const peakLoad = s.steps.length ? s.steps[s.steps.length - 1].load : 0;
  const base: Omit<RampReading, 'unitsPerMs' | 'bound'> = {
    kind: s.kind, status: s.status, peakLoad, steps: s.steps,
  };

  if (s.status === 'escaped' && s.steps.length >= 2) {
    // THE WIDEST VALID PAIR, not the last two.
    //
    // ⚠️ The last two steps were used once, and the estimate came out QUANTIZED rather than
    // noisy. Measured on a Galaxy A23 across eight runs, the draw figure took essentially two
    // values — 10.2 and 30.7 — because vsync rounds every frame to a whole interval, so the
    // difference between two adjacent steps can only be 1, 2 or 3 intervals. `512 / 50ms` and
    // `512 / 16.7ms` are exactly those two clusters. An estimator whose neighbouring outputs sit
    // 3x apart cannot rank two devices that differ by less than that.
    //
    // Spanning from the EARLIEST step that is off the vsync pin to the last one buys a much
    // larger denominator — several intervals instead of one — so the same ±1 interval of
    // quantization error becomes a small fraction of it. It costs nothing: every step was already
    // rendered and paid for.
    // ⚠️ **BUT NOT ANY PAIR — AN OUTLIER AT EITHER END CORRUPTS THE SLOPE DIRECTLY, and all three
    // ways that happens were measured on real hardware (2026-08-11).**
    //
    //   - a SPIKE as the last step. The last step is `b` by construction, so nothing dilutes it.
    //     Galaxy A23, shade: `... 512:49.9 1024:188.7` — 3.8x the time for 2x the load. That one
    //     step dragged the reading to 0.055 Mfrag/ms against that phone's usual 0.10-0.16, which is
    //     below the `middle` floor: one bad launch, and a mid-band phone reads `weak`.
    //   - a SPIKE as the first step, which is then picked as `a`. iPhone 8, shade: `4:26 8:9 …`.
    //     The first step of a ramp is a pipeline switch (new geometry, new blend state) and a
    //     warm-up render demonstrably does not absorb it on every device.
    //   - a FIXED FLOOR that happens to clear the pin. iPad mini 5, shade:
    //     `4:28 8:27 16:27 32:25 64:58 …` — the first four steps do not move with load AT ALL, so
    //     picking one as `a` measures the floor, not the device. `ESCAPE_GROWTH_RATIO` guards the
    //     escape DECISION; nothing guarded this SELECTION.
    //
    // So both endpoints must be load-dependent points, and the rules are the minimum that makes
    // them so: trim a spiking tail, never start from the first step, and require `a` to sit
    // measurably above the ramp's own floor.
    const pin = s.intervalMs * ESCAPE_PRIOR_MULTIPLE;
    let bi = s.steps.length - 1;
    while (bi > 0 && isSpike(s.steps, bi)) bi--;
    const b = s.steps[bi];
    // The ramp's own floor — its cheapest step. Anything at that level is fixed cost, whatever the
    // load says. Guarded for 0, which iOS produces routinely: it quantizes `performance.now()` to
    // 1 ms, so early cheap steps really do read exactly 0.
    const floorMs = Math.min(...s.steps.map((step) => step.frameMs));
    const loadBearing = (step: RampStep) =>
      !(floorMs > 0) || step.frameMs >= floorMs * GROWTH_OVER_FLOOR;
    // ⚠️ **PREFER a load-bearing `a`, but FALL BACK rather than refuse — the error SIGN is the
    // guarantee, and it already points the safe way.** Pairing with a floor point inflates `dMs`,
    // which UNDERSTATES the device, and understating sends it to a lower tier: the recoverable
    // mistake (see `qualityTier`'s header — overstating is what costs a GPU context). So a
    // floor-paired reading is worth having, and refusing one is a real loss: an overhead-dominated
    // device, where the first steps are ALL floor, would then never read at all. Two tests pin that
    // — `NEVER OVERSTATES an overhead-dominated device` and `keeps ramping when two long frames did
    // not GROW` — and both are the case this must not break.
    // ⚠️ **IF TRIMMING LEFT NOTHING BUT INDEX 0, THERE IS NO FIT — say so.** `bi` can walk down to
    // 1 on a legal 3-step escape whose final step spiked (`MIN_STEPS_BEFORE_ESCAPE` is 3, so that
    // is the minimum ramp, not a degenerate one). Both searches then require `0 < i < 1`, which is
    // unsatisfiable, and a `?? s.steps[bi - 1]` fallback would hand back exactly the index-0
    // pipeline-switch step the rule above exists to refuse. Found in close-out review, and it
    // OVERSTATES: on `[4:10, 8:24, 16:80]` that fallback fits 10 -> 24 and reports 0.286 units/ms
    // where the honest pair reports 0.143 — 2x high, in the direction that costs a GPU context.
    if (bi < 2) return { ...base, unitsPerMs: 0, bound: 'none' };
    // ⚠️ **`a` MUST NOT BE A SPIKE, and `find`-earliest actively PREFERS one** (review 2026-08-12).
    // `isSpike` had exactly ONE call site — the tail trim above — while this search took the
    // EARLIEST step clearing `pin`. `loadBearing` is a lower bound, so a hitch clears it trivially:
    // the first step a GC pause / OS deschedule / GPU stall touches is the first step that
    // qualifies, and `find` returns it. That shrinks `dMs` and therefore OVERSTATES throughput —
    // the direction this module's header names as what costs a GPU context.
    //
    // MEASURED against this module: an iPhone-8-class cpu ladder
    // `4096:0.4 8192:0.8 16384:1.5 32768:3 65536:6 131072:12` reads 10.9k xform/ms — the value that
    // device contributed to `PROBE_THRESHOLDS`. The SAME ladder with one 7 ms pause at step 2 reads
    // **22.9k**, clearing the `capable` floor of 14 500 and handing a mid-band phone the unclamped
    // tier. `isSpike` was already TRUE at that index; it was simply never asked.
    //
    // Only the median-of-three contained it, and only when at most one launch hitched.
    //
    // ⚠️ **THE TEST IS NON-MONOTONICITY, NOT MAGNITUDE — `isSpike` is the WRONG predicate here and
    // using it broke a real case.** `isSpike` asks "did this cost much more than the step before",
    // which on a ramp whose LOAD DOUBLES every step is exactly what a slow device legitimately
    // does: the pinned `escape beats the budget on the last affordable frame` case ramps
    // `20 -> 120 -> 140` and its 6x second step is genuine growth, not a hitch. What separates the
    // two is what comes AFTER. Real load growth is monotone — the next step carries twice the load,
    // so it cannot cost meaningfully LESS. A transient is a local maximum: `…0.8, 7, 3, 6…` and
    // `…10, 35, 14…` both fall back down, and both are the readings that overstated.
    const notTransient = (i: number) => {
      const next = s.steps[i + 1];               // always in range: the searches require `i < bi`
      return !next || s.steps[i].frameMs <= next.frameMs * NON_MONOTONE_RATIO;
    };
    const a = s.steps.find((step, i) => i > 0 && i < bi && step.frameMs >= pin && loadBearing(step) && notTransient(i))
      ?? s.steps.find((step, i) => i > 0 && i < bi && step.frameMs >= pin && notTransient(i))
      // The last-resort pair. Still checked: falling back onto a hitch is the same overstatement by
      // another route, and refusing costs only a reading — `bound: 'none'` falls through to what
      // earlier launches concluded, which is the safe direction.
      ?? (notTransient(bi - 1) ? s.steps[bi - 1] : undefined);
    if (!a) return { ...base, unitsPerMs: 0, bound: 'none' };
    const dLoad = b.load - a.load;
    const dMs = b.frameMs - a.frameMs;
    if (dLoad > 0 && dMs > 0) return { ...base, unitsPerMs: dLoad / dMs, bound: 'measured' };
    return { ...base, unitsPerMs: 0, bound: 'none' };
  }

  if ((s.status === 'ceiling' || s.status === 'budget') && peakLoad > 0) {
    // Never escaped, for either reason — it hit the ceiling load, or it ran out of frames. Both
    // say the same thing: it rendered `peakLoad` in the last frame time and never ran long, so
    // that ratio is a FLOOR on its throughput and nothing here can say how far above it sits.
    //
    // Against the LAST FRAME TIME, not against the display interval: a ramp can exhaust its
    // budget while running at 2x the interval (over-loaded but not yet past the escape
    // threshold), and dividing by the interval there would claim twice the throughput actually
    // demonstrated. Dividing by the frame that really rendered it is true in both regimes.
    // ⚠️ **THE SLOWER OF THE LAST TWO FRAMES — because an anomalously FAST final frame makes a
    // lower bound OVERSTATE, and overstating is the one direction that costs a GPU context.**
    // `peakLoad / lastMs` trusts a single frame, and a fluke there is unbounded: measured on a
    // fabricated-but-reachable ceiling ramp of `[20, 20, 20, 20, 20, 20, 20, 5]` ms it reports
    // 819.2 calls/ms against a representative 204.8 — 4x high, and high enough to clear the
    // `capable` floor on a device that cannot sustain it. iOS makes it likelier, not less: it
    // quantizes `performance.now()` to 1 ms, so a genuinely cheap final step reads 1.
    //
    // `Math.max` is strictly conservative and a NO-OP in the normal case: load grows monotonically,
    // so the last step is normally also the slowest and the max picks it. It only bites when the
    // final frame is faster than the one before it — which is precisely the case where it is not
    // representative of the load it claims to have rendered. Note the spike trim above is the
    // mirror of this and cannot serve here: that one rejects a too-SLOW step, which for a lower
    // bound is the safe direction anyway.
    const tail = s.steps.slice(-2);
    const lastMs = Math.max(...tail.map((step) => step.frameMs));
    if (lastMs > 0) return { ...base, unitsPerMs: peakLoad / lastMs, bound: 'lower' };
  }

  return { ...base, unitsPerMs: 0, bound: 'none' };
}

// ── Classification ─────────────────────────────────────────────────────────────────────────

/** What the probe concluded about the DEVICE. Deliberately not a tier: the probe classifies
 *  hardware, and `resolveTier` owns what a class means for a project. */
export type DeviceClass = 'weak' | 'middle' | 'capable' | 'unknown';

/** Which clock produced the step times in a measurement.
 *
 *  ⚠️ **A NUMBER FROM A FENCE AND A NUMBER FROM A QUEUE PROMISE ARE NOT THE SAME MEASUREMENT, and
 *  until this reached the log two devices were being compared across two instruments without
 *  anybody knowing which.** `makeGpuClock` has always reported its `kind` and the runner has always
 *  `mark()`ed it — but a mark is only retained as `lastStage`, which the next mark overwrites, so
 *  by the time the verdict printed the clock's identity was three stages gone. The S22 (WebGPU
 *  `onSubmittedWorkDone`) and the A23 (WebGL2 `fenceSync`) have different delivery latencies and
 *  different noise floors; a cross-device comparison that does not say which is which is not a
 *  comparison. */
export type ProbeClockKind = 'webgpu' | 'webgl2' | 'raf';

export interface ProbeMeasurement {
  intervalMs: number;
  /** What timed the steps — see {@link ProbeClockKind}. Report it beside every number it produced. */
  clockKind: ProbeClockKind;
  /** Which GPU axis this run measured — see `runBootRampProbe`'s `only2D`.
   *
   *  ⚠️ **EXPLICIT, not inferred from which reading is present.** "`shade` is undefined, so it must
   *  have been a 2D probe" is true today and silently wrong the first time a 3D probe's heavy
   *  program fails to compile — which is a supported, tested degrade path. The classifier would
   *  then judge a 3D device against 2D thresholds and say nothing about it. */
  axes: '2d' | '3d';
  /** The full-viewport overdraw ramp. Present on a 2D probe, where it is the DECIDING GPU axis:
   *  a 2D project's only tier-controlled GPU knob is `pixiPixelRatioCap`, which is fill-rate bound.
   *  Absent on a 3D probe, which spends its GPU budget on `shade` instead. */
  fill?: RampReading;
  /** The heavy-shader ramp, when the probe could build and compile its material.
   *
   *  Optional because a backend that refuses the material must still yield the fill
   *  measurement rather than nothing — and because it is EVIDENCE ONLY today: it is logged and
   *  reported, and no threshold reads it. It moves into {@link ProbeReading} (and bumps
   *  `CLASSIFIER_VERSION`, which is module-local and so not linkable here) if and only if a
   *  campaign shows it discriminates. */
  shade?: RampReading;
  /** The main-thread CPU ramp. Always available — it needs no GPU — but optional for the same
   *  evidence-only reason as {@link ProbeMeasurement.shade}. */
  cpu?: RampReading;
  /** The DISCARDED cpu passes, oldest first — reported, never classified.
   *
   *  ⚠️ **They are here because the pass-to-pass PROGRESSION is the DVFS signal, and this axis is
   *  the one still under investigation.** The GPU ramps discard their warm-up pass and drop it on
   *  the floor; the cpu ramp keeps its readings so a device's governor behaviour can be read off
   *  its ordinary boot log rather than needing a diagnostic build to ask the question again. The
   *  three phones this was derived on disagree about it sharply, and boot disagrees with in-game
   *  on the same phone (see `runCpuRamp`'s header) — so it is not a settled constant of the
   *  hardware, and printing it is how that stays visible.
   *
   *  A LIST rather than one reading because the count is a tuning knob (`CPU_WARMUP_RAMPS`) that
   *  has already moved once: with a single field, raising it would have silently reported one
   *  arbitrary pass out of several and hidden whether the later ones were still climbing.
   *
   *  ⛔ Nothing may classify on them. `readingOf` takes `cpu`, every threshold reads `cpu`, and a
   *  warm-up reading folded into either would put back exactly the cold-governor number the
   *  discards exist to remove. */
  cpuWarmups?: readonly RampReading[];
  /** Total wall-clock spent, including renderer creation, the shader compile and warm-up. This
   *  is the number that matters to a player, because the probe BLOCKS THE LAUNCH. */
  totalMs: number;
  /** Creating the throwaway probe renderer. Broken out because it is the part that could be
   *  reclaimed by probing on the real renderer instead (see the runner's header). */
  rendererMs: number;
  /** The blocking shader compile. Broken out because it is the cost that the plan's original
   *  "no new shader program" constraint was protecting against, and the whole justification for
   *  overriding that constraint is a claim about how small this is on a trivial unlit material.
   *  A claim that is reported on every probe is a claim that cannot quietly turn out false. */
  compileMs: number;
  /** The SECOND blocking compile — the heavy shader's, reported apart from the trivial material's
   *  for exactly the reason above, doubled. The original design banned a new shader program
   *  outright at ~1.2 s per program on a Huawei Y6; the heavy ramp overrides that ban a second
   *  time, and the override is only defensible while this number stays small. It is the first
   *  thing to read if a shade-ramp build costs more launch than it is worth. 0 when the heavy
   *  material was not built. */
  shadeCompileMs: number;
  /** Pixels in the drawing buffer the ramps ran against. REQUIRED to read `fill` at all — see
   *  {@link fillMegapixelsPerMs}. */
  bufferPixels: number;
  /** Pixels in the FIXED region the shade ramp shaded — normally 100x100, less only on a buffer
   *  too small to host it. Recorded rather than assumed: the clamp is rare and silent, and a
   *  reading whose unit quietly changed is worse than no reading. 0 when the ramp did not run. */
  shadeRegionPixels: number;
}

/** Fill throughput in MEGAPIXELS per millisecond.
 *
 *  ⚠️ **`fill.unitsPerMs` IS NOT COMPARABLE BETWEEN DEVICES AND MUST NOT BE USED DIRECTLY.** Its
 *  unit is full-viewport quads per millisecond, and a "viewport" is a different number of pixels
 *  on every device — an iPad Pro's is roughly 7x an iPhone 8's. Comparing them raw would have
 *  scored the phone as the faster fill device for the sole reason that its screen is smaller,
 *  which is the exact opposite of the truth and would have set the thresholds backwards.
 *
 *  Multiplying by the buffer size converts "screens per ms" into "pixels per ms", which is a
 *  property of the GPU rather than of the panel. It also makes the probe's own buffer size a free
 *  choice, which is what lets the runner clamp it for safety without losing comparability.
 *
 *  The DRAW ramp needs no such treatment: draw calls per millisecond is already resolution-free. */
export function fillMegapixelsPerMs(m: ProbeMeasurement): number {
  if (!m.bufferPixels || !m.fill || m.fill.bound === 'none') return 0;
  return (m.fill.unitsPerMs * m.bufferPixels) / 1_000_000;
}

/** Heavy-shader throughput in MILLIONS OF SHADED FRAGMENTS per millisecond.
 *
 *  The same treatment {@link fillMegapixelsPerMs} gives fill, and for the same reason: the ramp's
 *  raw unit is "instances per ms" and an instance covers `shadeRegionPixels` fragments. The
 *  difference is that this normalisation is almost always by the SAME constant (the region is fixed
 *  at 100x100 by design, where a viewport is whatever the panel is), so it exists to survive the one
 *  case that would otherwise change the unit silently — a buffer too small to host the region.
 *
 *  Note the fragment count is per TAP-CHAIN, not per texture read: each fragment runs `SHADE_TAPS`
 *  dependent samples, so this figure is proportional to, not equal to, sampler throughput. It is a
 *  device-comparable number, which is all a band boundary needs. */
export function shadeMegaFragmentsPerMs(m: ProbeMeasurement): number {
  if (!m.shade || !m.shadeRegionPixels || m.shade.bound === 'none') return 0;
  return (m.shade.unitsPerMs * m.shadeRegionPixels) / 1_000_000;
}

export interface ProbeVerdict {
  deviceClass: DeviceClass;
  /** One human-readable clause, surfaced through `diagnose` so a surprising class is
   *  explainable without an eval. */
  reason: string;
  /** ⭐ **Is the CPU AXIS what is holding this device out of the next band up?** True only when the
   *  reading fails the next band's cpu floor while CLEARING its GPU floor — i.e. the GPU has
   *  already demonstrated it belongs a band higher and only cpu says otherwise.
   *
   *  This exists because the boot cpu reading is a KNOWN UNDER-ESTIMATE (#205): measured on three
   *  Androids, a device reads 20-30% lower at boot than the same device sustains in game, because
   *  the probe runs while the launch boost is decaying and no amount of warming inside the probe
   *  closes the gap. The owner's decision was to accept that under-estimate rather than inflate
   *  the floors, and let live calibration promote — and `promotionCeiling` needs to know WHICH
   *  devices that licence applies to, because it does not apply to all of them.
   *
   *  ⚠️ **The narrowness is the whole argument.** `evaluateTierChange`'s `hasHeadroom` judges from
   *  `cpuMs` alone, and `promotionCeiling` documents at length why that must not overrule a GPU
   *  measurement — a Galaxy A23 can run the GPU at 84% of the frame while its CPU reads as idle,
   *  and no live signal on WebGL2 mobile can see it. That objection is about the SHADE axis, and
   *  it is untouched here: a device short on shade is not `cpuLimited` and its ceiling does not
   *  move. A cpu-limited device is the one case where the live signal measures the same quantity
   *  the probe under-read, so correcting it with that signal is sound rather than a loophole.
   *
   *  False at the top band (nothing above `capable` to be limited out of) and false for `unknown`
   *  (no reading, so no statement). */
  cpuLimited: boolean;
}

/** Facts that, if any of them changed, invalidate a cached verdict. */
export interface ProbeFingerprintInput {
  platform?: string;
  deviceModel?: string;
  gpuRenderer?: string;
  /** Drawing-buffer size the probe measured at — see the runner's header for why it matters. */
  viewportPx?: number;
}

/** A stable key for "the hardware this verdict describes".
 *
 *  A cache keyed only by "this device" is wrong the moment the value outlives the thing it
 *  described: a GPU DRIVER UPDATE can move throughput materially without changing the phone, and
 *  a restored backup can carry a verdict onto different hardware entirely. The renderer string
 *  moves with the driver, so it belongs in the key even though it is useless as a tier signal on
 *  its own (that ambiguity is why Android needs a probe at all).
 *
 *  Viewport is rounded to a coarse bucket, not stored exactly: a device rotated between launches,
 *  or a browser window nudged by a few pixels, has not become different hardware, and keying on
 *  the exact number would silently re-run a launch-blocking probe every time. */
export function probeFingerprint(input: ProbeFingerprintInput): string {
  const bucket = input.viewportPx ? Math.round(Math.sqrt(input.viewportPx) / 100) : 0;
  return [
    `v${CLASSIFIER_VERSION}`,
    input.platform ?? '', input.deviceModel ?? '', input.gpuRenderer ?? '', bucket,
  ].join('|');
}

/** Bump this whenever {@link PROBE_THRESHOLDS} or {@link classifyDevice} changes what a given
 *  measurement means.
 *
 *  ⚠️ WITHOUT IT THE CACHE OUTLIVES THE RULE THAT PRODUCED IT. The fingerprint answers "is this
 *  the same hardware", and it was complete for that question — but a cached verdict is not a
 *  measurement, it is a CONCLUSION, and re-drawing the band boundaries silently changes which
 *  conclusion the same phone deserves while leaving every already-launched device pinned to the
 *  old one. That is the exact shape of the bug this workstream keeps producing: a corrected rule
 *  that cannot reach the devices it was corrected for.
 *
 *  ⚠️ **A CHANGE TO WHAT THE RAMPS MEASURE COUNTS TOO, and version 3 is one.** The fingerprint asks
 *  "is this the same hardware" and the version asks "does the same reading still mean the same
 *  thing" — and that second question is not only about where the boundaries sit. When the fill ramp
 *  went additive it stopped measuring rasterization and started measuring fill (see
 *  `rampProbeRunner`'s `makeProbeAssets`), so a v2 sample and a v3 sample are readings of DIFFERENT
 *  QUANTITIES that happen to share a unit. Medianing them together would be the worst of both.
 *
 *  1 = the two-band (weak/capable) classifier, thresholds unset — so it never cached anything in
 *  production. 2 = the three-band classifier of #188. 3 = blended ramps, so overdraw is no longer
 *  removed by tile-based hidden-surface removal before it can be measured. 4 = the shade axis
 *  joined cpu in deciding.
 *
 *  **5 = the ramps moved off Three onto a raw WebGL2 context** (#203, `rampWorkloadGL.ts`), and
 *  this is the clearest case the rule has ever had: the same ramp, the same unit, a different
 *  instrument. Every v4 sample was taken through `WebGPURenderer` — a different API, a different
 *  compiler, a different submit path — so medianing one against a v5 sample would combine two
 *  measurements of the same quantity taken with two rulers. v5 also introduces the 2D probe shape,
 *  whose deciding axis is `fill` rather than `shade`.
 *
 *  **6 = the GPU ramps discard a warm-up PASS**, so a flagship is measured after its governor has
 *  clocked up rather than at idle. Measured: a Galaxy S22 reads 7.5 on pass 1 and 19.9 on pass 2,
 *  where a Galaxy A23 moves only 12.1 -> 15.6. Every v5 sample was taken at whatever clock the
 *  device happened to be at, and the error is largest on the fastest hardware — so medianing one
 *  against a v6 sample would mix two populations, not two readings.
 *
 *  **7 = the CPU ramp discards a warm-up pass too**, for the same governor reason v6 gave the GPU
 *  ramps. v6 left the cpu axis measuring whatever clock the CPU happened to be at, and the
 *  boot-vs-in-game A/B (#205, `runCpuRamp`'s header) showed that is not a small error: a Galaxy
 *  A23's cpu reading at boot is 2x what the same device reads while the game runs. Every v6 cpu
 *  sample is a cold-governor reading; medianing one against a v7 sample mixes the population this
 *  discard exists to leave behind.
 *
 *  **8 = A BURNED NUMBER, and it is deliberately not reused.** It was minted for a SECOND
 *  discarded cpu pass (`CPU_WARMUP_RAMPS` 1 -> 2), which was built, installed on three phones,
 *  measured, and **reverted** — it nearly doubled a Galaxy S22's boot spread (see
 *  `CPU_WARMUP_RAMPS`). The shipped instrument is therefore identical to v7's, and the honest
 *  thing would arguably be to go back to 7. It stays at 8 because builds carrying the two-discard
 *  instrument really did run on hardware and really did write samples, and a version number that
 *  goes backwards would let those samples median against readings they are not comparable to. A
 *  burned integer costs nothing; a mixed population costs a wrong band.
 *
 *  **9 = the fill ramp's ceiling rose 1024 -> 8192** (#221). This is not a boundary move, it is the
 *  same "different quantity, same unit" case as v3: a v8 fill sample from an iPhone Air or a Galaxy
 *  S22 is `ceiling/lower` — a LOWER BOUND on a device that never reached the escape bar — while a
 *  v9 sample from the same phone is an escaped measurement. Medianing a bound against a measurement
 *  understates the device by however much the old ceiling clipped, which on those two phones is
 *  exactly the error this change exists to remove. Weak hardware escapes long before either
 *  ceiling and is unaffected — but the version cannot be conditional on the device. */
const CLASSIFIER_VERSION = 9;

/** One band's floor: the throughput a device must clear on BOTH ramps to be called this.
 *
 *  ⚠️ **THESE ARE cpu AND shade, NOT fill AND draw — swapped 2026-08-11 after measuring seven
 *  devices, and the two it replaced were both broken.**
 *
 *    - `fill` never measured fill. It stacks coplanar OPAQUE quads, and a tile-based GPU resolves
 *      which fragment survives BEFORE shading, so 2047 of every 2048 invocations never happened;
 *      what it ranked was rasterization. Even blended, the Huawei Y6 spans 0.00-0.83 — a 40x range
 *      on one phone.
 *    - `draw` produced NO usable reading on the two weakest devices (Y6 0/6, iPhone 7 0/3), and its
 *      step tables there are noise: `32:6 64:40 128:11 256:11 512:45 1024:10 2048:7`. It failed on
 *      exactly the hardware the tier system exists for.
 *
 *  The replacements measure the axes the tiers actually gate (`TIER_SETTINGS` turns off IBL lookups,
 *  NPR post-FX and shadow sampling — texture-sampling and ALU) plus the main-thread cost that this
 *  plan's own strongest finding says decided forest-camp. */
export interface ProbeThreshold {
  /** Transform propagations per ms — main-thread CPU. Resolution-free by construction, and the one
   *  axis BOTH probe shapes share: a 2D game propagates transforms exactly as a 3D one does. */
  cpuUnitsPerMs: number;
  /** MILLIONS of heavy shaded fragments per ms, never the ramp's raw instances/ms — see
   *  {@link shadeMegaFragmentsPerMs} for why the raw figure is not comparable across devices.
   *  The GPU floor of a **3D** threshold. */
  shadeMfragPerMs?: number;
  /** MEGAPIXELS of overdraw per ms — {@link fillMegapixelsPerMs}. The GPU floor of a **2D**
   *  threshold, where the tier's only GPU knob (`pixiPixelRatioCap`) is fill-rate bound. */
  fillMpxPerMs?: number;
}

/** Which GPU axis a probe ran, and therefore which threshold table judges it. See
 *  {@link ProbeMeasurement.axes} for why this is carried explicitly rather than inferred. */
export type ProbeAxes = '2d' | '3d';

/** The two band boundaries, MEASURED on SEVEN DEVICES across two platforms (#188, 2026-08-11).
 *
 *  ⚠️ **THIS SHIPPED NULL FOR A REASON, AND THE REASON WAS NOT LAZINESS.** A threshold invented
 *  before the hardware was measured is exactly what ossifies, and this plan had already shipped one
 *  tier table whose two signals both turned out to be dead. So the probe MEASURED from the day it
 *  landed and CLASSIFIED nothing. What filled these in is real hardware, natively, three launches
 *  each, with the app's stored verdict wiped before EVERY launch so no reading is a refinement of
 *  another:
 *
 *      Huawei Y6 2019   webgl2    2.0k xform/ms   0.02 Mfrag/ms  ->  weak
 *      iPhone 7 (A10)   webgl2    5.5             0.03           ->  weak
 *      Galaxy A23 5G    webgpu    9.9             0.13           ->  middle
 *      iPhone 8 (A11)   webgl2   10.9             0.20           ->  middle
 *      Galaxy S22       webgpu   21.3             0.21           ->  capable
 *      iPhone Air       webgpu   37.4             0.20           ->  capable
 *
 *  (An iPad mini 5 measured cpu 7.9k and is deliberately absent from the derivation: its shade ramp
 *  sits on a ~27 ms fixed floor — the largest buffer here, on the fence path — so it yields one or
 *  two real points and no trustworthy slope. See the plan.)
 *
 *  Medians of `escaped`/`measured` readings only. A `budget`/`ceiling` row is a LOWER BOUND, not a
 *  measurement, and mixing the two is how this workstream twice talked itself into a wrong answer.
 *
 *  ── THE TWO AXES ARE COMPLEMENTARY, AND EACH COVERS THE OTHER'S BLIND SPOT ────────────────
 *  `cpu` is monotone over the whole range and separates every device. `shade` separates the BOTTOM
 *  decisively — 0.02/0.03 against the A23's 0.13, a 4-6x gap — and then SATURATES at the top, where
 *  the iPhone 8, S22 and iPhone Air all read 0.20-0.21 across several times the real performance.
 *  So shade decides `weak`, cpu decides `capable`, and requiring BOTH is what makes the pair work.
 *
 *  ⭐ The case that proves it is the iPhone 7: it CLEARS the middle cpu floor (5.5k against 4500)
 *  and FAILS the middle shade floor (0.03 against 0.06), so `clears()` demanding both is the only
 *  reason a 2016 phone is not called `middle`. A cpu-only classifier gets it wrong.
 *
 *  ── WHERE THE NUMBERS SIT ─────────────────────────────────────────────────────────────────
 *  Each boundary is the GEOMETRIC MEAN of the gap it splits, so it sits in the middle rather than
 *  snug against the nearest device. On cpu the gaps are 1.8x and 2.0x either side; on shade, 2.0x
 *  and 1.3x. Margin matters more than it looks: the per-launch spread is far wider than the
 *  per-device spread — the A23's shade alone has read 0.055 to 0.16 — so a boundary is being asked
 *  to separate MEDIANS, not readings. That is why every device pays the full
 *  {@link PROBE_SAMPLE_TARGET} launches and none settles early; see the note above that constant.
 *
 *  Fill these in from measurements, never from a datasheet. */
export const PROBE_THRESHOLDS: {
  middle: ProbeThreshold | null;
  capable: ProbeThreshold | null;
} = {
  /** Between the iPhone 7 (5.5k / 0.03) and the A23 (9.9k / 0.13). The SHADE floor is what does the
   *  work here — it is what keeps the iPhone 7 out of `middle`, since that phone clears the cpu
   *  floor comfortably.
   *
   *  ⭐ **THE CPU FLOOR MOVED 4,500 -> 2,500 WHEN THE PROBE STOPPED MEASURING IDLE CLOCKS**
   *  (2026-08-13, v6 — see `CLASSIFIER_VERSION`). Re-measured on the shipped warm-up path,
   *  `games/sling`, three wiped launches per device:
   *
   *      Huawei Y6    cpu 1.8/2.0/1.9 -> 1.9k    shade 0.04/0.05/0.03 -> 0.04
   *      Galaxy A23   cpu 3.0/8.2/3.5 -> 3.5k    shade 0.14/0.18/0.09 -> 0.14
   *      Galaxy S22   cpu 21.5/15.2/17.0 -> 17.0k shade 0.19/0.18/0.09 -> 0.18
   *
   *  ⭐ **0.04 < 0.14 < 0.18 — the shade axis is MONOTONE for the first time**, and the S22 clears
   *  the capable floor. This file said twice that `capable` was unreachable on Android; it was a
   *  governor artifact, not a boundary problem, and the discarded warm-up pass removed it.
   *
   *  The cpu floor had to move because the A23's cpu reads 3.0-8.2k on this instrument and 4,500
   *  vetoed it on two launches of three — a device with a clean shade reading of 0.14 being called
   *  `weak` by the axis that is NOT deciding. 2,500 separates every observed reading (Y6 max 2.0k,
   *  A23 min 3.0k) and sits between the two derivations: 2.45k from that min/max pair, 2.58k from
   *  the medians.
   *
   *  ⚠️ **ONLY THIS ONE NUMBER MOVED, deliberately.** Checked against all six devices the v4 table
   *  was derived from — Y6, iPhone 7, A23, iPhone 8, S22, iPhone Air — and every one still bands
   *  exactly as before. Three of those are iOS and have no v6 measurement (iOS answers from the
   *  model-id table and never reaches the probe), so a wider retune would have discarded recorded
   *  evidence to fit three Android phones. The `capable` row needs no change at all: the S22's new
   *  medians (17.0k / 0.18) clear it as they stand. */
  middle: { cpuUnitsPerMs: 2_500, shadeMfragPerMs: 0.06 },
  /** Between the iPhone 8 (10.9k / 0.20) and the S22 (21.3k / 0.21). Here it is the CPU floor that
   *  does the work: shade has saturated by this point and cannot tell these three apart. */
  capable: { cpuUnitsPerMs: 14_500, shadeMfragPerMs: 0.165 },
};

/** The 2D probe's band boundaries, **MEASURED ON THREE ANDROID DEVICES, 2026-08-13** (#203/#204).
 *
 *  They shipped `null` for one day, exactly as the 3D pair shipped null, because a threshold
 *  invented before the hardware is measured is what ossifies. This is the campaign that filled them
 *  in: `games/space-invader` (`render3d: false`, so the probe ran with no Three in the process at
 *  all — which is itself the proof `rampWorkloadGL` works), a debug build, `pm clear` before EVERY
 *  launch so no reading is a refinement of another, three launches per device.
 *
 *  ⭐ **RE-MEASURED 2026-08-13 ON v9 (#221), AND ONE NUMBER MOVED BY 3.4x.** The campaign below was
 *  taken with `RAMP_BOUNDS.fill.maxLoad` at 1024, which the S22 could not escape — so its 7.69 was
 *  a `ceiling/lower` BOUND, and the warning three paragraphs down said so and asked for exactly this
 *  re-measure. Same protocol, same project, same three phones, ceiling now 65536:
 *
 *      Huawei Y6 2019   PowerVR GE8300    fill 0.75 / 1.12 / 1.10  -> median 1.10   cpu 2.1k
 *      Galaxy A23       Mali-G57 MC2      fill 2.85 / 2.80 / 2.81  -> median 2.81   cpu 9.0k
 *      Galaxy S22       Adreno 730        fill 21.79 / 25.82 / 25.99 -> median 25.82 cpu 11.8k
 *      iPhone Air       Apple A19 Pro     fill 65.37 / 68.21 / 98.06 -> median 68.21 cpu 58.3k
 *
 *  ⭐ **THE iPHONE AIR IS THE FOURTH ANCHOR AND THE AXIS STAYS MONOTONE OVER 62x**: 1.10 / 2.81 /
 *  25.82 / 68.21. It too read `ceiling/lower` under the old bound (24.5, i.e. 2.8x under) and now
 *  escapes. It does NOT move a boundary — it clears `capable` by 8x — and that is the point of
 *  recording it: a threshold campaign needs a device that is unambiguously past the top floor, or
 *  the top floor is only ever pinned from below.
 *
 *  **All three now `escaped/measured`; not one is a bound.** The two weak devices barely moved
 *  (1.02 -> 1.10, 2.77 -> 2.81) — they escaped under the old ceiling too, so nothing about them
 *  changed — while the S22 went 7.69 -> 25.82. That asymmetry is the proof the old figure was the
 *  ceiling talking rather than the phone: a ramp bound cannot affect a device that never reaches it.
 *  ⭐ It also tightened the S22's own spread to 1.19x (from 1.05x on a pinned bound, which was
 *  precision about the ceiling, not about the GPU).
 *
 *  ⚠️ The ORIGINAL v5 campaign is kept below because the boundary derivation quoted it for a day
 *  and because it is the record of how the axis was found. Do not median a v5 fill sample against a
 *  v9 one — `CLASSIFIER_VERSION` exists to make that impossible.
 *
 *      Huawei Y6 2019   PowerVR GE8300    fill 1.43 / 1.02 / 0.66  -> median 1.02   cpu  2.0k
 *      Galaxy A23       Mali-G57 MC2      fill 2.97 / 1.93 / 2.77  -> median 2.77   cpu 10.1k
 *      Galaxy S22       Adreno 730        fill 7.88 / 7.69 / 7.47  -> median 7.69   cpu 13.9k  ⛔ BOUND
 *
 *  ⭐ **THE FILL AXIS SEPARATES ALL THREE, WHICH `shade` NEVER DID.** 1.10 / 2.81 / 25.82 is
 *  monotone with 2.6x and 9.2x between neighbours — and the top gap is 3.3x WIDER than the bounded
 *  campaign could see, which is the whole cost of a clipped ceiling. Compare the 3D pair, whose
 *  `shade` axis reads
 *  0.20/0.21/0.20 for an iPhone 8, an S22 and an iPhone Air and saturates from a 2017 phone upward.
 *  Measuring the axis the knob actually moves is what bought the separation: a 2D tier's only GPU
 *  knob is `pixiPixelRatioCap`, and fill rate is what it trades against.
 *
 *  ✅ **THE LOWER-BOUND WARNING THAT USED TO STAND HERE IS DISCHARGED (#221).** It read: the S22's
 *  fill exhausted `RAMP_BOUNDS.fill.maxLoad` without reaching the escape threshold, so 7.69 was a
 *  bound, 4.6 was "the LOWEST defensible capable floor rather than the centre of the real gap", and
 *  raising the ceiling until the S22 escapes would settle it. That was done, the S22 escapes, and
 *  the capable floor moved 4.6 -> 8.5 as a result. ⭐ **The lesson is about instruments, not about
 *  this axis:** a bound is safe to compare against in ONE direction (`clears()` handles it) and is
 *  useless for placing a boundary BETWEEN two devices, because a midpoint needs both ends. Nothing
 *  flagged this for a day except a `ceiling/lower` status in a log line nobody was reading.
 *
 *  ⚠️ **AND THE SAFETY ASYMMETRY IS WEAKER IN 2D THAN IN 3D, WHICH IS WHY A SLIGHTLY LOW CAPABLE
 *  FLOOR IS ACCEPTABLE HERE AND WOULD NOT BE THERE.** The 3D rule ("never guess upward") is
 *  written against a measured failure: booting `high` on weak hardware lights up IBL, shadows and
 *  post-FX, loses the GPU context, and blacks the screen for the process lifetime (#156). A 2D
 *  project has none of those — a wrong `high` costs fill rate at a higher DPR, which is the ~4x
 *  the Y6 measured (1x = 22ms/45fps, 2x = 69ms/14fps). Bad, and RECOVERABLE: live calibration now
 *  runs on 2D projects (`tierBoot.ts`), so an over-promoted device demotes itself within seconds.
 *  Before #203 it could not, and this floor would have had to be far more conservative.
 *
 *  ── WHY `cpu` DOES NOT DECIDE `capable` HERE, AND THE 3D TABLE'S ARGUMENT DOES NOT CARRY ──
 *  The 3D pair demands BOTH axes because each covers the other's blind spot. On this population
 *  the cpu axis **cannot separate mid from high at all**: the A23 ranges 9.5-12.8k and the S22
 *  12.0-13.9k, so their ranges OVERLAP, and the S22 also produced a 218.5k first-launch outlier
 *  (17x its other two readings). A capable floor on cpu would be decided by launch noise. So the
 *  capable row carries the SAME cpu floor as middle: cpu decides weak-versus-not, fill decides the
 *  rest, and that division is a measurement rather than a preference.
 *
 *  ⚠️ **A CORROBORATION THIS COMMENT ONCE CLAIMED HAS EXPIRED — do not lean on it.** It read: the
 *  geometric mean of the Y6 (2.0k) and the A23 (10.1k) is 4.49k, and the 3D table independently put
 *  its middle cpu floor at 4,500, so "two independent campaigns landing on the same boundary is the
 *  strongest evidence in this file that the cpu axis measures something real". The 3D floor moved
 *  to **2,500** on 2026-08-13 (v6, after the warm-up fix), so the two no longer agree — and the
 *  reason they diverged is the point: the A23's cpu reads 3.0-15.1k across sessions on the same
 *  project, a 5x spread. The agreement was a coincidence of which session each campaign sampled.
 *  **The cpu axis is the noisy one**; see the plan's § 1 for the boot-vs-quiet validation it needs.
 *
 *  ⚠️ Fill these in from measurements, never from a datasheet — and never from the 3D pair, which
 *  was taken through a `WebGPURenderer` (see `CLASSIFIER_VERSION`). */
export const PROBE_THRESHOLDS_2D: {
  middle: ProbeThreshold | null;
  capable: ProbeThreshold | null;
} = {
  /** Between the Y6 (1.10 Mpx/ms) and the A23 (2.81) — geometric mean 1.76.
   *
   *  ⚠️ **LEFT AT 1.68 ON THE v9 RE-MEASURE, deliberately.** The v5 pair (1.02 / 2.77) put the mean
   *  at 1.68 and the v9 pair puts it at 1.76 — a 5% move, well inside the launch-to-launch spread
   *  on this axis (the Y6 alone reads 0.75-1.12). Chasing that is fitting noise, and every re-fit
   *  costs the ability to say a threshold has been stable across two independent campaigns. Both
   *  devices escaped under BOTH ceilings, so there is no instrument change here to correct for —
   *  which is exactly why this row can be left alone while the `capable` row could not.
   *
   *  The cpu floor is the same 4,500 the 3D table derived independently; here it is the geometric
   *  mean of 2.0k and 10.1k, which is 4.49k. */
  middle: { cpuUnitsPerMs: 4_500, fillMpxPerMs: 1.68 },
  /** Between the A23 (2.81) and the S22 (25.82) — geometric mean 8.51, rounded to 8.5.
   *
   *  ⭐ **MOVED 4.6 -> 8.5 ON THE v9 RE-MEASURE (#221), and the old value was not wrong so much as
   *  bounded.** 4.6 was the geometric mean of 2.77 and a `ceiling/lower` 7.69 — a midpoint computed
   *  with one end pinned to the instrument's own ceiling. With the S22 escaping at 25.82 the real
   *  gap is 9.2x rather than 2.8x, and its centre is 8.5.
   *
   *  ⚠️ **The move is UPWARD, i.e. toward the conservative side, and that is worth stating because
   *  the direction was not chosen — it fell out.** Nothing measured sits between 4.6 and 8.5, so no
   *  device tested changes band; what changes is where a device we have never seen lands, and it
   *  now needs to look materially more like an S22 than like an A23 before it is called `capable`.
   *
   *  The cpu floor is deliberately NOT raised: those two devices' cpu ranges overlap, so it cannot
   *  decide this boundary and pretending otherwise would make the verdict depend on launch noise. */
  capable: { cpuUnitsPerMs: 4_500, fillMpxPerMs: 8.5 },
};

/** One device's throughput on both ramps, in the two COMPARABLE units — the only thing worth
 *  persisting between launches. Note it is not a `ProbeMeasurement`: totals, statuses and the
 *  buffer size describe the RUN, and it is the device we are trying to characterise. */
export interface ProbeReading {
  /** Transform propagations per ms. See {@link ProbeThreshold} for why this replaced `fill`. */
  cpuUnitsPerMs: number;
  /** Millions of heavy shaded fragments per ms — {@link shadeMegaFragmentsPerMs}, never the raw
   *  instances/ms, which is not comparable across devices. Zero on a 2D probe, which does not run
   *  the shade ramp. */
  shadeMfragPerMs: number;
  /** Megapixels of overdraw per ms — {@link fillMegapixelsPerMs}, never the raw screens/ms, which
   *  is a different number on every panel. The DECIDING GPU axis on a 2D probe; zero on a 3D one,
   *  which does not run the fill ramp. */
  fillMpxPerMs: number;
  /** ⚠️ **`measured` WAS HERE AND IS GONE (2026-08-11) — removed WITH the one-pass settle, and
   *  only safe to remove because of it.**
   *
   *  It existed for one job: a floor (`bound: 'lower'`) supports "this device is at least X", so
   *  placing it ABOVE a boundary is sound while placing it BELOW one is not — and without that
   *  asymmetry the rule was inverted against risk, since the LOWER a reading was, the more likely
   *  it froze the verdict for the life of the device. That danger lived entirely in settling from a
   *  SINGLE pass, which no longer happens.
   *
   *  Against a median of three, a floor is merely conservative: it understates the device, so it
   *  pulls the median DOWN, and down is the safe direction (a beat of uglier rendering, against a
   *  lost GPU context the other way). Whether a ramp escaped is still reported per launch in the
   *  boot log (`escaped/measured` vs `ceiling/lower`), which is where a human reads it.
   *
   *  ⚠️ If a one-pass shortcut is ever reinstated, this field has to come back with it. */
}

export function readingOf(m: ProbeMeasurement): ProbeReading {
  return {
    cpuUnitsPerMs: m.cpu?.unitsPerMs ?? 0,
    shadeMfragPerMs: shadeMegaFragmentsPerMs(m),
    fillMpxPerMs: fillMegapixelsPerMs(m),
  };
}

/** Does a measurement clear a band's floor? BOTH ramps must, because they measure different
 *  bottlenecks and a device that is fill-strong and submit-weak is not capable — it is
 *  forest-camp's failure mode wearing a good fill number. A `'lower'` bound counts as clearing:
 *  "at least X, and X clears" is a sound argument even though the true figure is unknown. */
function clears(r: ProbeReading, t: ProbeThreshold, axes: ProbeAxes): boolean {
  if (r.cpuUnitsPerMs < t.cpuUnitsPerMs) return false;
  // ⚠️ **FAILS CLOSED ON A MISSING GPU FLOOR, and it used to fail OPEN while a comment here claimed
  // the type prevented the case.** It does not: both GPU fields are optional on `ProbeThreshold`
  // (they must be — a 2D threshold carries `fillMpxPerMs` and a 3D one `shadeMfragPerMs`, so
  // neither can be required), so `{ cpuUnitsPerMs: 4_500 }` type-checks perfectly. With the old
  // `?? 0`, such a row turned the GPU comparison into "any non-negative reading clears" and
  // collapsed the band decision to CPU ALONE — which is precisely the classifier this file's own
  // derivation proves wrong (the iPhone 7 clears the middle cpu floor and fails the middle shade
  // floor; a cpu-only classifier calls a 2016 phone `middle`).
  //
  // `undefined` now means NOTHING clears, so a table edited to drop its axis's floor reports every
  // device as `weak` — loudly wrong and safe, rather than quietly permissive and unsafe. A guard
  // test asserts both shipped tables carry the floor their axis reads, so the loud case cannot
  // reach a device either.
  const floor = axes === '2d' ? t.fillMpxPerMs : t.shadeMfragPerMs;
  if (floor === undefined) return false;
  return (axes === '2d' ? r.fillMpxPerMs : r.shadeMfragPerMs) >= floor;
}

/** Band a single reading falls in. Split out from {@link classifyDevice} so a MEDIAN of several
 *  launches' readings can be classified by exactly the same rule as one launch's — the alternative
 *  being a second copy of the boundary comparisons, which would drift. */
export function classifyReading(r: ProbeReading, axes: ProbeAxes = '3d'): ProbeVerdict {
  const { middle, capable } = axes === '2d' ? PROBE_THRESHOLDS_2D : PROBE_THRESHOLDS;
  if (middle === null || capable === null) {
    return {
      deviceClass: 'unknown',
      cpuLimited: false,
      reason: `${axes} probe thresholds are unset — measure real hardware before classifying`,
    };
  }
  /** Does this reading miss `t` on cpu ALONE — GPU cleared, cpu short? See `ProbeVerdict.cpuLimited`. */
  const cpuOnlyShortOf = (t: ProbeThreshold): boolean => {
    if (r.cpuUnitsPerMs >= t.cpuUnitsPerMs) return false;
    const floor = axes === '2d' ? t.fillMpxPerMs : t.shadeMfragPerMs;
    // Fails CLOSED on a missing floor, for the same reason `clears` does: an absent GPU floor means
    // "nothing clears", so it cannot be read as "the GPU cleared and only cpu is short".
    if (floor === undefined) return false;
    return (axes === '2d' ? r.fillMpxPerMs : r.shadeMfragPerMs) >= floor;
  };
  const detail = `cpu ${(r.cpuUnitsPerMs / 1000).toFixed(1)}k xform/ms, `
    + (axes === '2d'
      ? `fill ${r.fillMpxPerMs.toFixed(3)}Mpx/ms`
      : `shade ${r.shadeMfragPerMs.toFixed(3)}Mfrag/ms`);
  if (clears(r, capable, axes)) {
    // Top band — there is no band above to be held out of, so `cpuLimited` is false by definition
    // rather than by measurement.
    return { deviceClass: 'capable', cpuLimited: false, reason: `${detail} — clears the capable floor on both ramps` };
  }
  if (clears(r, middle, axes)) {
    return {
      deviceClass: 'middle',
      cpuLimited: cpuOnlyShortOf(capable),
      reason: `${detail} — clears the middle floor on both ramps`,
    };
  }
  // Name the ramp that fell short, not just the verdict: "weak on draw" and "weak on fill" are
  // different hardware and lead to different authoring advice, and this string is what `diagnose`
  // and the boot log show.
  const cpuShort = r.cpuUnitsPerMs < middle.cpuUnitsPerMs;
  const gpuName = axes === '2d' ? 'the fill ramp' : 'the shade ramp';
  const gpuShort = axes === '2d'
    ? r.fillMpxPerMs < (middle.fillMpxPerMs ?? 0)
    : r.shadeMfragPerMs < (middle.shadeMfragPerMs ?? 0);
  const short = cpuShort && gpuShort ? 'both ramps' : cpuShort ? 'the cpu ramp' : gpuName;
  return {
    deviceClass: 'weak',
    cpuLimited: cpuOnlyShortOf(middle),
    reason: `${detail} — under the middle floor on ${short}`,
  };
}

/** Classify a completed measurement into one of the three measured bands. Pure.
 *
 *  Tested downward from the top: a device is `capable` if it clears that floor, else `middle` if
 *  it clears that one, else `weak`. Note what this does with a MIXED device — fill in the capable
 *  band, draw in the middle band — it reports `middle`, because clearing requires both ramps. That
 *  is the same rule the two-tier version had, and it is deliberately pessimistic: the weaker of a
 *  device's two bottlenecks is the one a frame actually hits. */
export function classifyDevice(m: ProbeMeasurement): ProbeVerdict {
  // ⚠️ THE RAMP FAILURE IS REPORTED BEFORE "thresholds unset", and both orders yield `'unknown'`
  // so only the REASON differs — which is the part a human reads out of `diagnose` or the boot
  // log. This order is deliberate: "the fill ramp produced no reading" is a fact about THIS
  // device's measurement and is actionable on the spot, while unset thresholds is a fact about
  // the build and identical on every device. (The order was the other way before the split into
  // `classifyReading`; the case needs BOTH conditions at once and is unreachable while the
  // thresholds ship non-null, but a silent swap is exactly what a close-out is for.)
  // ⚠️ THE GUARD IS ON cpu AND shade, the two ramps that now DECIDE. `fill` and `draw` are still
  // measured and still logged, and a failure in either must NOT refuse a verdict any more — they
  // fail routinely on exactly the weak hardware this exists for (draw: Y6 0/6, iPhone 7 0/3), and
  // letting them veto is what left those two phones with no verdict at all.
  // `'absent'` rather than a real `RampStatus`: a ramp that never ran did not exhaust a frame
  // budget, and saying `budget` there is a claim about something that did not happen — the exact
  // sort of quietly-false detail this module refuses to print elsewhere.
  // ⚠️ WHICH GPU RAMP DECIDES DEPENDS ON THE PROBE SHAPE (#203). A 2D probe never runs `shade`, so
  // demanding it here would refuse every 2D device a verdict while its own deciding axis sat
  // measured and ignored — the "mechanism that cannot fire" shape, in the one function whose job is
  // to reach a conclusion.
  const gpu = m.axes === '2d'
    ? m.fill ?? { kind: 'fill' as const, status: 'absent' }
    : m.shade ?? { kind: 'shade' as const, status: 'absent' };
  const undecidable = !m.cpu || m.cpu.bound === 'none' ? m.cpu ?? { kind: 'cpu' as const, status: 'absent' }
    : !('bound' in gpu) || gpu.bound === 'none' ? gpu
      : null;
  if (undecidable) {
    return {
      deviceClass: 'unknown',
      // No reading, so no statement about which axis is binding — see `ProbeVerdict.cpuLimited`.
      cpuLimited: false,
      reason: `${undecidable.kind} ramp produced no usable reading (${undecidable.status})`,
    };
  }
  // Shade compared in MEGA-FRAGMENTS/ms, not the ramp's raw instances/ms — see
  // shadeMegaFragmentsPerMs.
  return classifyReading(readingOf(m), m.axes);
}

// ── Refining a verdict ACROSS LAUNCHES (owner decision, 2026-08-09) ────────────────────────

/** How many readings a verdict is built from before it is frozen.
 *
 *  ⚠️ **ONE READING IS NOT ENOUGH, and that is measured, not assumed.** Five passes on each of
 *  three attached devices: the Y6 read `weak` x4 and `middle` x1, the A23 `middle` x4 and `weak`
 *  x1, the S22 `capable` x4 and `middle` x1. Every device produced one WRONG band in five, and the
 *  boot probe took one pass and cached it for the life of the device.
 *
 *  The reason the original design missed this: "the bands are 10x and 2.5x apart, well outside the
 *  estimator's ~3x resolution" compared band MEDIANS to a per-reading error bar. What one pass is
 *  exposed to is the WITHIN-device spread, and that measured 2.3-4.5x — the size of the gaps it
 *  has to resolve.
 *
 *  **THREE, because three is where it stops mattering**, checked exhaustively against those runs:
 *  every one of the 10 possible 3-subsets per device gives the right band (30/30). Two does not —
 *  a median of two is their mean, and the S22 fails 3 of 10. Five buys nothing three did not.
 *
 *  ⚠️ The Y6's bad draw is the one that matters, and it is why the direction of a mistake is not
 *  symmetric: it cleared the middle floor by 6% (1.596 against 1.5, 6.7 against 5), and a Y6 on
 *  `mid` gets IBL — the measured +26 ms of a ~53 ms frame that put it at 18 fps. */
export const PROBE_SAMPLE_TARGET = 3;

/** ⚠️ **ONE PASS CAN NO LONGER SETTLE A VERDICT — `PROBE_CLEAR_MARGIN` and `isClearOfBoundaries`
 *  were REMOVED (2026-08-11), because the measurement they rested on turned out to be false.**
 *
 *  The rule was: if a single reading sits 1.5x clear of every boundary, another launch cannot move
 *  it, so stop paying for one. That is sound if and only if the per-launch spread is smaller than
 *  the margin. It is not. Pooled across a day of native campaigns:
 *
 *      Galaxy A23  shade  0.055 0.10 0.11 0.12 0.13 0.16 0.16     (2.9x spread)
 *      iPhone 7    shade  0.03  0.03 0.07                          (2.3x spread)
 *
 *  **Those two distributions OVERLAP** — the A23's worst reading is below the iPhone 7's best — so
 *  no single reading can separate a mid-band phone from a weak one, at any margin. Their MEDIANS
 *  separate cleanly (0.12 against 0.03), which is exactly what {@link PROBE_SAMPLE_TARGET} is for.
 *
 *  What the old rule risked was not a slow launch but a permanent one: an unlucky pass 1.5x clear
 *  BELOW a boundary settled the device, wrote `final: true`, and was never re-measured. The A23 has
 *  produced such a pass (0.055, under the 0.06 `middle` floor) on real hardware.
 *
 *  The cost of removing it is two extra probe launches on a device that would have settled early —
 *  including the slowest hardware, where a probe costs most. That is the trade, taken deliberately:
 *  a launch is recoverable, a cached wrong verdict is for the life of the device. Do not reinstate
 *  a one-pass shortcut without first showing the per-launch spread is inside the margin. */

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The state a device's verdict is in between launches. */
export interface ProbeRefinement {
  samples: readonly ProbeReading[];
  deviceClass: DeviceClass;
  reason: string;
  /** See {@link ProbeVerdict.cpuLimited} — carried through so `resolveTier` can hand it to
   *  `promotionCeiling`. Taken from the MEDIAN verdict, not from the newest launch, for the same
   *  reason `deviceClass` is: one launch's reading is not what this device is. */
  cpuLimited: boolean;
  /** Settled — do not probe this device again. */
  final: boolean;
}

/** Classify the median of several launches' readings. **The one place that median is computed**,
 *  so the live refinement path and the cached-verdict path cannot drift into two definitions of
 *  what a device measured — which they would, because the cache stores `samples` and not the
 *  verdict's derived fields (`cpuLimited` was the first such field and immediately needed here). */
export function classifyMedianOf(samples: readonly ProbeReading[], axes: ProbeAxes): ProbeVerdict {
  if (samples.length === 0) {
    return { deviceClass: 'unknown', cpuLimited: false, reason: 'no reading to classify' };
  }
  return classifyReading({
    cpuUnitsPerMs: median(samples.map((s) => s.cpuUnitsPerMs)),
    // Both axes are medianed whichever shape is in play. Only one of them is read by
    // `classifyReading`, but a persisted sample that carried a real number on one launch and a
    // hole on the next would be a worse thing to debug than a field nobody consulted.
    shadeMfragPerMs: median(samples.map((s) => s.shadeMfragPerMs ?? 0)),
    fillMpxPerMs: median(samples.map((s) => s.fillMpxPerMs ?? 0)),
  }, axes);
}

/** Fold one launch's reading into what earlier launches measured, and say whether to stop.
 *
 *  ── WHY THE RUNNING ANSWER IS THE MINIMUM, NOT THE MEDIAN ─────────────────────────────────
 *  While still sampling, the band reported is the LOWEST any sample has produced; only the final,
 *  frozen verdict is the median. That asymmetry is deliberate and matches the one this whole
 *  workstream is built on: booting a weak device too high is a lost GPU context and a permanently
 *  black screen (#156), while booting a capable device too low costs a beat of uglier rendering
 *  that the next launch corrects. So the transient state errs downward, and the settled state —
 *  which is the one a device keeps — is the accurate one.
 *
 *  Concretely, on the measured runs: an S22 sits at `middle` for its first two launches and lands
 *  on `capable` at the third; a Y6 that draws its one bad `middle` sample first spends ONE launch
 *  there and is back on `weak` from the second, rather than keeping it forever.
 *
 *  Pure — the caller owns storage and the clock. */
export function refineProbeVerdict(
  previous: readonly ProbeReading[],
  reading: ProbeReading,
  /** Which axis decides — the same discriminator {@link classifyReading} takes, threaded through
   *  so a median of 2D readings is judged by the 2D table. A default would be a silent bug: the
   *  medians would be right and the boundary they were compared against would be the other
   *  shape's. */
  axes: ProbeAxes,
): ProbeRefinement {
  // ⚠️ NON-FINITE SAMPLES ARE DROPPED HERE, at the policy boundary, even though the persistence
  // layer already validates with `Number.isFinite`. This module is pure and its `previous` comes
  // from a PROVIDER SLOT — any implementation may supply it, and a test or a game's own store is
  // under no obligation to validate. The failure it prevents is quiet rather than loud: a `NaN`
  // makes the `(a, b) => a - b` comparator return `NaN` for every comparison touching it, which
  // V8 reads as "equal", so `sort` leaves the array in INSERTION ORDER and `sorted[mid]` is not
  // the median at all. Measured: one NaN sample among three returned `weak` — the safe direction
  // by luck, not by design — and stayed in the array to poison every later launch's median too.
  const samples = [...previous, reading]
    .filter((s) => Number.isFinite(s.cpuUnitsPerMs)
      && Number.isFinite(axes === '2d' ? s.fillMpxPerMs : s.shadeMfragPerMs))
    .slice(-PROBE_SAMPLE_TARGET);
  if (samples.length === 0) {
    return {
      samples, deviceClass: 'unknown', cpuLimited: false,
      reason: 'no finite reading to classify', final: false,
    };
  }
  const medianVerdict = classifyMedianOf(samples, axes);

  // ⚠️ There is deliberately NO one-pass shortcut here any more — see the note above
  // `PROBE_SAMPLE_TARGET`. Every device now pays the full three launches, including one whose
  // first reading looks unambiguous, because "unambiguous" was measured to be a property of the
  // launch rather than of the device.
  if (samples.length >= PROBE_SAMPLE_TARGET) {
    return {
      samples,
      deviceClass: medianVerdict.deviceClass,
      cpuLimited: medianVerdict.cpuLimited,
      // "readings", not "launches" — since #221 they may all come from ONE launch (see
      // `resolveProbeClass`'s in-launch loop), and a log line that says "3 launches" on a device's
      // first launch is the kind of small lie that costs an hour later.
      reason: `${medianVerdict.reason} (median of ${samples.length} readings)`,
      final: medianVerdict.deviceClass !== 'unknown',
    };
  }

  // ⚠️ **`axes` HERE TOO — IT WAS MISSING, AND IT MADE EVERY 2D DEVICE `weak` FOR TWO LAUNCHES.**
  // `classifyReading`'s parameter defaults to `'3d'`, and a 2D reading carries `shadeMfragPerMs: 0`
  // because a 2D probe never runs the shade ramp — so the interim ranking judged every 2D device
  // against a floor it could not clear by construction. The median path below was threaded
  // correctly, which is what made the bug survive: the two halves of this function disagreed, and
  // only the one that runs on launches 1 and 2 was wrong.
  //
  // Caught by reading a device log rather than by a test: a Galaxy A23 printed
  // `weak — lowest of 1 launch(es) so far ... (this pass alone: middle)`. Those two clauses
  // describe the SAME reading and cannot both be right — the "this pass alone" half goes through
  // `classifyDevice`, which does pass the axis. A disagreement printed on one line is the only
  // reason this was visible at all, which is an argument for logging both.
  const ranked = samples
    .map((s) => classifyReading(s, axes).deviceClass)
    .filter((c): c is Exclude<DeviceClass, 'unknown'> => c !== 'unknown');
  if (ranked.length === 0) {
    return { samples, deviceClass: 'unknown', cpuLimited: false, reason: medianVerdict.reason, final: false };
  }
  const order: Exclude<DeviceClass, 'unknown'>[] = ['weak', 'middle', 'capable'];
  const lowest = order[Math.min(...ranked.map((c) => order.indexOf(c)))];
  return {
    samples,
    deviceClass: lowest,
    // From the MEDIAN verdict even while the running answer is the LOWEST sample. The two are
    // deliberately different questions: `deviceClass` errs downward until the verdict settles
    // (booting a weak device high is a black screen), while `cpuLimited` is a statement about the
    // SHAPE of the bottleneck, where the median is the honest reading and erring in either
    // direction buys nothing.
    cpuLimited: medianVerdict.cpuLimited,
    reason: `${lowest} — lowest of ${samples.length} launch(es) so far, still refining `
      + `(${PROBE_SAMPLE_TARGET - samples.length} to go)`,
    final: false,
  };
}
