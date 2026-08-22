/**
 * "When did a human last touch this device?" — the signal tier calibration uses to decide whether
 * its frame profile is evidence at all.
 *
 * A phone nobody is touching has its clocks dropped by the CPU governor, so an idle frame profile
 * describes a THROTTLED device rather than a slow one. Measured on a Galaxy S22 idle on Court's
 * tutorial (bug `lvROp0yDYPSzS0VZM6LH`): ~41.6 ms medians against a 20 ms budget walked the most
 * powerful Android handset in the lab from `high` to `low` in ~66 ticks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteUserInput, msSinceUserInput, hasRecentUserInput, __resetUserActivityForTest,
} from '../../src/runtime/core/userActivity';

beforeEach(() => __resetUserActivityForTest());

describe('userActivity', () => {
  it('reports Infinity — not 0 — before any input has ever been seen', () => {
    // The distinction is load-bearing: a 0 here would read as "the player just touched it" on a
    // freshly booted device, which is the exact window the S22 demoted itself in.
    expect(msSinceUserInput(1000)).toBe(Infinity);
    expect(hasRecentUserInput(1000, 5000)).toBe(false);
  });

  it('measures from the last input', () => {
    noteUserInput(1000);
    expect(msSinceUserInput(3500)).toBe(2500);
    expect(hasRecentUserInput(3500, 5000)).toBe(true);
    expect(hasRecentUserInput(6500, 5000)).toBe(false);
  });

  it('treats the window as exclusive at its edge', () => {
    noteUserInput(0);
    expect(hasRecentUserInput(4999, 5000)).toBe(true);
    expect(hasRecentUserInput(5000, 5000)).toBe(false);
  });

  it('takes the MOST RECENT input, so a later touch reopens the window', () => {
    noteUserInput(0);
    noteUserInput(10_000);
    expect(hasRecentUserInput(12_000, 5000)).toBe(true);
  });

  it('takes `now` from the caller and keeps no clock of its own', () => {
    // Deliberate: the determinism guard forbids a bare wall-clock read in runtime/**, and a test
    // must be able to drive this without faking one.
    noteUserInput(500);
    expect(msSinceUserInput(500)).toBe(0);
  });
});
