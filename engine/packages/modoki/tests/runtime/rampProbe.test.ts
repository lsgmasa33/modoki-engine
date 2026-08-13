/** Boot ramp probe (#188) — the pure ramp policy and throughput maths.
 *
 *  Everything here is headless by construction: the module renders nothing and reads no clock,
 *  so a ramp is driven by feeding it a fabricated sequence of frame times. The interesting cases
 *  are the ones vsync creates — quantized frame times, a hiccup that looks like escape, and a
 *  device that never escapes at all — and each has its own block below.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startRamp, rampNextLoad, recordRampFrame, readRamp, estimateIntervalMs, classifyDevice,
  ESCAPE_MULTIPLE, ESCAPE_PRIOR_MULTIPLE, ABORT_FRAME_MS, RAMP_BOUNDS, PROBE_THRESHOLDS, probeFingerprint, fillMegapixelsPerMs,
  shadeMegaFragmentsPerMs,
  refineProbeVerdict, PROBE_SAMPLE_TARGET, readingOf, classifyReading, PROBE_THRESHOLDS_2D,
  type RampKind, type RampState, type RampReading, type ProbeMeasurement, type ProbeReading,
} from '../../src/runtime/rendering/rampProbe';

const INTERVAL = 1000 / 60; // 16.667 ms — a 60 Hz panel

/** Drive a ramp to completion, asking `frameFor(load)` what each frame costs. */
function runRamp(kind: RampKind, frameFor: (load: number) => number, interval = INTERVAL): RampState {
  let s = startRamp(kind, interval);
  for (let guard = 0; guard < 64; guard++) {
    const load = rampNextLoad(s);
    if (load === null) return s;
    s = recordRampFrame(s, frameFor(load));
  }
  throw new Error('ramp did not terminate');
}

/** A device with a real, finite throughput, presented through vsync.
 *
 *  This is the model the whole module is built against: work costs `overheadMs` plus
 *  `load / unitsPerMs`, and the compositor then rounds the presented frame UP to the next whole
 *  display interval. The quantization is the point — a naive `load / frameMs` reading cannot
 *  survive it, and the slope estimator has to. */
function vsyncDevice(unitsPerMs: number, overheadMs: number, interval = INTERVAL) {
  return (load: number) => {
    const work = overheadMs + load / unitsPerMs;
    return Math.ceil(Math.max(work, 0.0001) / interval) * interval;
  };
}

/** Shared measurement/reading fixtures, reused by several `describe` blocks below — including
 *  classifyDevice's cpu/shade classification tests and the fill/draw evidence-only tests, both
 *  #188's axis swap (2026-08-11) — extended with optional shade/cpu params rather than growing a
 *  fourth parallel factory. `fillMegapixelsPerMs` keeps its own smaller, block-local fixtures for
 *  its pre-existing tests; that ramp is unaffected by the swap. */
const readingFixture = (kind: RampKind, unitsPerMs: number, bound: RampReading['bound'] = 'measured'): RampReading => ({
  kind, status: bound === 'lower' ? 'ceiling' : bound === 'none' ? 'budget' : 'escaped',
  unitsPerMs, bound, peakLoad: 64, steps: [],
});
const measurementFixture = (
  fill: RampReading,
  draw: RampReading,
  extra?: { shade?: RampReading; cpu?: RampReading; shadeRegionPixels?: number },
): ProbeMeasurement => ({
  intervalMs: 16.7, clockKind: 'webgpu', axes: '3d', fill, draw,
  totalMs: 280, rendererMs: 60, compileMs: 18, shadeCompileMs: 0,
  bufferPixels: 1_000_000, shadeRegionPixels: extra?.shadeRegionPixels ?? 0,
  ...(extra?.shade ? { shade: extra.shade } : {}),
  ...(extra?.cpu ? { cpu: extra.cpu } : {}),
});
/** `shadeMegaFragmentsPerMs` multiplies `shade.unitsPerMs` by `shadeRegionPixels / 1e6`, so a
 *  fixture that wants a specific Mfrag/ms figure at the real 10,000px (100x100) region must
 *  convert: `unitsPerMs = mfrag * 100`. Kept next to `readingFixture` as the one place that
 *  conversion happens, rather than repeating the arithmetic at every call site. */
const shadeReading = (mfragPerMs: number, bound: RampReading['bound'] = 'measured'): RampReading =>
  readingFixture('shade', mfragPerMs * 100, bound);

describe('estimateIntervalMs', () => {
  it('takes the median so one slow warm-up frame cannot inflate the threshold', () => {
    // A first frame that pays for an allocation. A mean would read 25.6 and push the escape
    // threshold 50% too high, hiding a slow device behind its own warm-up.
    expect(estimateIntervalMs([50, 16.7, 16.7, 16.7, 16.7])).toBeCloseTo(16.7, 5);
  });

  it('averages the middle pair for an even sample count', () => {
    expect(estimateIntervalMs([10, 20, 30, 40])).toBe(25);
  });

  it('drops non-finite and non-positive samples', () => {
    expect(estimateIntervalMs([Number.NaN, 0, -5, 16.7, 16.7])).toBeCloseTo(16.7, 5);
  });

  it('returns 0 for nothing usable — a failed probe, not an infinitely fast display', () => {
    expect(estimateIntervalMs([])).toBe(0);
    expect(estimateIntervalMs([Number.NaN, -1])).toBe(0);
  });
});

describe('RAMP_BOUNDS — total over every RampKind', () => {
  it('gives every kind a start below its max, both powers of two — the ramp only ever doubles', () => {
    // A non-power-of-two ceiling is never actually reached: `recordRampFrame` only ever doubles
    // `nextLoad`, so a maxLoad off the doubling sequence from startLoad would sit forever out of
    // reach and the ramp would report `'ceiling'` at some ODD load nobody chose. Bitwise, not
    // `Math.log2`, to sidestep any float rounding on the larger bounds (cpu's maxLoad is 2097152).
    const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
    const kinds: readonly RampKind[] = ['fill', 'draw', 'shade', 'cpu'];
    for (const kind of kinds) {
      const bounds = RAMP_BOUNDS[kind];
      expect(bounds).toBeDefined();
      expect(bounds.startLoad).toBeLessThan(bounds.maxLoad);
      expect(isPowerOfTwo(bounds.startLoad)).toBe(true);
      expect(isPowerOfTwo(bounds.maxLoad)).toBe(true);
    }
  });
});

describe('startRamp', () => {
  it('starts at the kind\'s start load', () => {
    expect(rampNextLoad(startRamp('fill', INTERVAL))).toBe(RAMP_BOUNDS.fill.startLoad);
    expect(rampNextLoad(startRamp('draw', INTERVAL))).toBe(RAMP_BOUNDS.draw.startLoad);
  });

  it('refuses to run at all without a measured interval', () => {
    // Every threshold in the ramp is expressed as a multiple of the interval, so a probe that
    // could not measure one has nothing to compare against and must not render.
    const s = startRamp('fill', 0);
    expect(s.status).toBe('budget');
    expect(rampNextLoad(s)).toBeNull();
  });
});

describe('recordRampFrame — the ramp itself', () => {
  it('doubles the load each step', () => {
    let s = startRamp('draw', INTERVAL);
    const loads: number[] = [];
    for (let i = 0; i < 4; i++) {
      loads.push(rampNextLoad(s)!);
      s = recordRampFrame(s, INTERVAL);
    }
    expect(loads).toEqual([32, 64, 128, 256]);
  });

  it('never exceeds the ceiling load, and a device that never escapes still yields a bound', () => {
    // The status may be 'ceiling' OR 'budget' depending on how many frames the allowance affords
    // — which of the two is an artifact of the budget, not a property worth asserting. What must
    // hold is that the load is capped and the ramp still produced an answer.
    const s = runRamp('fill', () => INTERVAL);
    expect(Math.max(...s.steps.map((x) => x.load))).toBeLessThanOrEqual(RAMP_BOUNDS.fill.maxLoad);
    expect(['ceiling', 'budget']).toContain(s.status);
    expect(readRamp(s).bound).toBe('lower');
  });

  it('is inert once finished — a late frame cannot revive or corrupt it', () => {
    const done = runRamp('fill', () => INTERVAL);
    expect(recordRampFrame(done, 999)).toBe(done);
  });

  it('does not mutate the state it is handed', () => {
    const s = startRamp('fill', INTERVAL);
    const before = { ...s, steps: [...s.steps] };
    recordRampFrame(s, INTERVAL);
    expect(s.nextLoad).toBe(before.nextLoad);
    expect(s.steps).toHaveLength(0);
  });
});

