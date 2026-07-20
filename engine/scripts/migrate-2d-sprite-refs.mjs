#!/usr/bin/env node
/** One-shot migration: rewrite RAW-TEXTURE refs in 2D fields to the texture's
 *  auto-created whole-image SPRITE GUID (the "sprites-only 2D references" policy).
 *
 *  Background: 2D content used to reference a bare texture GUID as a "whole-image
 *  sprite". Now every 2D/UI-typed texture auto-emits a default whole-image sprite
 *  (scanner) whose GUID is `deriveGuid('sprite:' + textureGuid)`. This script
 *  repoints the 2D fields — `Renderable2D.sprite`, `UIElement.imageSrc`, and
 *  `.rig2d.json` `parts[].sprite` — from the texture GUID to that sprite GUID, and
 *  stamps `meta.type` on migrated textures (preserving the existing codec block so
 *  no re-import is triggered).
 *
 *  AMBIGUOUS textures — a texture referenced from BOTH a 2D field and a 3D usage
 *  (a material slot, or a KTX2/3D-typed format) — cannot be auto-assigned a single
 *  type, so they are REPORTED and left untouched for a human decision.
 *
 *  Only touches `games/<id>/runtime/assets/**` (the source of truth) — never
 *  `dist/`, `ios/`, `android/` build outputs.
 *
 *  Usage:
 *    node engine/scripts/migrate-2d-sprite-refs.mjs            # dry-run (report only)
 *    node engine/scripts/migrate-2d-sprite-refs.mjs --write    # apply the rewrites
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..'); // repo root (engine/scripts → ../..)
const WRITE = process.argv.includes('--write');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s);
const PRIMITIVE_SPRITES = new Set(['circle', 'square', 'triangle']);
const isExternalUrl = (s) => typeof s === 'string' && /^(https?:|data:|blob:)/.test(s);

/** EXACT copy of runtime `deriveGuid` (assetRefRules.ts) — FNV-1a spread. Must
 *  stay byte-identical to the scanner's so the derived sprite GUID matches. */
