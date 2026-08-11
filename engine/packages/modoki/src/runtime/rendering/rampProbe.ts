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
 *  tier system exists for. See docs/plans/low-end-device-support.md § "the boot ramp probe".
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
 *  docs/plans/low-end-device-support.md. Do not read the presence of a ramp here as a claim that
 *  it is load-bearing. */
export type RampKind = 'fill' | 'draw' | 'shade' | 'cpu';

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
  fill: { startLoad: 8, maxLoad: 1024 },
  /** Many tiny quads — per-object CPU submit. forest-camp's real frame submits hundreds of draws,
   *  and at 0.14 ms/call on the Y6 that is where its cost was.
   *
   *  Starts at 32, not 8: the budget affords ~9 frames at 60 Hz, and the first two doublings were
   *  measurably pointless — every device tested sat at vsync through them. Spending those frames
   *  higher up the ramp is what lets it reach the ceiling within budget. */
  draw: { startLoad: 32, maxLoad: 4096 },
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
export function startRamp(kind: RampKind, intervalMs: number, budgetMsOverride?: number): RampState {
  const { startLoad, maxLoad } = RAMP_BOUNDS[kind];
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
    const a = s.steps.find((step, i) => i > 0 && i < bi && step.frameMs >= pin && loadBearing(step))
      ?? s.steps.find((step, i) => i > 0 && i < bi && step.frameMs >= pin)
      ?? s.steps[bi - 1];
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
  fill: RampReading;
  draw: RampReading;
  /** The heavy-shader ramp, when the probe could build and compile its material.
   *
   *  Optional because a backend that refuses the material must still yield the fill/draw
   *  measurement rather than nothing — and because it is EVIDENCE ONLY today: it is logged and
   *  reported, and no threshold reads it. It moves into {@link ProbeReading} (and bumps
   *  `CLASSIFIER_VERSION`, which is module-local and so not linkable here) if and only if a
   *  campaign shows it discriminates. */
  shade?: RampReading;
  /** The main-thread CPU ramp. Always available — it needs no GPU — but optional for the same
   *  evidence-only reason as {@link ProbeMeasurement.shade}. */
  cpu?: RampReading;
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
  if (!m.bufferPixels || m.fill.bound === 'none') return 0;
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
 *  removed by tile-based hidden-surface removal before it can be measured. */
const CLASSIFIER_VERSION = 4;

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
  /** Transform propagations per ms — main-thread CPU. Resolution-free by construction. */
  cpuUnitsPerMs: number;
  /** MILLIONS of heavy shaded fragments per ms, never the ramp's raw instances/ms — see
   *  {@link shadeMegaFragmentsPerMs} for why the raw figure is not comparable across devices. */
  shadeMfragPerMs: number;
}

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
   *  floor comfortably. */
  middle: { cpuUnitsPerMs: 4_500, shadeMfragPerMs: 0.06 },
  /** Between the iPhone 8 (10.9k / 0.20) and the S22 (21.3k / 0.21). Here it is the CPU floor that
   *  does the work: shade has saturated by this point and cannot tell these three apart. */
  capable: { cpuUnitsPerMs: 14_500, shadeMfragPerMs: 0.165 },
};

/** One device's throughput on both ramps, in the two COMPARABLE units — the only thing worth
 *  persisting between launches. Note it is not a `ProbeMeasurement`: totals, statuses and the
 *  buffer size describe the RUN, and it is the device we are trying to characterise. */
export interface ProbeReading {
  /** Transform propagations per ms. See {@link ProbeThreshold} for why this replaced `fill`. */
  cpuUnitsPerMs: number;
  /** Millions of heavy shaded fragments per ms — {@link shadeMegaFragmentsPerMs}, never the raw
   *  instances/ms, which is not comparable across devices. */
  shadeMfragPerMs: number;
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
  };
}

/** Does a measurement clear a band's floor? BOTH ramps must, because they measure different
 *  bottlenecks and a device that is fill-strong and submit-weak is not capable — it is
 *  forest-camp's failure mode wearing a good fill number. A `'lower'` bound counts as clearing:
 *  "at least X, and X clears" is a sound argument even though the true figure is unknown. */
function clears(r: ProbeReading, t: ProbeThreshold): boolean {
  return r.cpuUnitsPerMs >= t.cpuUnitsPerMs && r.shadeMfragPerMs >= t.shadeMfragPerMs;
}

