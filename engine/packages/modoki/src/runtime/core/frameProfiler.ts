/** Frame-time profiler (#121 P2) — the instrument the rest of the low-end work depends on.
 *
 *  WHY THIS EXISTS, in one measured fact: someone cut a scene's GPU texture memory from ~36 MB
 *  to ~4.3 MB and the framerate changed by EXACTLY NOTHING — 12.5 fps and 83.1 ms median before
 *  and after, identical to the decimal. The memory win was real; it was not a speed win. Nothing
 *  in the engine could show that ~48 ms of that 83 ms frame was CPU spent submitting 237 draw
 *  calls, so a plausible fix got shipped against the wrong bottleneck. Per-project tuning across
 *  ~18 projects would repeat that investigation 18 times without this.
 *
 *  ── MEASURE FRAME TIME, NOT FPS ───────────────────────────────────────────────────────────
 *  fps SATURATES at the vsync ceiling. A device sitting at 60 fps may be spending 3 ms or 16 ms
 *  of a 16.7 ms frame — completely different answers to "can it afford more?" — and fps reports
 *  both as 60. Milliseconds of headroom against the budget is the honest metric, and it is the
 *  one the 30 fps target is already stated in. It also does not lie on a 120 Hz panel.
 *
 *  ── WHAT `restMs` IS AND IS NOT ───────────────────────────────────────────────────────────
 *  `restMs` is `frameMs - cpuMs`: everything that is not engine main-thread work. That is GPU
 *  time, compositing/present, AND IDLE. It is NOT a GPU-time measurement, and calling it one
 *  would be the same class of error as the texture pass above:
 *
 *    - When `frameMs` is pinned near the vsync interval, the frame is finishing early and
 *      `restMs` is mostly the browser WAITING. A big `restMs` here means headroom, not cost.
 *    - When `frameMs` is far above vsync (the Y6 2019 sat at 83 ms), there is no idle left and
 *      `restMs` genuinely is GPU + present — which is how that device's ~32 ms was attributed.
 *
 *  `vsyncBound` reports which regime a reading is in, so a consumer cannot misread the number
 *  without ignoring a field that says so. Real per-pass GPU timing needs timestamp queries
 *  (`GPUFeatureName.TimestampQuery`) and is deliberately out of scope here. */

import { rawNow } from './clock';

/** The 30 fps target, in milliseconds per frame. The bar every game and demo must clear on an
 *  iPhone 8 and a Galaxy A23 5G. */
export const BUDGET_30FPS_MS = 1000 / 30;

/** Frames retained. ~2 s at 60 fps, ~10 s on a device struggling at 12 fps — deliberately a
 *  frame count rather than a duration, so a slow device (the case that matters) gets a LONGER
 *  window and its percentiles stay meaningful instead of being computed over a handful of
 *  samples. */
export const PROFILE_WINDOW_FRAMES = 120;

/** A rAF interval this long is treated as a break in continuity (tab hidden, a debugger pause,
 *  the 6.65 s boot stall this engine has actually recorded) rather than a real frame, and is
 *  dropped. Without this one backgrounded tab poisons every percentile in the window. */
const MAX_PLAUSIBLE_FRAME_MS = 1000;

/** How far past the target frame time a frame may sit before it counts as OVER BUDGET.
 *
 *  `budgetMs` is the target frame interval times this, so at `targetFps: 60` the budget is 20 ms
 *  rather than 16.67 — a little slack, because a frame landing a hair late is not a quality
 *  problem.
 *
 *  Exported because `qualityTier` has to divide it back OUT: the demotion bar is expressed as a
 *  share of `budgetMs`, but the question it asks is about the TARGET FRAME TIME, and re-deriving
 *  the target means undoing this slack. A second literal `1.2` over there would be a code
 *  constant shadowing this one, which is exactly the drift the single-source-of-truth rule
 *  exists to prevent.
 *
 *  ⚠️ **`isVsyncBound` has two tolerances, and only ONE of them is this number** (#417). Its
 *  ENGINE-CAP branch measures the same reading against the same cap that `budgetMs` is derived
 *  from, so it uses `BUDGET_SLACK` and the two divide at the same point. Its DISPLAY-REFRESH
 *  branch is a different quantity entirely — see {@link VSYNC_TOLERANCE} — and is free to move
 *  independently of this one.
 *
 *  ⚠️ **That shared threshold makes the two verdicts complements only while the cap is no faster
 *  than the fastest refresh interval the profiler recognises** (i.e. `targetFps <= 60`, which is
 *  every project in the repo today). Above that, `isVsyncBound` FALLS THROUGH to the refresh
 *  branch, and a reading can be both — `targetFps: 120` on a 60 Hz panel measures 16 ms against a
 *  10 ms budget: over budget AND idle-waiting on the display. Both flags are then true and both
 *  are CORRECT; that pair is the signal that the panel, not the engine, is the floor. Pinned in
 *  both directions by `tests/runtime/frameProfiler.test.ts`.
 *
 *  Both of those facts used to be asserted, in contradiction, by two comments in this same file:
 *  this one said the numbers were unrelated, `getFrameProfile`'s said they could not disagree.
 *  Neither was right, because there were two numbers wearing one literal. */
