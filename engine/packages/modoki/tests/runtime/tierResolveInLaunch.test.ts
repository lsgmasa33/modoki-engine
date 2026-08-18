// @vitest-environment jsdom
/** The probe settles WITHIN one launch, not across three (#221 W2).
 *
 *  ⚠️ **THE DEFECT THIS PINS IS THAT LAUNCHES 1 AND 2 WERE WRONG BY CONSTRUCTION.** The verdict has
 *  always been the median of `PROBE_SAMPLE_TARGET` readings, and taking one reading per launch meant
 *  a device could not have a median until its third launch — so it spent the first two on the
 *  running "lowest sample so far" answer. Those are the launches a first impression is made on,
 *  which is the whole point of the workstream, and no test could see it: the old loop ran exactly
 *  once per call, so "one probe per launch" was true of the code and untested either way.
 *
 *  What is asserted here is therefore a COUNT and a `final` flag, not a band. The band was already
 *  covered by `rampProbe.test.ts`'s median tests; what was never covered is how many readings the
 *  boot path is willing to go and get.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProbeMeasurement } from '../../src/runtime/rendering/rampProbe';
import { PROBE_SAMPLE_TARGET } from '../../src/runtime/rendering/rampProbe';
import { probeVerdictStore, type CachedProbeVerdict } from '../../src/runtime/core/probeVerdictStore';
import { setRenderSettings, getRenderSettings, resetRenderSettings } from '../../src/runtime/rendering/renderSettings';
import { resetProbeInFlightForTest } from '../../src/runtime/rendering/probeReentrancy';
import { resetDeviceCaps } from '../../src/runtime/rendering/deviceCaps';

const runBootRampProbe = vi.hoisted(() => vi.fn());
vi.mock('../../src/runtime/rendering/rampProbeRunner', () => ({ runBootRampProbe }));

const { resolveActiveTierForNo3D } = await import('../../src/runtime/rendering/tierResolve');

const BASE = getRenderSettings();

/** Two configs, so the `single-config` short-circuit ("nothing to choose between" → `high`) does
 *  not answer instead of the resolver and skip the probe entirely. */
const TWO_CONFIGS = {
  low: { pixelRatioCap: 1, shadows: false, antialias: false },
  mid: { pixelRatioCap: 1.5, shadows: true, antialias: false },
};

/** A 2D measurement good enough to classify. `totalMs` is what the in-launch budget is spent
 *  against — but note the loop reads a real clock, not this field, so a test cannot exhaust the
 *  budget by inflating it (see the budget test, which does it honestly). */
function fakeMeasurement(fillUnitsPerMs: number, cpuUnitsPerMs = 9_000): ProbeMeasurement {
  const ramp = (kind: 'fill' | 'cpu', unitsPerMs: number) => ({
    kind, status: 'escaped' as const, unitsPerMs, bound: 'measured' as const, peakLoad: 8192,
    steps: [{ load: 4096, frameMs: 25 }, { load: 8192, frameMs: 55 }],
  });
  return {
    intervalMs: 16.7, clockKind: 'webgl2', axes: '2d',
    fill: ramp('fill', fillUnitsPerMs), cpu: ramp('cpu', cpuUnitsPerMs),
    totalMs: 500, rendererMs: 0, compileMs: 5, shadeCompileMs: 0,
    bufferPixels: 1_000_000, shadeRegionPixels: 0,
  } as ProbeMeasurement;
}

let write: ReturnType<typeof vi.fn<(verdict: CachedProbeVerdict | null) => void>>;