describe('escape detection', () => {
  it('rejects a spike out of a vsync-PINNED frame — that is a hiccup, not load', () => {
    // The predecessor sits at 1.0x the interval, so there is no second real point to draw a slope
    // between; whatever the spike is, it is not a measurement.
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL);
    s = recordRampFrame(s, INTERVAL * ESCAPE_MULTIPLE + 1);
    expect(s.status).toBe('running');
  });

  it('ACCEPTS a straining predecessor below 3x — measured on a real iPhone 8', () => {
    // The rule used to demand BOTH steps clear 3x, and that discarded a measurement the probe had
    // already paid for: an iPhone 8's draw ramp ran 512 calls in ~38ms then 1024 in ~76ms — a
    // clean doubling with 2x growth — but 38ms is only 2.2x a 17ms interval, so it was thrown
    // away, and reaching a step where both frames cleared 3x cost more than the whole budget.
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL);  // load 32, still pinned — MIN_STEPS_BEFORE_ESCAPE
    s = recordRampFrame(s, 38);        // load 64
    s = recordRampFrame(s, 76);        // load 128
    expect(s.status).toBe('escaped');
    const r = readRamp(s);
    expect(r.bound).toBe('measured');
    expect(r.unitsPerMs).toBeCloseTo(64 / 38, 3); // (128-64) calls over (76-38) ms
  });

  it('still rejects a predecessor that is barely off the pin', () => {
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL * (ESCAPE_PRIOR_MULTIPLE - 0.2));
    s = recordRampFrame(s, INTERVAL * 6);
    expect(s.status).toBe('running');
  });

  it('does not count a frame merely OVER the interval — vsync quantization lands there', () => {
    // A frame that misses one slot presents at exactly 2x the interval on a 60 Hz panel. If that
    // counted as escape the ramp would measure a slope off two missed slots.
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL * 2);
    s = recordRampFrame(s, INTERVAL * 2);
    expect(s.status).toBe('running');
  });

  it('escapes once two consecutive steps clear the threshold', () => {
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL);      // MIN_STEPS_BEFORE_ESCAPE — the settling guard
    s = recordRampFrame(s, INTERVAL * 4);
    expect(s.status).toBe('running');
    s = recordRampFrame(s, INTERVAL * 8);
    expect(s.status).toBe('escaped');
  });

  it('will NOT escape in the first couple of steps, however long those frames are', () => {
    // Measured: an iPhone 7 escaped the FILL ramp at LOAD 2 and reported 0.014 Mpx/ms — three
    // orders of magnitude out — off two slow frames right after the shader compile. At that load
    // a long frame cannot be the load; it is the pipeline still settling.
    let s = startRamp('fill', INTERVAL);
    s = recordRampFrame(s, INTERVAL * 4);
    s = recordRampFrame(s, INTERVAL * 9);
    // It may well end on 'budget' — those are long frames. What must NOT happen is a confident
    // throughput off the first two steps.
    expect(s.status).not.toBe('escaped');
    expect(readRamp(s).bound).not.toBe('measured');
  });

  it('escape beats the budget on the last affordable frame', () => {
    // The slow-device case: frames are long, so the budget runs out at almost the same moment
    // escape happens. Checking the budget first would discard the measurement it just paid for.
    let s = startRamp('fill', INTERVAL);
    s = recordRampFrame(s, 20);
    s = recordRampFrame(s, 120);
    expect(s.status).toBe('running');
    s = recordRampFrame(s, 140); // elapsed 280 >= the 150 ms ramp budget, but this IS the escape
    expect(s.status).toBe('escaped');
    expect(readRamp(s).bound).toBe('measured');
  });
});

describe('abort — the watchdog guard', () => {
  it('stops on the first frame at or past the abort ceiling', () => {
    let s = startRamp('fill', INTERVAL);
    s = recordRampFrame(s, ABORT_FRAME_MS);
    expect(s.status).toBe('aborted');
    expect(rampNextLoad(s)).toBeNull();
  });

  it('aborts even when that same frame would have completed an escape', () => {
    // Escape is the outcome we want, but not at the price of another doubling on a device that
    // just produced a quarter-second frame — that is the road to the lost context (#156).
    let s = startRamp('fill', INTERVAL);
    s = recordRampFrame(s, INTERVAL * 4);
    s = recordRampFrame(s, ABORT_FRAME_MS + 10);
    expect(s.status).toBe('aborted');
    expect(readRamp(s).bound).toBe('none');
  });

  it('treats a non-finite frame time as an abort', () => {
    expect(recordRampFrame(startRamp('fill', INTERVAL), Number.NaN).status).toBe('aborted');
  });
});

