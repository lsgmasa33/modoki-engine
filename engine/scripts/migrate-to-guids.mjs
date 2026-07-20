#!/usr/bin/env node
/** One-shot migration: assign stable UUIDs to every asset, rewrite every
 *  reference from path → guid, and write an assets.manifest.json.
 *
 *  Idempotent: assets that already have an `id` keep it. References that are
 *  already guids are left alone. Safe to re-run.
 *
 *  Usage: node scripts/migrate-to-guids.mjs [--dry-run]
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// Asset references on disk use absolute paths from project root (with a leading
// slash). The dev server's /api/write-file maps these back to files under ROOT.
const PROJECT_ROOT_PREFIX = '/';

// ── Scanning ────────────────────────────────────────────────────────────

/** Directories worth scanning for assets. We deliberately skip node_modules,
 *  ios/, android/, .git/, etc. `packages/modoki/src/runtime/assets` holds the
 *  engine's own bundled assets (mapped to /modoki/assets by fsToUrl). */
const SCAN_ROOTS = ['games', 'app', 'public', 'packages/modoki/src/runtime/assets'];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Convert an absolute file system path to a public URL.
 *
 *  The Vite asset-scanner plugin maps these directories at runtime:
 *    packages/modoki/src/runtime/assets/<rest> → /modoki/assets/<rest>
 *    games/<id>/runtime/assets/<rest>          → /games/<id>/assets/<rest>
 *
 *  We mirror those rewrites so the URLs in the manifest and in JSON refs match
 *  what the runtime actually fetches. */
function fsToUrl(absPath) {
  // Normalize to forward slashes: `relative()` returns backslash paths on Windows, and every
  // check below (the modoki/ prefix, the games/<id>/runtime/assets regex) expects URL-style
  // separators — without this the migration matched NOTHING on Windows and silently no-op'd.
  const rel = relative(ROOT, absPath).replace(/\\/g, '/');

  // packages/modoki/src/runtime/assets → /modoki/assets
  const modokiPrefix = 'packages/modoki/src/runtime/assets/';
  if (rel.startsWith(modokiPrefix)) {
    return '/modoki/assets/' + rel.substring(modokiPrefix.length);
  }

  // games/<id>/runtime/assets → /games/<id>/assets
  const gamesMatch = rel.match(/^games\/([^/]+)\/runtime\/assets\/(.*)$/);
  if (gamesMatch) {
    return `/games/${gamesMatch[1]}/assets/${gamesMatch[2]}`;
  }

  return PROJECT_ROOT_PREFIX + rel;
}

// ── Asset type detection ────────────────────────────────────────────────

function classify(filePath) {
  // Normalize Windows backslashes so the `/scenes/` directory check below works there too
  // (it's called with a native fs path — a bare scene.json under scenes/ was misclassified).
  filePath = filePath.replace(/\\/g, '/');
  if (filePath.endsWith('.mesh.json')) return 'mesh';
  if (filePath.endsWith('.mat.json')) return 'material';
  if (filePath.endsWith('.prefab.json')) return 'prefab';
  if (filePath.endsWith('.scene.json')) return 'scene';
  // Scene files often use bare `.json` under a `/scenes/` directory.
  if (filePath.endsWith('.json') && filePath.includes('/scenes/') && !filePath.endsWith('.meta.json')) return 'scene';
  // .glb/.hdr/.png/.jpg use sidecar .meta.json
  if (/\.(glb|gltf)$/i.test(filePath)) return 'model';
  if (/\.(hdr|exr)$/i.test(filePath)) return 'environment';
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(filePath)) return 'texture';
  return null;
}

// JSON files that might *look* like assets but aren't — skip these to avoid
// stomping unrelated config files. classify() already vets by extension, so
// these only need a loose shape check.
function isScenelike(json) {
  return json && typeof json === 'object' && Array.isArray(json.entities);
}
function isPrefablike(json) {
  return json && typeof json === 'object' && Array.isArray(json.entities) && 'rootLocalId' in json;
}
function isMeshlike(json) {
  return json && typeof json === 'object' && typeof json.model === 'string';
}
function isMatlike(json) {
  // Materials carry a version field. Custom-shader materials lack the standard
  // PBR fields, so don't gate on color/roughness/metalness/texture.
  return json && typeof json === 'object' && typeof json.version === 'number';
}

// ── Phase 1: scan + assign ids ──────────────────────────────────────────

