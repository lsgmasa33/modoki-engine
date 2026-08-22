/** gpuIdentity — classify a device from its GPU renderer string (#210).
 *
 *  The load-bearing tests here are the THREE REAL DEVICES: this table's only claim to correctness
 *  is that hardware we have measured lands in the band we measured it into. Everything else is
 *  mechanism.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeGpuKey, parseGpuKey, gpuIdentityTier, tierForBenchmarkFps,
  gpuGenerationFloors, MID_FLOOR_FPS, HIGH_FLOOR_FPS,
  CONFIDENT_SAMPLES, LOW_CONFIDENCE_MARGIN,
} from '../../src/runtime/rendering/gpuIdentity';
import { GPU_BENCHMARK_FPS, GPU_BENCHMARK_SAMPLES } from '../../src/runtime/rendering/gpuBenchmarks';

/** The readings the band floors were DERIVED from — rows with enough submissions to be taken at
 *  face value ({@link CONFIDENT_SAMPLES}).
 *
 *  ⚠️ **The gap tests below must use this, not every value in the table, and the reason is the
 *  whole point of the sample gate softening (2026-08-13).** Dropping the gate from 3 to 1 added 48
 *  rows, four of which land inside the floors' gaps — and those four are demoted by the
 *  low-confidence rule precisely BECAUSE they land there. Asserting the gaps over the raw values
 *  would fail on rows whose values the resolver deliberately does not believe. */
const confidentFps = (): number[] =>
  Object.entries(GPU_BENCHMARK_FPS)
    .filter(([key]) => (GPU_BENCHMARK_SAMPLES[key] ?? 0) >= CONFIDENT_SAMPLES)
    .map(([, fps]) => fps);

describe('normalizeGpuKey', () => {
  it('unwraps the ANGLE form Android Chrome actually reports', () => {
    // Not a nicety — this is the single most common string shape on the platform, and without the
    // unwrap the whole table matches nothing there.
    expect(normalizeGpuKey('ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)')).toBe('adreno730');
  });

  it('reduces the bare and vendor-prefixed forms to the same key', () => {
    expect(normalizeGpuKey('Adreno (TM) 730')).toBe('adreno730');
    expect(normalizeGpuKey('Qualcomm Adreno 730')).toBe('adreno730');
  });

  it('keeps the core count, which is what distinguishes two real GPUs', () => {
    // `mali-g57 mc2` reads 39.4 and `mc3` reads 47.9 — the "one name ships two GPUs" ambiguity
    // that was given as the reason Android had to be benchmarked instead of looked up.
    expect(normalizeGpuKey('Mali-G57 MC2')).toBe('malig57mc2');
    expect(normalizeGpuKey('Mali-G57 MC3')).toBe('malig57mc3');
  });

  it('is a FIXED POINT over every generated key', () => {
    // The generator has its own copy of this function (it is an .mjs build script and cannot
    // import from the package). A divergence would produce a table that silently never matches
    // and a fleet that quietly fell back to the probe — no error, no log, just a dead layer.
    for (const key of Object.keys(GPU_BENCHMARK_FPS)) {
      expect(normalizeGpuKey(key)).toBe(key);
    }
  });
});

describe('parseGpuKey', () => {
  it('reads Immortalis as the Mali-G series it is', () => {
    // Upstream writes `mali-g720-immortalis`; a 2026 device reports `Immortalis-G925`. Reading
    // those as two families would strand exactly the newest hardware.
    expect(parseGpuKey('malig720immortalismc12')).toMatchObject({ family: 'mali-g', generation: 720 });
    expect(parseGpuKey(normalizeGpuKey('Immortalis-G925 MC12')))
      .toMatchObject({ family: 'mali-g', generation: 925, cores: 12 });
  });

  it('separates the dead Mali-T series from Mali-G', () => {
    expect(parseGpuKey('malit880mp12')).toMatchObject({ family: 'mali-t', generation: 880 });
  });

  it('declines a PowerVR codename rather than inventing a generation', () => {
    expect(parseGpuKey('powervrroguemarlowe')).toBeNull();
    expect(parseGpuKey('powervrroguege8300')).toMatchObject({ family: 'powervr', generation: 8300 });
  });

  it('declines a masked Apple string', () => {
    expect(parseGpuKey(normalizeGpuKey('Apple GPU'))).toBeNull();
  });
});

