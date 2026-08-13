/** Classify a device by GPU IDENTITY rather than by benchmarking it at boot (#210).
 *
 *  ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *  `TIER_ALLOWLIST.androidGpuPatterns` shipped EMPTY, so 100% of Android devices fell through to
 *  the boot ramp probe. Measured 2026-08-12, that probe cannot carry the load:
 *
 *    - it measures the BOOT, not the device — the same Galaxy S22 reads `cpu` 11.2k on `sling`
 *      and 37.4k on `3d-physics-demo`, because the ramp runs while GLBs parse and textures upload;
 *    - its top axis is FLAT where the top boundary is — `shade` reads 0.20 / 0.21 / 0.20 for an
 *      iPhone 8, an S22 and an iPhone Air, so no Android device ever reached `capable`;
 *    - it needs THREE launches to settle (per-launch spread 2.3-4.5x), so the verdict is wrong on
 *      launches 1 and 2 — the ones a first impression is made on;
 *    - it BLOCKS LAUNCH 0.5-2.6 s.
 *
 *  Identity answers the same question in ~0 ms, correctly, on launch #1. The renderer string is
 *  already read on every device in a release build (`deviceCaps.readGlFacts`).
 *
 *  ── TWO LAYERS, AND THE SECOND COVERS THE FIRST'S BLIND SPOT ──────────────────────────────
 *  **Layer 2 (the table) answers for hardware we have data on** — 84 Android GPUs, from Kishonti's
 *  own open-sourced GFXBench results. Its mass sits at the bottom of the range, so the decision
 *  that can black-screen a phone is made where the data is densest. See `gpuBenchmarks.ts`.
 *
 *  **Layer 1 ({@link GENERATION_FLOORS}) answers for hardware the data can NEVER cover.** GFXBench
 *  was retired in December 2025, so that table is frozen for good: `Adreno 840`, `Immortalis-G925`
 *  and `Xclipse 950` will never appear in it. But the generation number is IN THE RENDERER STRING,
 *  and a per-family floor turns that into an answer with no data at all.
 *
 *  ⚠️ **EXTRAPOLATION IS ONLY EVER UPWARD, AND ONLY FROM AN AUTHORED FLOOR.** A generation below
 *  its family's floor is never extrapolated — it either matches a table row or falls through to
 *  the probe. Adreno numbering is not monotone in performance (an Adreno 662/665 is numerically
 *  above the 660 flagship and is a laptop or midrange part), so "higher number, better GPU" is
 *  sound only above a floor placed at the start of a flagship series.
 *
 *  This is the rule `qualityTier.ts` already applies on iOS and never applied here:
 *  *"A THRESHOLD, NOT A LIST — AND THAT IS THE WHOLE POINT… being out of date makes it
 *  conservative on OLD hardware rather than wrong on new."*
 *
 *  ── THE FAILURE DIRECTION IS NOT SYMMETRIC ────────────────────────────────────────────────
 *  Booting high on weak hardware is one 6,388 ms `submit-postfx`, a GPU watchdog kill, failed
 *  recovery, and a BLANK SCREEN for the process lifetime (#156, Huawei Y6). Booting low on strong
 *  hardware is a beat of uglier rendering the player can override. So every ambiguous case here
 *  resolves DOWN or returns `null` (which lands on the probe, and then on `low`) — never up.
 *
 *  Pure: takes a string, returns a verdict. No DOM, no renderer, no frame. That is what lets a
 *  2D-only project resolve a tier without mounting `Scene3D` at all (#203). */

import { GPU_BENCHMARK_FPS, GPU_BENCHMARK_SAMPLES } from './gpuBenchmarks';
import type { QualityTier } from './qualityTier';