export const BUDGET_SLACK = 1.2;

export interface FrameStat {
  median: number;
  p95: number;
  min: number;
  max: number;
}

export interface FrameProfile {
  /** Frames in the window. Below ~20 the percentiles are not worth quoting. */
  samples: number;
  /** Wall-clock interval between frame starts — the budget metric. */
  frameMs: FrameStat;
  /** Engine main-thread work: frame start to the end of the last frame callback. */
  cpuMs: FrameStat;
  /** `frameMs - cpuMs` — GPU + present + IDLE. Read `vsyncBound` before calling it GPU time. */
  restMs: FrameStat;
  /** Median frameMs expressed as fps, for humans. Derived, never measured. */
  fps: number;
  /** Median frameMs is within 20% of a plausible vsync interval, i.e. the frame is finishing
   *  early and `restMs` is mostly idle rather than GPU cost. */
  vsyncBound: boolean;
  /** Median frameMs exceeds {@link FrameProfile.budgetMs} — the phase-5 pass/fail. */
  overBudget: boolean;
  /** The threshold {@link FrameProfile.overBudget} was judged against, ms.
   *
   *  ⚠️ **REPORTED BECAUSE A CONSUMER GUESSED IT AND GUESSED WRONG** (close-out 2026-08-12).
   *  `overBudget` stopped meaning "slower than 30 fps" the moment it started reading the frame
   *  cap in force (see {@link frameCapIntervalMs}) — at the fleet's `targetFps: 60` the real
   *  threshold is **20 ms**, not 33.3. `evaluateTierChange` still built its demotion reason from
   *  `BUDGET_30FPS_MS`, so a device demoting at a 22 ms median logged *"median frame 22.0ms over
   *  the 33.3ms budget"* — a sentence that contradicts itself, on the one surface that exists to
   *  explain a surprising tier. A judgement that carries its own threshold cannot be misquoted. */
  budgetMs: number;
  /** Frames dropped from the window as discontinuities (see MAX_PLAUSIBLE_FRAME_MS). A
   *  non-zero count next to a healthy profile usually means stalls, not smooth rendering. */
  discontinuities: number;
  /** The LONGEST dropped interval, in ms, since the last reset — 0 when none was dropped.
   *
   *  Counting stalls without sizing them is what made the boot stall un-re-measurable (#212 item
   *  3): a 3,926 ms figure sat unverified in an issue for weeks because the only instrument that
   *  saw the stall deliberately threw the number away, and `discontinuities: 1` reads identically
   *  for a 1.1 s hitch and a 7 s freeze. Dropping it from the PERCENTILES is right — one stall
   *  would poison every one of them — but dropping it from the RECORD was not. Recorded here so
   *  "did the compileAsync change kill the boot stall" is one profiler read rather than a
   *  bespoke instrumentation pass. */
  worstStallMs: number;
}

// Two parallel ring buffers rather than an array of objects: this writes every frame, and a
// per-frame allocation is exactly the kind of cost a profiler must not introduce into what it
// measures.
const frameSamples = new Float64Array(PROFILE_WINDOW_FRAMES);
const cpuSamples = new Float64Array(PROFILE_WINDOW_FRAMES);
let writeIndex = 0;
let filled = 0;
let prevFrameStart = 0;
let discontinuities = 0;
let worstStallMs = 0;
// WHEN the worst stall was, in raw clock terms. Kept out of `FrameProfile` deliberately: it is
// not a statistic about the window, it is a coordinate used to intersect the stall with the boot
// timeline (#238) — "1,814 ms" is unattributable on its own, "1,814 ms, and these spans were open
// across it" is the answer. `-1` when nothing has been dropped.
let worstStallStart = -1;
let worstStallEnd = -1;

/** Record one frame. Called by `frameDriver` — two `rawNow()` reads and a ring write, so it is
 *  ALWAYS ON: the faults worth profiling (a boot-time context loss, an intermittent hitch) are
 *  exactly the ones you cannot reproduce on demand after enabling a flag. */
