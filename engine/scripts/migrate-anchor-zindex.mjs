#!/usr/bin/env node
/** One-shot migration: `UIAnchor.zIndex` and `UIElement.zIndex` write the same CSS
 *  `z-index` onto the same DOM node — `applyAnchorStyle` overwrote the element's value
 *  whenever the anchor's was truthy, so the anchor field only ever shadowed the element
 *  field. This copies a truthy `UIAnchor.zIndex` onto `UIElement.zIndex` (the anchor
 *  value wins on a conflict — it is what actually rendered) and deletes
 *  `UIAnchor.zIndex` unconditionally, truthy or not.
 *
 *  Mirrors `migrateV12toV13` (runtime/loaders/loadSceneFile.ts,
 *  `uiAnchorZIndexMigration.ts`) — this script is the one-time on-disk rewrite for the
 *  committed corpus; the runtime migration is what future old scenes go through.
 *
 *  Also bumps each rewritten scene's `version` to `SCENE_FORMAT_VERSION` and each rewritten
 *  prefab's to `PREFAB_FORMAT_VERSION`, both read from `runtime/core/version.ts` as TEXT rather
 *  than hardcoded — and never DOWNWARDS: a document stamped higher than the target is skipped
 *  untouched, because a newer build wrote it and this one cannot claim to understand it (#1468).
 *
 *  Only touches scene/prefab JSON under `games/<id>/runtime/assets` and
 *  `demos/<id>/runtime/assets`, and never the e2e fixtures (see the note at the push site
 *  below). Two independent filters do that, and neither one is a directory blocklist any more:
 *  the path PATTERN below restricts it to `runtime/assets`, and git's own view excludes ignored
 *  files. Note what that does NOT say — a TRACKED directory under `runtime/assets` is migrated
 *  whatever it is called, `build/` included, because `--exclude-standard` filters only
 *  `--others`.
 *
 *  Usage:
 *    node engine/scripts/migrate-anchor-zindex.mjs            # dry-run (report only)
 *    node engine/scripts/migrate-anchor-zindex.mjs --write    # apply the rewrites
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { repoFiles } from './repoCorpus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const WRITE = process.argv.includes('--write');

// ⚠️ READ from source, never hardcoded: this script STAMPS the version it believes in, so a stale
// literal silently DOWNGRADES every file it rewrites (it sat at 13 through the v14 bump, #1358).
// Same pattern as migrate-assets.mjs.
const versionSrc = readFileSync(
  resolve(ROOT, 'engine/packages/modoki/src/runtime/core/version.ts'), 'utf8');
const sceneVersionMatch = versionSrc.match(/SCENE_FORMAT_VERSION\s*=\s*(\d+)/);
if (!sceneVersionMatch) {
  console.error('could not read SCENE_FORMAT_VERSION from runtime/core/version.ts');
  process.exit(1);
}
const SCENE_FORMAT_VERSION = Number(sceneVersionMatch[1]);
// ⚠️ READ, for the same reason as the scene version one line up — this script STAMPS both, so a
// stale literal here downgrades every PREFAB it rewrites. The scene half was unpinned and this was
// left behind in the same function; version.ts says in as many words to check BOTH.
// #1468 moved PREFAB_FORMAT_VERSION out of editor/scene/prefab.ts into runtime/core/version.ts so
// the dev server could reach it. Read it from its new home; the hard exit below is what makes a
// wrong path loud instead of a silent downgrade.
const prefabSrc = readFileSync(
  resolve(ROOT, 'engine/packages/modoki/src/runtime/core/version.ts'), 'utf8');
const prefabVersionMatch = prefabSrc.match(/PREFAB_FORMAT_VERSION\s*=\s*(\d+)/);
if (!prefabVersionMatch) {
  console.error('could not read PREFAB_FORMAT_VERSION from runtime/core/version.ts');
  process.exit(1);
}
const PREFAB_FORMAT_VERSION = Number(prefabVersionMatch[1]);

/** Every scene/prefab file the REPO knows about, enumerated through GIT rather than by walking
 *  the filesystem.
 *
 *  ⚠️ **Read the honest version of why, because the commit that made this change overstated
 *  it.** The sibling guard `engine/tests/assets/anchorZIndexMigrated.test.ts` really was bitten
 *  by a blocklist walk that missed `games/*\/ads/` — but ITS walk was rooted at `games/`, where
 *  build output lives. This script's walk was always rooted at `<proj>/runtime/assets`, and
 *  build output (`dist/`, `ads/`, `.cache/`) lands at the PROJECT root, a sibling that root can
 *  never reach. Measured when this changed: the old walk and this enumeration select a
 *  byte-identical set. So this is not a bug fix — it removes a second way of answering "which
 *  files are ours" and reuses the one the gates already use, which is worth doing on its own,
 *  and is all it is.
 *
 *  `--cached --others --exclude-standard` is deliberate: tracked files PLUS untracked-but-not-
 *  ignored ones, so a scene a developer has just authored and not yet staged is still migrated,
 *  while everything in `.gitignore` is not. Same flags as the guard above and as
 *  `docCitations.test.ts`'s `repoFiles()`. */
