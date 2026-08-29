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
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  recordFrame, getFrameProfile, resetFrameProfile, setProfilerFrameCap, getWorstStallWindow,
  BUDGET_30FPS_MS, PROFILE_WINDOW_FRAMES, BUDGET_SLACK,
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

  it('SIZES the worst stall, not just counts it — 1.1s and 7s are not the same fault', () => {
    // The count alone was the whole instrument for the boot stall (#212 item 3), and it reads
    // identically for a hitch and a freeze — which is why a 3,926 ms figure could sit unverified.
    feed([
      { frameMs: 16, cpuMs: 4 },
      { frameMs: 1290, cpuMs: 5 },
      { frameMs: 16, cpuMs: 4 },
      { frameMs: 3926, cpuMs: 5 },
      { frameMs: 16, cpuMs: 4 },
    ]);
    const p = getFrameProfile();
    expect(p.discontinuities).toBe(2);
    expect(p.worstStallMs).toBe(3926);   // the WORST, not the latest
    expect(p.frameMs.max).toBe(16);      // and still kept out of the percentiles
  });

  it('records WHEN the worst stall was, so it can be intersected with the boot timeline', () => {
    // #238: "1,814 ms" is unattributable on its own. The window is the coordinate that lets the
    // boot timeline answer what was open across it — which is the difference between a
    // measurement and the three wrong guesses this workstream has already published.
    feed([
      { frameMs: 16, cpuMs: 4 },
      { frameMs: 1290, cpuMs: 5 },
      { frameMs: 16, cpuMs: 4 },
      { frameMs: 3926, cpuMs: 5 },
    ], 1000);
    // Frame starts: 1000, 1016, 2306, 2322, 6248 — the worst stall spans the last interval.
    expect(getWorstStallWindow()).toEqual({ startMs: 2322, endMs: 6248 });
    expect(getFrameProfile().worstStallMs).toBe(3926);
  });

  it('has no stall window before any frame is dropped, and clears it on reset', () => {
    feed([{ frameMs: 16, cpuMs: 4 }, { frameMs: 17, cpuMs: 4 }]);
    expect(getWorstStallWindow()).toBeNull();
    feed([{ frameMs: 2000, cpuMs: 4 }], 50_000);
    expect(getWorstStallWindow()).not.toBeNull();
    resetFrameProfile();
    // A stale window would attribute the NEXT measurement to spans from the previous one.
    expect(getWorstStallWindow()).toBeNull();
  });

  it('reports no stall as 0 rather than a stale high-water mark', () => {
    feed([{ frameMs: 16, cpuMs: 4 }, { frameMs: 17, cpuMs: 4 }]);
    expect(getFrameProfile().worstStallMs).toBe(0);
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

describe('frameProfiler — the two tolerances are separate numbers (#417)', () => {
  // ⚠️ `isVsyncBound` carried two bare `1.2` literals doing DIFFERENT jobs, and two comments in
  // frameProfiler.ts contradicted each other about whether either matched BUDGET_SLACK. The cap
  // branch genuinely IS the same reading against the same cap as `budgetMs`; the display-refresh
  // branch is a pattern-matching tolerance and is unrelated. These guards pin that split.
  //
  // Every threshold below is DERIVED from BUDGET_SLACK, never a hardcoded 1.2 — a test that
  // re-states the constant cannot notice the constant moving, which is the whole failure class.
  afterEach(() => setProfilerFrameCap(0)); // module state — must not leak into other test files

  const CAP_FPS = 30;
  const CAP_MS = 1000 / CAP_FPS;

  it('at a cap no faster than the panel, vsyncBound and overBudget are exact complements', () => {
    // The property that breaks the moment the two thresholds stop sharing BUDGET_SLACK: such a
    // median is one verdict or the other, never both and never neither. Swept across the
    // boundary rather than probed at one point.
    //
    // ⚠️ Scoped to CAP_FPS = 30 on purpose — the complement does NOT hold at every cap, and the
    // next test pins the case where it fails. An earlier version of this comment claimed it held
    // universally, which was the #417 defect class reappearing inside its own fix.
    for (const mult of [0.25, 0.5, 0.9, 0.99, BUDGET_SLACK, BUDGET_SLACK * 1.01, BUDGET_SLACK * 2]) {
      resetFrameProfile();
      setProfilerFrameCap(CAP_FPS);
      feed(Array.from({ length: 20 }, () => ({ frameMs: CAP_MS * mult, cpuMs: 1 })));
      const p = getFrameProfile();
      expect(p.vsyncBound !== p.overBudget, `median = cap * ${mult} produced `
        + `vsyncBound: ${p.vsyncBound}, overBudget: ${p.overBudget} — under a cap these must be `
        + 'complements. isVsyncBound\'s cap branch and budgetMs must both divide at '
        + 'cap * BUDGET_SLACK, from the one constant.').toBe(true);
    }
  });

  it('the capped verdict flips exactly at cap * BUDGET_SLACK, in both directions', () => {
    // Distinguishing the shared threshold from a coincidence: just under is the idle-waiting
    // regime, just over is late. Multipliers sit off the boundary so an ULP cannot decide it.
    for (const [mult, vsyncBound] of [[BUDGET_SLACK * 0.99, true], [BUDGET_SLACK * 1.01, false]] as const) {
      resetFrameProfile();
      setProfilerFrameCap(CAP_FPS);
      feed(Array.from({ length: 20 }, () => ({ frameMs: CAP_MS * mult, cpuMs: 1 })));
      const p = getFrameProfile();
      expect(p.vsyncBound, `at cap * ${mult}`).toBe(vsyncBound);
      expect(p.overBudget, `at cap * ${mult}`).toBe(!vsyncBound);
      expect(p.budgetMs).toBeCloseTo(CAP_MS * BUDGET_SLACK, 6);
    }
  });

  it('a cap FASTER than the panel reports both flags — the complement stops there', () => {
    // The exception the test above is scoped around, pinned rather than merely documented.
    // `targetFps: 120` on a 60Hz panel cannot be met: 16ms measured against a 10ms budget is
    // over budget, and `isVsyncBound` falls through to the refresh branch and recognises the
    // panel. Both flags true, and both correct — that pair is how a reader tells "the display is
    // the floor" from "the engine is too slow". Nothing in the repo authors targetFps > 60 today
    // (`rendering.targetFps` is authored project data and nothing clamps it), so this is latent;
    // it is pinned so the next person to raise a cap finds the behaviour described, not guessed.
    resetFrameProfile();
    setProfilerFrameCap(120);
    feed(Array.from({ length: 20 }, () => ({ frameMs: 16, cpuMs: 1 })));
    const p = getFrameProfile();
    expect(p.budgetMs).toBeCloseTo((1000 / 120) * BUDGET_SLACK, 6);
    expect(p.overBudget, '16ms against a 10ms budget').toBe(true);
    expect(p.vsyncBound, '16ms is within tolerance of the 60Hz interval').toBe(true);
  });

  it('UNCAPPED, the refresh-interval tolerance sits in the 1.2 band, applied to display intervals', () => {
    // ⚠️ This CANNOT distinguish VSYNC_TOLERANCE from BUDGET_SLACK — both hold 1.2, so swapping
    // one for the other in `isVsyncBound` leaves every assertion here green (verified: that
    // mutation passes 26/26). No runtime assertion can separate two constants of equal value;
    // the separation is a SOURCE fact, and the guard for it is the next test. What this one
    // pins is the VALUE and the branch: a median 15% above the 60Hz interval must still be
    // RECOGNISED as 60Hz, one 25% above must not, and the cap must be out of the way for the
    // refresh branch to be the thing answering.
    const HZ60_MS = 1000 / 60;
    for (const [mult, expected] of [[1.15, true], [1.25, false]] as const) {
      resetFrameProfile();
      setProfilerFrameCap(0); // uncapped — only the display-refresh branch can answer
      feed(Array.from({ length: 20 }, () => ({ frameMs: HZ60_MS * mult, cpuMs: 1 })));
      expect(getFrameProfile().vsyncBound, `60Hz interval * ${mult}, uncapped`).toBe(expected);
    }
  });

  // The guard that DOES distinguish them, and the only shape that can while both hold 1.2: a
  // source assertion that each branch names its own constant. Behaviour cannot see the
  // difference; the whole point of #417 was that two numbers were wearing one literal, and a
  // test blind to which constant is used would re-admit exactly that.
  //
  // Negative-only where a comment could forge a pass: the bare-literal ban is a `not.toMatch`,
  // so a `1.2` reappearing inside a comment fails loudly, which is the safe direction.
  it('each branch of isVsyncBound names its own constant — no bare literal returns', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/runtime/core/frameProfiler.ts'),
      'utf8',
    );
    const fn = src.slice(src.indexOf('function isVsyncBound'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body, 'the engine-cap branch must divide at the same constant as budgetMs')
      .toMatch(/frameCapIntervalMs \* BUDGET_SLACK/);
    expect(body, 'the display-refresh branch must use its own tolerance, not the budget slack')
      .toMatch(/iv \* VSYNC_TOLERANCE/);
    expect(body, 'a bare numeric multiplier is back in isVsyncBound — that is #417 exactly')
      .not.toMatch(/\*\s*\d+\.\d+/);
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
    expect(p.worstStallMs).toBe(0);
    // The baseline is cleared too, so the next single frame produces no phantom interval
    // measured against a timestamp from before the reset.
    recordFrame(50000, 50004);
    expect(getFrameProfile().samples).toBe(0);
  });
});