/** Band a single reading falls in. Split out from {@link classifyDevice} so a MEDIAN of several
 *  launches' readings can be classified by exactly the same rule as one launch's — the alternative
 *  being a second copy of the boundary comparisons, which would drift. */
export function classifyReading(r: ProbeReading): ProbeVerdict {
  const { middle, capable } = PROBE_THRESHOLDS;
  if (middle === null || capable === null) {
    return {
      deviceClass: 'unknown',
      reason: 'probe thresholds are unset — measure real hardware before classifying',
    };
  }
  const detail = `cpu ${(r.cpuUnitsPerMs / 1000).toFixed(1)}k xform/ms, `
    + `shade ${r.shadeMfragPerMs.toFixed(3)}Mfrag/ms`;
  if (clears(r, capable)) {
    return { deviceClass: 'capable', reason: `${detail} — clears the capable floor on both ramps` };
  }
  if (clears(r, middle)) {
    return { deviceClass: 'middle', reason: `${detail} — clears the middle floor on both ramps` };
  }
  // Name the ramp that fell short, not just the verdict: "weak on draw" and "weak on fill" are
  // different hardware and lead to different authoring advice, and this string is what `diagnose`
  // and the boot log show.
  const cpuShort = r.cpuUnitsPerMs < middle.cpuUnitsPerMs;
  const shadeShort = r.shadeMfragPerMs < middle.shadeMfragPerMs;
  const short = cpuShort && shadeShort ? 'both ramps' : cpuShort ? 'the cpu ramp' : 'the shade ramp';
  return { deviceClass: 'weak', reason: `${detail} — under the middle floor on ${short}` };
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
  const undecidable = !m.cpu || m.cpu.bound === 'none' ? m.cpu ?? { kind: 'cpu' as const, status: 'absent' }
    : !m.shade || m.shade.bound === 'none' ? m.shade ?? { kind: 'shade' as const, status: 'absent' }
      : null;
  if (undecidable) {
    return {
      deviceClass: 'unknown',
      reason: `${undecidable.kind} ramp produced no usable reading (${undecidable.status})`,
    };
  }
  // Shade compared in MEGA-FRAGMENTS/ms, not the ramp's raw instances/ms — see
  // shadeMegaFragmentsPerMs.
  return classifyReading(readingOf(m));
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
  /** Settled — do not probe this device again. */
  final: boolean;
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
    .filter((s) => Number.isFinite(s.cpuUnitsPerMs) && Number.isFinite(s.shadeMfragPerMs))
    .slice(-PROBE_SAMPLE_TARGET);
  if (samples.length === 0) {
    return { samples, deviceClass: 'unknown', reason: 'no finite reading to classify', final: false };
  }
  const medianVerdict = classifyReading({
    cpuUnitsPerMs: median(samples.map((s) => s.cpuUnitsPerMs)),
    shadeMfragPerMs: median(samples.map((s) => s.shadeMfragPerMs)),
  });

  // ⚠️ There is deliberately NO one-pass shortcut here any more — see the note above
  // `PROBE_SAMPLE_TARGET`. Every device now pays the full three launches, including one whose
  // first reading looks unambiguous, because "unambiguous" was measured to be a property of the
  // launch rather than of the device.
  if (samples.length >= PROBE_SAMPLE_TARGET) {
    return {
      samples,
      deviceClass: medianVerdict.deviceClass,
      reason: `${medianVerdict.reason} (median of ${samples.length} launches)`,
      final: medianVerdict.deviceClass !== 'unknown',
    };
  }

  const ranked = samples
    .map((s) => classifyReading(s).deviceClass)
    .filter((c): c is Exclude<DeviceClass, 'unknown'> => c !== 'unknown');
  if (ranked.length === 0) {
    return { samples, deviceClass: 'unknown', reason: medianVerdict.reason, final: false };
  }
  const order: Exclude<DeviceClass, 'unknown'>[] = ['weak', 'middle', 'capable'];
  const lowest = order[Math.min(...ranked.map((c) => order.indexOf(c)))];
  return {
    samples,
    deviceClass: lowest,
    reason: `${lowest} — lowest of ${samples.length} launch(es) so far, still refining `
      + `(${PROBE_SAMPLE_TARGET - samples.length} to go)`,
    final: false,
  };
}