export function recordFrame(frameStart: number, callbacksEnd: number): { frameMs: number; cpuMs: number } {
  const cpuMs = Math.max(0, callbacksEnd - frameStart);
  let frameMs = 0;
  if (prevFrameStart > 0) {
    frameMs = frameStart - prevFrameStart;
    if (frameMs > 0 && frameMs <= MAX_PLAUSIBLE_FRAME_MS) {
      frameSamples[writeIndex] = frameMs;
      cpuSamples[writeIndex] = cpuMs;
      writeIndex = (writeIndex + 1) % PROFILE_WINDOW_FRAMES;
      if (filled < PROFILE_WINDOW_FRAMES) filled++;
    } else {
      discontinuities++;
      if (frameMs > worstStallMs) {
        worstStallMs = frameMs;
        worstStallStart = prevFrameStart;
        worstStallEnd = frameStart;
      }
    }
  }
  prevFrameStart = frameStart;
  // Returned so a second consumer (the P6 capture) gets THIS frame's interval without keeping
  // its own `prevFrameStart` — two copies of that state would drift the moment either changed
  // its discontinuity handling, and the capture would silently disagree with the profile.
  return { frameMs, cpuMs };
}

const EMPTY_STAT: FrameStat = { median: 0, p95: 0, min: 0, max: 0 };

/** Percentile from an ALREADY-SORTED array, nearest-rank. */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** Median/p95/min/max of a sample set. Exported because `gpuTimings` summarises its own window
 *  the same way, and two implementations of "what p95 means" would drift the moment either was
 *  touched — the GPU panel and the CPU panel sit side by side, so a disagreement there would read
 *  as a measurement difference rather than as the bug it is. */
