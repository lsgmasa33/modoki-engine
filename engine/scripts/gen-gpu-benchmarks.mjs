#!/usr/bin/env node
/** Generate `runtime/rendering/gpuBenchmarks.ts` — the vendored mobile-GPU throughput table that
 *  layer 2 of the quality-tier resolver looks up (#210).
 *
 *  ── PROVENANCE: KISHONTI'S OWN OPEN-SOURCED RESULTS ───────────────────────────────────────
 *  Source: **GFXBench 5.0 toplist results**, published by Kishonti Ltd at
 *  https://github.com/Kishonti-Opensource/GFXBench_and_CompuBench_results after GFXBench was
 *  retired in December 2025. Copyright (c) 2005-2025 Kishonti Ltd.
 *
 *  The repository is dual-licensed — **BSD 3-Clause** for code, **CC BY 4.0** for non-code assets
 *  — and contains nothing but results CSVs, a LICENSE and a README. Whichever half the CSVs fall
 *  in, both are permissive and both are compatible with redistribution under Apache-2.0; there is
 *  no third, unlicensed category available. CC BY 4.0 requires credit, a link to the licence, and
 *  a statement that changes were made: all three are in `oss/THIRD-PARTY-NOTICES.md`.
 *
 *  ⚠️ **THIS REPLACED A SECOND-HAND COPY, AND THAT IS THE POINT.** The table was previously
 *  derived from `detect-gpu`'s vendored JSON — MIT, but MIT granted by a *republisher*, which left
 *  open whether the underlying figures carried rights of their own. Taking them from the
 *  measuring party directly turns a reading into a grant. GitHub reports the repo as
 *  `NOASSERTION` (its detector cannot classify a dual licence), so no automated scanner will ever
 *  resolve this — the hand-written notice is the only one there is.
 *
 *  ── WHY `1080p Manhattan Offscreen` ───────────────────────────────────────────────────────
 *  **OFFSCREEN, so it is not capped by the panel.** This is the defect that killed the previous
 *  table: its numbers were ONSCREEN framerates pinned at 120 by a 120 Hz display, so everything
 *  above an Adreno 650 read ~120 and flagships could not be separated at all — which is why this
 *  plan once concluded the top band was unresolvable. Offscreen, the same GPUs span
 *  650 -> 122, 730 -> 143, 740 -> 233, 750 -> 317, 830 -> 436.
 *
 *  ⚠️ **`Aztec Ruins High Tier Offscreen` WAS CHOSEN FIRST AND THAT WAS WRONG.** It separates
 *  better (9.5x / 4.9x between our three anchors against Manhattan's 8.2x / 3.6x) and is the more
 *  representative workload — a tier gates IBL, shadow sampling and post-FX, i.e. fragment and ALU
 *  cost, which is what Aztec stresses. Measured against the anchors at {@link MIN_SAMPLES}, it
 *  loses anyway:
 *
 *      1080p Manhattan Offscreen        84 GPUs   Y6 4.78 (n=3)   A23 39.4 (n=4)   S22 143 (n=9)
 *      Aztec Ruins High Tier Offscreen  55 GPUs   Y6 ** MISSING **  A23 5.6 (n=8)   S22 27 (n=18)
 *
 *  **Aztec drops the Huawei Y6 — the WEAK anchor.** Too few devices that weak ever completed it.
 *  Coverage at the bottom is not a tie-breaker here: that is the end where being wrong loses a GPU
 *  context and blacks out the screen for the process lifetime (#156), while being wrong at the top
 *  costs a beat of ugliness. A test that cannot see the hardware this feature exists for is the
 *  wrong instrument however cleanly it separates the rest. Manhattan also covers half again as
 *  many GPUs, and 3.6x at the mid/high boundary is ample against the ~1.0x we had.
 *
 *  ⚠️ **ONE TEST, NEVER A BLEND.** Numbers from two tests are two instruments and are not
 *  comparable; merging them to buy coverage is the exact mistake this plan documents having made
 *  before ("a number from a different instrument cannot calibrate this one").
 *
 *  ── WHAT WE KEEP, AND WHAT WE THROW AWAY ──────────────────────────────────────────────────
 *  One number per GPU — the median of the per-device medians — because we map to THREE COARSE
 *  BANDS, not to an fps. Android rows only (iOS masks its renderer to `Apple GPU` and is answered
 *  by the model-id table; desktop is answered by the `formFactor` carve-out).
 *
 *  Run: node engine/scripts/gen-gpu-benchmarks.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE_URL = 'https://raw.githubusercontent.com/Kishonti-Opensource/'
  + 'GFXBench_and_CompuBench_results/main/GFXBench-5.0-results.csv';
const TEST = '1080p Manhattan Offscreen';

/** Minimum submissions behind a GPU's figure.
 *
 *  **THREE, because a median of two is just their mean** — the same argument `PROBE_SAMPLE_TARGET`
 *  makes elsewhere in this engine, applied to the same problem. One or two results are one or two
 *  phones on one or two days, possibly thermally throttled, possibly a spoofed renderer string, and
 *  this table's whole job is to be steadier than the boot probe it replaced. Entries below this are
 *  dropped rather than smoothed: an absent row falls through to the probe, which is the honest
 *  outcome for "we do not know".
 *
 *  ⚠️ Stated because it is the kind of threshold that looks arbitrary later: raising this from 2 to
 *  3 also removed a row that was visibly wrong — `Mali-T720` (a 2014 entry-level Midgard part)
 *  reading 13.0 on n=2, which would have ranked it ABOVE a 2021 Mali-G68. The justification is the
 *  median argument, not that one row; but a rule that also deletes a known-bad datum is worth
 *  keeping for both reasons. */
