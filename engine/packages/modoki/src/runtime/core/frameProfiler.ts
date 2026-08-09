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
  /** Median frameMs exceeds the 30 fps budget — the phase-5 pass/fail. */
  overBudget: boolean;
  /** Frames dropped from the window as discontinuities (see MAX_PLAUSIBLE_FRAME_MS). A
   *  non-zero count next to a healthy profile usually means stalls, not smooth rendering. */
  discontinuities: number;
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

function isVsyncBound(medianFrameMs: number): boolean {
  if (medianFrameMs <= 0) return false;
  return VSYNC_INTERVALS_MS.some((iv) => medianFrameMs <= iv * 1.2);
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
  return {
    samples: filled,
    frameMs,
    cpuMs,
    restMs,
    fps: frameMs.median > 0 ? 1000 / frameMs.median : 0,
    vsyncBound: isVsyncBound(frameMs.median),
    overBudget: frameMs.median > BUDGET_30FPS_MS,
    discontinuities,
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
}

/** Timestamp source, shared with `frameDriver` so both agree under an injected manual clock. */
export function profilerNow(): number {
  return rawNow();
}