describe('readRamp — throughput', () => {
  it('recovers a device\'s real throughput despite vsync quantization and fixed overhead', () => {
    // 4 units/ms with 5 ms of per-frame overhead, presented through a 60 Hz compositor. A naive
    // `load / frameMs` at the escape step would read ~1.9 — off by more than 2x, because it
    // charges the overhead and the quantization to the load. The slope should not.
    const s = runRamp('draw', vsyncDevice(4, 5));
    const r = readRamp(s);
    expect(r.bound).toBe('measured');
    expect(r.unitsPerMs).toBeGreaterThan(3);
    expect(r.unitsPerMs).toBeLessThan(5.5);
  });

  it('NEVER OVERSTATES an overhead-dominated device', () => {
    // 40 ms of constant cost swamps the load term for the first several doublings. Once the load
    // does show through, the slope is recoverable but coarse — vsync quantization rounds every
    // reading up to a whole interval, which flattens the measured growth and understates the
    // device.
    //
    // The property that must hold is DIRECTIONAL, so that is what is asserted. Understating
    // throughput sends a device to the low tier, which is the recoverable mistake (see
    // qualityTier's module header); overstating it is the one that costs a GPU context. The size
    // of the error is a known limitation; its SIGN is a guarantee.
    const r = readRamp(runRamp('draw', vsyncDevice(8, 40)));
    expect(r.unitsPerMs).toBeGreaterThan(0);
    expect(r.unitsPerMs).toBeLessThanOrEqual(8);
  });

  it('reports a LOWER bound when a strong device never escapes', () => {
    const s = runRamp('draw', () => INTERVAL);
    const r = readRamp(s);
    expect(r.bound).toBe('lower');
    expect(r.unitsPerMs).toBeCloseTo(r.peakLoad / INTERVAL, 5);
  });

  it('divides a lower bound by the FRAME, not the interval, when the ramp ran long', () => {
    // Over-loaded but never past the escape threshold: frames sit at 2x the interval until the
    // budget runs out. Dividing by the interval here would claim twice the throughput shown.
    const s = runRamp('draw', () => INTERVAL * 2);
    const r = readRamp(s);
    expect(r.status).toBe('budget');
    expect(r.bound).toBe('lower');
    expect(r.unitsPerMs).toBeCloseTo(r.peakLoad / (INTERVAL * 2), 5);
  });

  it('keeps ramping when two long frames did not GROW — a long frame is not an escaped frame', () => {
    // Both steps are well past the threshold and identical: the cost is fixed overhead, not the
    // load. Stopping here would hand the slope estimator two identical points; the correct move
    // is to keep doubling until the load actually shows up.
    let s = startRamp('draw', INTERVAL);
    s = recordRampFrame(s, INTERVAL * 3.5);
    s = recordRampFrame(s, INTERVAL * 3.5);
    expect(s.status).toBe('running');
    expect(rampNextLoad(s)).toBe(128);

    // ...and it escapes as soon as the frame does grow.
    s = recordRampFrame(s, INTERVAL * 4.5);
    expect(s.status).toBe('escaped');
    expect(readRamp(s).bound).toBe('measured');
  });

  it('refuses rather than fitting from index 0 when trimming leaves nothing else', () => {
    // ⚠️ Found in close-out review, and it OVERSTATES. `MIN_STEPS_BEFORE_ESCAPE` is 3, so a 3-step
    // ramp is the legal minimum, not a degenerate one — and if its final step spiked, the trim
    // walks `bi` to 1 and both candidate searches need `0 < i < 1`, which is unsatisfiable. A
    // fallback to `steps[bi - 1]` would hand back index 0, the pipeline-switch step the rule exists
    // to refuse: on these numbers it would fit 4:10 -> 8:26, reporting 0.25 units/ms off a step it
    // is not allowed to use. Two points is not a fit; saying so is the only honest answer.
    let s = startRamp('shade', 16.7, 4_000);
    for (const ms of [10, 26, 90]) s = recordRampFrame(s, ms);
    expect(s.status).toBe('escaped');
    expect(readRamp(s)).toMatchObject({ bound: 'none', unitsPerMs: 0 });
  });

  it('ends the ramp on a NEGATIVE frame time — a backwards clock is not a fast frame', () => {
    // A negative elapsed time is finite and under the abort bar, so it used to record as an
    // ordinary step and could become a fit endpoint: `[-50, 24, 80]` produced a confident
    // `'measured'` reading built on a physically impossible input. This module already handles the
    // opposite clock pathology (iOS quantizing to whole milliseconds); this is the same care for a
    // clock that runs backwards.
    let s = startRamp('shade', 16.7, 4_000);
    s = recordRampFrame(s, -50);
    expect(s.status).toBe('aborted');
    expect(readRamp(s)).toMatchObject({ bound: 'none' });
  });

  it('a lower bound NEVER overstates on a fluke-fast final frame', () => {
    // ⚠️ Found in close-out review, and it is the dangerous direction. `peakLoad / lastMs` trusted a
    // single frame: a ceiling ramp whose last frame happens to come in at 5 ms among 20s reports
    // 819.2 calls/ms against a representative 204.8 — 4x high, enough to clear the `capable` floor
    // on a device that cannot sustain it. iOS makes it likelier, quantizing performance.now() to
    // 1 ms so a cheap final step reads 1. Taking the slower of the last two frames is strictly
    // conservative and a no-op whenever load growth makes the last step the slowest, which is the
    // normal case.
    let s = startRamp('draw', 16.7, 4_000);
    for (const ms of [20, 20, 20, 20, 20, 20, 20, 5]) s = recordRampFrame(s, ms);
    const r = readRamp(s);
    expect(r.bound).toBe('lower');
    expect(r.unitsPerMs).toBeCloseTo(r.peakLoad / 20, 5);
    expect(r.unitsPerMs).toBeLessThan(r.peakLoad / 5);
  });

  it('leaves an ordinary lower bound alone — the guard must not tax the normal case', () => {
    // Load grows, so the last frame is the slowest and `Math.max` picks exactly what the old code
    // picked. A conservative guard that also moved normal readings would silently re-band devices.
    let s = startRamp('draw', 16.7, 4_000);
    for (const ms of [5, 6, 8, 11, 14, 17, 20, 24]) s = recordRampFrame(s, ms);
    const r = readRamp(s);
    expect(r.bound).toBe('lower');
    expect(r.unitsPerMs).toBeCloseTo(r.peakLoad / 24, 5);
  });

  it('reports nothing usable for an aborted ramp with no prior steps', () => {
    const r = readRamp(recordRampFrame(startRamp('fill', INTERVAL), 400));
    expect(r).toMatchObject({ bound: 'none', unitsPerMs: 0, peakLoad: RAMP_BOUNDS.fill.startLoad });
  });

  it('ranks a fast device above a slow one on the same ramp', () => {
    // The property that actually matters downstream: whatever the absolute error, the ORDER of
    // two devices must survive the estimator.
    const fast = readRamp(runRamp('draw', vsyncDevice(20, 2)));
    const slow = readRamp(runRamp('draw', vsyncDevice(2, 2)));
    expect(fast.unitsPerMs).toBeGreaterThan(slow.unitsPerMs);
  });
});

describe('fillMegapixelsPerMs — the ramp\'s raw fill number is NOT comparable across devices', () => {
  const reading = (unitsPerMs: number): RampReading => ({
    kind: 'fill', status: 'escaped', unitsPerMs, bound: 'measured', peakLoad: 32, steps: [],
  });
  const m = (fillUnits: number, bufferPixels: number): ProbeMeasurement => ({
    intervalMs: INTERVAL, clockKind: 'webgpu', axes: '2d', fill: reading(fillUnits),
    draw: { kind: 'draw', status: 'escaped', unitsPerMs: 50, bound: 'measured', peakLoad: 512, steps: [] },
    totalMs: 300, rendererMs: 10, compileMs: 3, shadeCompileMs: 0, bufferPixels, shadeRegionPixels: 0,
  });

  it('converts screens-per-ms into pixels-per-ms', () => {
    expect(fillMegapixelsPerMs(m(2, 1_000_000))).toBeCloseTo(2, 6);
  });

  it('REVERSES the ranking a raw comparison would produce', () => {
    // This is the whole reason the function exists. A small phone (0.5 MP buffer) doing 4
    // screens/ms is pushing 2 Mpx/ms; a tablet (3.5 MP) doing 2 screens/ms is pushing 7 Mpx/ms.
    // Compared raw, the PHONE looks 2x faster -- for the sole reason that its screen is smaller.
    // That is exactly backwards, and it would have set the thresholds off the wrong device.
    const phone = m(4, 500_000);
    const tablet = m(2, 3_500_000);
    expect(phone.fill!.unitsPerMs).toBeGreaterThan(tablet.fill!.unitsPerMs);     // raw: phone wins
    expect(fillMegapixelsPerMs(tablet)).toBeGreaterThan(fillMegapixelsPerMs(phone)); // real: tablet
  });

  it('is 0 when there is no usable reading or no buffer size', () => {
    const noRead = { ...m(4, 500_000), fill: { ...reading(0), bound: 'none' as const } };
    expect(fillMegapixelsPerMs(noRead)).toBe(0);
    expect(fillMegapixelsPerMs(m(4, 0))).toBe(0);
  });
});

describe('shadeMegaFragmentsPerMs — the same treatment fillMegapixelsPerMs gives fill (#188)', () => {
  it('normalises instances/ms by the FIXED shade region into millions of shaded fragments/ms', () => {
    // 4 instances/ms over a 10,000px (100x100) region is 40,000 fragments/ms, i.e. 0.04 Mfrag/ms.
    const m = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      shade: readingFixture('shade', 4), shadeRegionPixels: 10_000,
    });
    expect(shadeMegaFragmentsPerMs(m)).toBeCloseTo(0.04, 6);
  });

  it('is 0 when the measurement carries no shade reading at all', () => {
    // The common case on a backend that refused the heavy material — fill/draw still measured,
    // shade simply absent.
    const m = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30));
    expect(shadeMegaFragmentsPerMs(m)).toBe(0);
  });

  it('is 0 when the shade ramp produced no usable reading', () => {
    const m = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      shade: readingFixture('shade', 0, 'none'), shadeRegionPixels: 10_000,
    });
    expect(shadeMegaFragmentsPerMs(m)).toBe(0);
  });

  it('is 0 when the region collapsed to nothing — a buffer too small to host it', () => {
    const m = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      shade: readingFixture('shade', 4), shadeRegionPixels: 0,
    });
    expect(shadeMegaFragmentsPerMs(m)).toBe(0);
  });
});