/** path (URL) → { type, guid, json | meta } */
const assetIndex = new Map();
const inlineJsonAssets = []; // [{ url, fsPath, json, type }]
const binaryAssets = []; // [{ url, fsPath, metaPath, meta, type }]

async function readJson(fsPath) {
  const txt = await readFile(fsPath, 'utf8');
  return JSON.parse(txt);
}

async function indexAsset(fsPath) {
  const ext = classify(fsPath);
  if (!ext) return;
  const url = fsToUrl(fsPath);

  // Use NFC-normalized URL as the index key. macOS readdir returns NFD-encoded
  // filenames for non-ASCII chars; JSON refs almost always use NFC. Normalizing
  // here lets either form resolve correctly.
  const urlNFC = url.normalize('NFC');

  if (ext === 'mesh' || ext === 'material' || ext === 'prefab' || ext === 'scene') {
    let json;
    try { json = await readJson(fsPath); } catch (e) {
      console.warn(`[skip] ${url}: invalid JSON (${e.message})`);
      return;
    }
    // Schema guard — skip JSON files that don't match expected shape
    if (ext === 'mesh' && !isMeshlike(json)) return;
    if (ext === 'material' && !isMatlike(json)) return;
    if (ext === 'prefab' && !isPrefablike(json)) return;
    if (ext === 'scene' && !isScenelike(json)) return;

    if (!isGuid(json.id)) json.id = randomUUID();
    else if (seenGuids.has(json.id)) {
      // Two files share the same id — almost always a manual file copy.
      // Regenerate on the *later* file (stable: first-scanned wins).
      console.warn(`[collision] ${url} shared id with ${seenGuids.get(json.id)}; regenerating.`);
      json.id = randomUUID();
    }
    seenGuids.set(json.id, url);
    inlineJsonAssets.push({ url, fsPath, json, type: ext });
    assetIndex.set(urlNFC, { type: ext, guid: json.id });
  } else if (ext === 'model' || ext === 'environment' || ext === 'texture') {
    const metaPath = fsPath + '.meta.json';
    let meta = { version: 2 };
    if (existsSync(metaPath)) {
      try { meta = await readJson(metaPath); } catch { /* corrupt — rewrite */ }
    }
    if (!isGuid(meta.id)) meta.id = randomUUID();
    else if (seenGuids.has(meta.id)) {
      console.warn(`[collision] ${url} shared id with ${seenGuids.get(meta.id)}; regenerating.`);
      meta.id = randomUUID();
    }
    seenGuids.set(meta.id, url);
    if (!meta.version) meta.version = 2;
    binaryAssets.push({ url, fsPath, metaPath, meta, type: ext });
    assetIndex.set(urlNFC, { type: ext, guid: meta.id });
  }
}

/** Track guids as we scan so we can detect collisions and regenerate on the
 *  later-scanned file. Filesystem order is stable enough for "first wins". */
const seenGuids = new Map();

// ── Phase 2: rewrite references ─────────────────────────────────────────

/** Trait field paths to scan inside scene/prefab `entities[].traits` and inside
 *  mesh/material assets. */
const TRAIT_REFS = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite'],
  UIElement: ['imageSrc'],
  ModelSource: ['glbPath'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
};

function urlOrGuidToGuid(ref) {
  if (typeof ref !== 'string' || !ref) return ref;
  if (isGuid(ref)) return ref;
  // External URLs pass through
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:') || ref.startsWith('blob:')) return ref;
  // Normalize Unicode (macOS HFS+ uses NFD for filenames; refs in JSON may be NFC).
  const normalized = ref.normalize('NFC');
  let entry = assetIndex.get(normalized);
  if (!entry) entry = assetIndex.get(ref.normalize('NFD'));
  return entry ? entry.guid : ref;
}

function rewriteEntityTraits(entity) {
  if (!entity || typeof entity !== 'object' || !entity.traits) return;
  for (const [traitName, fields] of Object.entries(TRAIT_REFS)) {
    const t = entity.traits[traitName];
    if (!t || typeof t === 'boolean') continue;
    for (const f of fields) {
      if (typeof t[f] === 'string') t[f] = urlOrGuidToGuid(t[f]);
    }
  }
  if (typeof entity.prefab === 'string') entity.prefab = urlOrGuidToGuid(entity.prefab);
  // Override map: { localId: { TraitName: { field: value } } }
  if (entity.overrides && typeof entity.overrides === 'object') {
    for (const overrides of Object.values(entity.overrides)) {
      if (!overrides || typeof overrides !== 'object') continue;
      for (const [traitName, fields] of Object.entries(overrides)) {
        if (!fields || typeof fields !== 'object') continue;
        const refFields = TRAIT_REFS[traitName] || [];
        for (const f of refFields) {
          if (typeof fields[f] === 'string') fields[f] = urlOrGuidToGuid(fields[f]);
        }
      }
    }
  }
}

