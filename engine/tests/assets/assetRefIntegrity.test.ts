/**
 * Invariant guard for GUID-only asset references.
 *
 * References are GUID-only: every asset ref stored in a scene/prefab/mesh/
 * material/particle JSON must be a GUID (resolved through the manifest), never a
 * literal project path. Path refs used to be tolerated by a dual-mode resolver,
 * which silently masked stale/wrong refs (a moved file still "worked" until it
 * didn't). The resolver now rejects internal asset paths loudly; these tests
 * assert that no committed asset reintroduces one, over the REAL shipped assets:
 *
 *   1. Every .particle.json carries a valid in-file GUID `id`.
 *   2. No scene/prefab/mesh/material/particle file references another asset by
 *      literal path — all refs are GUIDs (or genuinely external http/data URLs).
 *   3. Every GUID-shaped reference resolves to a known asset's GUID (no dangling).
 *   4. Particle resource entries in scenes carry a resolvable GUID path.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { findAssetRoots, readAssetGuid, detectType, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { deriveGuid } from '../../packages/modoki/src/runtime/loaders/assetRefRules';
import { resolveTextureType } from '../../packages/modoki/src/runtime/loaders/textureSettings';

// engine/tests/assets/ → repo root (games/ + engine/packages/modoki live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// The "real assets" checks below scan the repo's shipped GAME assets; skip the game-dependent
// cases when games/ is absent (engine-only OSS repo). docs/plans/engine-oss-public-repo.md.
const hasGames = fs.existsSync(path.join(PROJECT_ROOT, 'games'));
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = (s: unknown): s is string => typeof s === 'string' && GUID_RE.test(s);

/** A string that looks like an on-disk internal asset reference (the fragile,
 *  now-rejected form). Mirrors assetManifest.isInternalAssetPath. Fonts
 *  (.ttf/.woff) are intentionally excluded — fontFamily is a CSS name/path. */
function looksLikeAssetPath(s: string): boolean {
  if (!s.startsWith('/')) return false;
  return /\.(particle|mesh|mat|prefab|scene|shader|animset|spriteanim|timeline)\.json$|\.(glb|gltf|fbx|png|jpe?g|webp|hdr|exr)$/i.test(s);
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function urlFor(abs: string, roots: AssetRoot[]): string | null {
  for (const r of roots) {
    if (abs.startsWith(r.absDir + path.sep)) {
      return (r.urlPrefix + '/' + path.relative(r.absDir, abs).replace(/\\/g, '/')).normalize('NFC');
    }
  }
  return null;
}

/** Collect (path, type, abs) for every shippable asset under the real roots. */
function collectAssets() {
  const roots = findAssetRoots(PROJECT_ROOT);
  const assets: { url: string; type: string; abs: string }[] = [];
  for (const r of roots) {
    for (const abs of walk(r.absDir)) {
      const url = urlFor(abs, roots);
      if (!url) continue;
      const ext = path.extname(url).toLowerCase();
      const type = detectType(url, ext);
      if (!type) continue;
      assets.push({ url, type, abs });
    }
  }
  return { roots, assets };
}

/** Every distinct GUID owned by a shipped asset (in-file id for JSON, sidecar id for binaries). */
function knownGuids(assets: { type: string; abs: string }[]): Set<string> {
  const set = new Set<string>();
  for (const a of assets) {
    const g = readAssetGuid(a.abs, a.type);
    if (g) set.add(g.toLowerCase());
  }
  return set;
}

/** All string values found anywhere in a JSON tree. */
function stringValues(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringValues(v, out);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) stringValues(v, out);
  return out;
}

const { assets } = collectAssets();
const particles = assets.filter((a) => a.type === 'particle');
const scenes = assets.filter((a) => a.type === 'scene');
// Every JSON asset type that can embed a ref to another asset.
const REF_BEARING_TYPES = new Set(['scene', 'prefab', 'mesh', 'material', 'particle', 'animset', 'spriteanim']);
const refBearing = assets.filter((a) => REF_BEARING_TYPES.has(a.type));

