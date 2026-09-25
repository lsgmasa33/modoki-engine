#!/usr/bin/env node
/**
 * Migrate every committed scene + prefab JSON to the current asset format.
 *
 * Loads all scene files (under a `scenes/` dir + the e2e fixtures) and all prefab files
 * (`*.prefab.json`), applies the field migrations below, and stamps each SCENE with the
 * current `SCENE_FORMAT_VERSION` (read from `runtime/core/version.ts` — the single source of
 * truth, so this tool never goes stale). Prefab files carry an independent schema
 * `version` and are NOT version-stamped here; their trait data is still migrated.
 *
 * This is the PHYSICAL companion to the runtime migration chain in `loadSceneFile.ts`:
 * scenes are also upgraded at load, but prefab files are not, so they must be rewritten
 * here. Idempotent — safe to re-run; it rewrites a file only when something changed.
 *
 * Adding a future migration: extend `TRANSFORMS` with another deep transform and bump
 * `SCENE_FORMAT_VERSION` in `runtime/core/version.ts`; re-running this tool upgrades every
 * committed file in place.
 *
 * Usage:  node engine/scripts/migrate-assets.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoFiles } from './repoCorpus.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DRY = process.argv.includes('--dry');

// ── Current scene format version (single source of truth) ──────────────────────────
const versionSrc = readFileSync(
  path.join(REPO_ROOT, 'engine/packages/modoki/src/runtime/core/version.ts'), 'utf8');
const m = versionSrc.match(/SCENE_FORMAT_VERSION\s*=\s*(\d+)/);
if (!m) { console.error('could not read SCENE_FORMAT_VERSION from runtime/core/version.ts'); process.exit(1); }
const SCENE_FORMAT_VERSION = Number(m[1]);
// Read the same way and for the same reason (#1468): this script REWRITES prefab files too, and a
// prefab a newer build wrote must be left alone rather than run through this build's transforms.
const mp = versionSrc.match(/PREFAB_FORMAT_VERSION\s*=\s*(\d+)/);
if (!mp) { console.error('could not read PREFAB_FORMAT_VERSION from runtime/core/version.ts'); process.exit(1); }
const PREFAB_FORMAT_VERSION = Number(mp[1]);

// ── Field transforms (mirror loadSceneFile.ts migrations) ──────────────────────────
const RENDERABLE_TRAITS = new Set([
  'Renderable3D', 'Renderable3DPrimitive', 'Renderable2D', 'SkinnedModel', 'ParticleEmitter',
]);

/** v8→v9: rename a renderable trait's per-renderer `isActive` → `isVisible` wherever it
 *  lives (traits, prefab `overrides[localId][TraitName]`, `added[]` subtrees,
 *  `nestedOverrides` paths). All those key trait data by the TRAIT NAME, so one rule
 *  covers every location and `EntityAttributes.isActive` (entity on/off) is never hit. */
function renameRenderableActiveToVisible(node) {
  let changed = false;
  if (Array.isArray(node)) {
    for (const v of node) changed = renameRenderableActiveToVisible(v) || changed;
    return changed;
  }
  if (!node || typeof node !== 'object') return false;
  for (const [key, value] of Object.entries(node)) {
    if (RENDERABLE_TRAITS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      if ('isActive' in value) {
        if (!('isVisible' in value)) value.isVisible = value.isActive;
        delete value.isActive;
        changed = true;
      }
    }
    changed = renameRenderableActiveToVisible(value) || changed;
  }
  return changed;
}

/** Ordered deep field transforms applied to every scene + prefab. Each returns true if
 *  it mutated the tree. Append future migrations here. */
const TRANSFORMS = [renameRenderableActiveToVisible];

