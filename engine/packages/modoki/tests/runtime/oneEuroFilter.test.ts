/** The 1€ filter — the adaptive smoothing behind pointer prediction.
 *
 *  Pure arithmetic (dt is passed in, no DOM, no clock), so its defining PROPERTY is directly
 *  testable without a device: the cutoff rises with speed, so a nearly-still signal is smoothed
 *  hard and a fast one is barely smoothed at all. That is the whole reason it replaced a fixed
 *  EMA, which had to pick one behaviour for both and was measurably wrong at both ends on the
 *  same device.
 *
 *  What is NOT asserted here is which parameters a device wants — that is feel, and it belongs
 *  in front of a human with the debug tuner. */

import { describe, it, expect } from 'vitest';
import {
  createOneEuroFilter, oneEuroAlpha, POINTER_FILTER_DEFAULTS,
} from '../../src/runtime/input/oneEuroFilter';

/** 60 Hz in seconds — the sample rate of the device the pointer work was measured on. */
const DT = 1 / 60;

/** Feed a constant value `n` times and return the last output. */
function settle(f: ReturnType<typeof createOneEuroFilter>, value: number, n: number): number {
  let out = value;
  for (let i = 0; i < n; i++) out = f.filter(value, DT).value;
  return out;
}

describe('oneEuroAlpha', () => {
  it('rises with the cutoff — a higher cutoff means less smoothing', () => {
    const low = oneEuroAlpha(1, DT);
    const high = oneEuroAlpha(100, DT);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThan(low);
  });

  it('rises with the sample gap — a sparser signal must weight each new sample more', () => {
    expect(oneEuroAlpha(1, 1 / 30)).toBeGreaterThan(oneEuroAlpha(1, 1 / 240));
  });
});

describe('createOneEuroFilter', () => {
  it('passes the first sample through untouched', () => {
    // Seeding with the sample, not 0 — otherwise every gesture would begin with the filter
    // sweeping in from the origin.
    const f = createOneEuroFilter({ ...POINTER_FILTER_DEFAULTS });
    const s = f.filter(500, DT);
    expect(s.value).toBe(500);
    expect(s.derivative).toBe(0);
  });

  it('converges to a constant signal', () => {
    const f = createOneEuroFilter({ ...POINTER_FILTER_DEFAULTS });
    f.filter(0, DT);
    expect(settle(f, 100, 300)).toBeCloseTo(100, 1);
  });

  it('SMOOTHS a slow noisy signal — the jitter case', () => {
    // A stationary finger with ±1px of digitizer noise. Heavy smoothing is what should happen.
    const f = createOneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    f.filter(100, DT);
    let maxDev = 0;
    for (let i = 0; i < 60; i++) {
      const noisy = 100 + (i % 2 === 0 ? 1 : -1);
      maxDev = Math.max(maxDev, Math.abs(f.filter(noisy, DT).value - 100));
    }
    // The raw signal deviates by 1px every sample; the filtered one must be far quieter.
    expect(maxDev).toBeLessThan(0.35);
  });

  it('TRACKS a fast signal once beta opens the cutoff — the lag case', () => {
    // The defining property: same filter, same noise, but moving fast. With beta > 0 the cutoff
    // rises with speed, so the output must follow far more closely than the beta:0 case does.
    const ramp = (beta: number): number => {
      const f = createOneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      let v = 0, out = 0;
      for (let i = 0; i < 60; i++) { v += 20; out = f.filter(v, DT).value; }   // 20px per sample
      return v - out;   // how far BEHIND the filter is
    };
    const lagNoBeta = ramp(0);
    const lagWithBeta = ramp(0.05);
    expect(lagWithBeta).toBeLessThan(lagNoBeta);
    expect(lagWithBeta).toBeGreaterThanOrEqual(0);
  });

  it('reports the derivative in units per SECOND', () => {
    const f = createOneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 60 });
    f.filter(0, DT);
    let d = 0;
    for (let i = 1; i <= 120; i++) d = f.filter(i * 6, DT).derivative;   // 6px per 1/60s = 360 px/s
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(400);
  });

  it('reset() forgets history, so one gesture cannot smear into the next', () => {
    const f = createOneEuroFilter({ ...POINTER_FILTER_DEFAULTS });
    settle(f, 1000, 60);
    f.reset();
    // Without the reset the next gesture would start smoothing down from 1000.
    expect(f.filter(10, DT).value).toBe(10);
  });

  it('survives a pathological dt or value rather than poisoning every later sample', () => {
    // The filter is RECURSIVE — one NaN never washes out on its own, it corrupts the signal for
    // the rest of the gesture. So bad input has to be refused at the door.
    const f = createOneEuroFilter({ ...POINTER_FILTER_DEFAULTS });
    f.filter(100, DT);
    f.filter(101, 0);            // dt 0 → would divide by zero
    f.filter(NaN, DT);           // a value the DOM should never produce, but might
    f.filter(102, -5);           // negative dt → a clock that went backwards
    const out = f.filter(103, DT);
    expect(Number.isFinite(out.value)).toBe(true);
    expect(Number.isFinite(out.derivative)).toBe(true);
  });
});