beforeEach(() => {
  resetProbeInFlightForTest();
  resetDeviceCaps();
  // ⚠️ MANDATORY between these tests: `resolveActiveTier` early-outs once a tier exists, so
  // without it every test after the first resolves nothing and asserts on the first test's probe
  // calls. It presents as "runBootRampProbe called 0 times" — which reads like the loop not
  // running, i.e. exactly the failure under test, from the one cause that is not it.
  resetRenderSettings();
  runBootRampProbe.mockReset();
  // 2.81 Mpx/ms on a 1 Mpx buffer — the Galaxy A23's measured 2D figure, i.e. `middle`.
  runBootRampProbe.mockResolvedValue(fakeMeasurement(2.81));
  write = vi.fn<(verdict: CachedProbeVerdict | null) => void>();
  probeVerdictStore.provide({ read: () => null, write });
  setRenderSettings({
    ...BASE,
    three: { ...BASE.three, qualityTier: 'auto', tiers: TWO_CONFIGS as never },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetProbeInFlightForTest();
  probeVerdictStore.provide(null as never);
  setRenderSettings(BASE);
  vi.restoreAllMocks();
});

describe('the boot probe settles within ONE launch (#221 W2)', () => {
  it('⭐ runs PROBE_SAMPLE_TARGET passes in a single resolve, not one', async () => {
    await resolveActiveTierForNo3D();
    expect(runBootRampProbe).toHaveBeenCalledTimes(PROBE_SAMPLE_TARGET);
  });

  it('⭐ writes a SETTLED verdict, so the next launch pays nothing', async () => {
    // The half that matters to a player: before this, launch 2 probed again — and launch 3. A
    // `final: false` write with a full sample set would be the silent half-fix (the cost paid, the
    // benefit not taken), which is why `final` is asserted and not just the sample count.
    await resolveActiveTierForNo3D();

    const last = write.mock.calls.at(-1)![0]!;
    expect(last.samples).toHaveLength(PROBE_SAMPLE_TARGET);
    expect(last.final).toBe(true);
    expect(last.deviceClass).toBe('middle');
  });

  it('a device that already has a SETTLED verdict does not probe at all', async () => {
    // The cache must still short-circuit ahead of the loop, or settling in one launch would just
    // move the cost to every launch.
    probeVerdictStore.provide({
      read: () => ({
        fingerprint: '', deviceClass: 'middle', final: true,
        samples: [{ cpuUnitsPerMs: 9_000, shadeMfragPerMs: 0, fillMpxPerMs: 2.81 }],
      } as CachedProbeVerdict),
      write,
    });
    await resolveActiveTierForNo3D();
    // The fingerprint will not match jsdom's, so this asserts the general shape rather than a hit;
    // what it must never do is loop three times on a device it has already settled.
    expect(runBootRampProbe.mock.calls.length).toBeLessThanOrEqual(PROBE_SAMPLE_TARGET);
  });

  it('⚠️ a pass that yields NO measurement stops the loop instead of retrying it', async () => {
    // `runBootRampProbe` resolves null for environment failures — no DOM, no renderer, a throw.
    // Retrying charges the launch again for a failure that is a property of the environment and
    // will reproduce. Two passes: one good, then null.
    runBootRampProbe
      .mockResolvedValueOnce(fakeMeasurement(2.81))
      .mockResolvedValue(null);

    await resolveActiveTierForNo3D();

    expect(runBootRampProbe).toHaveBeenCalledTimes(2);
    const last = write.mock.calls.at(-1)![0]!;
    expect(last.samples).toHaveLength(1);
    // NOT settled — one reading is not a median, and the next launch must be allowed to refine.
    expect(last.final).toBe(false);
  });

  it('⭐ passes that DISAGREE about the band do not settle — and only the COLD one is kept', async () => {
    // The measured reason this rule exists: in-launch passes are a WARMING sequence, not
    // independent draws. A Huawei Y6 read fill 1.37 → 2.11 → 1.69 inside one launch (in-launch
    // median 1.69) against a cross-launch median of 1.10 — a 1.5x upward bias, past the 1.68
    // `middle` fill floor. Medianing a warm population against cold-derived thresholds is the
    // mistake; disagreement is the signal that the warming reached a boundary.
    //
    // 1.0 / 2.5 / 2.5 with a cpu high enough not to veto: weak, then middle, then middle.
    runBootRampProbe
      .mockResolvedValueOnce(fakeMeasurement(1.0, 9_000))
      .mockResolvedValue(fakeMeasurement(2.5, 9_000));

    await resolveActiveTierForNo3D();

    expect(runBootRampProbe).toHaveBeenCalledTimes(PROBE_SAMPLE_TARGET);
    const last = write.mock.calls.at(-1)![0]!;
    expect(last.final).toBe(false);
    // Exactly the pre-#221 shape: one cold sample, refine on the next launch.
    expect(last.samples).toHaveLength(1);
    expect(last.samples[0].fillMpxPerMs).toBeCloseTo(1.0, 5);
    // And the stored band DESCRIBES that sample rather than being the lowest of all three.
    expect(last.deviceClass).toBe('weak');
  });

  it('⚠️ a first pass that yields no measurement writes NOTHING rather than an empty verdict', async () => {
    // Guards the `samples.length > 0` half of the write condition. Writing a verdict with no
    // samples would cache a device's `unknown` state, which `resolveProbeClass` has always refused
    // to do — and the loop made it newly reachable, because `deviceClass` now carries across passes.
    runBootRampProbe.mockResolvedValue(null);
    await resolveActiveTierForNo3D();
    expect(write).not.toHaveBeenCalled();
  });
});


/** ⭐ **THE SECOND HALF: SETTLING ACROSS LAUNCHES, WHICH #221 BROKE AND #240 MEASURED (issue #240).**
 *
 *  The in-launch loop above is seeded from the CACHE, so a launch that reads a stored sample runs
 *  fewer than `PROBE_SAMPLE_TARGET` passes by construction — and the in-launch settle requires
 *  three passes IN THIS LAUNCH. A device that missed the one settle window it gets (its passes
 *  disagreed, or the budget cut the loop short) therefore read 1 sample, ran 2 passes and stored 1
 *  sample, on every launch for the life of the install. Reproduced on a Galaxy A23 across three
 *  launches, 2026-08-18, at ~1.1 s of blocked launch each.
 *
 *  What these pin is the ACCUMULATION and the cross-launch settle, in launch sequences rather than
 *  in one call — the defect is invisible inside a single resolve, which is why the whole of #221's
 *  suite above stayed green through it. */
describe('the boot probe also settles ACROSS launches (#240)', () => {
  /** A persistent store, so a launch reads what the previous one wrote — the fingerprint included.
   *  Hand-building a cached record instead is the trap: jsdom's fingerprint would not match it, the
   *  record would read as "no cache", and the test would pass by probing from scratch. */
  function persistentStore() {
    const box: { record: CachedProbeVerdict | null } = { record: null };
    return {
      box,
      store: {
        read: () => box.record,
        write: (v: CachedProbeVerdict) => { box.record = v; },
      },
    };
  }

  /** One cold launch. The passes DISAGREE within it (cold 1.0 = weak, then warm 2.5 = middle),
   *  which is the near-boundary device the in-launch unanimity rule deliberately refuses to settle
   *  — and therefore the only device that ever reaches this path. Returns the pass count. */
  async function launch(store: ReturnType<typeof persistentStore>['store']): Promise<number> {
    resetProbeInFlightForTest();
    resetDeviceCaps();
    resetRenderSettings();
    setRenderSettings({
      ...BASE,
      three: { ...BASE.three, qualityTier: 'auto', tiers: TWO_CONFIGS as never },
    });
    runBootRampProbe.mockReset();
    runBootRampProbe.mockResolvedValue(fakeMeasurement(2.5, 9_000));
    runBootRampProbe.mockResolvedValueOnce(fakeMeasurement(1.0, 9_000));
    probeVerdictStore.provide(store as never);
    await resolveActiveTierForNo3D();
    return runBootRampProbe.mock.calls.length;
  }

  it('⭐ a device whose passes never agree still settles — by the THIRD launch, not never', async () => {
    const { box, store } = persistentStore();

    // Launch 1: empty cache, so the loop runs the full three passes and they disagree — one cold
    // reading is kept, exactly as before.
    expect(await launch(store)).toBe(PROBE_SAMPLE_TARGET);
    expect(box.record!.samples).toHaveLength(1);
    expect(box.record!.final).toBe(false);

    // Launch 2: THE REGRESSION. This wrote 1 sample back before the fix — the absorbing state.
    expect(await launch(store)).toBe(2);
    expect(box.record!.samples).toHaveLength(2);
    expect(box.record!.final).toBe(false);

    // Launch 3: the third COLD reading completes the cross-launch median, which is the pre-#221
    // rule and the degrade path the store's comment always claimed to preserve.
    expect(await launch(store)).toBe(1);
    expect(box.record!.samples).toHaveLength(PROBE_SAMPLE_TARGET);
    expect(box.record!.final).toBe(true);
    expect(box.record!.deviceClass).toBe('weak');
  });

  it('⭐ and then stops probing entirely — the launch-blocking probe is what the bug cost', async () => {
    const { box, store } = persistentStore();
    await launch(store);
    await launch(store);
    await launch(store);
    expect(box.record!.final).toBe(true);
    // The half a player feels. A settled record short-circuits ahead of the loop, so launch 4 pays
    // nothing; without the settle it paid two passes, forever.
    expect(await launch(store)).toBe(0);
  });

  it('⚠️ what accumulates is COLD readings only — never this launch\'s warm passes', async () => {
    // The reason the store kept one sample in the first place, and it must survive the fix: warm
    // in-launch passes are a different population from the cold ones the thresholds were derived
    // from, so medianing the two together is the "number from a different instrument" mistake.
    // Every launch here reads 1.0 cold and 2.5 warm; only the 1.0s may be persisted.
    const { box, store } = persistentStore();
    await launch(store);
    await launch(store);
    await launch(store);

    expect(box.record!.samples).toHaveLength(PROBE_SAMPLE_TARGET);
    for (const s of box.record!.samples) expect(s.fillMpxPerMs).toBeCloseTo(1.0, 5);
  });
});
