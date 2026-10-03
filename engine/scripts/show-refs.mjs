#!/usr/bin/env node
/** Print every asset/entity reference in a scene or prefab file, with GUIDs
 *  resolved to their current paths via assets.manifest.json.
 *
 *  Useful when diffing broken refs — bare GUIDs in a scene file are inscrutable
 *  without this tool. Run it any time you suspect a stale or dangling ref (after
 *  moving/deleting an asset, for instance).
 *
 *  Usage:
 *    node engine/scripts/show-refs.mjs path/to/scene-or-prefab.json
 *    node engine/scripts/show-refs.mjs --all     # walk every scene/prefab in the repo
 *
 *  ⚠️ `--all` was broken two further ways until #805, BOTH of them independent of the Windows
 *  separator bug that #798 fixed in this same function (that was instance 8 of
 *  docs/windows.md § Paths; it is not what this note is about, and the `toPosix` call it added
 *  was correct):
 *
 *    1. `ROOT` was `resolve(__dirname, '..')` — `engine/`, not the repo root. So `loadManifest()`
 *       probed `engine/assets.manifest.json` and two siblings, none of which exist (the manifest
 *       is at the repo root), and EVERY guid ref reported as unresolvable; and the walk could not
 *       see `games/`/`demos/` at all. MEASURED: `--all` reached 2 files, against 154 in the repo.
 *    2. The walker keyed PREFABS by extension but SCENES by DIRECTORY (`.../scenes/`), so a
 *       `.scene.json` outside a `scenes/` folder was invisible no matter what the root was —
 *       9 such files live at `engine/tests/e2e/fixtures/*.scene.json`. This is why fixing the
 *       root alone would still have under-reported.
 *
 *  Both are fixed by routing through `repoCorpus.mjs` (`repoRoot()`/`repoFiles()`) and keying
 *  scenes on the extension, like prefabs. Note that 0 `.prefab.json` files exist anywhere under
 *  the OLD root, so the prefab branch had never once fired in this script's life.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { repoRoot, repoFiles } from './repoCorpus.mjs';
import { parseJsonText } from './jsonFile.mjs'; // #1799: a BOM is read through
import { walkObjects } from './jsonWalk.mjs';

const ROOT = repoRoot();
const args = process.argv.slice(2);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);

const TRAIT_REFS = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite'],
  UIElement: ['imageSrc'],
  ModelSource: ['glbPath'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
};

/** guid → asset, from the asset IDs the repo itself holds (#2119): a binary's `.meta.json`
 *  sidecar and a JSON asset's own top-level `id`, which is where the editor's scanner reads them.
 *  The root `assets.manifest.json` is a build output that is rarely regenerated (it still listed
 *  deleted projects), so a game's refs read through it alone showed every one as missing; it is
 *  read only for a guid the repo does not hold. */
async function loadManifest() {
  const byGuid = new Map();
  const sources = [];
  let fromRepo = 0;
  for (const f of repoFiles({ match: /\.json$/i, floor: 1 })) {
    const sidecar = /\.meta\.json$/i.test(f.rel);
    let data;
    try { data = parseJsonText(await readFile(f.abs, 'utf-8')); } catch { continue; }
    if (!data || typeof data !== 'object' || !isGuid(data.id)) continue;
    const path = '/' + (sidecar ? f.rel.replace(/\.meta\.json$/i, '') : f.rel);
    const type = sidecar ? 'file' : (/\.([a-z0-9-]+)\.json$/i.exec(f.rel)?.[1] ?? 'json');
    // An id two files carry (a calibration copy of a level, say): the shipped asset wins, whatever
    // the sort order, so the ref prints the file the game actually loads.
    const had = byGuid.get(data.id);
    if (had && (had.path.includes('/runtime/assets/') || !path.includes('/runtime/assets/'))) continue;
    if (!had) fromRepo++;
    byGuid.set(data.id, { guid: data.id, path, type });
  }
  if (fromRepo) sources.push(`repo asset ids (${fromRepo})`);
  const manifestPath = join(ROOT, 'assets.manifest.json');
  if (existsSync(manifestPath)) {
    const data = parseJsonText(await readFile(manifestPath, 'utf-8'));
    for (const a of (data.assets ?? [])) {
      if (a.guid && !byGuid.has(a.guid)) byGuid.set(a.guid, a);
    }
    sources.push(relative(ROOT, manifestPath));
  }
  return { byGuid, source: sources.length ? sources.join(' + ') : null };
}