/** Reduce a renderer string to a stable lookup key.
 *
 *  ⚠️ **MUST STAY IDENTICAL TO `normalizeGpuKey` IN `engine/scripts/gen-gpu-benchmarks.mjs`** —
 *  the generator writes the keys this looks up, so a divergence produces a table that silently
 *  never matches and a fleet that silently falls back to the probe. `gpuIdentity.test.ts` pins
 *  the two against each other by re-normalizing every generated key and requiring a fixed point.
 *
 *  The ANGLE unwrap is not a nicety: Android Chrome reports
 *  `ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)`, so without it the single most common
 *  string shape on the platform matches nothing. */
export function normalizeGpuKey(raw: string): string {
  // ⚠️ The unwrap is GREEDY to the LAST paren, and a lazy `[^)]*` here was a real bug: the inner
  // string contains `Adreno (TM)`, so a non-greedy class stops at THAT closing paren, the anchor
  // fails, the whole match fails, and `ANGLE (Qualcomm` survives as a candidate — which then
  // normalizes to `angle` and matches nothing in the table. The most common renderer string on
  // Android silently classified as unknown.
  const wrapped = /^angle\s*\((.*)\)\s*$/i.exec(raw.trim());
  const candidates = (wrapped ? wrapped[1] : raw)
    .split(',')
    // Normalize each field BEFORE choosing between them. Choosing first and stripping after let a
    // vendor-only field (`Qualcomm`) win the length comparison against the GPU name and then
    // collapse to nothing.
    .map((part) => part
      .toLowerCase()
      .replace(/\((?:tm|r)\)/g, ' ')
      .replace(/\b(?:qualcomm|arm|samsung|imagination|technologies|inc|corporation|ltd)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ''))
    // Drop the API field ANGLE appends (`OpenGL ES 3.2`) and anything a vendor strip emptied.
    .filter((s) => s && !/^(?:opengl|vulkan|direct3d|d3d)/.test(s));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? '';
}

/** A GPU family that gets an authored generation floor (see {@link GENERATION_FLOORS}), because its
 *  model numbers order monotonically at the top of the range. Deliberately excludes:
 *
 *    - **Mali-T** — a dead series (last part 2016); a "newer" T-number is not newer hardware.
 *    - **PowerVR Rogue** — upstream names half of them by codename (`hood`, `lando`, `marlowe`),
 *      so there is no number to compare and no maximum to be above.
 *    - **Apple** — WebGL masks it to `Apple GPU`. iOS answers from the model id instead, which is
 *      strictly better; see `iosModelTier`. */
type ExtrapolableFamily = 'adreno' | 'mali-g' | 'xclipse';

export interface ParsedGpu {
  /** Normalized family. `mali-g` covers Immortalis, which IS the Mali-G series renamed at the
   *  top end — upstream writes `mali-g720-immortalis` while a 2026 device reports
   *  `Immortalis-G925`, and reading those as two families would strand the newest hardware. */
  family: ExtrapolableFamily | 'mali-t' | 'powervr' | 'apple';
  /** The model number — `730` for an Adreno 730, `925` for an Immortalis-G925. */
  generation: number;
  /** Core count where the string carries one (`MC2`). Absent is not zero: most strings omit it. */
  cores?: number;
}

/** Extract family + generation from a NORMALIZED key. Takes the key rather than the raw string so
 *  the table's own keys and a live renderer string go through exactly the same parser — a second
 *  parser for one of them is how the two would drift. */
