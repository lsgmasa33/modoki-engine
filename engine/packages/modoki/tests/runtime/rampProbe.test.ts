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
  type RampKind, type RampState, type RampReading, type ProbeMeasurement,
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
    intervalMs: INTERVAL, fill: reading(fillUnits),
    draw: { kind: 'draw', status: 'escaped', unitsPerMs: 50, bound: 'measured', peakLoad: 512, steps: [] },
    totalMs: 300, rendererMs: 10, compileMs: 3, bufferPixels,
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
    expect(phone.fill.unitsPerMs).toBeGreaterThan(tablet.fill.unitsPerMs);       // raw: phone wins
    expect(fillMegapixelsPerMs(tablet)).toBeGreaterThan(fillMegapixelsPerMs(phone)); // real: tablet
  });

  it('is 0 when there is no usable reading or no buffer size', () => {
    const noRead = { ...m(4, 500_000), fill: { ...reading(0), bound: 'none' as const } };
    expect(fillMegapixelsPerMs(noRead)).toBe(0);
    expect(fillMegapixelsPerMs(m(4, 0))).toBe(0);
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
  const reading = (kind: RampKind, unitsPerMs: number, bound: RampReading['bound'] = 'measured'): RampReading => ({
    kind, status: bound === 'lower' ? 'ceiling' : 'escaped', unitsPerMs, bound, peakLoad: 64, steps: [],
  });
  const measurement = (fill: RampReading, draw: RampReading) => ({
    intervalMs: INTERVAL, fill, draw, totalMs: 280, rendererMs: 60, compileMs: 18, bufferPixels: 1_000_000,
  });

  afterEach(() => {
    PROBE_THRESHOLDS.fillMpxPerMs = null;
    PROBE_THRESHOLDS.drawUnitsPerMs = null;
  });

  it('ships with thresholds unset, so every device is `unknown`', () => {
    // The shipped state, asserted deliberately: like TIER_ALLOWLIST being empty, this is the
    // correct state until an A23 and a Y6 have been measured, NOT an unfinished feature. It
    // means landing the probe changes no device's behaviour.
    expect(PROBE_THRESHOLDS.fillMpxPerMs).toBeNull();
    expect(PROBE_THRESHOLDS.drawUnitsPerMs).toBeNull();
    const v = classifyDevice(measurement(reading('fill', 1e6), reading('draw', 1e6)));
    expect(v.deviceClass).toBe('unknown');
    expect(v.reason).toMatch(/thresholds are unset/);
  });

  it('calls a device capable only when BOTH ramps clear', () => {
    PROBE_THRESHOLDS.fillMpxPerMs = 2;
    PROBE_THRESHOLDS.drawUnitsPerMs = 10;
    expect(classifyDevice(measurement(reading('fill', 3), reading('draw', 20))).deviceClass)
      .toBe('capable');
  });

  it('calls a fill-strong, submit-weak device weak — that is forest-camp\'s failure mode', () => {
    PROBE_THRESHOLDS.fillMpxPerMs = 2;
    PROBE_THRESHOLDS.drawUnitsPerMs = 10;
    const v = classifyDevice(measurement(reading('fill', 50), reading('draw', 3)));
    expect(v.deviceClass).toBe('weak');
    expect(v.reason).toMatch(/the draw ramp/);
  });

  it('accepts a lower bound that clears — "at least X, and X clears" is sound', () => {
    PROBE_THRESHOLDS.fillMpxPerMs = 2;
    PROBE_THRESHOLDS.drawUnitsPerMs = 10;
    expect(classifyDevice(measurement(reading('fill', 5, 'lower'), reading('draw', 40, 'lower')))
      .deviceClass).toBe('capable');
  });

  it('refuses to classify when either ramp produced no reading', () => {
    PROBE_THRESHOLDS.fillMpxPerMs = 2;
    PROBE_THRESHOLDS.drawUnitsPerMs = 10;
    const v = classifyDevice(measurement(reading('fill', 0, 'none'), reading('draw', 40)));
    expect(v.deviceClass).toBe('unknown');
    expect(v.reason).toMatch(/fill ramp produced no usable reading/);
  });

  it('names both ramps when neither clears', () => {
    PROBE_THRESHOLDS.fillMpxPerMs = 2;
    PROBE_THRESHOLDS.drawUnitsPerMs = 10;
    expect(classifyDevice(measurement(reading('fill', 0.5), reading('draw', 1))).reason)
      .toMatch(/both ramps/);
  });
});