describe('asset GUID reference integrity (real assets)', () => {
  it.skipIf(!hasGames)('finds the shipped assets (sanity: the suite is actually scanning)', () => {
    expect(particles.length).toBeGreaterThan(0);
    expect(refBearing.length).toBeGreaterThan(0);
  });

  it('every .particle.json has a valid in-file GUID id', () => {
    const missing = particles.filter((p) => {
      const json = JSON.parse(fs.readFileSync(p.abs, 'utf-8'));
      return !isGuid(json.id);
    });
    expect(missing.map((m) => m.url)).toEqual([]);
  });

  it('no scene/prefab/mesh/material/particle file references an asset by literal path (all refs are GUIDs)', () => {
    const offenders: string[] = [];
    for (const a of refBearing) {
      const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8'));
      for (const s of stringValues(json)) {
        if (looksLikeAssetPath(s)) offenders.push(`${a.url} (${a.type}) → ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every GUID-shaped ref in ref-bearing files resolves to a known asset', () => {
    const guids = knownGuids(assets);
    // Trait/field names that hold an asset reference (not random GUID-shaped data
    // like entity/scene ids, which live under other keys).
    // NOTE: UIElement.imageSrc is NOT here — like Renderable2D.sprite it points at a
    // SPRITE sub-asset (a texture slice, or a 2D/UI texture's derived whole-image
    // sprite), which lives in a texture's .meta.json / is derived, not a top-level
    // manifest entry. `knownGuids` only knows top-level asset ids, so it can't resolve
    // those. The dedicated "sprites-only 2D references" block below validates imageSrc
    // against the full sprite GUID set (slices + derived whole-image).
    const refKeys = new Set(['effect', 'texture', 'material', 'mesh', 'model', 'source', 'glbPath', 'hdrPath', 'animSet', 'animSets',
      // SpriteAnimator.clipSet → a .spriteanim asset (a real top-level manifest entry).
      // NOTE: clip `frames` are sprite-SLICE sub-asset GUIDs (live in a texture's
      // .meta.json, not the manifest) — like Renderable2D.sprite they're excluded from
      // this dangling-resolution scan; the per-file block below asserts they're GUIDs.
      'clipSet',
      // .mat.json PBR map refs — every MeshStandardMaterial texture slot.
      'normalTexture', 'roughnessTexture', 'metalnessTexture', 'emissiveTexture', 'aoTexture', 'alphaTexture', 'bumpTexture', 'displacementTexture', 'lightTexture', 'envTexture']);
    const dangling: string[] = [];

    const check = (url: string, node: unknown, key?: string): void => {
      if (typeof node === 'string') {
        if (key && refKeys.has(key) && isGuid(node) && !guids.has(node.toLowerCase())) {
          dangling.push(`${url} → ${key}: ${node}`);
        }
      } else if (Array.isArray(node)) {
        for (const v of node) check(url, v, key);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) check(url, v, k);
      }
    };

    for (const a of refBearing) {
      check(a.url, JSON.parse(fs.readFileSync(a.abs, 'utf-8')));
    }
    expect(dangling).toEqual([]);
  });

  it('particle resource entries in scenes carry a resolvable GUID path', () => {
    const guids = knownGuids(assets);
    const dangling: string[] = [];
    for (const s of scenes) {
      const json = JSON.parse(fs.readFileSync(s.abs, 'utf-8')) as { resources?: { type: string; path: string }[] };
      for (const r of json.resources ?? []) {
        if (r.type !== 'particle') continue;
        if (!isGuid(r.path)) dangling.push(`${s.url} → particle resource not a GUID: ${r.path}`);
        else if (!guids.has(r.path.toLowerCase())) dangling.push(`${s.url} → particle resource GUID unresolved: ${r.path}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

// ── spriteanim assets (flipbook clip sets) ─────────────────────────────────
const spriteanims = assets.filter((a) => a.type === 'spriteanim');

describe('spriteanim assets (real assets)', () => {
  it('every .spriteanim.json has a valid in-file GUID id, a clips object, and GUID (not path) frames', () => {
    const bad: string[] = [];
    for (const a of spriteanims) {
      const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8'));
      if (!isGuid(json.id)) bad.push(`${a.url}: missing/invalid id`);
      if (!json.clips || typeof json.clips !== 'object' || Array.isArray(json.clips)) { bad.push(`${a.url}: clips is not an object`); continue; }
      for (const [name, clip] of Object.entries(json.clips as Record<string, { frames?: unknown }>)) {
        if (!Array.isArray(clip?.frames)) { bad.push(`${a.url}:${name} frames not an array`); continue; }
        for (const f of clip.frames) {
          if (typeof f !== 'string') bad.push(`${a.url}:${name} frame not a string`);
          else if (!isGuid(f)) bad.push(`${a.url}:${name} frame is not a GUID: ${f}`); // never a literal path
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── Sprites-only 2D references ─────────────────────────────────────────────
// Every 2D sprite field (Renderable2D.sprite, UIElement.imageSrc) and rig2d
// parts[].sprite must reference a SPRITE, never a raw TEXTURE — a texture is not
// atlas-able and carries no rect/pivot. Textures auto-emit a whole-image sprite
// (deriveGuid('sprite:'+texGuid)); slices live in the texture's meta `sprites[]`.
const textureAssets = assets.filter((a) => a.type === 'texture');

/** GUID sets: every raw-texture GUID, and every valid sprite GUID (explicit
 *  slices + the auto whole-image sprite of each 2D/UI texture). */
function textureAndSpriteGuids() {
  const textures = new Set<string>();
  const sprites = new Set<string>();
  for (const t of textureAssets) {
    const g = readAssetGuid(t.abs, 'texture');
    if (!g) continue;
    const guid = g.toLowerCase();
    textures.add(guid);
    const metaPath = t.abs + '.meta.json';
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Parameters<typeof resolveTextureType>[0] & { sprites?: { guid?: string }[] };
    for (const s of meta?.sprites ?? []) if (isGuid(s.guid)) sprites.add(s.guid!.toLowerCase());
    // A 2D/UI texture with no explicit slices exposes a derived whole-image sprite.
    const ttype = resolveTextureType(meta);
    if (ttype === '2d' || ttype === 'ui') sprites.add(deriveGuid('sprite:' + guid).toLowerCase());
  }
  return { textures, sprites };
}

/** Collect 2D sprite-field GUID refs from a scene/prefab entity tree + rig2d. */
function collect2DRefs(url: string, json: unknown, out: { url: string; at: string; ref: string }[], at = ''): void {
  if (Array.isArray(json)) { json.forEach((v, i) => collect2DRefs(url, v, out, `${at}[${i}]`)); return; }
  if (!json || typeof json !== 'object') return;
  const node = json as Record<string, unknown>;
  for (const [trait, field] of [['Renderable2D', 'sprite'], ['UIElement', 'imageSrc']] as const) {
    const t = node[trait];
    if (t && typeof t === 'object') {
      const v = (t as Record<string, unknown>)[field];
      if (typeof v === 'string' && v) out.push({ url, at: `${at}.${trait}.${field}`, ref: v });
    }
  }
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') collect2DRefs(url, v, out, `${at}.${k}`);
}

describe('sprites-only 2D references (real assets)', () => {
  const { textures, sprites } = textureAndSpriteGuids();
  const rig2ds = assets.filter((a) => a.type === 'rig2d');
  const sceneLike = assets.filter((a) => a.type === 'scene' || a.type === 'prefab');

  it('no 2D sprite field references a raw texture GUID (must be a sprite)', () => {
    const offenders: string[] = [];
    const refs: { url: string; at: string; ref: string }[] = [];
    for (const a of sceneLike) collect2DRefs(a.url, JSON.parse(fs.readFileSync(a.abs, 'utf-8')), refs);
    for (const a of rig2ds) {
      const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8')) as { parts?: { sprite?: unknown }[] };
      (json.parts ?? []).forEach((p, i) => {
        if (typeof p?.sprite === 'string' && p.sprite) refs.push({ url: a.url, at: `parts[${i}].sprite`, ref: p.sprite });
      });
    }
    for (const r of refs) {
      if (!isGuid(r.ref)) continue; // primitive keyword / URL / empty
      if (textures.has(r.ref.toLowerCase())) offenders.push(`${r.url} ${r.at} → raw texture ${r.ref}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every 2D sprite-field GUID resolves to a known sprite (explicit slice or derived whole-image)', () => {
    const dangling: string[] = [];
    const refs: { url: string; at: string; ref: string }[] = [];
    for (const a of sceneLike) collect2DRefs(a.url, JSON.parse(fs.readFileSync(a.abs, 'utf-8')), refs);
    for (const a of rig2ds) {
      const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8')) as { parts?: { sprite?: unknown }[] };
      (json.parts ?? []).forEach((p, i) => {
        if (typeof p?.sprite === 'string' && p.sprite) refs.push({ url: a.url, at: `parts[${i}].sprite`, ref: p.sprite });
      });
    }
    for (const r of refs) {
      if (!isGuid(r.ref)) continue;
      if (!sprites.has(r.ref.toLowerCase())) dangling.push(`${r.url} ${r.at} → unknown sprite ${r.ref}`);
    }
    expect(dangling).toEqual([]);
  });
});

// ── P5: skeletal animset assets ────────────────────────────────────────────
const animsets = assets.filter((a) => a.type === 'animset');

describe.skipIf(!hasGames)('skeletal animset assets (real assets)', () => {
  it('every .animset.json has a valid in-file GUID id and a clips array', () => {
    const bad: string[] = [];
    for (const a of animsets) {
      const json = JSON.parse(fs.readFileSync(a.abs, 'utf-8'));
      if (!isGuid(json.id)) bad.push(`${a.url}: missing/invalid id`);
      if (!Array.isArray(json.clips)) bad.push(`${a.url}: clips is not an array`);
      else for (const c of json.clips) {
        if (typeof c?.name !== 'string' || !c.name) bad.push(`${a.url}: a clip is missing a name`);
        if (c.speed !== undefined && typeof c.speed !== 'number') bad.push(`${a.url}:${c.name} speed not a number`);
        if (c.loop !== undefined && typeof c.loop !== 'boolean') bad.push(`${a.url}:${c.name} loop not a boolean`);
        if (c.fadeDuration !== undefined && typeof c.fadeDuration !== 'number') bad.push(`${a.url}:${c.name} fadeDuration not a number`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the alien-animal animset resolves to its authored per-clip params', async () => {
    const aa = animsets.find((a) => a.url.endsWith('alien-animal.animset.json'));
    expect(aa, 'alien-animal animset present').toBeTruthy();
    const def = JSON.parse(fs.readFileSync(aa!.abs, 'utf-8'));
    const { resolveAnimSetParams, setAnimSet, clearAnimSetCache, ANIMSET_DEFAULTS } =
      await import('../../packages/modoki/src/runtime/loaders/animSetCache');
    clearAnimSetCache();
    setAnimSet('aa', def);
    // Authored values come through…
    expect(resolveAnimSetParams('aa', 'Run-Cycle')).toEqual({ speed: 1.2, loop: true, fadeDuration: 0.2 });
    expect(resolveAnimSetParams('aa', 'Attack_Bite')).toEqual({ speed: 1, loop: false, fadeDuration: 0.1 });
    expect(resolveAnimSetParams('aa', 'Idel_Normal')).toEqual({ speed: 1, loop: true, fadeDuration: 0.3 });
    // …and an unlisted clip falls back to engine defaults.
    expect(resolveAnimSetParams('aa', 'NotAClip')).toEqual(ANIMSET_DEFAULTS);
    clearAnimSetCache();
  });
});