export function parseGpuKey(key: string): ParsedGpu | null {
  // ⚠️ **BOTH `MC` AND `MP`, and matching only `MC` silently killed the coreless fallback for every
  // older Mali.** ARM writes `MCn` on Valhall-era parts and `MPn` on Midgard/Bifrost ones, and the
  // table carries both (`malig72mp3`, `malit880mp12` beside `malig57mc2`). With `/mc(\d+)/` a
  // device reporting `Mali-G72 MP6` parsed as coreless, so the "retry without the core count" step
  // never ran, and it fell through to the probe even though `malig72` (47) is right there. The
  // stranded population is Midgard/Bifrost — i.e. exactly the old, weak hardware this table is
  // densest on and this whole feature exists for.
  const cores = /m[cp](\d+)/.exec(key);
  const withCores = (family: ParsedGpu['family'], generation: number): ParsedGpu =>
    cores ? { family, generation, cores: Number(cores[1]) } : { family, generation };

  // Immortalis FIRST: `malig720immortalis` must read as mali-g 720, and `immortalisg925` as
  // mali-g 925. Testing the bare `malig` pattern first would still work for the former, but the
  // latter has no `malig` prefix at all and would fall through to `null`.
  const immortalis = /^immortalisg(\d+)/.exec(key);
  if (immortalis) return withCores('mali-g', Number(immortalis[1]));

  const adreno = /^adreno(\d+)/.exec(key);
  if (adreno) return withCores('adreno', Number(adreno[1]));

  const maliG = /^malig(\d+)/.exec(key);
  if (maliG) return withCores('mali-g', Number(maliG[1]));

  const maliT = /^malit(\d+)/.exec(key);
  if (maliT) return withCores('mali-t', Number(maliT[1]));

  const xclipse = /^xclipse(\d+)/.exec(key);
  if (xclipse) return withCores('xclipse', Number(xclipse[1]));

  if (key.startsWith('powervr')) {
    const n = /(?:ge|gx|gm|gt|bxm|bxe)(\d+)/.exec(key);
    return n ? withCores('powervr', Number(n[1])) : null;
  }
  if (key.startsWith('apple')) return null;
  return null;
}

/** The two band floors, in the table's unit — median `1080p Manhattan Offscreen` fps.
 *
 *  ⚠️ **NOT A FRAME BUDGET.** These are boundaries on a RELATIVE RANKING; 29 does not mean 29 fps
 *  in a Modoki scene. The only thing that validates them is which side our measured devices land
 *  on, and that is checked by a test rather than asserted here.
 *
 *  ── THE THREE ANCHORS, WHICH ARE THE WHOLE JUSTIFICATION ──────────────────────────────────
 *      Huawei Y6      PowerVR GE8300     4.78  -> `low`   measured NOT to afford IBL (+26 ms of a
 *                                                         ~53 ms frame, 18 fps)
 *      Galaxy A23     Mali-G57 MC2      39.43  -> `mid`   measured affording IBL and shadows, and
 *                                                         holding 59.5 fps at DPR 1.5
 *      Galaxy S22     Adreno 730       143.24  -> `high`  measured resolving `high` on device
 *
 *  ⚠️ **NEITHER BOUNDARY SITS IN A LARGE VOID, AND THE PREVIOUS TABLE'S VOID WAS AN ARTIFACT.**
 *  The old detect-gpu-derived table had a conspicuous empty interval at 71-89 that this comment
 *  once leaned on as "decided by the data". It was not: those were ONSCREEN framerates capped at
 *  120 by a 120 Hz panel, so the "gap" was the edge of a saturation cliff. On uncapped offscreen
 *  data the distribution is dense and continuous — which is more truthful, and means both floors
 *  are now placed at the WIDEST LOCAL GAP rather than in a canyon:
 *
 *      `mid`  = 29  — the widest gap in the Y6..A23 corridor is 27.86 (`malig71`) -> 29.99
 *                     (Intel HD 5500), a 1.08x step with nothing between. It puts budget silicon
 *                     of the Mali-G52 / Adreno 430-512 class on `low`: those read 22-24, i.e.
 *                     ~0.6x the A23, which was itself measured only *just* affording IBL.
 *      `high` = 85  — the widest gap in the A23..S22 corridor is 77.24 (`adreno630`) -> 91.02
 *                     (`adreno640`), a 1.18x step. It puts 2019-and-later flagships on `high`
 *                     (Adreno 640/650/660/730+, Mali-G78, Xclipse 920) and upper-midrange on
 *                     `mid` (Adreno 618/630/642L, Mali-G68/G72/G76/G77).
 *
 *  Both err toward `low`, the recoverable direction: a beat of uglier rendering, against the lost
 *  GPU context and permanently black screen of #156. And no entry sits exactly ON either value, so
 *  neither is one rounding away from flipping — a property a test pins, because it was violated
 *  once already (a floor of 22 landed exactly on two 2016 budget parts and promoted them).
 *
 *  **What would settle them properly: measured devices BETWEEN the anchors.** Everything from 4.78
 *  to 143 rests on three points and a plausibility argument. One phone reading 20-40 and one
 *  reading 80-120, run against the `mid`/`high` configs, would replace most of this paragraph. */