describe('probeFingerprint — what invalidates a cached verdict', () => {
  const base = { platform: 'android', deviceModel: 'SM-A236B', gpuRenderer: 'Adreno (TM) 610', viewportPx: 360 * 760 };

  it('is stable for the same hardware', () => {
    expect(probeFingerprint(base)).toBe(probeFingerprint({ ...base }));
  });

  it('changes when the GPU RENDERER changes — a driver update can move throughput', () => {
    // The renderer string is useless as a tier signal on its own (that ambiguity is why Android
    // needs a probe at all), but it is exactly right as a cache key: it moves with the driver.
    expect(probeFingerprint({ ...base, gpuRenderer: 'Adreno (TM) 619' })).not.toBe(probeFingerprint(base));
  });

  it('changes when the device does — a restored backup must not carry a verdict across hardware', () => {
    expect(probeFingerprint({ ...base, deviceModel: 'Pixel 7' })).not.toBe(probeFingerprint(base));
    expect(probeFingerprint({ ...base, platform: 'ios' })).not.toBe(probeFingerprint(base));
  });

  it('survives a rotation and a nudged window — those are not new hardware', () => {
    // Keying on the exact viewport would re-run a LAUNCH-BLOCKING probe every rotation.
    expect(probeFingerprint({ ...base, viewportPx: 760 * 360 })).toBe(probeFingerprint(base));
    expect(probeFingerprint({ ...base, viewportPx: 360 * 760 + 2400 })).toBe(probeFingerprint(base));
  });

  it('does change for a genuinely different display size', () => {
    expect(probeFingerprint({ ...base, viewportPx: 2560 * 1440 })).not.toBe(probeFingerprint(base));
  });

  it('is total — missing facts produce a key, not a crash', () => {
    expect(typeof probeFingerprint({})).toBe('string');
  });
});

describe('classifyDevice', () => {
  // cpu is a plain units/ms figure; shade needs shadeReading()'s Mfrag/ms conversion (see its
  // comment above). fill/draw no longer decide anything (#188 swapped the classifying axes), so
  // most cases here pin them at 'none' to prove that directly — see the dedicated regression test
  // below for why that matters.
  const measurement = (cpuUnitsPerMs: number, shadeMfragPerMs: number, bound: RampReading['bound'] = 'measured') =>
    measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', cpuUnitsPerMs, bound),
      shade: shadeReading(shadeMfragPerMs, bound),
      shadeRegionPixels: 10_000,
    });

  const SHIPPED = { middle: PROBE_THRESHOLDS.middle, capable: PROBE_THRESHOLDS.capable };
  afterEach(() => {
    PROBE_THRESHOLDS.middle = SHIPPED.middle;
    PROBE_THRESHOLDS.capable = SHIPPED.capable;
  });

  it('ships with the two MEASURED boundaries, not with nulls', () => {
    // The shipped state, asserted deliberately — it was null for most of this workstream, and
    // deliberately so. #188 swapped the classifying axes from fill/draw to cpu/shade on
    // 2026-08-11 after seven real devices showed fill never measured fill (tile-based GPUs
    // discard coplanar overdraw before shading) and draw produced no reading on the two weakest
    // phones; these are the boundaries that replaced the old fill/draw pair. Reverting either to
    // null would silently stop every device from being classified at all.
    expect(PROBE_THRESHOLDS.middle).toEqual({ cpuUnitsPerMs: 2_500, shadeMfragPerMs: 0.06 });
    expect(PROBE_THRESHOLDS.capable).toEqual({ cpuUnitsPerMs: 14_500, shadeMfragPerMs: 0.165 });
  });

  it('bands each of the six devices this classifier was derived from correctly (#188, 2026-08-11)', () => {
    // Medians of escaped/measured launches, from PROBE_THRESHOLDS' own doc comment. A seventh
    // device (iPad mini 5) was measured but deliberately excluded from the derivation — its shade
    // ramp sits on a fixed ~27ms floor (the largest buffer here) and never yields a trustworthy
    // slope — so it is not repeated here.
    const band = (cpuUnitsPerMs: number, shadeMfragPerMs: number) =>
      classifyDevice(measurement(cpuUnitsPerMs, shadeMfragPerMs)).deviceClass;
    expect(band(2_000, 0.02)).toBe('weak');     // Huawei Y6 2019
    // The case that PROVES cpu and shade must both clear: this phone clears the middle cpu floor
    // (5.5k >= 4500) but fails the middle shade floor (0.03 < 0.06). A cpu-only classifier would
    // wrongly call a 2016 phone `middle`.
    expect(band(5_500, 0.03)).toBe('weak');     // iPhone 7 (A10)
    expect(band(9_900, 0.13)).toBe('middle');   // Galaxy A23 5G
    expect(band(10_900, 0.20)).toBe('middle');  // iPhone 8 (A11)
    expect(band(21_300, 0.21)).toBe('capable'); // Galaxy S22
    expect(band(37_400, 0.20)).toBe('capable'); // iPhone Air
  });

  it('reports `unknown` if either boundary is unset', () => {
    PROBE_THRESHOLDS.capable = null;
    const v = classifyDevice(measurement(1e6, 1e6));
    expect(v.deviceClass).toBe('unknown');
    expect(v.reason).toMatch(/thresholds are unset/);
  });

  it('calls a device capable only when BOTH ramps clear the capable floor', () => {
    expect(classifyDevice(measurement(21_300, 0.21)).deviceClass).toBe('capable');
  });

  it('files a cpu-capable, shade-middling device as MIDDLE — the weaker ramp decides', () => {
    // Deliberately pessimistic, and it is the same rule the two-tier and fill/draw classifiers
    // had: a frame hits the weaker of a device's two bottlenecks, so a strong cpu number cannot
    // vouch for shading.
    const v = classifyDevice(measurement(20_000, 0.10));
    expect(v.deviceClass).toBe('middle');
  });

  it('calls a cpu-strong, shade-weak device weak — and names the shade ramp specifically', () => {
    const v = classifyDevice(measurement(50_000, 0.01));
    expect(v.deviceClass).toBe('weak');
    expect(v.reason).toMatch(/the shade ramp/);
  });

  it('accepts a lower bound that clears — "at least X, and X clears" is sound', () => {
    expect(classifyDevice(measurement(21_300, 0.21, 'lower')).deviceClass).toBe('capable');
  });

  it('a failed fill or draw ramp does NOT prevent classification — the whole point of #188', () => {
    // The exact defect the swap fixes: the Huawei Y6 (0/6 draw escapes) and the iPhone 7 (0/3)
    // used to classify on zero launches, because a `'none'` fill or draw refused a verdict. Good
    // cpu+shade must still classify normally with fill/draw both unusable.
    const m = measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', 21_300), shade: shadeReading(0.21), shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(m).deviceClass).toBe('capable');
  });

  it('refuses to classify when the cpu ramp produced no reading — absent or `bound: \'none\'`', () => {
    const absent = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      shade: shadeReading(0.21), shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(absent).reason).toMatch(/cpu ramp produced no usable reading/);

    const none = measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', 0, 'none'), shade: shadeReading(0.21), shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(none).deviceClass).toBe('unknown');
    expect(classifyDevice(none).reason).toMatch(/cpu ramp produced no usable reading/);
  });

  it('refuses to classify when the shade ramp produced no reading — absent or `bound: \'none\'`', () => {
    const absent = measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      cpu: readingFixture('cpu', 21_300),
    });
    expect(classifyDevice(absent).reason).toMatch(/shade ramp produced no usable reading/);

    const none = measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', 21_300), shade: readingFixture('shade', 0, 'none'), shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(none).reason).toMatch(/shade ramp produced no usable reading/);
  });

  it('names both ramps when neither clears even the middle floor', () => {
    expect(classifyDevice(measurement(1_000, 0.01)).reason).toMatch(/both ramps/);
  });
});