describe('band floors', () => {
  it('places the boundaries where the derivation says', () => {
    expect(tierForBenchmarkFps(HIGH_FLOOR_FPS)).toBe('high');
    expect(tierForBenchmarkFps(HIGH_FLOOR_FPS - 1)).toBe('mid');
    expect(tierForBenchmarkFps(MID_FLOOR_FPS)).toBe('mid');
    expect(tierForBenchmarkFps(MID_FLOOR_FPS - 1)).toBe('low');
  });

  it('the high floor still sits in an EMPTY interval of the CONFIDENT table', () => {
    // 85 sits in the widest gap of the A23..S22 corridor — 77.24 (`adreno630`) to 91.02
    // (`adreno640`), with nothing between. Regenerating the table could close that gap and
    // silently turn a data-placed boundary into an arbitrary one; this fails when that happens.
    //
    // ⚠️ It DID happen, and the guard worked: softening the sample gate added `adreno644` at
    // 90.273, inside this gap. It is a single submission, so the low-confidence rule rounds it to
    // `mid` — see the rule's own tests below. The floor is still placed by the data it was
    // derived from, which is what this asserts.
    const inGap = confidentFps().filter((f) => f > 77.241 && f < 91.023);
    expect(inGap).toEqual([]);
    expect(HIGH_FLOOR_FPS).toBeGreaterThan(77.241);
    expect(HIGH_FLOOR_FPS).toBeLessThan(91.023);
  });

  it('⚠️ the MID floor sits in an empty interval too, and NO entry lands exactly on it', () => {
    // REGRESSION (close-out): an earlier floor sat exactly ON two 2016-era BUDGET parts, so `>=`
    // promoted them to `mid` — IBL, shadows, DPR 1.5 — on the thinnest evidence in the table, in
    // the direction that costs a GPU context (#156). 29 sits in the empty 27.86-29.99 interval,
    // and the last assertion keeps it off any entry exactly.
    const inGap = confidentFps().filter((f) => f > 27.864 && f < 29.992);
    expect(inGap).toEqual([]);
    expect(MID_FLOOR_FPS).toBeGreaterThan(27.864);
    expect(MID_FLOOR_FPS).toBeLessThan(29.992);
    // A boundary that any entry sits exactly on is one rounding away from flipping. Asserted over
    // the WHOLE table, thin rows included: an exact hit is a coincidence worth knowing about
    // whatever the row's confidence, and the low-confidence rule rounds down rather than away.
    expect(Object.values(GPU_BENCHMARK_FPS)).not.toContain(MID_FLOOR_FPS);
  });

  it('⚠️ 2016 BUDGET silicon is low; 2016 FLAGSHIP silicon is mid', () => {
    // The semantic the mid floor buys, pinned so a future retune has to face it explicitly:
    // budget silicon of the era does not get IBL and shadows; a flagship of the same era does.
    expect(gpuIdentityTier('Adreno (TM) 512')?.tier).toBe('low');   // Snapdragon 625, budget
    expect(gpuIdentityTier('Mali-G52 MC2')?.tier).toBe('low');      // entry-level
    expect(gpuIdentityTier('Adreno (TM) 530')?.tier).toBe('mid');   // Snapdragon 820, flagship
  });
});

