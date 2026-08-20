// @vitest-environment jsdom
/** The on-demand probe re-run measures and reports — and changes NOTHING (#205).
 *
 *  ⚠️ **THE POINT OF THESE ASSERTIONS IS THE NEGATIVE SPACE.** `runProbeForDiagnostics` exists to
 *  answer one question — does the cpu ramp read differently at boot than it does on a quiet main
 *  thread — and a diagnostic that folded its own readings into `probeVerdictStore` would move the
 *  number it was built to measure, asymmetrically (an idle reading is precisely the one that
 *  differs from a boot one). It would also do it invisibly: nothing about a stored median looks
 *  wrong afterwards. Same for publishing a tier — a QA tap that silently re-tiered the running
 *  game would make every subsequent observation on that device untrustworthy.
 *
 *  So "the store was not written" and "the tier did not change" are the behaviour under test, not
 *  incidental tidiness, and they are asserted on the SUCCESS path (with a mocked measurement)
 *  rather than only on jsdom's no-GL failure path, where they would hold vacuously.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProbeMeasurement } from '../../src/runtime/rendering/rampProbe';
import { probeVerdictStore, type CachedProbeVerdict } from '../../src/runtime/core/probeVerdictStore';
import { getActiveQualityTier, setRenderSettings, getRenderSettings } from '../../src/runtime/rendering/renderSettings';
import { resetProbeInFlightForTest, withProbeInFlight } from '../../src/runtime/rendering/probeReentrancy';

const runBootRampProbe = vi.hoisted(() => vi.fn());
vi.mock('../../src/runtime/rendering/rampProbeRunner', () => ({ runBootRampProbe }));

const { runProbeForDiagnostics } = await import('../../src/runtime/rendering/tierResolve');

const BASE = getRenderSettings();

/** A measurement good enough for `classifyDevice` to return a real band — a ramp that escaped, on
 *  both axes a 3D probe reads. The exact numbers do not matter to these assertions; that it is a
 *  SUCCESS rather than a `null` does, because the whole risk lives on the success path. */
function fakeMeasurement(): ProbeMeasurement {
  const ramp = (kind: 'shade' | 'cpu', unitsPerMs: number) => ({
    kind, status: 'escaped' as const, unitsPerMs, bound: 'measured' as const, peakLoad: 1024,
    steps: [{ load: 512, frameMs: 20 }, { load: 1024, frameMs: 40 }],
  });
  return {
    intervalMs: 16.7, clockKind: 'webgl2', axes: '3d',
    shade: ramp('shade', 1_800), cpu: ramp('cpu', 10_700),
    cpuWarmups: [ramp('cpu', 5_350), ramp('cpu', 8_000)],
    totalMs: 900, rendererMs: 0, compileMs: 30, shadeCompileMs: 45,
    bufferPixels: 310_000, shadeRegionPixels: 10_000,
  } as ProbeMeasurement;
}

let write: ReturnType<typeof vi.fn<(verdict: CachedProbeVerdict | null) => void>>;

beforeEach(() => {
  resetProbeInFlightForTest();
  runBootRampProbe.mockReset();
  runBootRampProbe.mockResolvedValue(fakeMeasurement());
  write = vi.fn<(verdict: CachedProbeVerdict | null) => void>();
  probeVerdictStore.provide({ read: () => null, write });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // …and `log` too, since the probe's ordinary-path evidence moved there when
  // console.warn became a Crashlytics issue (2026-08-20). Silencing only `warn` would
  // leave this suite printing a probe report per pass.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  resetProbeInFlightForTest();
  setRenderSettings(BASE);
  vi.restoreAllMocks();
});

describe('runProbeForDiagnostics', () => {
  it('⭐ does NOT write the verdict store — an idle reading must not move the stored median', async () => {
    const summary = await runProbeForDiagnostics();

    // Non-vacuous: the probe really did produce a measurement and really was classified.
    expect(runBootRampProbe).toHaveBeenCalledOnce();
    expect(summary).toContain('cpu 10.7k xform/ms');
    expect(write).not.toHaveBeenCalled();
  });

  it('⭐ reports every DISCARDED cpu pass in order, and the gain over the first', async () => {
    // The measured pass is what classifies; the warm-up passes are what say whether this device's
    // governor was asleep for them, and whether it was STILL CLIMBING when the measured pass ran —
    // the question `CPU_WARMUP_RAMPS` is tuned against. Printing the sequence is what lets the next
    // person read a phone's DVFS behaviour off an ordinary boot log instead of rebuilding a
    // diagnostic to ask again.
    const summary = await runProbeForDiagnostics();

    expect(summary).toContain('cpu 10.7k xform/ms');
    // 5.3, not 5.4: `(5350/1000).toFixed(1)` is "5.3" — 5.35 is not exactly representable and
    // rounds down. Pinning the real output rather than the arithmetic one on purpose.
    expect(summary).toContain('warm-up 5.3k->8.0k, gain 2.00x');
  });

  it('⭐ does NOT publish a tier — tapping it cannot change what is on screen', async () => {
    const before = getActiveQualityTier();

    await runProbeForDiagnostics();

    expect(getActiveQualityTier()).toBe(before);
  });

  it('runs the 2D probe shape when asked, so the reading is comparable to a 2D boot', async () => {
    await runProbeForDiagnostics(true);

    expect(runBootRampProbe).toHaveBeenCalledWith(expect.any(Function), true);
  });

  it('⭐ refuses while another probe is in flight, rather than measuring its contention', async () => {
    // A boot probe still running is the one condition under which this measurement would be
    // actively misleading — two probes contending for the same main thread is the confound the
    // whole boot-vs-idle A/B exists to remove.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const inFlight = withProbeInFlight(() => held.then(() => null));

    const summary = await runProbeForDiagnostics();

    expect(summary).toContain('already running');
    expect(runBootRampProbe).not.toHaveBeenCalled();
    release();
    await inFlight;
  });

  it('reports a probe that produced nothing, instead of throwing or reporting a band', async () => {
    runBootRampProbe.mockResolvedValue(null);

    expect(await runProbeForDiagnostics()).toContain('no measurement');
    expect(write).not.toHaveBeenCalled();
  });

  it('reports a probe that threw, naming the last stage it reached', async () => {
    runBootRampProbe.mockImplementation(async (mark: (s: string) => void) => {
      mark('shade:512');
      throw new Error('context lost');
    });

    const summary = await runProbeForDiagnostics();

    expect(summary).toContain("threw at stage 'shade:512'");
    expect(summary).toContain('context lost');
  });
});
