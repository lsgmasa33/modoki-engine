#!/usr/bin/env node
/**
 * One-time (idempotent) migration for #172: move the five owner-private
 * `build.*` fields (`PRIVATE_BUILD_FIELDS`, `engine/project-config.ts`) OUT of
 * every project's COMMITTED `project.config.json` and into its GITIGNORED
 * `project.user.json`, where `overlayPrivateBuildFields` (`engine/project-config.ts`)
 * transparently overlays them back for every reader. The canonical key path
 * (`build.<field>`) does not change — only where the value physically lives.
 *
 * Why: those five fields (Apple Team ID, GCS bucket, CDN names, deploy command)
 * were defended only by a publish-time SCRUB (`scripts/lib/scrub-project-config.mjs`),
 * which has already failed twice on branch merges (a real Team ID + real device
 * UDIDs reached `main` from a worker branch forked before a privacy scrub — see
 * docs/engine-oss-publishing.md). The scrub stays the backstop; the primary
 * defense is now that the value is never committed at all.
 *
 * Usage:
 *   node engine/scripts/migrate-private-config.mjs             # applies the migration
 *   node engine/scripts/migrate-private-config.mjs --dry-run   # reports only, writes nothing
 *
 * Scans every project under every root in PROJECT_ROOT_DIRS (projectRoots.mjs) —
 * do NOT hardcode `games`/`demos` here, that list is the single source of truth.
 * Idempotent: once a project's committed fields are blanked, a second run finds
 * nothing to move for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './projectRoots.mjs';
import { loadEnginePluginModule } from './loadVendorPlugins.mjs';

// MODOKI_MIGRATE_REPO_ROOT overrides the repo root — test-only, so a vitest suite can point this
// at a throwaway temp directory (with its own games/demos/engine/project-config.ts) instead of
// the real repo. Unset in normal use: the real invocation always derives it from its own path.
const repoRoot = process.env.MODOKI_MIGRATE_REPO_ROOT
  ? path.resolve(process.env.MODOKI_MIGRATE_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRY = process.argv.includes('--dry-run');

// project-config.ts is deliberately import-free (browser-safe), so it bundles cleanly through
// the same esbuild-to-tempfile seam every other .mjs script uses to reach TypeScript sources
// (see loadVendorPlugins.mjs) — this is what lets the migration read PRIVATE_BUILD_FIELDS from
// its ONE definition instead of re-enumerating the five names here.
const projectConfigModule = await loadEnginePluginModule(repoRoot, 'project-config.ts');
if (!projectConfigModule) {
  console.error('Could not load engine/project-config.ts (is esbuild installed?) — aborting.');
  process.exit(1);
}
const { PRIVATE_BUILD_FIELDS, PROJECT_CONFIG_FILENAME, PROJECT_USER_CONFIG_FILENAME } = projectConfigModule;

/** Parse a JSON file. `null` = missing (nothing to migrate); `undefined` = exists but
 *  unreadable (reported, then skipped — the migration must not clobber a file it can't
 *  fully understand). */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`  ✖ ${file} is not valid JSON (${e.message}) — skipped`);
    return undefined;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

let totalFieldsMoved = 0;
let totalFieldsCleared = 0;
let totalProjectsTouched = 0;
/** Projects this run could NOT process (unreadable JSON, a failed write). Tracked because a
 *  privacy migration that SKIPS a project leaves the secret committed — the exact thing it exists
 *  to prevent — and the summary below would otherwise print "every project is already clean" over
 *  the top of it and exit 0. A silent no-op reported as success is the worst possible answer here,
 *  so any entry makes the run exit non-zero. */
const skipped = [];