describe('⚠️ thin rows — the price of softening the sample gate from 3 to 1', () => {
  // The gate softened on 2026-08-13 (84 rows -> 132) because the measured band-flip rate of a
  // single submission is 0.7%, and because the alternative to a row is the boot probe, which was
  // measured missing by a FULL BAND on a Galaxy S22. This rule is where that risk is paid for.

  it('takes a thin row at face value when it clears the floor by the margin', () => {
    // Adreno 619 (47.5, n=1) is nowhere near 29 — one submission is fine when the answer is not
    // close. If this ever demotes, the rule has stopped being a boundary rule.
    expect(gpuIdentityTier('Adreno (TM) 619')?.tier).toBe('mid');
    expect(gpuIdentityTier('Mali-G610 MC6')?.tier).toBe('high');   // 160.9, n=1
  });

  it('⭐ rounds a thin row DOWN when it only just clears a floor', () => {
    // The four rows in today's table that are both thin AND boundary-adjacent. Each would have
    // shipped a band higher on one or two submissions.
    expect(gpuIdentityTier('Adreno (TM) 644')?.tier).toBe('mid');  // 90.3, n=1, high floor 85
    expect(gpuIdentityTier('Adreno (TM) 615')?.tier).toBe('low');  // 29.4, n=2, mid floor 29
    expect(gpuIdentityTier('Adreno (TM) 616')?.tier).toBe('low');  // 32.4, n=2
  });

  it('says WHY in the reason, because the two numbers otherwise read as a bug', () => {
    // 90.3 against a documented floor of 85 resolving `mid` is exactly the shape of thing a
    // reader files a bug about. `diagnose` is the surface that has to answer for it.
    const v = gpuIdentityTier('Adreno (TM) 644');
    expect(v?.reason).toContain('1 submission');
    expect(v?.reason).toContain('rounded DOWN');
    // ...and a confident row says nothing extra, so the note means something when it appears.
    expect(gpuIdentityTier('Adreno (TM) 730')?.reason).not.toContain('submission');
  });

  it('rounds DOWN only — a thin row just BELOW a floor is left where it is', () => {
    // Promoting on thin evidence is the direction that ends in a lost GPU context (#156). A row
    // sitting under a floor is already on the safe side and must not be nudged across it.
    expect(tierForBenchmarkFps(MID_FLOOR_FPS - 0.1, 1)).toBe('low');
    expect(tierForBenchmarkFps(HIGH_FLOOR_FPS - 0.1, 1)).toBe('mid');
  });

  it('leaves every CONFIDENT row exactly where it was before the gate softened', () => {
    // The compatibility claim the value of CONFIDENT_SAMPLES rests on: it is the OLD gate, so a
    // row the previous table shipped is judged identically. Nothing that shipped changes tier.
    for (const [key, fps] of Object.entries(GPU_BENCHMARK_FPS)) {
      if ((GPU_BENCHMARK_SAMPLES[key] ?? 0) < CONFIDENT_SAMPLES) continue;
      expect(tierForBenchmarkFps(fps, GPU_BENCHMARK_SAMPLES[key]), key).toBe(tierForBenchmarkFps(fps));
    }
  });

  it('⚠️ demotes only a HANDFUL of rows — a regeneration that demotes wholesale is a red flag', () => {
    // Non-vacuity in both directions. If a future source produced mostly thin rows, this rule
    // would quietly become "everything is one band lower", which is a different policy than the
    // one that was argued for. Four today; the ceiling is deliberately loose, the point is order
    // of magnitude.
    const demoted = Object.entries(GPU_BENCHMARK_FPS).filter(([key, fps]) =>
      tierForBenchmarkFps(fps, GPU_BENCHMARK_SAMPLES[key]) !== tierForBenchmarkFps(fps));
    expect(demoted.length).toBeGreaterThan(0);
    expect(demoted.length).toBeLessThan(15);
  });

  it('the margin and the confidence gate are the values the derivation names', () => {
    // Both are quoted by number in gen-gpu-benchmarks.mjs's justification and in rendering.md.
    // Changing one without the other leaves the prose lying.
    expect(CONFIDENT_SAMPLES).toBe(3);
    expect(LOW_CONFIDENCE_MARGIN).toBe(1.2);
  });
});

describe('⭐ the three devices this was measured on', () => {
  // These are the entire empirical basis for the table. If one moves, the layer is wrong — not
  // the test.
  it('Huawei Y6 2019 (PowerVR GE8300) -> low', () => {
    // Measured NOT to afford IBL: +26 ms of a ~53 ms frame, 18 fps.
    expect(gpuIdentityTier('PowerVR Rogue GE8300')).toMatchObject({ tier: 'low', via: 'gpu-benchmark' });
  });

  it('Galaxy A23 5G (Mali-G57 MC2) -> mid', () => {
    // Measured AFFORDING IBL and shadows, and holding 59.5 fps at DPR 1.5.
    expect(gpuIdentityTier('Mali-G57 MC2')).toMatchObject({ tier: 'mid', via: 'gpu-benchmark' });
  });

  it('Galaxy S22 (Adreno 730) -> high, through the ANGLE string it really reports', () => {
    // The device the probe called `middle` on two separate projects, which is what started #210.
    expect(gpuIdentityTier('ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)'))
      .toMatchObject({ tier: 'high', via: 'gpu-benchmark' });
  });
});