export const MID_FLOOR_FPS = 29;
/** See {@link MID_FLOOR_FPS}. Placed in the empty 77.24-91.02 interval. */
export const HIGH_FLOOR_FPS = 85;

/** Submissions behind a table row at or above which its figure is taken at FACE VALUE.
 *
 *  The generator's sample gate softened from 3 to 1 on 2026-08-13 (84 rows -> 132; see
 *  `gen-gpu-benchmarks.mjs` for the bootstrap that justifies it). The measured risk of a thin row
 *  is small but not zero — **0.7% of single submissions land in a different band than their GPU's
 *  full-population median** — and it is concentrated entirely in rows sitting just above a floor.
 *  A row at 143 does not care; a row at 29.4 against a floor of 29 does.
 *
 *  So the softening is paid for HERE rather than by dropping the data: below this many samples, a
 *  figure inside {@link LOW_CONFIDENCE_MARGIN} of the floor it just cleared is rounded DOWN. The
 *  value is 3 because that is the gate this replaced — rows the old table already trusted are
 *  trusted identically, so nothing that shipped before changes tier. */
export const CONFIDENT_SAMPLES = 3;

/** How far above a floor a thin row must sit to be believed — 1.2, i.e. 20%.
 *
 *  Chosen against the measured spread rather than picked: the p75 single-submission reading is
 *  1.06x its truth and the p95 is 1.49x, so 20% covers the ordinary high tail without discarding
 *  rows that clear a floor decisively. Applied to today's table it demotes **exactly four** rows,
 *  all of them thin AND boundary-adjacent — Adreno 615 (29.4), Intel Skylake GT1 (31.0) and Adreno
 *  616 (32.4) over the `mid` floor of 29, and Adreno 644 (90.3, n=1) over the `high` floor of 85 —
 *  and leaves the other 44 additions at face value.
 *
 *  ⚠️ It rounds DOWN only. A thin row just BELOW a floor is left alone: that is already the safe
 *  side, and promoting on thin evidence is the direction that ends in a lost GPU context (#156). */
export const LOW_CONFIDENCE_MARGIN = 1.2;

/** Band a table reading falls in. Pure and total — every number has a band.
 *
 *  `samples` is the row's submission count ({@link GPU_BENCHMARK_SAMPLES}). Omit it and the figure
 *  is taken at face value, which is the right default for a number that did not come from the
 *  table — a test's literal, or a future hand-authored anchor. Passing it in is what activates the
 *  {@link CONFIDENT_SAMPLES} rounding, and both real call sites do. */
export function tierForBenchmarkFps(fps: number, samples?: number): QualityTier {
  const thin = samples !== undefined && samples < CONFIDENT_SAMPLES;
  // Round a thin row down to the band below whichever floor it only just cleared. Written as
  // "cleared this floor but not by the margin" rather than as a scaled comparison so that the two
  // floors cannot drift apart: each is checked against its own value.
  if (fps >= HIGH_FLOOR_FPS) return thin && fps < HIGH_FLOOR_FPS * LOW_CONFIDENCE_MARGIN ? 'mid' : 'high';
  if (fps >= MID_FLOOR_FPS) return thin && fps < MID_FLOOR_FPS * LOW_CONFIDENCE_MARGIN ? 'low' : 'mid';
  return 'low';
}

