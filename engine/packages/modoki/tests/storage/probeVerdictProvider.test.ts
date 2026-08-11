/** The PlayerPrefs-backed probe verdict cache — the WRITE→READ round trip (#188).
 *
 *  ⚠️ **THIS FILE EXISTS BECAUSE ITS ABSENCE COST A SHIPPING BUG.** Both halves of the cache were
 *  unit-tested through their own module and neither was ever driven the way production drives it:
 *  write a verdict on one launch, read it back on the next. So when the classifier swapped from
 *  `fill`/`draw` to `cpu`/`shade` (#188, 2026-08-11), the provider's read-side validator kept
 *  checking the OLD field names — and because it validates unvalidated JSON through deliberate
 *  `as` casts, no type error was possible. Every read returned `null`, the cache was dead, and the
 *  probe re-ran on every launch forever while never accumulating the samples it needs to settle.
 *
 *  The device campaigns could not catch it either: they wipe app data before every launch on
 *  purpose, to get independent readings, which is exactly the state in which a dead cache is
 *  invisible. A round-trip test is the only thing that sees it. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PlayerPrefs, InMemoryBackend } from '../../src/runtime/storage';
import { probeVerdictStore, type CachedProbeVerdict } from '../../src/runtime/core/probeVerdictStore';
import { readingOf, refineProbeVerdict, type ProbeReading } from '../../src/runtime/rendering/rampProbe';
import '../../src/runtime/storage/probeVerdictProvider';

const VERDICT: CachedProbeVerdict = {
  fingerprint: 'v4|android|SM-A236B|Adreno (TM) 610|6',
  deviceClass: 'middle',
  // Real A23 readings (native, 2026-08-11).
  samples: [
    { cpuUnitsPerMs: 9_200, shadeMfragPerMs: 0.11 },
    { cpuUnitsPerMs: 9_900, shadeMfragPerMs: 0.14 },
  ],
  final: false,
};

describe('probe verdict cache — write then read, the way two launches drive it', () => {
  beforeEach(async () => {
    await PlayerPrefs.init({ backend: new InMemoryBackend() });
  });
  afterEach(() => { probeVerdictStore.get()?.write(null); });

  it('reads back exactly what it wrote — the seam that had no test', () => {
    const store = probeVerdictStore.get()!;
    store.write(VERDICT);
    expect(store.read()).toEqual(VERDICT);
  });

  it('accumulates samples ACROSS launches, so a device can actually settle', () => {
    // The property the cache exists for. With a dead read the sample list restarts at 1 every
    // launch, `PROBE_SAMPLE_TARGET` is never reached, `final` is never true, and the probe blocks
    // every launch for the life of the install — measurably worse than having no cache at all,
    // because the launch cost is paid forever and no verdict is ever earned.
    const launches: ProbeReading[] = [
      { cpuUnitsPerMs: 9_200, shadeMfragPerMs: 0.11 },
      { cpuUnitsPerMs: 9_900, shadeMfragPerMs: 0.14 },
      { cpuUnitsPerMs: 10_600, shadeMfragPerMs: 0.16 },
    ];
    const store = probeVerdictStore.get()!;
    let refined = refineProbeVerdict([], launches[0]);
    for (const reading of launches.slice(1)) {
      store.write({
        fingerprint: VERDICT.fingerprint,
        deviceClass: refined.deviceClass as CachedProbeVerdict['deviceClass'],
        samples: [...refined.samples],
        final: refined.final,
      });
      // The next launch reads the record back and folds its own pass in — if `read()` returns
      // null here the chain silently restarts, which is the whole bug.
      const carried = store.read();
      expect(carried, 'the previous launch\'s samples must survive').not.toBeNull();
      refined = refineProbeVerdict(carried!.samples, reading);
    }
    expect(refined.samples).toHaveLength(3);
    expect(refined).toMatchObject({ deviceClass: 'middle', final: true });
  });

  it('accepts a reading built by readingOf, not just a hand-written sample', () => {
    // Pins the two shapes together. `readingOf` is what production persists, so a field it emits
    // that the validator does not know about is the exact drift this file guards.
    const reading = readingOf({
      intervalMs: 16.7, clockKind: 'webgpu',
      fill: { kind: 'fill', status: 'ceiling', unitsPerMs: 0, bound: 'lower', peakLoad: 0, steps: [] },
      draw: { kind: 'draw', status: 'ceiling', unitsPerMs: 0, bound: 'lower', peakLoad: 0, steps: [] },
      cpu: { kind: 'cpu', status: 'escaped', unitsPerMs: 9_900, bound: 'measured', peakLoad: 131_072, steps: [] },
      shade: { kind: 'shade', status: 'escaped', unitsPerMs: 14, bound: 'measured', peakLoad: 512, steps: [] },
      totalMs: 1_700, rendererMs: 19, compileMs: 96, shadeCompileMs: 53,
      bufferPixels: 290_000, shadeRegionPixels: 10_000,
    });
    const store = probeVerdictStore.get()!;
    store.write({ ...VERDICT, samples: [reading] });
    expect(store.read()?.samples).toEqual([reading]);
  });

  it('still refuses a record that is malformed rather than merely old', () => {
    // The validation must stay strict — this value decides whether a phone boots into the tier
    // that once cost a Huawei Y6 its GPU context, so a partial record reads as "no cache".
    const store = probeVerdictStore.get()!;
    for (const bad of [
      { ...VERDICT, samples: [] },
      { ...VERDICT, samples: [{ cpuUnitsPerMs: Number.NaN, shadeMfragPerMs: 0.11 }] },
      { ...VERDICT, samples: [{ cpuUnitsPerMs: 9_200 }] },            // half a sample
      { ...VERDICT, deviceClass: 'unknown' as CachedProbeVerdict['deviceClass'] },
      { ...VERDICT, fingerprint: '' },
    ]) {
      store.write(bad as CachedProbeVerdict);
      expect(store.read(), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
});