describe('generation extrapolation — the frozen-table escape hatch', () => {
  it('⚠️ the floors are AUTHORED, and deriving them from the table was measured to break', () => {
    // REGRESSION: the ceiling used to be "the highest generation the table knows", extrapolating
    // only into a newer series. When the data source improved and the table GAINED `adreno830`,
    // that ceiling moved INSIDE the 8xx series and the rule then refused Adreno 840 and 850 —
    // real, shipping flagships — permanently, since GFXBench is retired and the table can never
    // gain them. A rule whose coverage SHRINKS when the data improves is the wrong rule.
    const floors = gpuGenerationFloors();
    expect(floors.adreno).toMatchObject({ atOrAbove: 800, tier: 'high' });
    expect(floors['mali-g']).toMatchObject({ atOrAbove: 900, tier: 'high' });
    expect(floors.xclipse).toMatchObject({ atOrAbove: 930, tier: 'high' });
  });

  it('an Adreno the table DOES list is answered by the table, not the floor', () => {
    // 830 is in the data now, so it must not reach the floor at all — the two mechanisms have to
    // agree about who owns a given GPU, or a table fix would be silently overridden.
    expect(gpuIdentityTier('Adreno (TM) 830')).toMatchObject({ tier: 'high', via: 'gpu-benchmark' });
  });

  it('classifies REAL current silicon the table has never heard of', () => {
    // ⚠️ These are shipping parts, not invented ones. An earlier version of this test used
    // `Adreno (TM) 850`, which DOES NOT EXIST — it was a rumour for Snapdragon 8 Elite Gen 6. A
    // test that only passes for hardware nobody sells is not a guarantee about anything.
    //
    // The point this pins: GFXBench stopped publishing in Dec 2025 and the newest alternative
    // (cpuranker, Jan 2026) does not have these either, so NO database answers here — the
    // generation parse is what covers the top of the market, and it needs no data refresh ever.
    const real = [
      'Adreno (TM) 840',       // Snapdragon 8 Elite Gen 5
      'Adreno (TM) 850',       // the generation after it, which will never be in a frozen table
      'Immortalis-G925 MC12',  // Dimensity 9400
      'Xclipse 950',           // Exynos 2500
    ];
    for (const renderer of real) {
      expect(gpuIdentityTier(renderer), renderer)
        .toMatchObject({ tier: 'high', via: 'gpu-generation' });
    }
  });

  it('a midrange part INSIDE the top series falls to the probe, and that is deliberate', () => {
    // Adreno 725/732/735 are real 2023-24 midrange parts absent from our table. Layer 1 refuses
    // them because extrapolating inside a series is unsound (an Adreno 765 is numerically above a
    // 750 and architecturally below it). They take the conservative path instead.
    //
    // This is the ONE gap a newer database would close — cpuranker (Jan 2026) has all three, plus
    // Huawei's Maleoon family, which detect-gpu lacks entirely. Recorded here so the gap is a
    // known, tested property rather than a surprise.
    for (const renderer of ['Adreno (TM) 725', 'Adreno (TM) 732', 'Adreno (TM) 735', 'Maleoon 910']) {
      expect(gpuIdentityTier(renderer), renderer).toBeNull();
    }
  });

  it('⚠️ a BIGGER NUMBER inside the top series is not a newer series — Adreno 765 is not high', () => {
    // REGRESSION: a plain `generation > ceiling` promoted this to `high`. Within one Adreno series
    // the last two digits are the market tier, not the generation — an Adreno 765 is upper-
    // midrange where an Adreno 750 is a flagship. Unlisted and inside the top series means the
    // probe answers, not an inherited flagship band.
    expect(gpuIdentityTier('Adreno (TM) 765')).toBeNull();
    // And the flagship series above the floor still extrapolates, so the guard did not disable
    // the feature it guards.
    expect(gpuIdentityTier('Adreno (TM) 840')).toMatchObject({ tier: 'high', via: 'gpu-generation' });
  });

  it('Xclipse clears its floor, which sits above the generations the table can cover', () => {
    // 920 (Exynos 2200) -> 940 (2400) -> 950 (2500) are three architectures inside one hundred,
    // which is why this family's floor is 930 rather than a round series boundary.
    expect(gpuIdentityTier('Samsung Xclipse 950')).toMatchObject({ tier: 'high', via: 'gpu-generation' });
  });

  it('does not extrapolate a dead series', () => {
    expect(gpuIdentityTier('Mali-T9999')).toBeNull();
  });

  it('⚠️ a family with NO floor reaches the lookup and must not throw', () => {
    // REGRESSION (close-out): the floors were a TOTAL `Record<ExtrapolableFamily, …>` indexed with
    // `parsed.family as ExtrapolableFamily`. The cast lies — `parsed.family` is also `powervr`,
    // `mali-t` or `apple`, for which the lookup is genuinely `undefined` — but TypeScript typed the
    // result as non-undefined, so the `floor &&` guard that prevented `undefined.atOrAbove` looked
    // REDUNDANT to the compiler and to any tidy-up pass. Removing it would throw a TypeError inside
    // `resolveTier`, on the renderer bring-up path.
    //
    // These three parse to a family with no floor and no table row, so they take exactly that path.
    for (const renderer of ['PowerVR Rogue GE9999', 'Mali-T9999', 'Mali-T1234 MP8']) {
      expect(() => gpuIdentityTier(renderer), renderer).not.toThrow();
      expect(gpuIdentityTier(renderer), renderer).toBeNull();
    }
  });

  it('prefers an exact table hit over any parse — codenames included', () => {
    // `powervr rogue marlowe` HAS a row (39). `parseGpuKey` cannot read a generation out of it,
    // and it does not need to: the lookup already answered. Asserting null here was my own error,
    // and it would have argued for deleting a working row.
    expect(gpuIdentityTier('PowerVR Rogue Marlowe'))
      .toMatchObject({ tier: 'mid', via: 'gpu-benchmark' });
  });
});