describe('classifyDevice ignores fill/draw — they are logged only, not classified on (#188 axis swap)', () => {
  // Fixed cpu/shade pair that lands in `middle` on its own (the Galaxy A23 medians from the
  // classifyDevice suite above). Every test below only varies fill/draw around it. Before #188
  // this block pinned shade/cpu as the evidence-only axes; the swap inverted which pair that is.
  const cpuReading = readingFixture('cpu', 9_900);
  const midShadeReading = shadeReading(0.13);

  it('stays `middle` whether fill/draw are absurdly high, absurdly low, or absent entirely', () => {
    // A future change that starts classifying on fill/draw again is exactly the regression this
    // pins: today NOTHING reads those fields for classification, so no value — however extreme —
    // may move the verdict.
    const withHighAxes = measurementFixture(readingFixture('fill', 1e9), readingFixture('draw', 1e9), {
      cpu: cpuReading, shade: midShadeReading, shadeRegionPixels: 10_000,
    });
    const withLowAxes = measurementFixture(readingFixture('fill', 1e-9), readingFixture('draw', 1e-9), {
      cpu: cpuReading, shade: midShadeReading, shadeRegionPixels: 10_000,
    });
    const withNoneAxes = measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: cpuReading, shade: midShadeReading, shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(withHighAxes).deviceClass).toBe('middle');
    expect(classifyDevice(withLowAxes).deviceClass).toBe('middle');
    expect(classifyDevice(withNoneAxes).deviceClass).toBe('middle');
  });

  it('does not refuse classification when fill or draw themselves are unusable', () => {
    // classifyDevice's `'unknown'` check reads only m.cpu.bound / m.shade.bound now — a `'none'`
    // on an evidence-only axis must not slip through that check and poison an otherwise-good
    // reading. Same fact as the dedicated regression test in the classifyDevice suite above, from
    // the "ignores fill/draw entirely" side rather than the "cpu/shade still decide" side.
    const withNoneAxes = measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: cpuReading, shade: midShadeReading, shadeRegionPixels: 10_000,
    });
    expect(classifyDevice(withNoneAxes).deviceClass).toBe('middle');
  });
});

describe('readRamp rejects OUTLIER STEPS — the real tables that motivated it', () => {
  /** Load these recordings were CAPTURED at. Pinned, not inherited from `RAMP_BOUNDS`.
   *
   *  ⚠️ Every table below is an exact step sequence off a real phone at loads 4, 8, 16, … When the
   *  production shade ramp moved its start to 32 (it was fitting through a GPU-clock latency
   *  floor), inheriting the constant re-attached these frame times to loads that never produced
   *  them and three tests went red. They are not stale: they are evidence about `readRamp`'s
   *  FITTING behaviour, which does not depend on where the ramp begins. Re-recording them at 32
   *  would discard three device sessions to prove nothing new. */
  const RECORDED_AT_START_LOAD = 4;

  /** Drive a shade ramp through an exact recorded step table, at the load it was recorded at. */
  function shadeRampOf(frameTimes: readonly number[]) {
    // 400 ms, matching `GPU_RAMP_BUDGET_MS` — these tables came off the GPU-CLOCK path, which
    // budgets in wall clock rather than in frames. With the presentation path's 150 ms the ramps
    // exhaust their allowance before escaping and every reading degrades to a floor, which is a
    // fact about the budget and not about the steps under test.
    // 16.7 EXACTLY, not `INTERVAL` (1000/60 = 16.6667). The GPU-clock path has no display to
    // measure, so it feeds a nominal 16.7 — and the difference is not cosmetic here: the iPad's
    // `32:25` step clears a 25.00 pin and misses a 25.05 one, so at 1000/60 that ramp escapes a
    // step early and stops before the load-bearing steps this test is about.
    let s = startRamp('shade', 16.7, 400, RECORDED_AT_START_LOAD);
    for (const ms of frameTimes) s = recordRampFrame(s, ms);
    return s;
  }

  it('drops a SPIKING last step instead of fitting through it — the A23 launch that read weak', () => {
    // Galaxy A23, shade, native (2026-08-11). Every step is orderly until the last, which costs
    // 3.8x the time for 2x the load — a hitch, not load. The last step is `b` by construction, so
    // nothing dilutes it: fitting through it dragged the reading to 0.055 Mfrag/ms against that
    // phone's usual 0.10-0.16, i.e. UNDER the 0.06 middle floor. On a squarely mid-band phone.
    const r = readRamp(shadeRampOf([8.3, 10.5, 11.1, 13.6, 17.5, 26.1, 37.7, 49.9, 188.7]));
    expect(r.bound).toBe('measured');
    // Trimmed, the fit runs 128:26.1 -> 512:49.9 and lands back among that device's real readings.
    expect(r.unitsPerMs / 100).toBeCloseTo(0.161, 3);
    // The number that matters is which side of the boundary it falls: 0.055 was weak, 0.161 is not.
    expect(r.unitsPerMs / 100).toBeGreaterThan(PROBE_THRESHOLDS.middle!.shadeMfragPerMs!);
  });

  it('never starts the fit at the FIRST step — the A23 launch that read nothing at all', () => {
    // Same phone, a different launch, opening `4:127.5` before settling to 21.7. The first step of
    // a ramp is a pipeline switch (new geometry, new blend state) and a warm-up render demonstrably
    // does not absorb it on every device. Picked as the fit's start, it made the frame time DECREASE
    // across the span, so the old rule reported `bound: 'none'` — the device measured nothing.
    const r = readRamp(shadeRampOf([127.5, 21.7, 14.9, 15.1, 20.4, 28.2, 42.6, 60.8]));
    expect(r.bound).toBe('measured');
    expect(r.unitsPerMs / 100).toBeCloseTo(0.118, 3);
  });

  it('prefers a load-bearing start point over one sitting on the ramp\'s floor', () => {
    // iPad mini 5, shade: the first four steps do not move with load AT ALL (28/27/27/25 across an
    // eightfold increase) because that device carries a ~27 ms fixed cost per submit — biggest
    // buffer here, on the fence path. A floor point is not a measurement of the device, so the fit
    // starts at 64:58, the first step that actually moved.
    const r = readRamp(shadeRampOf([28, 27, 27, 25, 58, 57, 87]));
    expect(r.bound).toBe('measured');
    // 64:58 -> 256:87, not 4:28 -> 256:87 (which would read 0.043 by crediting the floor with load).
    expect(r.unitsPerMs / 100).toBeCloseTo(0.066, 3);
  });
});