/** Per family: the generation at or above which a GPU is `high` WITHOUT a table row.
 *
 *  This is the "A THRESHOLD, NOT A LIST" rule that `IOS_TIER_MIN_GENERATION` already applies to
 *  Apple model ids, applied to Android — and it is AUTHORED, deliberately, having first been
 *  derived from the table and found broken.
 *
 *  ⚠️ **DERIVING IT FROM THE TABLE FAILED, AND THE FAILURE WAS INSTRUCTIVE.** The ceiling used to
 *  be "the highest generation the table knows", with extrapolation allowed only into a NEWER
 *  SERIES (`floor(n/100)`), because within one series the trailing digits are market tier rather
 *  than generation — an Adreno 662/665 is numerically above the 660 flagship and is a laptop or
 *  midrange part, so a plain `>` would promote it. That reasoning is still right.
 *
 *  What broke it was BETTER DATA. When the source moved to Kishonti's results the table gained
 *  `adreno830`, so the derived ceiling moved from 750 to 830 — *inside* the 8xx series — and the
 *  newer-series test then refused every Adreno above it. **Adreno 840 and 850 fell through to the
 *  probe**, and because GFXBench is retired the table can never gain them. A rule whose coverage
 *  SHRANK when the data improved is the wrong rule.
 *
 *  An authored floor has neither problem: it is unaffected by what the table happens to contain
 *  (the table is consulted first anyway, so a listed GPU never reaches here), and being out of date
 *  makes it conservative on old hardware rather than wrong on new. Each entry is one public fact.
 *
 *  ⚠️ Set each floor at the START OF A FLAGSHIP SERIES, never just above the newest chip — the
 *  point is to answer for silicon that does not exist yet. */
const GENERATION_FLOORS: Partial<Record<ParsedGpu['family'], { atOrAbove: number; tier: QualityTier }>> = {
  /** Adreno 8xx is the Snapdragon 8 Elite line (830 = Gen 4, 840 = Gen 5). Everything below 800
   *  is 7xx or older, where the table decides and an unlisted part is genuinely ambiguous. */
  adreno: { atOrAbove: 800, tier: 'high' },
  /** ARM's flagship line renamed to Immortalis and moved to three digits at G7xx; G9xx is the
   *  Immortalis generation (G925 = Dimensity 9400). G6xx/G7xx contain midrange parts, so the floor
   *  sits above them rather than at G700. */
  'mali-g': { atOrAbove: 900, tier: 'high' },
  /** Samsung has stayed inside 9xx across three architectures (920 = Exynos 2200, 940 = 2400,
   *  950 = 2500), so the floor sits just above the generations the table can cover. */
  xclipse: { atOrAbove: 930, tier: 'high' },
};

/** Test seam — the authored floors. Exported so a test can assert they still sit above what the
 *  table answers for, i.e. that the two mechanisms cannot contradict each other. */
export function gpuGenerationFloors(): Readonly<typeof GENERATION_FLOORS> {
  return GENERATION_FLOORS;
}

/** Band a table row, and the parenthetical that explains it — from ONE reading of the row.
 *
 *  ⚠️ **The tier and the explanation must not be computed separately, and they were at first.** A
 *  first cut had the call sites pass `GPU_BENCHMARK_SAMPLES[key]` to `tierForBenchmarkFps` and a
 *  sibling helper re-derive "did that round down?" for the reason. A mutation test found the hole
 *  immediately: drop the sample count at ONE call site and the tier silently stops rounding while
 *  the reason keeps announcing a rounding that no longer happens. Two halves of one fact, kept in
 *  step by hand, is the exact shape this repo keeps getting bitten by — so there is now one
 *  lookup, and a caller cannot hold it wrong.
 *
 *  ⚠️ **The rounding case MUST say so.** An Adreno 644 reading 90.3 against a documented `high`
 *  floor of 85 resolves `mid`, and a reader comparing those two numbers in `diagnose` has every
 *  reason to file a bug. The one surface that explains a surprising tier has to explain this one
 *  too — the same argument `resolveProbeClass` makes for labelling its evidence-only lines. */