function resolveRef(ref, manifest) {
  if (typeof ref !== 'string' || !ref) return { kind: 'empty', display: '<empty>' };
  if (!isGuid(ref)) return { kind: 'path', display: ref };
  const hit = manifest.byGuid.get(ref);
  return hit
    ? { kind: 'guid', display: `${ref}  →  ${hit.path}  [${hit.type}]` }
    : { kind: 'missing', display: `${ref}  →  ⚠️  NOT IN MANIFEST` };
}

function walkRefs(json, manifest, out) {
  // Every object at any depth (#2119): a v20 scene / v10 prefab states its records on
  // `members[key].traits` and its user nodes in `members[key].own`, and a walk that named its
  // containers (`entities`, `overrides`) printed none of them.
  walkObjects(json, (obj, at) => {
    for (const [traitName, fields] of Object.entries(TRAIT_REFS)) {
      const bag = obj[traitName];
      if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
      for (const f of fields) {
        const v = bag[f];
        if (typeof v === 'string' && v) out.push({ at: `${at}.${traitName}.${f}`, ref: v, ...resolveRef(v, manifest) });
      }
    }
    // A scene entry's or a prefab reference row's prefab
    if (typeof obj.prefab === 'string' && obj.prefab) {
      out.push({ at: `${at}.prefab`, ref: obj.prefab, ...resolveRef(obj.prefab, manifest) });
    }
    // The resources list
    if (Array.isArray(obj.resources)) {
      for (let i = 0; i < obj.resources.length; i++) {
        const r = obj.resources[i];
        if (r && typeof r.path === 'string') {
          out.push({ at: `${at}.resources[${i}](${r.type})`, ref: r.path, ...resolveRef(r.path, manifest) });
        }
      }
    }
  });
}

async function showFile(filePath, manifest) {
  const txt = await readFile(filePath, 'utf-8');
  let json;
  try { json = parseJsonText(txt); } catch (e) { console.warn(`[skip] ${filePath}: ${e.message}`); return; }

  const out = [];
  walkRefs(json, manifest, out);

  console.log(`\n== ${relative(ROOT, filePath)} ==`);
  if (json.id) console.log(`   file.id: ${json.id}`);
  if (typeof json.version === 'number') console.log(`   version: ${json.version}`);
  if (out.length === 0) { console.log('   (no refs)'); return; }

  const counts = { guid: 0, path: 0, missing: 0, empty: 0 };
  for (const r of out) counts[r.kind]++;
  console.log(`   refs: ${out.length}  (guid: ${counts.guid}, path: ${counts.path}, missing: ${counts.missing})`);
  for (const r of out) {
    const marker = r.kind === 'missing' ? '✗' : r.kind === 'path' ? '⚠' : '·';
    console.log(`   ${marker} ${r.at}`);
    console.log(`     ${r.display}`);
  }
}

async function main() {
  const manifest = await loadManifest();
  console.log(`[show-refs] manifest: ${manifest.source ?? '(none found — guid refs will all show ⚠️ NOT IN MANIFEST)'}`);
  console.log(`[show-refs] entries: ${manifest.byGuid.size}`);

  if (args.includes('--all')) {
    // Keyed on EXTENSION for both scene and prefab — the old walker keyed prefabs by
    // extension but scenes by directory (`.../scenes/`), which missed any `.scene.json`
    // outside a `scenes/` folder. See the header comment.
    const targets = repoFiles({ match: /\.(scene|prefab)\.json$/i, floor: 1 });
    for (const f of targets) await showFile(f.abs, manifest);
    return;
  }

  if (args.length === 0) {
    console.error('Usage: node engine/scripts/show-refs.mjs <file.json>');
    console.error('       node engine/scripts/show-refs.mjs --all');
    process.exit(1);
  }

  for (const a of args) {
    const abs = resolve(a);
    if (!existsSync(abs)) { console.error(`Not found: ${a}`); continue; }
    await showFile(abs, manifest);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