let repoFilesCache;
function repoSceneAndPrefabFiles() {
  if (repoFilesCache) return repoFilesCache;
  // Migrated onto the ONE shared producer (#771). Every hazard this function used to spell out
  // by hand now lives in engine/scripts/repoCorpus.mjs, which was LIFTED FROM THIS FILE: the two
  // separate aborts (a git THROW cannot be caught by an empty-result check), unmerged-stage and
  // case-folded dedup, and the regular-file filter. It returns git-relative POSIX paths, which
  // is what deletes the round-trip filesMatching() used to need.
  //
  // The producer THROWS on a broken enumeration; a CLI owes the operator a legible line instead
  // of a stack trace, so it is translated here. That is the same reason the old inline version
  // caught its own execFileSync throw.
  try {
    repoFilesCache = repoFiles({ match: /\.(scene|prefab)\.json$/i, floor: 1 });
  } catch (e) {
    console.error(`ABORT: ${e.message} Nothing was written.`);
    process.exit(1);
  }
  return repoFilesCache;
}

/** The repo's scene/prefab files whose REPO-RELATIVE path matches `re`.
 *
 *  ⚠️ Matches on the git-relative path, NOT on a prefix built from `readdir`. Mixing the two is
 *  a real defect and it was reproduced: the prefix would come from the on-disk name and the
 *  candidates from the git index, so on a case-insensitive filesystem (macOS and Windows — i.e.
 *  every clone) a case-only rename like `mv games/Sling games/sling` leaves the index holding
 *  `games/Sling/...` while the prefix reads `games/sling/...`. `startsWith` then matches
 *  NOTHING, `existsSync` still passes, and the script reports a clean sweep over a project it
 *  silently skipped.
 *
 *  ⚠️ Single-sourcing the path on git alone does NOT, by itself, "remove the whole class" — that
 *  was claimed here once and it was false in the same shape as the bug above. Fixing the
 *  prefix-vs-index mismatch left the CALLER's regex free to be a case-sensitive literal
 *  (`(games|demos)`), so an index holding `Games/...` against a worktree holding `games/...`
 *  still matched nothing — same silent skip, different cause. `re` itself must therefore be
 *  case-insensitive (an `i` flag) for every literal segment it names, not just the project
 *  segment; this function does not lower-case anything on its own, so that is on each `re` this
 *  is called with. */
function filesMatching(re) {
  // Matches on `rel` — git's own repo-relative POSIX path — rather than recomputing it with
  // `relative(ROOT, abs).split(sep).join('/')` as this line used to. That recomputation was
  // CORRECT, but it was the `node:path` round-trip the docblock above spends two paragraphs
  // warning about, kept safe only by remembering the `.split(sep).join('/')`. The producer hands
  // back the string git already had, so there is nothing left to normalise or forget.
  return repoSceneAndPrefabFiles().filter((f) => re.test(f.rel)).map((f) => f.abs);
}

let changedFiles = 0, changedKeys = 0, skippedTooNew = 0;
const unmatchable = [];

/** Migrate one `UIAnchor`/`UIElement` bag in place. Returns true if it changed anything.
 *  `context` (file/entity/location) is used ONLY to make an `unmatchable` report
 *  actionable — it does not change what gets migrated.
 *
 *  ⚠️ `context.carrier` decides what happens to a truthy value with NO sibling `UIElement`,
 *  and the two callers need OPPOSITE answers — the same split the runtime helper makes
 *  (`uiAnchorZIndexMigration.ts`, close-out round 2):
 *   - `'skip'` — an ENTITY's own `traits`. A full trait bag, so "no `UIElement`" really means
 *     the entity has no `UIElement` trait; `buildTree` requires one for a node to exist at
 *     all, so there is no rendered value to lose, and inventing the trait would change what
 *     spawns. Report it and drop the key.
 *   - `'create'` — an OVERRIDE bag (`overrides[localId]`, `nestedOverrides[path][localId]`).
 *     A per-FIELD diff, so "no `UIElement`" only means this override does not touch
 *     `UIElement` YET — the entity may well have (or gain) the trait. Deleting here loses a
 *     real authored z-index with nowhere for it to reappear, so CREATE the carrier. This
 *     script rewrites other people's projects on disk, so getting it wrong is unrecoverable. */
