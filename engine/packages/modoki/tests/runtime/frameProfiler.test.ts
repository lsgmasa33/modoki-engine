/** Frame-time profiler (#121 P2) — `runtime/core/frameProfiler.ts`.
 *
 *  `recordFrame` takes explicit timestamps, so this whole suite is deterministic with no clock
 *  injection and no rAF: feed exact frames, assert exact statistics.
 *
 *  The assertions worth reading are the ones about what the numbers MEAN — that `restMs` is
 *  computed per-frame rather than as a difference of medians, and that `vsyncBound` marks the
 *  regime where `restMs` is idle rather than GPU cost. Both encode mistakes that would make the
 *  profiler confidently wrong rather than merely absent, which is worse than having no profiler
 *  at all — the plan exists because a previous fix was shipped against the wrong bottleneck. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordFrame, getFrameProfile, resetFrameProfile, setProfilerFrameCap,
  BUDGET_30FPS_MS, PROFILE_WINDOW_FRAMES,
} from '../../src/runtime/core/frameProfiler';

/** Feed frames of exactly `frameMs` apart, each costing `cpuMs` of main-thread work. */
function feed(frames: Array<{ frameMs: number; cpuMs: number }>, start = 1000) {
  let t = start;
  // The first recordFrame only establishes a baseline (no previous frame to measure against).
  recordFrame(t, t + 1);
  for (const f of frames) {
    t += f.frameMs;
    recordFrame(t, t + f.cpuMs);
  }
}

beforeEach(() => resetFrameProfile());

describe('frameProfiler — empty state', () => {
  it('reports zeros with no samples rather than NaN', () => {
    const p = getFrameProfile();
    expect(p.samples).toBe(0);
    expect(p.frameMs).toEqual({ median: 0, p95: 0, min: 0, max: 0 });
    expect(p.fps).toBe(0);
    expect(p.overBudget).toBe(false);
  });

  it('a single frame produces NO sample — there is no interval to measure yet', () => {
    recordFrame(1000, 1005);
    expect(getFrameProfile().samples).toBe(0);
  });
});

describe('frameProfiler — statistics', () => {
  it('computes frame and cpu statistics over the window', () => {
    feed([
      { frameMs: 10, cpuMs: 4 },
      { frameMs: 20, cpuMs: 6 },
      { frameMs: 30, cpuMs: 8 },
    ]);
    const p = getFrameProfile();
    expect(p.samples).toBe(3);
    expect(p.frameMs.min).toBe(10);
    expect(p.frameMs.max).toBe(30);
    expect(p.frameMs.median).toBe(20);
    expect(p.cpuMs.median).toBe(6);
  });

  it('derives fps from median frame time, never measuring it directly', () => {
    feed(Array.from({ length: 10 }, () => ({ frameMs: 50, cpuMs: 10 })));
    expect(getFrameProfile().fps).toBeCloseTo(20, 5);
  });

  it('clamps a negative cpu span to zero instead of poisoning the stats', () => {
    // Defensive: a clock that goes backwards must not produce a negative cost.
    recordFrame(1000, 1000);
    recordFrame(1016, 1010); // callbacksEnd < frameStart
    expect(getFrameProfile().cpuMs.min).toBe(0);
  });
});

describe('frameProfiler — restMs is not a GPU measurement', () => {
  it('subtracts PER FRAME, not median(frame) - median(cpu)', () => {
    // Chosen so the two disagree: per-frame rest is [2, 18] -> median 2, while a
    // difference-of-medians would give 10 - 2 = 8. The latter corresponds to no frame that
    // actually happened; it is a difference of two order statistics from different frames.
    feed([
      { frameMs: 10, cpuMs: 8 },
      { frameMs: 20, cpuMs: 2 },
    ]);
    const p = getFrameProfile();
    expect(p.restMs.min).toBe(2);
    expect(p.restMs.max).toBe(18);
    expect(p.restMs.median).toBe(2);
  });

  it('flags a 60fps-paced reading as vsyncBound — restMs there is IDLE, not GPU cost', () => {
    // 3ms of work in a 16.7ms frame: the remaining ~13.7ms is the browser waiting for vsync.
    // Reading that as "13.7ms of GPU time" is the misinterpretation this flag exists to block.
    feed(Array.from({ length: 20 }, () => ({ frameMs: 1000 / 60, cpuMs: 3 })));
    const p = getFrameProfile();
    expect(p.vsyncBound).toBe(true);
    expect(p.overBudget).toBe(false);
  });

  it('does NOT flag a struggling device as vsyncBound — there restMs really is GPU + present', () => {
    // The Huawei Y6 2019's measured profile: 83ms frames, ~48ms of it CPU. No idle left.
    feed(Array.from({ length: 20 }, () => ({ frameMs: 83, cpuMs: 48 })));
    const p = getFrameProfile();
    expect(p.vsyncBound).toBe(false);
    expect(p.overBudget).toBe(true);
    expect(p.cpuMs.median).toBe(48);
    expect(p.restMs.median).toBe(35);
  });
});

