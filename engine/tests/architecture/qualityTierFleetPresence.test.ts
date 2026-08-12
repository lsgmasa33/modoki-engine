/** Guard: every project's COMMITTED `rendering.three.tiers` carries every key the seeder knows
 *  about — a fleet sweep, not just a check on the seeder's own output.
 *
 *  `qualityTierSeed.test.ts` pins the SEEDER's values against the engine's `TIER_SETTINGS`, and
 *  `seed-quality-tiers.mjs --dry-run` reports what it WOULD write, but nothing runs the seeder
 *  against the fleet as part of `npm test` — today's 23 configs are correct by hand only, and a
 *  new engine field (or a new `PostFXEffect`, see `backfillTiers`'s header) could ship with no
 *  signal that any authored config is now missing it.
 *
 *  ⚠️ **KEY PRESENCE ONLY — never a value.** #188 A1 moved tier CONTENT out of the engine
 *  specifically so a project could tune its own degradation (docs/rendering.md § "Quality
 *  tiers"), and `qualityTierSeed.test.ts`'s header says the same about the seed itself: the
 *  moment an author changes one, the guard must stay quiet. Asserting VALUES here would forbid
 *  exactly the tuning R3 exists to enable — this only asserts that a key an authored tier
 *  claims to override is actually PRESENT, not what it is set to. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { REPO_ROOT, hasAnyProject } from '../helpers/repoLayout';
// @ts-expect-error — a plain .mjs script with no type declarations; only its data is used here.
import { SEED } from '../../scripts/seed-quality-tiers.mjs';

const TIER_NAMES = ['mid', 'low'] as const;

/** Every key path the seed carries, NESTED KEYS INCLUDED — `['postFX.bloom', 'shadows', …]`.
 *
 *  ⚠️ **A TOP-LEVEL PASS CANNOT SEE THE ONE CASE THAT MATTERS, and this guard shipped with one**
 *  (close-out 2026-08-12). `postFX` is a single top-level key, so `'postFX' in authored` is
 *  satisfied by `{npr:false}` alone — while `complete()` merges a partial block over `ALL_POSTFX`
 *  and reads every ABSENT effect as ALLOWED (`qualityTier.ts`). So the exact regression this file
 *  was written for — a new `PostFXEffect` reaching the engine and no committed config carrying it
 *  — would leave that effect switched ON for every project on `low` and `mid`, and this guard
 *  would stay green. `backfillTiers` recurses for precisely this reason; so does the engine's own
 *  `hasEveryField`. The guard now mirrors them instead of being the shallow one of the three. */
function seedKeyPaths(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? seedKeyPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`]);
}

/** Is a dotted key path present in the authored config? Presence only — never the value. */
function hasPath(authored: Record<string, unknown>, keyPath: string): boolean {
  let cur: unknown = authored;
  for (const seg of keyPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return true;
}

describe('the committed fleet carries every SEED key on every authored tier (#205 R4.4)', () => {
  // Non-vacuity floor, same shape as the sibling fleet-sweep suites (privateBuildFields.test.ts,
  // projectPresencePredicate.test.ts): `hasAnyProject()` is the loose "did the walk find
  // anything at all" predicate, deliberately checked explicitly rather than trusted implicitly —
  // the public snapshot ships no `games/`, and a naive sweep over an empty project list would
  // pass every assertion below by scanning nothing, which is a documented repeat failure here.
  it('finds project configs to check — a vacuous pass is a failure', () => {
    expect(hasAnyProject()).toBe(true);
  });

  it.skipIf(!hasAnyProject())(
    'every authored tiers.mid / tiers.low has every SEED key present (values may differ — tuning is allowed)',
    () => {
      const projects = discoverProjects(REPO_ROOT) as { dir: string; name: string }[];
      const configFiles = projects
        .map((p) => path.join(p.dir, 'project.config.json'))
        .filter((f) => fs.existsSync(f));
      expect(configFiles.length).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const file of configFiles) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          rendering?: { three?: { tiers?: Record<string, Record<string, unknown>> } };
        };
        const tiers = raw.rendering?.three?.tiers;
        if (!tiers) continue; // relies on `auto` with no authored ladder — not this guard's concern
        for (const tierName of TIER_NAMES) {
          const authored = tiers[tierName];
          if (!authored) continue; // this project never authored this tier
          for (const key of seedKeyPaths(SEED[tierName] as Record<string, unknown>)) {
            if (!hasPath(authored, key)) missing.push(`${path.relative(REPO_ROOT, file)}: tiers.${tierName}.${key}`);
          }
        }
      }
      expect(missing).toEqual([]);
    },
  );
});