for (const proj of discoverProjects(repoRoot)) {
  const label = `${proj.root}/${proj.name}`;
  const cfgFile = path.join(proj.dir, PROJECT_CONFIG_FILENAME);
  const cfg = readJson(cfgFile);
  if (cfg === undefined) { skipped.push(`${label}: ${PROJECT_CONFIG_FILENAME} unreadable`); continue; }
  if (cfg == null || typeof cfg !== 'object') continue; // no committed config at all — nothing to do
  const build = cfg.build;
  if (!build || typeof build !== 'object') continue; // never set any build.* field

  const committed = PRIVATE_BUILD_FIELDS.filter(
    (field) => typeof build[field] === 'string' && build[field] !== '',
  );
  if (!committed.length) continue; // already migrated (blanked) or never set

  const userFile = path.join(proj.dir, PROJECT_USER_CONFIG_FILENAME);
  const userRaw = readJson(userFile);
  if (userRaw === undefined) {
    // Do NOT overwrite a file we could not parse — but this project keeps its committed secret,
    // so it is a FAILURE of the migration, not a benign skip.
    skipped.push(`${label}: ${PROJECT_USER_CONFIG_FILENAME} unreadable — ${committed.length} field(s) left COMMITTED`);
    continue;
  }
  const user = userRaw && typeof userRaw === 'object' ? userRaw : {};
  const userBuild = user.build && typeof user.build === 'object' ? { ...user.build } : {};

  // A field the user file ALREADY sets is not migrated over — it is blanked in the committed
  // file and the local value kept. Same precedence overlayPrivateBuildFields reads by (a
  // non-empty user value wins), and it matters on a re-run: merging a worker branch that
  // forked before this change reintroduces the old committed value, and a blind move would
  // then overwrite this machine's own setting with the stale one.
  const fieldsToMove = committed.filter(
    (field) => !(typeof userBuild[field] === 'string' && userBuild[field] !== ''),
  );
  const fieldsToClear = committed.filter((f) => !fieldsToMove.includes(f));
  for (const field of fieldsToClear) build[field] = '';

  for (const field of fieldsToMove) {
    userBuild[field] = build[field];
    build[field] = '';
  }

  // Write ORDER is load-bearing: the user file (which GAINS the value) first, the committed file
  // (which loses it) second. Crash between them and the value exists in both places — recoverable,
  // and a re-run finishes the job via the already-set-locally branch above. The reverse order
  // would blank the committed value before the only other copy was safely on disk, and a crash
  // there DESTROYS it.
  if (!DRY) {
    try {
      user.build = userBuild;
      writeJson(userFile, user);
      cfg.build = build;
      writeJson(cfgFile, cfg);
    } catch (e) {
      // Report against the project, do not abort the whole run: the other projects are independent
      // and a permissions problem on one must not leave the rest un-migrated too.
      skipped.push(`${label}: write failed (${e.message}) — re-run after fixing it`);
      continue;
    }
  }

  // Logged AFTER the writes land, so a line that says "moved" is a fact rather than an intention.
  for (const field of fieldsToClear) {
    console.log(`${DRY ? '[dry-run] would clear' : 'cleared'} ${label}: build.${field} (project.user.json already sets it)`);
  }
  totalFieldsCleared += fieldsToClear.length;
  for (const field of fieldsToMove) console.log(`${DRY ? '[dry-run] would move' : 'moved'} ${label}: build.${field}`);
  totalFieldsMoved += fieldsToMove.length;
  totalProjectsTouched += 1;
}

console.log('');
if (skipped.length) {
  console.error(`✖ ${skipped.length} project(s) could NOT be migrated and still carry a committed private value:`);
  for (const s of skipped) console.error(`    ${s}`);
}
if (totalFieldsMoved === 0 && totalFieldsCleared === 0 && !skipped.length) {
  console.log('Nothing to migrate — every project is already clean.');
} else if (totalFieldsMoved || totalFieldsCleared) {
  const cleared = totalFieldsCleared ? `, cleared ${totalFieldsCleared} already set locally` : '';
  console.log(
    `${DRY ? 'Would move' : 'Moved'} ${totalFieldsMoved} field(s)${cleared} across ${totalProjectsTouched} project(s).`,
  );
}

// A skip means a secret is still committed somewhere. Exit non-zero so a caller (or a human
// reading only the tail) cannot mistake a partial run for a clean one.
if (skipped.length) process.exit(1);
