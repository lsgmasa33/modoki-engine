#!/usr/bin/env node
/** One-shot migration for #231: rewrite `UIElement.fontFamily` from a CSS FAMILY NAME to
 *  the font asset's GUID, and retype the scene `resources[]` entry that carried it.
 *
 *  Background: `fontFamily` was the last `accept:`-typed field in the engine that stored
 *  something other than a GUID. That made it a reference the BUILD cannot see — the
 *  tree-shaker had to resolve it by matching family names against filenames, and the
 *  validator/`diagnose` could not check it at all. It holds a font-asset GUID now.
 *
 *  Matching is `parseFontFilename(path).family` — the SAME rule the runtime loader and the
 *  build's font walk use, so a value this script cannot match is one nothing else could
 *  resolve either.
 *
 *  What it does NOT do: guess. A family that matches no font asset is REPORTED and left
 *  alone — it is probably a system typeface (`system-ui`, `Helvetica`), which belongs in the
 *  new `systemFont` field, and only the author knows whether that was the intent. The
 *  runtime keeps rendering such a value (with a one-time warning) either way.
 *
 *  Only touches `games/<id>/**` and `demos/<id>/**` scene/prefab JSON under `runtime/assets`
 *  — never `dist/`, `ios/`, `android/` build outputs.
 *
 *  Usage:
 *    node engine/scripts/migrate-font-family-refs.mjs            # dry-run (report only)
 *    node engine/scripts/migrate-font-family-refs.mjs --write    # apply the rewrites
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFontFilename } from '../packages/modoki/src/runtime/loaders/fontNaming.ts';
import { repoFiles } from './repoCorpus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const WRITE = process.argv.includes('--write');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);

/** Every file under `<projectRel>` (a repo-relative POSIX path, e.g. `games/sling`) whose
 *  git-relative path satisfies `match` — git-backed enumeration (#771/#799) replaces the
 *  hand-rolled recursive walker. `ios`/`android` are excluded explicitly because they are TRACKED
 *  native mirrors; `node_modules`/`dist`/`.cache`/`ads` need no entry at all, since every one of
 *  them is gitignored and is therefore absent from the corpus for free. */
function projectFiles(projectRel, match) {
  return repoFiles({
    under: projectRel,
    match,
    exclude: ['ios', 'android'],
    floor: 0,
  }).map(({ abs }) => abs);
}

/** family name (as the runtime derives it) → font asset GUID, from the `.meta.json` sidecars. */
async function buildFamilyIndex(projectRel) {
  const metas = projectFiles(projectRel, (rel) => /\.(ttf|otf|woff2?)\.meta\.json$/i.test(rel));
  const index = new Map();
  for (const meta of metas) {
    let json;
    try { json = JSON.parse(await readFile(meta, 'utf-8')); } catch { continue; }
    if (!json?.id) continue;
    const family = parseFontFilename(meta.replace(/\.meta\.json$/i, '')).family;
    // A family with several variants (Regular + Bold) resolves to whichever asset comes
    // first: the ref pins ONE file, and the runtime registers every variant of its family
    // anyway (`loadFontFamily`), so any variant of the right family is a correct answer.
    if (!index.has(family)) index.set(family, json.id);
  }
  return index;
}

let changedFiles = 0, changedRefs = 0;
const unmatched = new Map();   // family → [file, …]

for (const rootDir of ['games', 'demos']) {
  const projects = await readdir(join(ROOT, rootDir), { withFileTypes: true }).catch(() => []);
  for (const proj of projects.filter((d) => d.isDirectory())) {
    const projectRel = `${rootDir}/${proj.name}`;
    const index = await buildFamilyIndex(projectRel);
    const files = projectFiles(projectRel, (rel) => /\.(scene|prefab)\.json$/i.test(rel));

    for (const file of files) {
      let json;
      try { json = JSON.parse(await readFile(file, 'utf-8')); } catch { continue; }
      let dirty = false;
      const migratedFamilies = new Set();

      const visitTraits = (traits) => {
        const ui = traits?.UIElement;
        if (!ui || typeof ui !== 'object') return;
        const v = ui.fontFamily;
        if (typeof v !== 'string' || !v || isGuid(v)) return;
        const guid = index.get(v);
        if (!guid) {
          if (!unmatched.has(v)) unmatched.set(v, []);
          unmatched.get(v).push(file.slice(ROOT.length + 1));
          return;
        }
        ui.fontFamily = guid;
        migratedFamilies.add(v);
        dirty = true; changedRefs++;
      };

      // Entities, their prefab-instance overrides, and any added subtrees.
      const visitEntry = (entry) => {
        if (!entry || typeof entry !== 'object') return;
        visitTraits(entry.traits);
        for (const bag of Object.values(entry.overrides ?? {})) visitTraits(bag);
        for (const added of entry.added ?? []) visitEntry(added);
        for (const child of entry.children ?? []) visitEntry(child);
      };
      for (const entry of json.entities ?? []) visitEntry(entry);

      // The scene's resources[] entry for a migrated family: `{type:'font', path:'<name>'}`
      // becomes `{type:'font-family', path:'<guid>'}`. Left alone when its family was not
      // migrated, so a partially-migrated scene stays loadable.
      if (Array.isArray(json.resources)) {
        for (const r of json.resources) {
          if (r?.type === 'font' && typeof r.path === 'string' && migratedFamilies.has(r.path)) {
            r.type = 'font-family';
            r.path = index.get(r.path);
            dirty = true;
          }
        }
        json.resources.sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.path).localeCompare(String(b.path)));
      }

      if (dirty) {
        changedFiles++;
        console.log(`${WRITE ? 'rewrote' : 'would rewrite'} ${file.slice(ROOT.length + 1)}`);
        // No trailing newline: that is how the editor's own scene writer serializes, and
        // adding one here would show up as a diff on the next save in every migrated file.
        if (WRITE) await writeFile(file, JSON.stringify(json, null, 2));
      }
    }
  }
}

console.log(`\n${changedRefs} fontFamily ref(s) in ${changedFiles} file(s)${WRITE ? ' rewritten' : ' would be rewritten (dry run — pass --write)'}.`);
if (unmatched.size > 0) {
  console.log('\nLeft alone — no font asset has this family. Probably a SYSTEM typeface: move the');
  console.log('value into the new UIElement.systemFont field, or import the font and re-run.');
  for (const [family, files] of unmatched) console.log(`  "${family}" — ${files.join(', ')}`);
}
