#!/usr/bin/env node
/** Seed every project's authored quality configs (docs/rendering.md § "Quality tiers").
 *
 *  ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *  Phase A1 moved what a tier CONTAINS out of the engine's `TIER_SETTINGS` table and into the
 *  project (`rendering.three.tiers`), and A2 made a project with ONE config skip the boot probe
 *  entirely. Left alone, that would silently stop all 22 existing projects from degrading — they
 *  all ship `qualityTier: 'auto'` and author nothing, so every one of them would resolve the
 *  unclamped default on every device.
 *
 *  **Owner decision, 2026-08-11: seed the fleet.** Every project that relies on `auto` gets
 *  today's engine tables written in, so nothing regresses anywhere. The accepted price is that a
 *  seeded project has more than one config and therefore keeps paying the launch-blocking probe.
 *
 *  ── WHY THE VALUES ARE COPIED HERE, AND WHY THAT IS SAFE ─────────────────────────────────
 *  A `.mjs` script cannot import the engine's TypeScript, so these are a copy. A copy that can
 *  drift from its source is exactly the shadowing failure this repo warns about — so
 *  `engine/tests/architecture/qualityTierSeed.test.ts` imports BOTH this module and the real
 *  `TIER_SETTINGS` and deep-equals them. If someone changes a measured value in the engine and
 *  not here, that test goes red.
 *
 *  ⚠️ **The guard is on the SEED, deliberately not on the projects.** Asserting that every
 *  project's `tiers` still equals `TIER_SETTINGS` would forbid the one thing this whole feature
 *  exists for: a project tuning its own degradation. Seeded values are a STARTING POINT, and the
 *  moment an author changes one the guard must stay quiet.
 *
 *  ── THE BACKFILL, AND WHY IT ADDS RATHER THAN OVERWRITES ─────────────────────────────────
 *  #202 added three fields to `TierRenderOverrides` (`targetFps`, `pixiPixelRatioCap`,
 *  `pixiAntialias`). `needsSeed()` already treats "authors `tiers`" as done, so the 22 projects A4
 *  seeded would carry `mid`/`low` missing those three keys FOREVER — precisely the projects this
 *  feature targets, `games/court` included. So a second pass, `backfillTiers()`, adds any SEED key
 *  an authored tier is missing, per tier, and never touches a key that is already there — the
 *  STARTING POINT principle above applies just as much to a field added today as to one seeded
 *  in A4: a tuned value stays authoritative. A tier the project never authored is not manufactured
 *  here either; that decision is `needsSeed()`'s, one layer up. This is not a one-shot migration —
 *  the same pass backfills any field added after today, for free.
 *
 *  Usage:  node engine/scripts/seed-quality-tiers.mjs [--dry-run]
 *  Idempotent: a project that already authors every current field on `rendering.three.tiers` is
 *  left completely alone (a second run seeds nothing and backfills nothing), because a fully
 *  seeded/backfilled/tuned config may have been tuned since.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './projectRoots.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A mirror of the engine's measured `TIER_SETTINGS.mid` / `.low`. Keep in sync — the test named
 *  in the header enforces it. Every number here is a measurement; the plan's §3 records which. */
export const SEED = {
  mid: {
    pixelRatioCap: 1,
    antialias: false,
    shadows: true,
    shadowMapCeiling: 1024,
    postFX: { npr: false, ao: false, dof: false, bloom: false, vignette: false },
    maxDirectional: 2,
    maxLocal: 3,
    ibl: true,
    iblOffAmbientBoost: 1,
    iblOffExposure: 1,
    targetFps: 0,
    pixiPixelRatioCap: 1,
    pixiAntialias: false,
  },
  low: {
    pixelRatioCap: 1,
    antialias: false,
    shadows: false,
    shadowMapCeiling: 512,
    postFX: { npr: false, ao: false, dof: false, bloom: false, vignette: false },
    maxDirectional: 1,
    maxLocal: 1,
    ibl: false,
    iblOffAmbientBoost: 4,
    iblOffExposure: 1.25,
    targetFps: 30,
    pixiPixelRatioCap: 1,
    pixiAntialias: false,
  },
};

/** Should this project be seeded? Only one that is actually relying on `auto` — a project that
 *  PINNED a tier already made its decision and a seeded ladder it never consults would be noise
 *  in its config file. A project that already authors `tiers` is left alone (it may be tuned).
 *
 *  ⚠️ **A MISSING `rendering.three` BLOCK STILL NEEDS SEEDING, and reading it as "nothing to
 *  degrade" was wrong.** Ten of the 22 projects omit the block entirely and inherit the schema
 *  default — which is `qualityTier: 'auto'`. They are exactly as exposed as the twelve that spell
 *  it out, and skipping them would have quietly halved the migration while reporting success.
 */
export function needsSeed(cfg) {
  const three = cfg?.rendering?.three;
  if (three?.tiers) return false;                // already authored, possibly tuned since
  return (three?.qualityTier ?? 'auto') === 'auto';
}

/** Add any SEED key an authored tier is missing, PER TIER, and never touch a key already there —
 *  see the header for why add-only is the rule and not an oversight. Mutates `tiers` in place (the
 *  caller owns a fresh parse of its own file) and returns the `tier.key` labels it added, so the
 *  console summary can say honestly what happened. A tier absent from `tiers` (the project never
 *  authored it) is left absent — that decision belongs to `needsSeed()`, not here. */
export function backfillTiers(tiers) {
  const added = [];
  for (const tierName of ['mid', 'low']) {
    const authored = tiers?.[tierName];
    if (!authored) continue;                       // never authored — not this function's call
    for (const key of Object.keys(SEED[tierName])) {
      if (!(key in authored)) {
        authored[key] = SEED[tierName][key];
        added.push(`${tierName}.${key}`);
      }
    }
  }
  return added;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const projects = discoverProjects(repoRoot);
  const seeded = [];
  const backfilled = [];
  const skipped = [];

  for (const proj of projects) {
    const file = path.join(proj.dir, 'project.config.json');
    if (!fs.existsSync(file)) { skipped.push(`${proj.name} (no project.config.json)`); continue; }
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(raw);

    if (needsSeed(cfg)) {
      // Create the path when the project omits it — those projects inherit `qualityTier: 'auto'`
      // from the schema default and are just as exposed as the ones that spell the block out.
      cfg.rendering ??= {};
      cfg.rendering.three ??= {};
      cfg.rendering.three.tiers = structuredClone(SEED);
      if (!dryRun) {
        // Trailing newline + 2-space indent: match what the editor's own config writer produces,
        // so a later save from Project Settings is not a whitespace-only diff on top of this.
        fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      }
      seeded.push(proj.name);
      continue;
    }

    const tiers = cfg?.rendering?.three?.tiers;
    if (tiers) {
      const added = backfillTiers(tiers);
      if (added.length > 0) {
        if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
        backfilled.push(`${proj.name} (${added.join(', ')})`);
        continue;
      }
      skipped.push(`${proj.name} (already authors tiers)`);
      continue;
    }

    skipped.push(`${proj.name} (pinned '${cfg.rendering.three.qualityTier}')`);
  }

  console.log(`${dryRun ? '[dry-run] would seed' : 'seeded'} ${seeded.length}: ${seeded.join(', ') || '(none)'}`);
  console.log(`${dryRun ? '[dry-run] would backfill' : 'backfilled'} ${backfilled.length}: ${backfilled.join(', ') || '(none)'}`);
  console.log(`skipped ${skipped.length}: ${skipped.join(', ') || '(none)'}`);
}

// Only run when invoked directly — the test imports SEED/needsSeed/backfillTiers and must not
// write files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