function migrateTraits(traits, context) {
  if (!traits || typeof traits !== 'object') return false;
  const anchor = traits.UIAnchor;
  if (!anchor || typeof anchor !== 'object' || !('zIndex' in anchor)) return false;
  const anchorZIndex = anchor.zIndex;
  if (anchorZIndex) {
    let element = traits.UIElement;
    if (element && typeof element === 'object') {
      element.zIndex = anchorZIndex;
    }
    else if (context.carrier === 'create') {
      element = { zIndex: anchorZIndex };
      traits.UIElement = element;
    }
    // No UIElement trait/bag here — nothing to carry the value onto. Report it rather
    // than inventing a trait (verified: 0 counterexamples in the corpus, but the script
    // should say so loudly if that ever changes) — WITH enough to actually find it:
    // the key is about to be deleted below, so this is the only record of where it was.
    else if (!element) {
      unmatchable.push(
        `${context.file}: entity "${context.name}" (localId ${context.localId}, ${context.location}) — ` +
        `truthy UIAnchor.zIndex (${anchorZIndex}) with no sibling UIElement trait`,
      );
    }
  }
  delete anchor.zIndex;
  changedKeys++;
  return true;
}

/** Walk an entity node (and prefab-instance overrides / added subtrees / nested
 *  overrides) migrating any `UIAnchor.zIndex` found. Verified: 0 hits inside a
 *  prefab-instance `overrides` block in the current corpus, but walked anyway since
 *  it costs nothing and matches the runtime helper's reach (`migrateUIAnchorZIndexStructured`,
 *  `uiAnchorZIndexMigration.ts`) — same four locations: `traits`, `overrides[localId]`,
 *  `added[]` subtrees, and `nestedOverrides[path][localId]`. `nestedOverrides` is
 *  path-keyed over a localId map (`{path: {localId: {TraitName: fields}}}` —
 *  `loadSceneFile.ts`'s `NestedOverridePaths`), so it needs TWO `Object.entries` calls to
 *  reach the trait bag, unlike `overrides`'s one. */
function visitEntry(entry, filePath, dirtyRef) {
  if (!entry || typeof entry !== 'object') return;
  const file = filePath.slice(ROOT.length + 1);
  const name = entry.name ?? '(unnamed)';
  const localId = entry.localId ?? entry.id ?? '(no id)';
  if (migrateTraits(entry.traits, { file, name, localId, location: 'traits', carrier: 'skip' })) dirtyRef.dirty = true;
  for (const [overrideLocalId, bag] of Object.entries(entry.overrides ?? {})) {
    if (migrateTraits(bag, { file, name, localId, location: `overrides[${overrideLocalId}]`, carrier: 'create' })) dirtyRef.dirty = true;
  }
  for (const added of entry.added ?? []) visitEntry(added, filePath, dirtyRef);
  for (const child of entry.children ?? []) visitEntry(child, filePath, dirtyRef);
  for (const [nestedPath, pathBag] of Object.entries(entry.nestedOverrides ?? {})) {
    for (const [nestedLocalId, bag] of Object.entries(pathBag)) {
      const location = `nestedOverrides['${nestedPath}'][${nestedLocalId}]`;
      // Override bag -> CREATE the carrier; see migrateTraits' context.carrier note.
      if (migrateTraits(bag, { file, name, localId, location, carrier: 'create' })) dirtyRef.dirty = true;
    }
  }
}

