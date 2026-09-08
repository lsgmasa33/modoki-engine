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

async function loadManifest() {
  const candidates = [
    join(ROOT, 'assets.manifest.json'),
    join(ROOT, 'public', 'assets.manifest.json'),
    join(ROOT, 'dist', 'assets.manifest.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const data = JSON.parse(await readFile(p, 'utf-8'));
    const byGuid = new Map();
    for (const a of (data.assets ?? [])) {
      if (a.guid) byGuid.set(a.guid, a);
    }
    return { byGuid, source: p };
  }
  return { byGuid: new Map(), source: null };
}

function resolveRef(ref, manifest) {
  if (typeof ref !== 'string' || !ref) return { kind: 'empty', display: '<empty>' };
  if (!isGuid(ref)) return { kind: 'path', display: ref };
  const hit = manifest.byGuid.get(ref);
  return hit
    ? { kind: 'guid', display: `${ref}  →  ${hit.path}  [${hit.type}]` }
    : { kind: 'missing', display: `${ref}  →  ⚠️  NOT IN MANIFEST` };
}

function walkRefs(obj, manifest, out, breadcrumb) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkRefs(obj[i], manifest, out, `${breadcrumb}[${i}]`);
    return;
  }
  if (!obj || typeof obj !== 'object') return;

  // Direct trait fields: surface every ref we know to look for
  for (const [traitName, fields] of Object.entries(TRAIT_REFS)) {
    if (obj[traitName] && typeof obj[traitName] === 'object' && obj[traitName] !== true) {
      for (const f of fields) {
        const v = obj[traitName][f];
        if (typeof v === 'string' && v) {
          out.push({ at: `${breadcrumb}.${traitName}.${f}`, ref: v, ...resolveRef(v, manifest) });
        }
      }
    }
  }
  // Top-level prefab field on a scene entity
  if (typeof obj.prefab === 'string' && obj.prefab) {
    out.push({ at: `${breadcrumb}.prefab`, ref: obj.prefab, ...resolveRef(obj.prefab, manifest) });
  }
  // Resources list
  if (Array.isArray(obj.resources)) {
    for (let i = 0; i < obj.resources.length; i++) {
      const r = obj.resources[i];
      if (r && typeof r.path === 'string') {
        out.push({ at: `${breadcrumb}.resources[${i}](${r.type})`, ref: r.path, ...resolveRef(r.path, manifest) });
      }
    }
  }

  // Recurse into known nested containers
  for (const key of ['entities', 'overrides']) {
    if (key in obj) walkRefs(obj[key], manifest, out, `${breadcrumb}.${key}`);
  }
}

async function showFile(filePath, manifest) {
  const txt = await readFile(filePath, 'utf-8');
  let json;
  try { json = JSON.parse(txt); } catch (e) { console.warn(`[skip] ${filePath}: ${e.message}`); return; }

  const out = [];
  walkRefs(json, manifest, out, 'root');

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