describe('readRamp rejects a TRANSIENT as the fit\'s start point (review 2026-08-12, #202 close-out)', () => {
  // ⚠️ THE DEFECT. `loadBearing`/`pin` are LOWER bounds only, so `find`-earliest picked the
  // FIRST step that cleared them — and a hitch (a GC pause, an OS deschedule, a GPU stall) clears
  // a lower bound trivially. That shrinks `dMs` and OVERSTATES throughput — the direction that
  // costs a GPU context (see the module's own header). `isSpike` was the wrong guard to reuse
  // here (it compares against the PREVIOUS step, which a ramp that doubles its load legitimately
  // trips — see the existing `escape beats the budget on the last affordable frame` case, ramping
  // `20 -> 120 -> 140`); the correct test is NON-MONOTONICITY: a real load step cannot cost less
  // than its DOUBLED successor, so a step that does is a local maximum, not load.

  /** Drive a `cpu` ramp through an exact recorded step table (loads 4096, 8192, 16384, ... —
   *  `RAMP_BOUNDS.cpu.startLoad` doubling), mirroring `shadeRampOf` above. */
  function cpuRampOf(frameTimes: readonly number[]) {
    let s = startRamp('cpu', 4, 200);
    for (const ms of frameTimes) s = recordRampFrame(s, ms);
    return s;
  }

  it('the baseline ladder — an iPhone-8-class cpu ramp with no hitch', () => {
    // The exact reading that phone contributed to PROBE_THRESHOLDS.
    const s = cpuRampOf([0.4, 0.8, 1.5, 3, 6, 12]);
    expect(s.status).toBe('escaped');
    const r = readRamp(s);
    expect(r.bound).toBe('measured');
    expect(r.unitsPerMs).toBeCloseTo(10922.67, 1);
  });

  it('a hitch mid-ramp (16384:7 instead of 1.5) reads the SAME — it did not overstate the device', () => {
    // Before the fix this read 22937.6 (`find`-earliest paired the hitch step, 16384:7, with the
    // final step: dLoad=114688, dMs=5).
    const s = cpuRampOf([0.4, 0.8, 7, 3, 6, 12]);
    expect(s.status).toBe('escaped');
    const r = readRamp(s);
    expect(r.unitsPerMs).toBeCloseTo(10922.67, 1);
  });

  it('a hitch one step later (32768:8 instead of 3) reads the SAME again', () => {
    // Before the fix this read 24576 (`find`-earliest paired 32768:8 with the final step:
    // dLoad=98304, dMs=4).
    const s = cpuRampOf([0.4, 0.8, 1.5, 8, 6, 12]);
    expect(s.status).toBe('escaped');
    const r = readRamp(s);
    expect(r.unitsPerMs).toBeCloseTo(10922.67, 1);
  });

  it('the SAME defect on the shade axis — a hitch at 32:35 must not overstate throughput', () => {
    // Baseline: 4:8 8:9 16:10 32:12 64:14 128:20 256:30 512:55 -> ~10.24 units/ms (both cases
    // fit 256:30 -> 512:55; the ladder up to there is all sub-pin floor).
    let s = startRamp('shade', 16.7, 400, 4);   // ladder written at loads 4,8,16,… — see RECORDED_AT_START_LOAD
    for (const ms of [8, 9, 10, 12, 14, 20, 30, 55]) s = recordRampFrame(s, ms);
    expect(s.status).toBe('escaped');
    expect(readRamp(s).unitsPerMs).toBeCloseTo(10.24, 1);

    // Same ladder, 32:12 replaced by 32:35 (a hitch). Before the fix this read 24 (`find`-earliest
    // paired 32:35 with the final step: dLoad=480, dMs=20).
    let hitched = startRamp('shade', 16.7, 400, 4);   // ladder written at loads 4,8,16,… — see RECORDED_AT_START_LOAD
    for (const ms of [8, 9, 10, 35, 14, 20, 30, 55]) hitched = recordRampFrame(hitched, ms);
    expect(hitched.status).toBe('escaped');
    expect(readRamp(hitched).unitsPerMs).toBeCloseTo(10.24, 1);
  });
});

describe('refining a verdict ACROSS LAUNCHES (#188)', () => {
  // `fillMpxPerMs` is 0 throughout: these are the real 3D readings off the phones, taken before a
  // 2D probe shape existed, and the 3D classifier does not read that axis. A fabricated value
  // would be a number nobody measured sitting in the one fixture that exists because it is real.
  const r = (cpuUnitsPerMs: number, shadeMfragPerMs: number): ProbeReading =>
    ({ cpuUnitsPerMs, shadeMfragPerMs, fillMpxPerMs: 0 });

  /** REAL per-launch readings, native, three launches per device with the stored verdict wiped
   *  before each one (2026-08-11). Not illustrative — these are the numbers off the phones, and two
   *  of them are the outlier launches that motivated removing the one-pass settle: the A23's 0.055
   *  shade (under the 0.06 `middle` floor, on a squarely mid-band phone) and the S22's 0.07 (under
   *  the 0.165 `capable` floor, on a flagship). Both must be survivable. */
  const RUNS = {
    y6:       [r(1_600, 0.02), r(2_000, 0.03), r(2_300, 0.02)],
    iphone7:  [r(5_500, 0.03), r(5_500, 0.03), r(6_600, 0.07)],
    a23:      [r(9_200, 0.055), r(9_900, 0.11), r(10_600, 0.16)],
    iphone8:  [r(8_200, 0.16), r(10_900, 0.20), r(12_300, 0.33)],
    s22:      [r(19_600, 0.07), r(21_000, 0.21), r(23_800, 0.22)],
    air:      [r(37_400, 0.18), r(37_400, 0.20), r(37_400, 0.21)],
  };

  /** Replay launches through the real policy, exactly as `resolveProbeClass` drives it. */
  function replay(readings: readonly ProbeReading[]) {
    let state = { samples: [] as ProbeReading[], final: false };
    const seen: string[] = [];
    for (const reading of readings) {
      if (state.final) break;                      // settled: a later launch must not probe again
      const next = refineProbeVerdict(state.samples, reading, '3d');
      state = { samples: [...next.samples], final: next.final };
      seen.push(next.deviceClass);
    }
    return { bands: seen, launchesProbed: seen.length, settled: state.final };
  }

  it('lands all six measured devices in their intended band', () => {
    expect(replay(RUNS.y6).bands.at(-1)).toBe('weak');
    expect(replay(RUNS.iphone7).bands.at(-1)).toBe('weak');
    expect(replay(RUNS.a23).bands.at(-1)).toBe('middle');
    expect(replay(RUNS.iphone8).bands.at(-1)).toBe('middle');
    expect(replay(RUNS.s22).bands.at(-1)).toBe('capable');
    expect(replay(RUNS.air).bands.at(-1)).toBe('capable');
  });

  it('makes EVERY device pay the full three launches — no reading settles on its own', () => {
    // ⚠️ This is the fix for a measured hazard, not caution. The old rule settled a device whose
    // single reading sat 1.5x clear of every boundary, which is sound only if the per-launch spread
    // is smaller than that margin. Pooled over a day of native campaigns the A23's shade spanned
    // 0.055-0.16 and the iPhone 7's 0.03-0.07 — distributions that OVERLAP, so no single reading
    // separates a mid-band phone from a weak one at any margin. The Y6 used to settle here on one
    // pass; it no longer does, and that is the trade taken deliberately.
    for (const runs of Object.values(RUNS)) {
      expect(replay(runs)).toMatchObject({ launchesProbed: PROBE_SAMPLE_TARGET, settled: true });
    }
  });

  it('survives the A23 launch that read UNDER the weak boundary', () => {
    // The real 0.055 shade pass, drawn first. It classifies `weak` on its own and the running answer
    // follows it down — but the median of three corrects it, and nothing was frozen in between.
    // Under the old one-pass rule this reading was 1.5x clear below the middle floor, i.e. exactly
    // the shape that would have cached `weak` on this phone for the life of the device.
    expect(replay(RUNS.a23).bands).toEqual(['weak', 'weak', 'middle']);
  });

  it('reports the LOWEST band while refining, not the median — the safe direction', () => {
    // Booting a weak device high is a lost GPU context (#156); booting a capable device low is a
    // beat of ugliness the next launch fixes. So the transient answer errs down and only the
    // settled one is the median. The S22's real first launch read shade 0.07, under the capable
    // floor, so it opens at `middle` and earns `capable` only once three samples are in.
    expect(replay(RUNS.s22).bands).toEqual(['middle', 'middle', 'capable']);
  });

  it('never keeps more than the target number of samples', () => {
    let samples: ProbeReading[] = [];
    for (const reading of [...RUNS.a23, ...RUNS.a23]) {
      samples = [...refineProbeVerdict(samples, reading, '3d').samples];
    }
    expect(samples).toHaveLength(PROBE_SAMPLE_TARGET);
  });

  it('never settles while the thresholds are unset', () => {
    PROBE_THRESHOLDS.middle = null;
    expect(refineProbeVerdict([], r(2_000, 0.02), '3d')).toMatchObject({ deviceClass: 'unknown', final: false });
  });
});

