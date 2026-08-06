/** Profiler counters (profiler plan P9) — `runtime/core/profilerCounters.ts`.
 *
 *  The distinction under test is levels vs rates. Getting it backwards produces a quiet wrong
 *  answer in BOTH directions — a level that resets reads as a system that keeps emptying, and a
 *  rate that persists reads as work still happening after it stopped — so the two semantics are
 *  separate functions rather than a flag, and these tests pin each one's frame-boundary
 *  behaviour. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setCounter, countEvent, recordCounterFrame, getCounters, resetCounters,
  MAX_COUNTERS, COUNTER_WINDOW_FRAMES,
} from '../../src/runtime/core/profilerCounters';
import { setProfilerEnabled } from '../../src/runtime/core/profilerMarkers';

const find = (name: string) => getCounters().counters.find((c) => c.name === name);

beforeEach(() => {
  resetCounters();
  setProfilerEnabled(true);
});

afterEach(() => {
  setProfilerEnabled(false);
  resetCounters();
});

describe('profilerCounters — levels persist', () => {
  it('a level carries across frames that do not set it', () => {
    // "enemies alive" does not become 0 on a frame nobody counted.
    setCounter('enemies', 12);
    recordCounterFrame();
    recordCounterFrame();
    recordCounterFrame();
    expect(find('enemies')).toMatchObject({ kind: 'level', current: 12, median: 12 });
  });

  it('a level follows its last set value', () => {
    setCounter('pool', 4); recordCounterFrame();
    setCounter('pool', 9); recordCounterFrame();
    expect(find('pool')!.current).toBe(9);
    expect(find('pool')!.max).toBe(9);
  });
});

describe('profilerCounters — rates reset', () => {
  it('an event counter accumulates within a frame and resets at the boundary', () => {
    // "spawns this frame" genuinely IS 0 on a frame with no spawns.
    countEvent('spawns'); countEvent('spawns'); countEvent('spawns');
    recordCounterFrame();
    expect(find('spawns')).toMatchObject({ kind: 'rate', current: 3 });

    recordCounterFrame(); // a frame with no spawns
    expect(find('spawns')!.current).toBe(0);
  });

  it('countEvent takes an increment', () => {
    countEvent('bytes', 500);
    countEvent('bytes', 250);
    recordCounterFrame();
    expect(find('bytes')!.current).toBe(750);
  });

  it('max remembers the busiest frame after the rate has reset', () => {
    countEvent('spawns', 40); recordCounterFrame();
    for (let i = 0; i < 5; i++) recordCounterFrame();
    expect(find('spawns')!.current).toBe(0);
    expect(find('spawns')!.max).toBe(40);
  });
});

describe('profilerCounters — statistics and limits', () => {
  it('reports the median over the window', () => {
    for (let i = 0; i < 10; i++) { setCounter('n', 5); recordCounterFrame(); }
    setCounter('n', 999); recordCounterFrame();
    expect(find('n')!.median).toBe(5);
    expect(find('n')!.max).toBe(999);
  });

  it('retains only the window', () => {
    setCounter('n', 100);
    recordCounterFrame();
    setCounter('n', 1);
    for (let i = 0; i < COUNTER_WINDOW_FRAMES; i++) recordCounterFrame();
    expect(find('n')!.max).toBe(1); // the 100 has aged out
  });

  it('caps distinct counters and REPORTS it', () => {
    for (let i = 0; i < MAX_COUNTERS + 10; i++) setCounter(`c${i}`, 1);
    recordCounterFrame();
    const rep = getCounters();
    expect(rep.counters.length).toBeLessThanOrEqual(MAX_COUNTERS);
    expect(rep.truncated).toBe(true);
  });

  it('records nothing while profiling is off', () => {
    setProfilerEnabled(false);
    setCounter('x', 5);
    countEvent('y');
    recordCounterFrame();
    expect(getCounters().counters).toHaveLength(0);
  });
});