async function migrateFile(file) {
  let json;
  try { json = JSON.parse(await readFile(file, 'utf-8')); } catch (e) {
    console.log(`PARSE ERROR ${file.slice(ROOT.length + 1)}: ${e.message}`);
    return;
  }
  const dirtyRef = { dirty: false };
  for (const entry of json.entities ?? []) visitEntry(entry, file, dirtyRef);
  if (!dirtyRef.dirty) return;

  const isPrefab = /\.prefab\.json$/i.test(file);
  const target = isPrefab ? PREFAB_FORMAT_VERSION : SCENE_FORMAT_VERSION;

  // ⚠️ REFUSE a document a NEWER build wrote (#1468) — never rewrite it, and never lower its stamp.
  // This script has no server and no client wrapper between it and the bytes, so the write gate
  // (`engine/plugins/prefabWriteGuard.ts`) cannot see it; the refusal has to live here. The stamp
  // was UNCONDITIONAL, so running an older checkout of this script over a newer corpus rewrote the
  // file with this build's understanding of it and then claimed the older number — losing whatever
  // the newer format added and mislabelling what remained.
  //
  // One-sided, like every other prefab gate in this repo: the whole point of this script is to
  // migrate documents BELOW the target, and an exact-match check would refuse all of them.
  if (typeof json.version === 'number' && json.version > target) {
    skippedTooNew++;
    console.log(`SKIP ${file.slice(ROOT.length + 1)}: format ${json.version} is newer than ${target} — written by a newer build`);
    return;
  }
  json.version = target;

  changedFiles++;
  console.log(`${WRITE ? 'rewrote' : 'would rewrite'} ${file.slice(ROOT.length + 1)}`);
  // No trailing newline — matches the editor's own scene/prefab writer.
  if (WRITE) await writeFile(file, JSON.stringify(json, null, 2));
}

// One pattern instead of a readdir of project directories: the project list IS whatever git
// reports under these roots, so a project cannot be missed because its directory name and its
// indexed name disagree (see `filesMatching`). Built from `PROJECT_ROOT_DIRS`
// (engine/scripts/projectRoots.mjs), the single source of truth for the project roots — not a
// second, unpointered `(games|demos)` literal. Case-insensitive (`i`): see `filesMatching`'s note.
const PROJECT_PATTERN = new RegExp(`^(${PROJECT_ROOT_DIRS.join('|')})/[^/]+/runtime/assets/`, 'i');
const targets = [...filesMatching(PROJECT_PATTERN)];
// ⚠️ The e2e fixtures are DELIBERATELY left un-migrated at `version: 9` — they earn their keep by
// driving the whole migration ladder (including v12→v13) on every e2e run, and migrating them in
// place would quietly retire that coverage. Running this script over them would look like a
// successful sweep and silently cost the only end-to-end proof the new step is wired up at all.
// `engine/tests/assets/anchorZIndexMigrated.test.ts` asserts they still carry the key, so doing it
// anyway turns the gate red rather than passing unnoticed — but do not make that test the thing
// that catches it. Pass --include-e2e-fixtures only if that decision is being reversed on purpose.
if (process.argv.includes('--include-e2e-fixtures')) {
  targets.push(...filesMatching(/^engine\/tests\/e2e\/fixtures\//i));
}

// ⚠️ An enumeration that returns NOTHING reports "0 keys would be rewritten" and exits 0 —
// indistinguishable from a corpus that is already clean, which is exactly how a silently broken
// walk presents. Asserting on the REPO-WIDE scene/prefab count (as this once did) is too weak: it
// stays green for ANY failure of the PATTERN above — e.g. a typo in `runtime/assets` — because
// that count doesn't touch the pattern at all. Assert on `targets` instead, and report both
// numbers so the operator can tell "the pattern broke" (targets 0, enumerated > 0) from "git
// broke" (enumerated 0 too — see the abort inside `repoSceneAndPrefabFiles`). This repo always has
// scene/prefab files under `games/**/runtime/assets` or `demos/**/runtime/assets`, so `targets`
// is never legitimately 0. The sibling guard pins the same thing
// (`anchorZIndexMigrated.test.ts`); it belongs here MORE, because a wrong answer here is a
// rewrite that silently did not happen.
if (targets.length === 0) {
  const enumerated = repoSceneAndPrefabFiles().length;
  console.error(`ABORT: the path pattern matched 0 of ${enumerated} enumerated scene/prefab `
    + 'file(s). This repo always has scene/prefab files under games/**/runtime/assets or '
    + 'demos/**/runtime/assets, so a match count of 0 means the pattern stopped matching, not a '
    + 'clean corpus. Nothing was written.');
  process.exit(1);
}

for (const file of targets) await migrateFile(file);

console.log(`\n${changedKeys} UIAnchor.zIndex key(s) in ${changedFiles} file(s)${WRITE ? ' rewritten' : ' would be rewritten (dry run — pass --write)'}.`);
// Counted and reported, never silent: a skipped file still HAS the key this script exists to
// migrate, so a run that reports 0 rewrites and says nothing else would read as a clean corpus.
if (skippedTooNew > 0) console.log(`${skippedTooNew} file(s) SKIPPED — written by a newer build; update this checkout and re-run.`);
if (unmatchable.length > 0) {
  console.log('\nCould not migrate (no sibling UIElement trait to carry the value onto):');
  for (const m of unmatchable) console.log(`  ${m}`);
}