describe('frameProfiler — the 30fps budget', () => {
  it('is not over budget at exactly the budget', () => {
    feed(Array.from({ length: 10 }, () => ({ frameMs: BUDGET_30FPS_MS, cpuMs: 5 })));
    expect(getFrameProfile().overBudget).toBe(false);
  });

  it('is over budget just past it', () => {
    feed(Array.from({ length: 10 }, () => ({ frameMs: BUDGET_30FPS_MS + 1, cpuMs: 5 })));
    expect(getFrameProfile().overBudget).toBe(true);
  });

  it('judges on the MEDIAN, so a few slow frames do not condemn a healthy run', () => {
    const frames = Array.from({ length: 18 }, () => ({ frameMs: 16, cpuMs: 4 }));
    frames.push({ frameMs: 200, cpuMs: 150 }, { frameMs: 180, cpuMs: 140 });
    feed(frames);
    const p = getFrameProfile();
    expect(p.overBudget).toBe(false);
    expect(p.frameMs.max).toBe(200);   // ...but the outliers are still visible
    expect(p.frameMs.p95).toBeGreaterThan(100);
  });
});

describe('frameProfiler — discontinuities', () => {
  it('drops an implausibly long gap instead of poisoning every percentile', () => {
    // A backgrounded tab / debugger pause / the engine's recorded 6.65s boot stall.
    feed([
      { frameMs: 16, cpuMs: 4 },
      { frameMs: 6650, cpuMs: 5 },
      { frameMs: 16, cpuMs: 4 },
    ]);
    const p = getFrameProfile();
    expect(p.discontinuities).toBe(1);
    expect(p.samples).toBe(2);
    expect(p.frameMs.max).toBe(16);
  });

  it('counts discontinuities so a stall cannot masquerade as smooth rendering', () => {
    feed([
      { frameMs: 2000, cpuMs: 5 },
      { frameMs: 3000, cpuMs: 5 },
      { frameMs: 16, cpuMs: 4 },
    ]);
    expect(getFrameProfile().discontinuities).toBe(2);
  });

  it('ignores a zero or negative interval', () => {
    recordFrame(1000, 1002);
    recordFrame(1000, 1002); // same timestamp — no elapsed interval
    expect(getFrameProfile().samples).toBe(0);
  });
});

describe('frameProfiler — setProfilerFrameCap (#202 close-out: the cap must be judged against itself)', () => {
  // ⚠️ `low`'s seeded `targetFps: 30` produces a ~33.3ms median, which is not within 1.2x of ANY
  // display interval in VSYNC_INTERVALS_MS (the largest accepted median there is 20ms). Without
  // `setProfilerFrameCap`, a device obeying its own 30fps cap read `vsyncBound: false` and
  // `overBudget` against the fixed 30fps budget — which made live promotion out of `low`
  // mathematically impossible fleet-wide. This is the regression that fix exists to close.
  afterEach(() => setProfilerFrameCap(0)); // module state — must not leak into other test files

  it('a device pacing to a 30fps cap reads vsyncBound + NOT overBudget, capped at 30', () => {
    setProfilerFrameCap(30);
    feed(Array.from({ length: 20 }, () => ({ frameMs: 1000 / 30, cpuMs: 5 })));
    const p = getFrameProfile();
    expect(p.vsyncBound).toBe(true);
    expect(p.overBudget).toBe(false);
  });

  it('the SAME frames read NOT vsyncBound with no cap in force (0 = uncapped)', () => {
    // Distinguishing control: same frame times, only the cap differs. ~33.3ms clears none of the
    // display intervals (largest accepted median there is 20ms), so with no cap this must flip.
    setProfilerFrameCap(0);
    feed(Array.from({ length: 20 }, () => ({ frameMs: 1000 / 30, cpuMs: 5 })));
    const p = getFrameProfile();
    expect(p.vsyncBound).toBe(false);
  });
});

describe('frameProfiler — the ring', () => {
  it('retains only the most recent PROFILE_WINDOW_FRAMES', () => {
    feed(Array.from({ length: PROFILE_WINDOW_FRAMES + 50 }, () => ({ frameMs: 16, cpuMs: 4 })));
    expect(getFrameProfile().samples).toBe(PROFILE_WINDOW_FRAMES);
  });

  it('a fast run eventually evicts an earlier slow one', () => {
    feed(Array.from({ length: 10 }, () => ({ frameMs: 100, cpuMs: 80 })));
    expect(getFrameProfile().overBudget).toBe(true);
    // Fill the whole window with healthy frames — the slow ones must age out entirely.
    feed(Array.from({ length: PROFILE_WINDOW_FRAMES + 5 }, () => ({ frameMs: 16, cpuMs: 4 })), 999999);
    const p = getFrameProfile();
    expect(p.frameMs.max).toBe(16);
    expect(p.overBudget).toBe(false);
  });

  it('resetFrameProfile clears the window, the baseline and the discontinuity count', () => {
    feed([{ frameMs: 5000, cpuMs: 5 }, { frameMs: 16, cpuMs: 4 }]);
    expect(getFrameProfile().discontinuities).toBe(1);
    resetFrameProfile();
    const p = getFrameProfile();
    expect(p.samples).toBe(0);
    expect(p.discontinuities).toBe(0);
    // The baseline is cleared too, so the next single frame produces no phantom interval
    // measured against a timestamp from before the reset.
    recordFrame(50000, 50004);
    expect(getFrameProfile().samples).toBe(0);
  });
});
