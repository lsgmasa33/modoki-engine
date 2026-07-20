#!/usr/bin/env node
/**
 * Migrate every committed scene + prefab JSON to the current asset format.
 *
 * Loads all scene files (under a `scenes/` dir + the e2e fixtures) and all prefab files
 * (`*.prefab.json`), applies the field migrations below, and stamps each SCENE with the
 * current `SCENE_FORMAT_VERSION` (read from `runtime/version.ts` — the single source of
 * truth, so this tool never goes stale). Prefab files carry an independent schema
 * `version` and are NOT version-stamped here; their trait data is still migrated.
 *
 * This is the PHYSICAL companion to the runtime migration chain in `loadSceneFile.ts`:
 * scenes are also upgraded at load, but prefab files are not, so they must be rewritten
 * here. Idempotent — safe to re-run; it rewrites a file only when something changed.
 *
 * Adding a future migration: extend `TRANSFORMS` with another deep transform and bump
 * `SCENE_FORMAT_VERSION` in `runtime/version.ts`; re-running this tool upgrades every
 * committed file in place.
 *
 * Usage:  node engine/scripts/migrate-assets.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DRY = process.argv.includes('--dry');

// ── Current scene format version (single source of truth) ──────────────────────────
const versionSrc = readFileSync(
  path.join(REPO_ROOT, 'engine/packages/modoki/src/runtime/version.ts'), 'utf8');
const m = versionSrc.match(/SCENE_FORMAT_VERSION\s*=\s*(\d+)/);
if (!m) { console.error('could not read SCENE_FORMAT_VERSION from runtime/version.ts'); process.exit(1); }
const SCENE_FORMAT_VERSION = Number(m[1]);

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

// ── Discover files (tracked, via git) ──────────────────────────────────────────────
// Game assets only. The e2e fixtures (engine/tests/e2e/fixtures/*.json) are hand-authored
// with compact one-line trait objects, so they are migrated by hand to preserve that
// formatting (a re-serialize would expand every object). They're also upgraded at load by
// loadSceneFile's migration chain, so tests pass regardless.
const patterns = [
  'games/*/runtime/**/scenes/*.json',     // scenes
  'games/*/runtime/**/*.prefab.json',     // prefabs
];
const files = new Set();
for (const pat of patterns) {
  let out = '';
  try { out = execSync(`git ls-files '${pat}'`, { cwd: REPO_ROOT, encoding: 'utf8' }); } catch { /* none */ }
  for (const f of out.split('\n').map((s) => s.trim()).filter(Boolean)) files.add(f);
}

let rewritten = 0, bumped = 0;
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
  let didBump = false;
  if (isScene && json.version !== SCENE_FORMAT_VERSION) { json.version = SCENE_FORMAT_VERSION; didBump = true; }

  if (changed || didBump) {
    // Match the editor's writer (serialize.ts / vite-asset-scanner.ts): 2-space indent,
    // NO trailing newline — otherwise the next in-editor save churns the file back.
    if (!DRY) writeFileSync(abs, JSON.stringify(json, null, 2));
    rewritten++;
    if (didBump) bumped++;
    console.log(`${DRY ? 'would migrate' : 'migrated'}${changed ? ' (fields)' : ''}${didBump ? ` (v→${SCENE_FORMAT_VERSION})` : ''}: ${rel}`);
  }
}
console.log(`\n✓ ${rewritten} file(s) ${DRY ? 'would be ' : ''}rewritten (${bumped} scene version stamps) → format v${SCENE_FORMAT_VERSION}.`);