function bandRow(key: string, fps: number): { tier: QualityTier; note: string } {
  const n = GPU_BENCHMARK_SAMPLES[key];
  const tier = tierForBenchmarkFps(fps, n);
  if (n === undefined || n >= CONFIDENT_SAMPLES) return { tier, note: '' };
  const note = `, from ${n} submission${n === 1 ? '' : 's'}`
    + (tier !== tierForBenchmarkFps(fps)
      ? ` — rounded DOWN a band for sitting within ${LOW_CONFIDENCE_MARGIN}x of the floor` : '');
  return { tier, note };
}

export interface GpuIdentityVerdict {
  tier: QualityTier;
  /** Which layer answered. `'gpu-benchmark'` is a table hit; `'gpu-generation'` is extrapolation
   *  past the top of the table. Distinct because they carry different confidence, and a surprising
   *  tier should be explainable from `diagnose` without an eval. */
  via: 'gpu-benchmark' | 'gpu-generation';
  reason: string;
}

/** Classify a renderer string, or return `null` when identity cannot answer — which is the signal
 *  to fall through to the boot probe.
 *
 *  Lookup order, most specific first:
 *    1. the full key including core count (`malig57mc2`) — upstream distinguishes MC2 (36) from
 *       MC3 (48), which is exactly the "one name ships two GPUs" ambiguity that was given as the
 *       reason Android had to measure;
 *    2. the key WITHOUT core count (`malig57`) — a core count we have no row for is still a
 *       family+generation we do;
 *    3. generation extrapolation, but only ABOVE the table's maximum for that family.
 *
 *  Returns `null` rather than guessing on: a masked string (`Apple GPU`), an unknown vendor, a
 *  software rasterizer, or a generation below the table's maximum that simply is not listed. */
export function gpuIdentityTier(renderer: string | undefined): GpuIdentityVerdict | null {
  if (!renderer) return null;
  const key = normalizeGpuKey(renderer);
  if (!key) return null;

  const exact = GPU_BENCHMARK_FPS[key];
  if (exact !== undefined) {
    const { tier, note } = bandRow(key, exact);
    return {
      tier,
      via: 'gpu-benchmark',
      reason: `${renderer} is a known GPU (throughput index ${exact}${note})`,
    };
  }

  const parsed = parseGpuKey(key);
  if (!parsed) return null;

  // (2) Drop the core count and retry. `mc2` is a suffix on the key, so removing it is textual
  // rather than a re-serialization — which keeps this honest if the key format ever gains a field.
  if (parsed.cores !== undefined) {
    const coreless = key.replace(/m[cp]\d+/, '');
    const relaxed = GPU_BENCHMARK_FPS[coreless];
    if (relaxed !== undefined) {
      const { tier, note } = bandRow(coreless, relaxed);
      return {
        tier,
        via: 'gpu-benchmark',
        reason: `${renderer} matched ${coreless} (throughput index ${relaxed}${note}); `
          + 'no row for this core count',
      };
    }
  }

  // (3) Newer than the data can ever cover. See {@link GENERATION_FLOORS}.
  //
  // ⚠️ Keyed by `parsed.family` with NO CAST, and the `Partial<>` on the record is what makes that
  // safe. It used to read `GENERATION_FLOORS[parsed.family as ExtrapolableFamily]` against a TOTAL
  // `Record`, so TypeScript typed `floor` as non-undefined while `parsed.family` can perfectly well
  // be `powervr`, `mali-t` or `apple` — for which the lookup really is `undefined`. The `floor &&`
  // below was therefore the only thing between a PowerVR device and `undefined.atOrAbove`, and the
  // compiler considered that guard redundant: a tidy-up pass removing an "always truthy" check
  // would have thrown a TypeError inside `resolveTier`, on the renderer's bring-up path.
  const floor = GENERATION_FLOORS[parsed.family];
  if (floor && parsed.generation >= floor.atOrAbove) {
    return {
      tier: floor.tier,
      via: 'gpu-generation',
      reason: `${renderer} is ${parsed.family} generation ${parsed.generation}, at or above the `
        + `'${floor.tier}' floor of ${floor.atOrAbove}`,
    };
  }

  return null;
}