function rewriteResources(json) {
  if (!Array.isArray(json.resources)) return;
  for (const res of json.resources) {
    if (typeof res.path === 'string') res.path = urlOrGuidToGuid(res.path);
  }
}

// v7 → v8 migration: Persistent.guid → EntityAttributes.guid
function migrateSceneV7toV8(json) {
  if (typeof json.version !== 'number' || json.version >= 8) return;
  for (const entry of json.entities || []) {
    const p = entry?.traits?.Persistent;
    if (p && typeof p === 'object' && p.guid) {
      const ea = entry.traits.EntityAttributes;
      if (ea && typeof ea === 'object' && !ea.guid) ea.guid = p.guid;
      entry.traits.Persistent = true;
    }
  }
  json.version = 8;
}

function rewriteScene(json) {
  migrateSceneV7toV8(json);
  for (const entity of json.entities || []) rewriteEntityTraits(entity);
  rewriteResources(json);
}

function rewritePrefab(json) {
  for (const entity of json.entities || []) {
    if (!entity.traits) continue;
    // Prefab entities use the same trait shape as scene entities
    rewriteEntityTraits(entity);
    // Clear any baked-in guid on EntityAttributes (per-instance identity lives on the live entity)
    const ea = entity.traits.EntityAttributes;
    if (ea && typeof ea === 'object') ea.guid = '';
  }
}

function rewriteMesh(json) {
  if (typeof json.model === 'string') json.model = urlOrGuidToGuid(json.model);
  if (typeof json.material === 'string') json.material = urlOrGuidToGuid(json.material);
}

function rewriteMaterial(json) {
  if (typeof json.texture === 'string') json.texture = urlOrGuidToGuid(json.texture);
}

// ── Run ─────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[migrate] root: ${ROOT}`);
  console.log(`[migrate] dry-run: ${DRY_RUN}`);

  // Scan
  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    if (existsSync(abs)) await walk(abs, allFiles);
  }
  console.log(`[migrate] scanned ${allFiles.length} files`);

  for (const f of allFiles) await indexAsset(f);
  console.log(`[migrate] indexed ${assetIndex.size} assets`);

  // Rewrite refs inside JSON assets
  let writeCount = 0;
  for (const a of inlineJsonAssets) {
    if (a.type === 'scene') rewriteScene(a.json);
    else if (a.type === 'prefab') rewritePrefab(a.json);
    else if (a.type === 'mesh') rewriteMesh(a.json);
    else if (a.type === 'material') rewriteMaterial(a.json);

    if (DRY_RUN) continue;
    await writeFile(a.fsPath, JSON.stringify(a.json, null, 2));
    writeCount++;
  }

  // Write binary asset sidecars
  for (const a of binaryAssets) {
    if (DRY_RUN) continue;
    await writeFile(a.metaPath, JSON.stringify(a.meta, null, 2));
    writeCount++;
  }

  // Write the assets manifest. Array-of-entries format matches vite-asset-scanner
  // so a single file serves both font/panel discovery and the guid resolver.
  const manifest = {
    version: 2,
    assets: Array.from(assetIndex.entries()).map(([url, { type, guid }]) => ({
      guid,
      path: url,
      type,
      name: basename(url).replace(/\.(mesh|mat|prefab|scene)?\.json$/i, '').replace(/\.[^.]+$/, ''),
    })),
  };
  // Try ROOT/public first; if that doesn't exist, write under ROOT directly.
  const publicDir = join(ROOT, 'public');
  const manifestPath = existsSync(publicDir)
    ? join(publicDir, 'assets.manifest.json')
    : join(ROOT, 'assets.manifest.json');
  if (!DRY_RUN) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    writeCount++;
  }

  console.log(`[migrate] ${DRY_RUN ? 'would write' : 'wrote'} ${writeCount} files`);
  console.log(`[migrate] manifest: ${manifestPath}`);
}

run().catch((e) => {
  console.error('[migrate] FAILED:', e);
  process.exit(1);
});