export function summarizeStat(values: number[]): FrameStat {
  if (values.length === 0) return EMPTY_STAT;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const summarize = summarizeStat;

/** Plausible display refresh intervals, ms. A median frameMs sitting just above one of these
 *  means the renderer is finishing early and waiting — not that it is GPU-bound. */
const VSYNC_INTERVALS_MS = [1000 / 60, 1000 / 120, 1000 / 90, 1000 / 144];

/** How far above a nominal refresh interval a median may sit and still be RECOGNISED as that
 *  interval. This is a pattern-matching tolerance — it exists because a real 60 Hz loop measures
 *  a hair over 16.67 ms, not because 16.67 ms is anyone's budget.
 *
 *  ⚠️ Deliberately NOT {@link BUDGET_SLACK}, which happens to hold the same value. That one says
 *  "how late is still acceptable" and is compared against the ENGINE'S cap; this one says "close
 *  enough to be that refresh rate" and is compared against the DISPLAY's intervals. Retuning the
 *  budget must not silently re-classify which displays the profiler can recognise, so the numbers
 *  are named apart even while they coincide (#417). */
const VSYNC_TOLERANCE = 1.2;

/** The interval the ENGINE'S OWN frame cap is pacing to, ms; 0 when uncapped.
 *
 *  ⚠️ **THIS FIELD EXISTS BECAUSE ITS ABSENCE DISABLED TIER PROMOTION ON EVERY PROJECT IN THE
 *  REPO** (review 2026-08-12). `frameDriver` skips the whole callback pass before `recordFrame`
 *  runs, so a capped loop's `frameMs` is the CAP's interval, not the display's — and the list
 *  above knows only display intervals. #202 seeded `low.targetFps: 30` into all 23 projects, so
 *  every `low` device read `frameMs.median ≈ 33.3 ms`, which is not within 1.2x of ANY entry
 *  above (the largest accepted median is 20 ms). `vsyncBound` therefore went false, `hasHeadroom`
 *  fell to its `<= BUDGET_30FPS_MS * 0.5` branch — 16.67 ms, unreachable under a 30 fps cap — and
 *  the single promotion step `promotionCeiling` grants a `calibrating` device could never fire.
 *
 *  ⚠️ **THAT BRANCH IS GONE (2026-08-20) — the history above is why the field exists, not how the
 *  decision works now.** `hasHeadroom` no longer reads `frameMs` or `vsyncBound` at all; it asks
 *  whether the engine's CPU fits the frame the NEXT tier targets. The cap still has to be pushed
 *  in, because `budgetMs`/`overBudget` are derived from it and promotion is floored on
 *  `!overBudget`. See `docs/rendering.md` § "Quality tiers" (the "AN IDLE WINDOW IS NOT EVIDENCE EITHER" rule).
 *
 *  A cap is a FRAME-DRIVER fact, not a display fact, so it is PUSHED IN rather than imported:
 *  `frameProfiler` is L0 core and the cap's owner (`frameDriver`, L2) may import downward but not
 *  the reverse. It is set from `setTargetFPS` — the single point every source of the cap goes
 *  through (project config AND a tier) — so a new source cannot bypass it. */
let frameCapIntervalMs = 0;

/** Tell the profiler what interval the frame driver is pacing to. `fps <= 0` means uncapped.
 *  Called only from {@link setTargetFPS}; see {@link frameCapIntervalMs} for why it is a push. */
export function setProfilerFrameCap(fps: number): void {
  frameCapIntervalMs = fps > 0 ? 1000 / fps : 0;
}

function isVsyncBound(medianFrameMs: number): boolean {
  if (medianFrameMs <= 0) return false;
  // The engine's own cap first: a loop pacing to 33.3 ms because it was TOLD to is finishing
  // early and waiting, which is exactly what this flag means — the same regime as vsync.
  //
  // BUDGET_SLACK, not a literal, and not VSYNC_TOLERANCE: this is the SAME reading against the
  // SAME cap that `getFrameProfile`'s `budgetMs` is derived from, so the two split the line at
  // the same point, from the one constant (#417).
  if (frameCapIntervalMs > 0 && medianFrameMs <= frameCapIntervalMs * BUDGET_SLACK) return true;
  // FALLS THROUGH when the cap branch says no — deliberately. A cap FASTER than the panel cannot
  // be met, and the reading is then genuinely both late (vs the cap) and idle-waiting (vs the
  // panel), so the display question still has to be asked. This is why the two verdicts are
  // complements only up to a 60 fps cap; see BUDGET_SLACK's banner.
  return VSYNC_INTERVALS_MS.some((iv) => medianFrameMs <= iv * VSYNC_TOLERANCE);
}

/** Summarise the current window. Pure — safe to call from a diagnose payload or a debug tab at
 *  any cadence; it never mutates the ring. */
export function getFrameProfile(): FrameProfile {
  const frames: number[] = [];
  const cpus: number[] = [];
  for (let i = 0; i < filled; i++) {
    frames.push(frameSamples[i]);
    cpus.push(cpuSamples[i]);
  }
  const frameMs = summarize(frames);
  const cpuMs = summarize(cpus);
  // Per-frame subtraction, then summarised — NOT median(frame) - median(cpu), which would be a
  // difference of two order statistics from different frames and need not correspond to any
  // frame that actually happened.
  const restMs = summarize(frames.map((f, i) => Math.max(0, f - cpus[i])));
  // ONE expression for the threshold, published as `budgetMs` and compared against below — so
  // "what counts as over budget" and "what we say it was" cannot disagree.
  const budgetMs = frameCapIntervalMs > 0 ? frameCapIntervalMs * BUDGET_SLACK : BUDGET_30FPS_MS;
  return {
    samples: filled,
    frameMs,
    cpuMs,
    restMs,
    fps: frameMs.median > 0 ? 1000 / frameMs.median : 0,
    vsyncBound: isVsyncBound(frameMs.median),
    // Judged against the cap in force, not a fixed 30 fps. A project that ASKED for 30 is not
    // "over budget" for delivering it — and at `targetFps: 30` the nominal interval is
    // BUDGET_30FPS_MS to the decimal, so a bare `>` made obeying the cap a jitter-decided coin
    // flip. This divides at `cap * BUDGET_SLACK`, the same point as `isVsyncBound`'s cap branch
    // and from the same constant — so up to a 60 fps cap the two verdicts are complements. Above
    // that they can BOTH be true, and correctly so (see BUDGET_SLACK's banner). This comment used
    // to claim it matched `isVsyncBound`'s "tolerance", which was two different numbers under one
    // literal, and then claimed a complement that does not hold at every cap — #417.
    overBudget: frameMs.median > budgetMs,
    budgetMs,
    discontinuities,
    worstStallMs,
  };
}

/** Drop the window. For tests, and for starting a clean measurement around a specific action
 *  (load this scene, run this tour) rather than reading a window blurred by whatever preceded
 *  it. */
export function resetFrameProfile(): void {
  frameSamples.fill(0);
  cpuSamples.fill(0);
  writeIndex = 0;
  filled = 0;
  prevFrameStart = 0;
  discontinuities = 0;
  worstStallMs = 0;
  worstStallStart = -1;
  worstStallEnd = -1;
}

/** The raw-clock window the worst stall occupied, or null when no frame has been dropped. The
 *  boot-timeline read subtracts `getBootOrigin()` from these to ask what was open at the time. */
export function getWorstStallWindow(): { startMs: number; endMs: number } | null {
  if (worstStallStart < 0) return null;
  return { startMs: worstStallStart, endMs: worstStallEnd };
}

/** Timestamp source, shared with `frameDriver` so both agree under an injected manual clock. */
export function profilerNow(): number {
  return rawNow();
}