describe('the refinement policy does not trust its own inputs', () => {
  it('drops a non-finite sample instead of letting it wreck the median', () => {
    // `previous` arrives through a PROVIDER SLOT, so any implementation may supply it. A NaN makes
    // the `(a,b) => a-b` comparator return NaN for every comparison touching it, which V8 reads as
    // "equal" — `sort` then leaves the array in INSERTION ORDER and `sorted[mid]` is not the
    // median at all. Measured before the guard: one NaN among three returned `weak` (safe by luck)
    // and stayed in the array to poison every later launch too.
    const good = { cpuUnitsPerMs: 21_300, shadeMfragPerMs: 0.21, fillMpxPerMs: 0 };
    const r = refineProbeVerdict([good, { cpuUnitsPerMs: NaN, shadeMfragPerMs: NaN, fillMpxPerMs: 0 }], good, '3d');
    expect(r.samples).toEqual([good, good]);
    expect(r.samples.every((s) => Number.isFinite(s.cpuUnitsPerMs))).toBe(true);
  });

  it('says so rather than guessing when nothing finite survives', () => {
    const r = refineProbeVerdict([], { cpuUnitsPerMs: Number.NaN, shadeMfragPerMs: 1, fillMpxPerMs: 0 }, '3d');
    expect(r).toMatchObject({ deviceClass: 'unknown', final: false });
    expect(r.samples).toHaveLength(0);
  });

  // readingFixture/measurementFixture/shadeReading are the module-scope ones above (shared with
  // RAMP_BOUNDS, shadeMegaFragmentsPerMs and classifyDevice).
  const SHIPPED_TH = { middle: PROBE_THRESHOLDS.middle, capable: PROBE_THRESHOLDS.capable };
  afterEach(() => { PROBE_THRESHOLDS.middle = SHIPPED_TH.middle; PROBE_THRESHOLDS.capable = SHIPPED_TH.capable; });

  it('no longer persists whether a reading was a slope — and that is safe ONLY because no single '
    + 'pass can settle', () => {
    // `ProbeReading.measured` existed to stop a FLOOR settling a device BELOW a boundary on one
    // pass: a `bound: 'lower'` reading supports "at least X" and says nothing about being slower,
    // so the lower a reading was, the more likely it froze the verdict for the life of the device.
    // With the one-pass shortcut gone that danger has no path left — against a median of three a
    // floor is merely conservative, since it understates and understating is the recoverable
    // direction. So the field went with it.
    const slope = readingOf(measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', 21_300), shade: shadeReading(0.21), shadeRegionPixels: 10_000,
    }));
    const floor = readingOf(measurementFixture(readingFixture('fill', 0, 'none'), readingFixture('draw', 0, 'none'), {
      cpu: readingFixture('cpu', 21_300, 'lower'), shade: shadeReading(0.21, 'lower'), shadeRegionPixels: 10_000,
    }));
    expect(slope).toEqual(floor);
    expect(slope).not.toHaveProperty('measured');
    // ⚠️ The property that replaced it: NEITHER can settle a device by itself, whichever it is.
    expect(refineProbeVerdict([], slope, '3d').final).toBe(false);
    expect(refineProbeVerdict([], floor, '3d').final).toBe(false);
  });

  it('reports the RAMP failure ahead of "thresholds unset" — the device-specific fact wins', () => {
    // Both orders yield `unknown`, so only the reason differs — and that is what a human reads out
    // of `diagnose`. Pinned because the order silently swapped when `classifyReading` was split
    // out of `classifyDevice`, and nothing would have caught it.
    PROBE_THRESHOLDS.middle = null;
    PROBE_THRESHOLDS.capable = null;
    const v = classifyDevice(measurementFixture(readingFixture('fill', 5), readingFixture('draw', 30), {
      cpu: readingFixture('cpu', 0, 'none'), shade: shadeReading(0.21), shadeRegionPixels: 10_000,
    }));
    expect(v.deviceClass).toBe('unknown');
    expect(v.reason).toMatch(/cpu ramp produced no usable reading/);
  });
});

describe('the effective frame interval is the GAME\'s, not the rAF cadence', () => {
  // The rule `rampProbeRunner` applies before starting a ramp:
  //   effective = max(measured rAF interval, 1000 / targetFPS)
  // Pinned here as pure arithmetic because the runner itself needs a renderer, and this is the
  // part that decides every downstream threshold.
  const effective = (measured: number, targetFps: number) =>
    Math.max(measured, targetFps > 0 ? 1000 / targetFps : 0);

  it('uses the frame-driver cap when rAF ticks FASTER than the game renders', () => {
    // Measured on a Galaxy S22 natively: rAF every 8.4ms (~119Hz), game at 60fps because
    // frameDriver skips every other tick. Feeding 8.4 halved escape (3x -> 25ms not 50ms) and the
    // budget (9x -> 75ms not 150ms), so the phone ran out of budget before escaping and never
    // settled on a tier.
    expect(effective(8.4, 60)).toBeCloseTo(16.67, 1);
  });

  it('uses the MEASURED value when the DISPLAY is the slower of the two', () => {
    // The case the measurement exists for: a thermally throttled iPhone 8 really drops to 30Hz,
    // and assuming 16.7 there would double every threshold against a display that cannot deliver.
    expect(effective(33.3, 60)).toBeCloseTo(33.3, 1);
  });

  it('changes nothing on a device where the two already agree', () => {
    expect(effective(16.7, 60)).toBeCloseTo(16.7, 1);
  });

  it('falls back to the measurement when the cap is disabled', () => {
    expect(effective(8.4, 0)).toBeCloseTo(8.4, 1);
  });
});

describe('⭐ the three devices the 2D bands were measured on (#203/#204, 2026-08-13)', () => {
  // `games/space-invader` (render3d:false, so the probe ran with no Three in the process at all),
  // debug build, `pm clear` before EVERY launch, three launches each. Medians below. These are the
  // entire empirical basis for the 2D table — if one moves, the table is wrong, not the test.
  const reading2D = (cpuK: number, fillMpx: number): ProbeReading =>
    ({ cpuUnitsPerMs: cpuK * 1000, shadeMfragPerMs: 0, fillMpxPerMs: fillMpx });

  it('ships with two MEASURED boundaries, not with nulls', () => {
    // They shipped null for one day on purpose. Reverting either would silently stop classifying
    // every unrecognised 2D device.
    expect(PROBE_THRESHOLDS_2D.middle).toEqual({ cpuUnitsPerMs: 4_500, fillMpxPerMs: 1.68 });
    expect(PROBE_THRESHOLDS_2D.capable).toEqual({ cpuUnitsPerMs: 4_500, fillMpxPerMs: 4.6 });
  });

  it('Huawei Y6 (PowerVR GE8300) — fill 1.02, cpu 2.0k — is weak', () => {
    expect(classifyReading(reading2D(2.0, 1.02), '2d').deviceClass).toBe('weak');
  });

  it('⭐ Galaxy A23 (Mali-G57 MC2) — fill 2.77 — is middle, and specifically NOT capable', () => {
    // The half that matters: 2.77 sits below the 4.6 capable floor, so the A23 does not get an
    // unclamped 2D DPR. That is the decision #204 is about.
    expect(classifyReading(reading2D(10.1, 2.77), '2d').deviceClass).toBe('middle');
  });

  it('⚠️ the middle FILL floor is load-bearing for a device none of the three anchors is', () => {
    // Mutation exposed this: dropping the middle fill floor from 1.68 to 0.5 broke no device test,
    // because all three anchors are decided by other comparisons (the Y6 fails the cpu floor
    // outright). The floor exists for a device with adequate CPU and poor fill — a budget phone
    // with a modern core and a weak GPU, which is most of the population this workstream is about.
    // Without a case like this the floor could rot to any value and the suite would stay green.
    expect(classifyReading(reading2D(10.0, 1.00), '2d').deviceClass).toBe('weak');
    expect(classifyReading(reading2D(10.0, 2.00), '2d').deviceClass).toBe('middle');
  });

  it('Galaxy S22 (Adreno 730) — fill >= 7.69 — is capable, on a LOWER BOUND', () => {
    // Its ramp never escaped (ceiling/lower), so the reading is "at least 7.69". Clearing a floor
    // on a lower bound is sound; FAILING one on a lower bound would not have been.
    expect(classifyReading(reading2D(13.9, 7.69), '2d').deviceClass).toBe('capable');
  });

  it('⚠️ the cpu axis cannot separate the A23 from the S22 — fill is what decides', () => {
    // Their measured cpu ranges OVERLAP (A23 9.5-12.8k, S22 12.0-13.9k), which is why the capable
    // row carries the same cpu floor as middle. Swap only the fill figures and the verdicts swap
    // with them: the decision really is made on the axis the doc claims.
    expect(classifyReading(reading2D(13.9, 2.77), '2d').deviceClass).toBe('middle');
    expect(classifyReading(reading2D(10.1, 7.69), '2d').deviceClass).toBe('capable');
  });

  it('a 2D reading is NOT judged by the 3D table', () => {
    // Different quantities in different units. Judging one by the other's floors is the "number
    // from a different instrument" mistake this workstream has made twice.
    const a23 = reading2D(10.1, 2.77);
    expect(classifyReading(a23, '2d').deviceClass).toBe('middle');
    expect(classifyReading(a23, '3d').deviceClass).toBe('weak');   // shade is 0 on a 2D probe
  });
});

