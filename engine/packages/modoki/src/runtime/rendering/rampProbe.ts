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
 *  ── THE CONSTRAINT THAT SHAPES EVERYTHING: NO NEW SHADER PROGRAM ──────────────────────────
 *  One distinct program costs ~1.2 s to compile on a Huawei Y6 (16 479 ms for postfx-demo's 14
 *  programs, against 2 928 ms on an A23). A probe with its own material would spend 4x its
 *  entire budget before drawing a pixel, on exactly the hardware being profiled. So the ramps
 *  may only vary things that need no new program: DRAW COUNT and OVERDRAW, on a material the
 *  frame has already compiled. That constraint belongs to the runner, but it is why there are
 *  exactly two ramp kinds and why neither of them varies shading.
 *
 *  ── IT MUST RAMP, NEVER START HEAVY ───────────────────────────────────────────────────────
 *  A fixed heavy probe risks the failure that started this workstream: a 6.4 s submit trips the
 *  GPU watchdog, the WebGL context is lost, and the screen stays black for the process lifetime
 *  (#156). Start tiny, double, and abort on the first frame past {@link ABORT_FRAME_MS} — which
 *  is ~25x below the submit that actually killed that device. */

/** Which bottleneck a ramp leans on. The two are separate because the strongest finding in this
 *  workstream is that three projects had three DIFFERENT bottlenecks: a fill-heavy probe would
 *  not have predicted forest-camp being CPU-bound on per-object submit. */
export type RampKind = 'fill' | 'draw';

/** One rendered step: how much was drawn, and how long that frame took. */
export interface RampStep {
  load: number;
  frameMs: number;
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
  /** A single frame exceeded {@link ABORT_FRAME_MS}. Stop immediately — see the watchdog note. */
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

export function startRamp(kind: RampKind, intervalMs: number): RampState {
  const { startLoad, maxLoad } = RAMP_BOUNDS[kind];
  return {
    kind,
    intervalMs,
    maxLoad,
    // Derived from the MEASURED interval — see RAMP_BUDGET_FRAMES for why frames, not ms.
    budgetMs: intervalMs * RAMP_BUDGET_FRAMES,
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
export function recordRampFrame(s: RampState, frameMs: number): RampState {
  if (s.status !== 'running') return s;

  const step: RampStep = { load: s.nextLoad, frameMs };
  const steps = [...s.steps, step];
  const elapsedMs = s.elapsedMs + Math.max(0, frameMs);
  const next = { ...s, steps, elapsedMs };

  if (!Number.isFinite(frameMs) || frameMs >= ABORT_FRAME_MS) {
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
    const b = s.steps[s.steps.length - 1];
    const pin = s.intervalMs * ESCAPE_PRIOR_MULTIPLE;
    const a = s.steps.find((step, i) => i < s.steps.length - 1 && step.frameMs >= pin)
      ?? s.steps[s.steps.length - 2];
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
    const lastMs = s.steps[s.steps.length - 1].frameMs;
    if (lastMs > 0) return { ...base, unitsPerMs: peakLoad / lastMs, bound: 'lower' };
  }

  return { ...base, unitsPerMs: 0, bound: 'none' };
}

// ── Classification ─────────────────────────────────────────────────────────────────────────

/** What the probe concluded about the DEVICE. Deliberately not a tier: the probe classifies
 *  hardware, and `resolveTier` owns what a class means for a project. */
export type DeviceClass = 'weak' | 'capable' | 'unknown';

export interface ProbeMeasurement {
  intervalMs: number;
  fill: RampReading;
  draw: RampReading;
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
  /** Pixels in the drawing buffer the ramps ran against. REQUIRED to read `fill` at all — see
   *  {@link fillMegapixelsPerMs}. */
  bufferPixels: number;
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
  return [input.platform ?? '', input.deviceModel ?? '', input.gpuRenderer ?? '', bucket].join('|');
}

/** Throughput a device must clear on BOTH ramps to be called `capable`, in load units per ms.
 *
 *  ⚠️ **NULL ON PURPOSE, and this is not an unfinished feature** — it is the same decision, for
 *  the same reason, as `TIER_ALLOWLIST` shipping empty in `qualityTier.ts`: a threshold invented
 *  before the hardware was measured is exactly what ossifies, and this plan has already shipped
 *  one tier table whose two signals both turned out to be dead. The probe MEASURES from the day
 *  it lands; it CLASSIFIES only once a Galaxy A23 and a Huawei Y6 have produced real numbers
 *  (step 6 of the plan). Until then every device reports `'unknown'`, which `resolveTier` reads
 *  as today's behaviour exactly — start low, nothing changes.
 *
 *  Fill this in from measurements, never from a datasheet. */
export const PROBE_THRESHOLDS: { fillMpxPerMs: number | null; drawUnitsPerMs: number | null } = {
  /** MEGAPIXELS per ms, never quads per ms — see {@link fillMegapixelsPerMs} for why the raw
   *  ramp figure is meaningless across devices. */
  fillMpxPerMs: null,
  /** Draw calls per ms. Already resolution-free. */
  drawUnitsPerMs: null,
};

/** Classify a completed measurement. Pure.
 *
 *  BOTH ramps must clear, because they measure different bottlenecks and a device that is
 *  fill-strong and submit-weak is not capable — it is forest-camp's failure mode wearing a good
 *  fill number. A `'lower'` bound counts as clearing: "at least X, and X clears" is a sound
 *  argument even though the true figure is unknown. */
export function classifyDevice(m: ProbeMeasurement): ProbeVerdict {
  const { fillMpxPerMs, drawUnitsPerMs } = PROBE_THRESHOLDS;
  if (fillMpxPerMs === null || drawUnitsPerMs === null) {
    return {
      deviceClass: 'unknown',
      reason: 'probe thresholds are unset — measure an A23 and a Y6 before classifying',
    };
  }
  if (m.fill.bound === 'none' || m.draw.bound === 'none') {
    const failed = m.fill.bound === 'none' ? m.fill : m.draw;
    return {
      deviceClass: 'unknown',
      reason: `${failed.kind} ramp produced no usable reading (${failed.status})`,
    };
  }

  // Fill compared in MEGAPIXELS/ms, not in the ramp's raw quads/ms — see fillMegapixelsPerMs.
  const fillMpx = fillMegapixelsPerMs(m);
  const fillOk = fillMpx >= fillMpxPerMs;
  const drawOk = m.draw.unitsPerMs >= drawUnitsPerMs;
  const detail = `fill ${fillMpx.toFixed(2)}Mpx/ms, draw ${m.draw.unitsPerMs.toFixed(2)}/ms`;
  if (fillOk && drawOk) {
    return { deviceClass: 'capable', reason: `${detail} — clears both thresholds` };
  }
  const short = !fillOk && !drawOk ? 'both ramps' : !fillOk ? 'the fill ramp' : 'the draw ramp';
  return { deviceClass: 'weak', reason: `${detail} — under threshold on ${short}` };
}