// ── Discover files (via the shared git-backed enumerator, repoCorpus.mjs) ──────────
// Game assets only. The e2e fixtures (engine/tests/e2e/fixtures/*.json) are hand-authored
// with compact one-line trait objects, so they are migrated by hand to preserve that
// formatting (a re-serialize would expand every object). They're also upgraded at load by
// loadSceneFile's migration chain, so tests pass regardless.
//
// This used to be `execSync(`git ls-files '${pat}'`)` — a shell STRING, not an argv array.
// execSync spawns cmd.exe on Windows, which does not strip single quotes, so the quoted
// pathspec reached git literally and matched nothing; the `catch { /* none */ }` then
// swallowed the failure and every run below silently rewrote 0 files while reporting
// success. MEASURED on this clone: quoted → 0 files, unquoted → 69. repoFiles() uses
// execFileSync with an argv array, so there is no shell in the loop to mis-parse a quote.
//
// The two globs are expressed as `under: 'games'` (git-filtered, cheap) plus a `match`
// regex carrying the rest of each pattern verbatim — `repoFiles()` has no glob support, so
// this is the direct translation, not a loosening of what each pattern reaches.
const scenes = repoFiles({
  under: 'games',
  match: /^games\/[^/]+\/runtime\/.*\/scenes\/[^/]+\.json$/,
  floor: 20, // measured 45 today; the floor is far under that so only a broken match/under can trip it
});
const prefabs = repoFiles({
  under: 'games',
  match: /^games\/[^/]+\/runtime\/.*\.prefab\.json$/,
  floor: 20, // measured 58 today
});
const files = new Set([...scenes, ...prefabs].map(({ rel }) => rel));

let rewritten = 0, bumped = 0, skippedTooNew = 0;
for (const rel of [...files].sort()) {
  const abs = path.join(REPO_ROOT, rel);
  let json;
  try { json = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { console.warn(`skip (parse): ${rel} — ${e.message}`); continue; }

  let changed = false;
  for (const t of TRANSFORMS) changed = t(json) || changed;

  // A SCENE has a top-level `entities` array and no `rootLocalId`; stamp it with the
  // current scene format version. Prefab files (rootLocalId present) keep their own
  // independent schema `version`.
  const isScene = Array.isArray(json.entities) && json.rootLocalId === undefined;

  // ⚠️ REFUSE a document a NEWER build wrote (#1468) — found by the close-out sweep of the same
  // defect in `migrate-anchor-zindex.mjs`. Two halves, and this file had both:
  //
  //   - the scene stamp was `!==`, so a v16 scene written by a newer build was stamped back DOWN to
  //     this build's number — claiming a shape this build cannot produce;
  //   - prefabs are rewritten here (the TRANSFORMS below run on them) with no version check at all,
  //     so a newer prefab was run through this build's understanding of its fields.
  //
  // One-sided, like every other gate in this family: the entire point of this script is to migrate
  // documents BELOW the current number, so an exact-match check would refuse all of them.
  const target = isScene ? SCENE_FORMAT_VERSION : PREFAB_FORMAT_VERSION;
  if (typeof json.version === 'number' && json.version > target) {
    skippedTooNew++;
    console.log(`SKIP ${rel}: format ${json.version} is newer than ${target} — written by a newer build`);
    continue;
  }

  let didBump = false;
  // `!==` is safe HERE and only here: the refusal above has already returned for anything stamped
  // above the target, so by this line `json.version` is at or below it and this can only ever stamp
  // FORWARD. It was the whole downgrade before that guard existed. Left as one mechanism rather than
  // two — a `<` here as well would be unfalsifiable (mutating it back to `!==` leaves every test
  // green, which is exactly what a redundant guard looks like from the outside).
  if (isScene && json.version !== SCENE_FORMAT_VERSION) { json.version = SCENE_FORMAT_VERSION; didBump = true; }

  if (changed || didBump) {
    // Match the editor's writer: 2-space indent AND a trailing newline — otherwise the next
    // in-editor save churns the file back. This used to omit the newline for scenes/prefabs
    // because the client-side writer (`editor/scene/serialize.ts`) emitted none — #835 moved
    // that writer onto the same `jsonFileBody`/`assetJsonBytes` byte shape every other asset
    // document uses, so this script no longer needs a scene/prefab exception to agree with it.
    // Kept as a literal rather than an import of `assetJsonBytes` because this is .mjs and that
    // module is .ts — the same keep-in-sync split as PROJECT_ROOT_DIRS.
    if (!DRY) writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
    rewritten++;
    if (didBump) bumped++;
    console.log(`${DRY ? 'would migrate' : 'migrated'}${changed ? ' (fields)' : ''}${didBump ? ` (v→${SCENE_FORMAT_VERSION})` : ''}: ${rel}`);
  }
}
console.log(`\n✓ ${rewritten} file(s) ${DRY ? 'would be ' : ''}rewritten (${bumped} scene version stamps) → format v${SCENE_FORMAT_VERSION}.`);
// Counted and reported, never silent: a skipped file still holds whatever this script exists to
// migrate, so a run that rewrites nothing and says nothing else would read as a clean corpus.
if (skippedTooNew > 0) console.log(`${skippedTooNew} file(s) SKIPPED — written by a newer build; update this checkout and re-run.`);