describe('⚠️ the INTERIM verdict must use the 2D table too (found on a Galaxy A23)', () => {
  // Before three samples exist, `refineProbeVerdict` returns the LOWEST band seen so far — a
  // deliberate "start low, climb as evidence accumulates". That interim path called
  // `classifyReading` WITHOUT the axis, so it defaulted to the 3D table, where a 2D reading's
  // `shadeMfragPerMs` is 0 by construction. Every 2D device therefore reported `weak` on launches
  // 1 and 2 — the launches a first impression is made on, which is the owner's stated constraint.
  const a23 = { cpuUnitsPerMs: 10_100, shadeMfragPerMs: 0, fillMpxPerMs: 2.77 };

  it('a single A23-grade 2D reading refines to middle, not weak', () => {
    const r = refineProbeVerdict([], a23, '2d');
    expect(r.deviceClass).toBe('middle');
    expect(r.final).toBe(false);        // still refining — the interim path, which is the buggy one
  });

  it('and the interim verdict AGREES with what classifyDevice says about the same reading', () => {
    // The disagreement between these two is exactly what the device log showed:
    // "weak — lowest of 1 launch(es) so far ... (this pass alone: middle)". They read the same
    // numbers and must reach the same band.
    expect(refineProbeVerdict([], a23, '2d').deviceClass).toBe(classifyReading(a23, '2d').deviceClass);
  });

  it('the conservative rule itself still holds — the lowest of two disagreeing launches wins', () => {
    // Non-vacuity: the fix must not have turned "lowest so far" into "latest".
    const weak = { cpuUnitsPerMs: 2_000, shadeMfragPerMs: 0, fillMpxPerMs: 1.02 };
    expect(refineProbeVerdict([a23], weak, '2d').deviceClass).toBe('weak');
    expect(refineProbeVerdict([weak], a23, '2d').deviceClass).toBe('weak');
  });
});

describe('⚠️ a threshold missing its axis\'s GPU floor fails CLOSED (close-out 2026-08-13)', () => {
  // `clears()` used `?? 0` and a comment claiming the type prevented a threshold with no GPU
  // floor. It does not: both GPU fields must be optional, since a 2D row carries fillMpxPerMs and
  // a 3D row shadeMfragPerMs. So `{ cpuUnitsPerMs: 4_500 }` type-checks, and `?? 0` turned the GPU
  // comparison into "anything clears" — collapsing the decision to CPU alone, the classifier this
  // file's own iPhone 7 derivation proves wrong.
  const SHIPPED = { ...PROBE_THRESHOLDS_2D };
  afterEach(() => { PROBE_THRESHOLDS_2D.middle = SHIPPED.middle; PROBE_THRESHOLDS_2D.capable = SHIPPED.capable; });

  it('a GPU-floor-less threshold clears NOTHING rather than everything', () => {
    PROBE_THRESHOLDS_2D.middle = { cpuUnitsPerMs: 4_500 };          // the forgetful edit
    PROBE_THRESHOLDS_2D.capable = { cpuUnitsPerMs: 4_500 };
    // An S22-grade reading: huge fill, ample cpu. Fail-open called this `capable`; fail-closed
    // calls it `weak` — wrong, but loudly and in the safe direction.
    const s22 = { cpuUnitsPerMs: 13_900, shadeMfragPerMs: 0, fillMpxPerMs: 7.69 };
    expect(classifyReading(s22, '2d').deviceClass).toBe('weak');
  });

  it('⭐ and the SHIPPED tables each carry the floor their axis reads', () => {
    // The guard that keeps the loud case off a device. Asserted per axis, because a 3D row
    // carrying only fillMpxPerMs would satisfy a naive "has some GPU field" check and still
    // decide nothing.
    for (const [name, t] of Object.entries(PROBE_THRESHOLDS)) {
      expect(t?.shadeMfragPerMs, `3D ${name} threshold has no shade floor`).toBeGreaterThan(0);
    }
    for (const [name, t] of Object.entries(PROBE_THRESHOLDS_2D)) {
      expect(t?.fillMpxPerMs, `2D ${name} threshold has no fill floor`).toBeGreaterThan(0);
    }
  });
});

describe('⭐ the three devices the 3D bands were RE-ANCHORED on (v6 warm-up path, 2026-08-13)', () => {
  // `games/sling`, shipped discarded-warm-up path, `pm clear` before every launch, three each.
  // Medians. These replace nothing — the six v4 devices below still band identically — they are
  // the evidence that the cpu floor had to move from 4,500 to 2,500.
  const r3d = (cpuK: number, shade: number): ProbeReading =>
    ({ cpuUnitsPerMs: cpuK * 1000, shadeMfragPerMs: shade, fillMpxPerMs: 0 });

  it('Huawei Y6 — cpu 1.9k, shade 0.04 — weak', () => {
    expect(classifyReading(r3d(1.9, 0.04), '3d').deviceClass).toBe('weak');
  });

  it('⭐ Galaxy A23 — cpu 3.5k, shade 0.14 — middle, which the 4,500 floor denied it', () => {
    // The verdict the re-anchor exists for: a clean shade reading vetoed by the axis that is not
    // deciding. At the old floor this device read `weak` on two launches of three.
    expect(classifyReading(r3d(3.5, 0.14), '3d').deviceClass).toBe('middle');
  });

  it('⭐⭐ Galaxy S22 — cpu 17.0k, shade 0.18 — CAPABLE, a band this file twice called unreachable', () => {
    // Before the warm-up pass this phone measured 0.07-0.08 shade and could not clear 0.165 on any
    // instrument. The hardware never changed; it was being measured at idle clocks.
    expect(classifyReading(r3d(17.0, 0.18), '3d').deviceClass).toBe('capable');
  });

  it('and the shade axis is MONOTONE across the three — 0.04 < 0.14 < 0.18', () => {
    // The property that was false in every previous session: the S22 ranked BELOW the A23.
    // ⚠️ Two literal-vs-literal assertions lived here (`expect(0.04).toBeLessThan(0.14)`) and were
    // removed in close-out: they compared constants to each other, could not fail whatever the code
    // did, and read as coverage. The band sequence below is the assertion that can.
    const bands = [r3d(1.9, 0.04), r3d(3.5, 0.14), r3d(17.0, 0.18)]
      .map((x) => classifyReading(x, '3d').deviceClass);
    expect(bands).toEqual(['weak', 'middle', 'capable']);
  });
});