const MIN_SAMPLES = 3;

/** Parse one CSV line, honouring quotes. Device and vendor names really do contain commas
 *  (`Samsung Electronics Co., Ltd.`), so a naive `split(',')` shifts every later field — which
 *  silently reads the screen-size column as the OS. */
function parseCsvLine(line) {
  const out = []; let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Reduce Kishonti's `hardware name` to the GPU as a DEVICE would report it.
 *
 *  Their column carries a vendor prefix and sometimes an ANGLE wrapper with a trailing API clause:
 *    `Qualcomm Adreno (TM) 730`
 *    `Imagination Technologies PowerVR Rogue GE8300`
 *    `Samsung Electronics Co., Ltd. ANGLE (Samsung Xclipse 920) on Vulkan 1.3.279`
 *  The last form is why this exists: the ` on Vulkan …` suffix defeats an anchored unwrap, and the
 *  `Co., Ltd.` comma defeats the field-splitting in `normalizeGpuKey`. Strip the suffix, unwrap
 *  ANGLE, and let the shared key function do the rest. */
function cleanHardwareName(raw) {
  const noApi = raw.replace(/\s+on\s+(?:vulkan|opengl|opengl es|metal|direct3d)\b.*$/i, '').trim();
  const angle = /angle\s*\((.*)\)\s*$/i.exec(noApi);
  // ⚠️ **CORE-COUNT DESCRIPTORS MUST GO, and leaving them in produced six DEAD KEYS.** Kishonti
  // writes `ARM Mali-T880 MP12 (dodeca core)`; a device reports `Mali-T880 MP12`. Keeping the
  // suffix yields `malit880mp12dodecacore`, which no renderer string can ever normalize to — a row
  // that looks like coverage and matches nothing. The count is already in the `MPn`/`MCn` token,
  // so the parenthetical is redundant as well as harmful.
  return (angle ? angle[1] : noApi)
    .replace(/\((?:mono|dual|tri|quad|penta|hexa|hepta|octa|deca|dodeca)[\s-]*core\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reduce a renderer string to a stable lookup key.
 *
 *  ⚠️ MUST STAY IDENTICAL TO `normalizeGpuKey` in `gpuIdentity.ts` — the generator writes the keys
 *  the runtime looks up, so a divergence produces a table that silently never matches. A unit test
 *  re-normalizes every generated key and requires a fixed point. */
function normalizeGpuKey(raw) {
  const wrapped = /^angle\s*\((.*)\)\s*$/i.exec(raw.trim());
  const candidates = (wrapped ? wrapped[1] : raw)
    .split(',')
    .map((part) => part
      .toLowerCase()
      .replace(/\((?:tm|r)\)/g, ' ')
      .replace(/\b(?:qualcomm|arm|samsung|imagination|technologies|inc|corporation|ltd)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ''))
    .filter((s) => s && !/^(?:opengl|vulkan|direct3d|d3d)/.test(s));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? '';
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

console.log(`fetching ${SOURCE_URL} …`);
const res = await fetch(SOURCE_URL);
if (!res.ok) throw new Error(`${SOURCE_URL} -> ${res.status}`);
const csv = await res.text();
console.log(`  ${(csv.length / 1e6).toFixed(1)} MB`);

const lines = csv.split('\n');
const header = parseCsvLine(lines[0]);
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column '${name}' missing — the CSV schema changed`);
  return i;
};
const [cTest, cFps, cOs, cType, cHw] =
  ['test name', 'median result (fps)', 'os', 'hardware type', 'hardware name'].map(col);

const byKey = new Map(); // key -> { fps: number[], names: Set }
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const f = parseCsvLine(lines[i]);
  if (f[cTest] !== TEST || f[cOs] !== 'Android' || f[cType] !== 'GPU') continue;
  const fps = parseFloat(f[cFps]);
  if (!Number.isFinite(fps) || fps <= 0) continue;
  const name = cleanHardwareName(f[cHw] ?? '');
  const key = normalizeGpuKey(name);
  if (!key) continue;
  if (!byKey.has(key)) byKey.set(key, { fps: [], names: new Set() });
  const e = byKey.get(key);
  e.fps.push(fps);
  e.names.add(name);
}

const kept = [...byKey.entries()]
  .filter(([, e]) => e.fps.length >= MIN_SAMPLES)
  .map(([key, e]) => ({ key, fps: Number(median(e.fps).toFixed(3)), n: e.fps.length, names: [...e.names].sort() }))
  .sort((a, b) => a.fps - b.fps || a.key.localeCompare(b.key));

const dropped = byKey.size - kept.length;
console.log(`  ${byKey.size} GPUs on '${TEST}'; kept ${kept.length}, dropped ${dropped} below ${MIN_SAMPLES} samples`);

const out = `/* eslint-disable */
/** GENERATED by \`engine/scripts/gen-gpu-benchmarks.mjs\` — DO NOT EDIT BY HAND.
 *
 *  Mobile GPU throughput, keyed by \`normalizeGpuKey(rendererString)\`. The value is the median
 *  **${TEST}** framerate across submissions for that GPU. It is a RELATIVE RANKING, not a frame
 *  budget; \`gpuIdentity.ts\` maps it to a band.
 *
 *  ⭐ **OFFSCREEN, therefore NOT capped by the display.** The table this replaced used onscreen
 *  framerates pinned at 120 by a 120 Hz panel, so every GPU above an Adreno 650 read ~120 and
 *  flagships could not be told apart — which is why this workstream once concluded the top band
 *  was unresolvable. Here they separate by several times.
 *
 *  ── ATTRIBUTION (approved verbatim by the rights holder, 2026-08-12 — do not reword) ─────
 *
 *  GPU performance data derived from GFXBench and CompuBench toplist results,
 *  (c) 2005-2025 Kishonti Ltd, licensed under CC BY 4.0
 *  (https://creativecommons.org/licenses/by/4.0/). Values were aggregated and
 *  modified from the published results.
 *
 *  Published at https://github.com/Kishonti-Opensource/GFXBench_and_CompuBench_results. The
 *  specific changes: Android GPU rows for a single test were selected, per-device medians reduced
 *  to one median per GPU, GPUs with fewer than ${MIN_SAMPLES} submissions dropped, vendor
 *  prefixes, ANGLE wrappers and core-count descriptors stripped, and keys renormalized. Full
 *  notice: \`oss/THIRD-PARTY-NOTICES.md\`.
 *
 *  ${kept.length} entries, from ${byKey.size} Android GPUs on this test.
 */
export const GPU_BENCHMARK_FPS: Readonly<Record<string, number>> = {
${kept.map((r) => `  ${JSON.stringify(r.key)}: ${r.fps},`).join('\n')}
};

/** How many submissions each figure is a median of. Not read at runtime — it exists so a
 *  surprising row can be weighed without regenerating, and so a test can assert the thin ones are
 *  known rather than accidental. */
export const GPU_BENCHMARK_SAMPLES: Readonly<Record<string, number>> = {
${kept.map((r) => `  ${JSON.stringify(r.key)}: ${r.n},`).join('\n')}
};

/** The upstream \`hardware name\` values each key was built from. Debugging aid: it answers "why did
 *  this phone get that tier" without re-running the generator, and a normalization change shows up
 *  here as a diff. */
export const GPU_BENCHMARK_SOURCE_NAMES: Readonly<Record<string, readonly string[]>> = {
${kept.map((r) => `  ${JSON.stringify(r.key)}: ${JSON.stringify(r.names)},`).join('\n')}
};
`;

const dest = join(dirname(fileURLToPath(import.meta.url)),
  '../packages/modoki/src/runtime/rendering/gpuBenchmarks.ts');
writeFileSync(dest, out);
console.log(`wrote ${kept.length} entries -> ${dest}`);
