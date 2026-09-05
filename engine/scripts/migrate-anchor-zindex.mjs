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
 *  Also bumps each rewritten scene's `version` to 13, and each rewritten prefab's
 *  `version` to `PREFAB_FORMAT_VERSION` (3).
 *
 *  Only touches `games/<id>/**` and `demos/<id>/**` scene/prefab JSON under
 *  `runtime/assets`, plus `engine/tests/e2e/fixtures/**` — never `dist/`, `ios/`,
 *  `android/`, `build/`.
 *
 *  Usage:
 *    node engine/scripts/migrate-anchor-zindex.mjs            # dry-run (report only)
 *    node engine/scripts/migrate-anchor-zindex.mjs --write    # apply the rewrites
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const WRITE = process.argv.includes('--write');

const SCENE_FORMAT_VERSION = 13;
const PREFAB_FORMAT_VERSION = 3;

async function walkFiles(dir, pred, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.cache', 'ios', 'android', 'ads', 'build'].includes(e.name)) continue;
      await walkFiles(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

let changedFiles = 0, changedKeys = 0;
const unmatchable = [];

/** Migrate one entity's `traits` bag in place. Returns true if it changed anything. */
function migrateTraits(traits) {
  if (!traits || typeof traits !== 'object') return false;
  const anchor = traits.UIAnchor;
  if (!anchor || typeof anchor !== 'object' || !('zIndex' in anchor)) return false;
  const anchorZIndex = anchor.zIndex;
  if (anchorZIndex) {
    const element = traits.UIElement;
    if (element && typeof element === 'object') {
      element.zIndex = anchorZIndex;
    }
    // No UIElement trait on this entity — nothing to carry the value onto. Report it
    // rather than inventing a trait (verified: 0 counterexamples in the corpus, but
    // the script should say so loudly if that ever changes).
    else if (!element) {
      unmatchable.push(`truthy UIAnchor.zIndex (${anchorZIndex}) with no sibling UIElement trait`);
    }
  }
  delete anchor.zIndex;
  changedKeys++;
  return true;
}

/** Walk an entity node (and prefab-instance overrides / added subtrees / nested
 *  overrides) migrating any `UIAnchor.zIndex` found. Verified: 0 hits inside a
 *  prefab-instance `overrides` block in the current corpus, but walked anyway since
 *  it costs nothing and matches the runtime helper's reach. */
function visitEntry(entry, filePath, dirtyRef) {
  if (!entry || typeof entry !== 'object') return;
  if (migrateTraits(entry.traits)) dirtyRef.dirty = true;
  for (const bag of Object.values(entry.overrides ?? {})) {
    if (migrateTraits(bag)) dirtyRef.dirty = true;
  }
  for (const added of entry.added ?? []) visitEntry(added, filePath, dirtyRef);
  for (const child of entry.children ?? []) visitEntry(child, filePath, dirtyRef);
  if (entry.nestedOverrides) {
    for (const bag of Object.values(entry.nestedOverrides)) {
      if (migrateTraits(bag)) dirtyRef.dirty = true;
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
  json.version = isPrefab ? PREFAB_FORMAT_VERSION : SCENE_FORMAT_VERSION;

  changedFiles++;
  console.log(`${WRITE ? 'rewrote' : 'would rewrite'} ${file.slice(ROOT.length + 1)}`);
  // No trailing newline — matches the editor's own scene/prefab writer.
  if (WRITE) await writeFile(file, JSON.stringify(json, null, 2));
}

const targets = [];
for (const rootDir of ['games', 'demos']) {
  const projects = await readdir(join(ROOT, rootDir), { withFileTypes: true }).catch(() => []);
  for (const proj of projects.filter((d) => d.isDirectory())) {
    const assetsDir = join(ROOT, rootDir, proj.name, 'runtime', 'assets');
    const files = await walkFiles(assetsDir, (p) => /\.(scene|prefab)\.json$/i.test(p));
    targets.push(...files);
  }
}
targets.push(...await walkFiles(join(ROOT, 'engine', 'tests', 'e2e', 'fixtures'), (p) => /\.(scene|prefab)\.json$/i.test(p)));

for (const file of targets) await migrateFile(file);

console.log(`\n${changedKeys} UIAnchor.zIndex key(s) in ${changedFiles} file(s)${WRITE ? ' rewritten' : ' would be rewritten (dry run — pass --write)'}.`);
if (unmatchable.length > 0) {
  console.log('\nCould not migrate (no sibling UIElement trait to carry the value onto):');
  for (const m of unmatchable) console.log(`  ${m}`);
}