function deriveGuid(seed) {
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  const part = (n) => fnv(n + ':' + seed).toString(16).padStart(8, '0');
  const hex = part(0) + part(1) + part(2) + part(3);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const spriteGuidFor = (texGuid) => deriveGuid('sprite:' + texGuid);

/** Recursively collect files under `dir` matching `pred` (skips build-output dirs). */
async function walkFiles(dir, pred, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.cache') continue;
      await walkFiles(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** Every `games/<id>/runtime/assets` dir. */
async function assetRoots() {
  const gamesDir = join(ROOT, 'games');
  const roots = [];
  for (const e of await readdir(gamesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const r = join(gamesDir, e.name, 'runtime', 'assets');
    if (existsSync(r)) roots.push(r);
  }
  return roots;
}

const TEX_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function resolveTextureType(meta) {
  if (meta?.type) return meta.type;
  const fmt = meta?.texture?.format;
  return fmt === 'webp' || fmt === 'png' ? '2d' : '3d';
}

async function main() {
  const roots = await assetRoots();

  // 1. Index every texture: guid → { metaPath, srcPath, format, type }.
  const texByGuid = new Map();
  for (const root of roots) {
    const metas = await walkFiles(root, (p) => p.endsWith('.meta.json') && TEX_EXT.has(extname(p.slice(0, -'.meta.json'.length)).toLowerCase()));
    for (const metaPath of metas) {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      if (!isGuid(meta.id)) continue;
      texByGuid.set(meta.id, {
        metaPath, srcPath: metaPath.slice(0, -'.meta.json'.length),
        format: meta?.texture?.format, type: resolveTextureType(meta), meta,
        used2D: false, used3D: resolveTextureType(meta) === '3d' || String(meta?.texture?.format || '').startsWith('ktx2'),
      });
    }
  }

  // 2. Mark textures used in 3D (any material slot referencing the texture GUID).
  for (const root of roots) {
    const mats = await walkFiles(root, (p) => p.endsWith('.mat.json'));
    for (const matPath of mats) {
      const raw = await readFile(matPath, 'utf-8');
      for (const guid of texByGuid.keys()) if (raw.includes(guid)) texByGuid.get(guid).used3D = true;
    }
  }

  // 3. Walk 2D content, plan rewrites of raw-texture refs in 2D fields.
  const TWO_D_TRAIT_FIELDS = { Renderable2D: ['sprite'], UIElement: ['imageSrc'] };
  const edits = []; // { file, json, changes: [{ at, from, to }] }
  const ambiguous = new Set();

  const planRef = (val, at, changes) => {
    if (typeof val !== 'string' || !val || !isGuid(val)) return val;         // empty/keyword/URL/path → leave
    const tex = texByGuid.get(val);
    if (!tex) return val;                                                     // already a sprite/other GUID
    tex.used2D = true;
    if (tex.used3D) { ambiguous.add(val); return val; }                      // ambiguous → don't touch
    const to = spriteGuidFor(val);
    changes.push({ at, from: val, to });
    return to;
  };

  // recursive walk for scenes/prefabs (entity trees + prefab overrides)
  const walkContent = (node, path, changes) => {
    if (Array.isArray(node)) { node.forEach((n, i) => walkContent(n, `${path}[${i}]`, changes)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [trait, fields] of Object.entries(TWO_D_TRAIT_FIELDS)) {
      const t = node[trait];
      if (t && typeof t === 'object') for (const f of fields) {
        if (typeof t[f] === 'string') t[f] = planRef(t[f], `${path}.${trait}.${f}`, changes);
      }
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walkContent(v, `${path}.${k}`, changes);
  };

  const contentFiles = [];
  for (const root of roots) {
    contentFiles.push(...await walkFiles(root, (p) => {
      const b = basename(p);
      return b.endsWith('.rig2d.json') || b.endsWith('.prefab.json') ||
        (extname(p) === '.json' && /(^|\/)scenes\//.test(p.replace(/\\/g, '/')));
    }));
  }

  for (const file of contentFiles) {
    const json = JSON.parse(await readFile(file, 'utf-8'));
    const changes = [];
    if (file.endsWith('.rig2d.json') && Array.isArray(json.parts)) {
      json.parts.forEach((part, i) => {
        if (part && typeof part.sprite === 'string') part.sprite = planRef(part.sprite, `parts[${i}].sprite`, changes);
      });
    } else {
      walkContent(json, basename(file), changes);
    }
    if (changes.length) edits.push({ file, json, changes });
  }

  // 4. Report.
  console.log(`\n=== 2D sprite-ref migration (${WRITE ? 'WRITE' : 'DRY-RUN'}) ===`);
  console.log(`textures indexed: ${texByGuid.size} · content files scanned: ${contentFiles.length}`);
  let total = 0;
  for (const { file, changes } of edits) {
    console.log(`\n${file.replace(ROOT + '/', '')}  (${changes.length})`);
    for (const c of changes) { console.log(`  ${c.at}: ${c.from} → ${c.to}`); total++; }
  }
  console.log(`\nrewrites planned: ${total}`);

  if (ambiguous.size) {
    console.log(`\n⚠️  AMBIGUOUS textures (referenced in 2D AND 3D — NOT migrated; decide the type manually):`);
    for (const g of ambiguous) {
      const t = texByGuid.get(g);
      console.log(`  ${g}  ${t?.srcPath.replace(ROOT + '/', '')}  [format=${t?.format}]`);
    }
  } else {
    console.log(`\nno ambiguous textures.`);
  }

  if (!WRITE) { console.log(`\n(dry-run — re-run with --write to apply)\n`); return; }

  // 5. Apply: rewrite content files + stamp meta.type on migrated (unambiguous) textures.
  const migratedTex = new Set();
  for (const { file, json, changes } of edits) {
    await writeFile(file, JSON.stringify(json, null, 2) + '\n');
    for (const c of changes) migratedTex.add(c.from);
  }
  let stamped = 0;
  for (const guid of migratedTex) {
    const t = texByGuid.get(guid);
    if (!t || t.meta.type === t.type) continue;
    t.meta.type = t.type; // preserve texture block → same hash → no re-import
    await writeFile(t.metaPath, JSON.stringify(t.meta, null, 2) + '\n');
    stamped++;
  }
  console.log(`\n✅ wrote ${edits.length} content file(s); stamped type on ${stamped} texture meta(s).\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
