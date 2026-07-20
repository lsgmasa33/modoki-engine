/** Determinism guard (Phase 0 — verification harness).
 *
 *  The headless playtest loop only reproduces if engine runtime systems take
 *  time from the injectable clock (`rawNow`/`getSimDelta`/`getVisualDelta`) and
 *  randomness from the seeded RNG service — never wall-clock or `Math.random`
 *  directly. This test fails the build if a new offender appears under
 *  `src/runtime/**`, so determinism can't silently drift (it's exactly what
 *  would have caught the skeletal-mixer-on-its-own-clock bug).
 *
 *  The allowlist is EXPLICIT and reviewed — every entry is a deliberate
 *  exception with a documented reason, not a silent pass. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/runtime');

/** Files permitted to read the real wall-clock, each for a documented reason. */
const ALLOW_WALLCLOCK = new Set<string>([
  'systems/clock.ts',         // THE sanctioned wrapper — the single source of "now"
  'systems/rng.ts',           // sanctioned RNG entropy seed (Date.now at module load)
]);

/** Files permitted to use Math.random (cosmetic-only; never gameplay state). */
const ALLOW_RANDOM = new Set<string>([
  // (none yet — engine runtime is clean. Cosmetic particle jitter would go here.)
]);

/** Files permitted to mint an UNSEEDED guid (`crypto.randomUUID` / `newGuid()`). These are
 *  all AUTHORING / IMPORT / PERSISTENCE paths, never a deterministic sim tick — a random guid
 *  there is correct (a fresh unique identity). The guard exists so a NEW runtime *system* that
 *  spawns on the sim playhead can't silently reach for a random guid (which would corrupt the
 *  replay-stable event journal, exactly the Timeline control-track bug) — it must instead derive
 *  a stable guid (e.g. spawnPrefabInstance's `guidSeed`) or be consciously allowlisted here. */
const ALLOW_UNSEEDED_GUID = new Set<string>([
  'loaders/assetRefRules.ts',   // DEFINES newGuid() — the sanctioned random-guid source
  'loaders/loadGLB.ts',         // mints asset guids at GLB import time (authoring)
  'loaders/spriteSheet.ts',     // mints sprite guids at slice time (authoring)
  'loaders/loadSceneFile.ts',   // ad-hoc runtime-spawn fallback; deterministic callers pass guidSeed
  'traits/Persistent.ts',       // one-time guid when an entity is marked persistent (authoring)
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip block + line comments so a `performance.now()` mention in prose doesn't
 *  trip the guard — only real call sites count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const FILES = tsFiles(RUNTIME).map((f) => ({ rel: relative(RUNTIME, f).replace(/\\/g, '/'), code: stripComments(readFileSync(f, 'utf8')) }));

describe('determinism guard (Phase 0)', () => {
  it('no direct wall-clock outside the allowlist', () => {
    const offenders = FILES
      .filter((f) => /\b(performance\.now|Date\.now)\s*\(/.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !ALLOW_WALLCLOCK.has(rel));
    expect(offenders, `use rawNow()/getSimDelta()/getVisualDelta() instead, or add a reviewed allowlist entry:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no Math.random outside the allowlist (route gameplay RNG through the seeded service)', () => {
    const offenders = FILES
      .filter((f) => /\bMath\.random\s*\(/.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !ALLOW_RANDOM.has(rel));
    expect(offenders, `route through the seeded RNG service, or add a reviewed allowlist entry:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no unseeded guid (crypto.randomUUID / newGuid) outside the allowlist — deterministic spawns must derive a stable guid', () => {
    const offenders = FILES
      .filter((f) => /\bcrypto\.randomUUID\s*\(|\bnewGuid\s*\(/.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !ALLOW_UNSEEDED_GUID.has(rel));
    expect(offenders, `a deterministic sim path must derive a stable guid (e.g. spawnPrefabInstance guidSeed), or add a reviewed allowlist entry:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the allowlist itself stays small (review pressure)', () => {
    // If this trips, a redesign is probably leaking wall-clock — don't just bump it.
    expect(ALLOW_WALLCLOCK.size).toBeLessThanOrEqual(3);
  });
});
