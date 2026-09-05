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
 *  `runtime/assets` — never the e2e fixtures (see the note at the push site below), `dist/`, `ios/`,
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
// ⚠️ The e2e fixtures are DELIBERATELY left un-migrated at `version: 9` — they earn their keep by
// driving the whole migration ladder (including v12→v13) on every e2e run, and migrating them in
// place would quietly retire that coverage. Running this script over them would look like a
// successful sweep and silently cost the only end-to-end proof the new step is wired up at all.
// `engine/tests/assets/anchorZIndexMigrated.test.ts` asserts they still carry the key, so doing it
// anyway turns the gate red rather than passing unnoticed — but do not make that test the thing
// that catches it. Pass --include-e2e-fixtures only if that decision is being reversed on purpose.
if (process.argv.includes('--include-e2e-fixtures')) {
  targets.push(...await walkFiles(join(ROOT, 'engine', 'tests', 'e2e', 'fixtures'), (p) => /\.(scene|prefab)\.json$/i.test(p)));
}

for (const file of targets) await migrateFile(file);

console.log(`\n${changedKeys} UIAnchor.zIndex key(s) in ${changedFiles} file(s)${WRITE ? ' rewritten' : ' would be rewritten (dry run — pass --write)'}.`);
if (unmatchable.length > 0) {
  console.log('\nCould not migrate (no sibling UIElement trait to carry the value onto):');
  for (const m of unmatchable) console.log(`  ${m}`);
}