describe('declining to answer — which is what hands the device to the probe', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['masked Apple', 'Apple GPU'],
    ['software rasterizer', 'SwiftShader'],
    ['an unknown vendor', 'Vivante GC7000'],
  ])('%s -> null', (_label, renderer) => {
    expect(gpuIdentityTier(renderer)).toBeNull();
  });

  it('falls back to the coreless row when the core count is unlisted', () => {
    // `mali-g76 mc4` is listed; a `mali-g76 mc9` is not, but the family+generation still is.
    const v = gpuIdentityTier('Mali-G76 MC9');
    expect(v).not.toBeNull();
    expect(v!.via).toBe('gpu-benchmark');
    expect(v!.reason).toContain('no row for this core count');
  });

  it('⚠️ MP core counts fall back too, not just MC — older Mali writes MPn', () => {
    // REGRESSION (close-out): the cores regex was `/mc(\d+)/`, so every Midgard/Bifrost part
    // parsed as coreless and the fallback above never ran for them. `Mali-G72 MP6` has no row,
    // fell straight through to the probe, and `malig72` (47) was sitting right there unused.
    // The stranded population is old, weak hardware — exactly what this table is densest on.
    for (const [renderer, tier] of [
      ['Mali-G72 MP6', 'mid'],     // malig72  = 47
      ['Mali-T880 MP16', 'low'],   // malit880 = 11
      ['Mali-T760 MP2', 'low'],    // malit760 =  9
    ] as const) {
      const v = gpuIdentityTier(renderer);
      expect(v, renderer).not.toBeNull();
      expect(v!.tier, renderer).toBe(tier);
      expect(v!.reason, renderer).toContain('no row for this core count');
    }
  });
});

describe('the table itself', () => {
  it('is non-vacuous and every value is a usable number', () => {
    const entries = Object.entries(GPU_BENCHMARK_FPS);
    expect(entries.length).toBeGreaterThan(70);
    for (const [key, fps] of entries) {
      expect(Number.isFinite(fps), key).toBe(true);
      expect(fps, key).toBeGreaterThan(0);
    }
  });

  it('keeps its mass where the risky decision is made', () => {
    // The argument for trusting this layer at the bottom is that most of the data lives there:
    // the decision that can black-screen a phone is made where entries are dense. If a
    // regeneration ever inverted that, the argument would need re-making.
    const all = Object.values(GPU_BENCHMARK_FPS);
    expect(all.filter((f) => f < MID_FLOOR_FPS).length / all.length).toBeGreaterThan(0.5);
  });
});
