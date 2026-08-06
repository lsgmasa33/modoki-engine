/** Marker aggregation (profiler plan P3) — `runtime/core/profilerAggregate.ts`.
 *
 *  Frames are simulated by driving the marker core with the manual clock, so every statistic
 *  here is exact.
 *
 *  The claims worth pinning are the ones a reader would otherwise take on trust: that the
 *  ranking is by SELF time (a parent's total would otherwise always win and the ranking would
 *  just re-list the tree top-down), that same-named markers under different parents stay
 *  distinct, and that `presence` uses the right denominator — a marker in 3 of 120 frames is a
 *  different claim from one in all 120. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setProfilerEnabled, beginProfilerSample, endProfilerSample, beginProfilerFrame, endProfilerFrame,
  resetProfilerMarkers,
} from '../../src/runtime/core/profilerMarkers';
import {
  recordMarkerFrame, getMarkerAggregate, getMarkerRanking, resetMarkerAggregate,
  MARKER_WINDOW_FRAMES,
} from '../../src/runtime/core/profilerAggregate';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

/** Run one whole frame built by `body`, and fold it into the window. */
function frame(body: () => void) {
  beginProfilerFrame();
  body();
  endProfilerFrame();
  recordMarkerFrame();
}

function span(name: string, ms: number, inner?: () => void) {
  beginProfilerSample(name);
  advanceManual(ms);
  inner?.();
  endProfilerSample();
}

const find = (path: string) => getMarkerAggregate().ranking.find((r) => r.path === path);

beforeEach(() => {
  resetProfilerMarkers();
  resetMarkerAggregate();
  setProfilerEnabled(true);
  setManualNow(0);
});

afterEach(() => {
  setProfilerEnabled(false);
  resetProfilerMarkers();
  resetMarkerAggregate();
  restoreRealClock();
});

describe('profilerAggregate — the ranking', () => {
  it('ranks by SELF time, so a parent does not outrank the child that costs the time', () => {
    // Without this the ranking would just re-list the tree top-down: every ancestor's total
    // includes its children, so 'frame' would always be #1 and tell you nothing.
    for (let i = 0; i < 10; i++) {
      frame(() => {
        beginProfilerSample('ecs');
        advanceManual(1);          // 1ms of ecs's own work
        span('physics', 20);       // the real cost
        endProfilerSample();
      });
    }
    const ranking = getMarkerAggregate().ranking;
    expect(ranking[0].name).toBe('physics');
    expect(ranking[0].selfMs).toBe(20);
    expect(find('frame/ecs')!.selfMs).toBe(1);
  });

  it('keeps same-named markers under different parents distinct', () => {
    for (let i = 0; i < 5; i++) {
      frame(() => {
        beginProfilerSample('scene-a'); span('sync', 3); endProfilerSample();
        beginProfilerSample('scene-b'); span('sync', 9); endProfilerSample();
      });
    }
    expect(find('frame/scene-a/sync')!.selfMs).toBe(3);
    expect(find('frame/scene-b/sync')!.selfMs).toBe(9);
  });

  it('excludes the synthetic `frame` root — it is structure, not a measured span', () => {
    // Found on a live editor: the root is never sampled, so it contributed a permanent all-zero
    // row that cost a slot in the top-N an agent pays response budget for.
    for (let i = 0; i < 5; i++) frame(() => span('ecs', 3));
    const agg = getMarkerAggregate();
    expect(agg.ranking.find((r) => r.path === 'frame')).toBeUndefined();
    expect(agg.ranking.map((r) => r.name)).toContain('ecs');
    // ...but it remains the root of the TREE, where it is the structure.
    expect(agg.tree?.name).toBe('frame');
  });

  it('getMarkerRanking(n) truncates to the worst n', () => {
    for (let i = 0; i < 5; i++) {
      frame(() => { span('a', 30); span('b', 20); span('c', 10); });
    }
    const top = getMarkerRanking(2);
    expect(top).toHaveLength(2);
    expect(top.map((r) => r.name)).toEqual(['a', 'b']);
  });
});

describe('profilerAggregate — statistics', () => {
  it('reports the MEDIAN, so one outlier frame does not dominate', () => {
    for (let i = 0; i < 20; i++) frame(() => span('steady', 5));
    frame(() => span('steady', 500));
    const s = find('frame/steady')!;
    expect(s.selfMs).toBe(5);
  });

  it('MAX catches a one-off hitch that the median and p95 both correctly hide', () => {
    // 1 spike in 21 frames is 4.8% of samples, so p95 legitimately excludes it — and
    // "legitimately excludes" is exactly wrong when the stutter IS what you are hunting.
    // Median = what it costs normally, max = what it costs at its worst.
    for (let i = 0; i < 20; i++) frame(() => span('steady', 5));
    frame(() => span('steady', 500));
    const s = find('frame/steady')!;
    expect(s.selfP95).toBe(5);
    expect(s.selfMax).toBe(500);
  });

  it('p95 DOES catch a spike that recurs often enough to matter', () => {
    for (let i = 0; i < 20; i++) frame(() => span('janky', i % 5 === 0 ? 90 : 5));
    const s = find('frame/janky')!;
    expect(s.selfMs).toBe(5);
    expect(s.selfP95).toBe(90);
  });

  it('counts calls per frame for a marker entered several times', () => {
    for (let i = 0; i < 4; i++) {
      frame(() => { span('sys', 2); span('sys', 2); span('sys', 2); });
    }
    const s = find('frame/sys')!;
    expect(s.callsPerFrame).toBe(3);
    expect(s.selfMs).toBe(6);
  });

  it('presence distinguishes an every-frame marker from an occasional one', () => {
    for (let i = 0; i < 10; i++) {
      frame(() => {
        span('always', 1);
        if (i < 2) span('rare', 50);
      });
    }
    expect(find('frame/always')!.presence).toBe(1);
    expect(find('frame/rare')!.presence).toBeCloseTo(0.2, 5);
  });

  it('a rare-but-expensive marker is not hidden by its rarity', () => {
    // presence is reported SEPARATELY rather than folded into the number, so a 50ms hitch in
    // 2 of 10 frames still ranks on its cost and the reader decides what to make of it.
    for (let i = 0; i < 10; i++) {
      frame(() => { span('always', 1); if (i < 2) span('rare', 50); });
    }
    expect(getMarkerAggregate().ranking[0].name).toBe('rare');
  });

  it('tracks frames recorded', () => {
    for (let i = 0; i < 7; i++) frame(() => span('x', 1));
    expect(getMarkerAggregate().framesRecorded).toBe(7);
  });
});

describe('profilerAggregate — the window', () => {
  it('retains only the most recent MARKER_WINDOW_FRAMES per marker', () => {
    for (let i = 0; i < 30; i++) frame(() => span('m', 100));
    for (let i = 0; i < MARKER_WINDOW_FRAMES; i++) frame(() => span('m', 4));
    // The slow frames have aged out entirely.
    const s = find('frame/m')!;
    expect(s.selfMs).toBe(4);
    expect(s.selfP95).toBe(4);
  });

  it('resetMarkerAggregate clears the window', () => {
    for (let i = 0; i < 5; i++) frame(() => span('m', 3));
    resetMarkerAggregate();
    const agg = getMarkerAggregate();
    expect(agg.framesRecorded).toBe(0);
    expect(agg.ranking).toEqual([]);
  });
});

describe('profilerAggregate — disabled', () => {
  it('records nothing while markers are off', () => {
    setProfilerEnabled(false);
    for (let i = 0; i < 5; i++) frame(() => span('m', 3));
    expect(getMarkerAggregate().framesRecorded).toBe(0);
  });
});
