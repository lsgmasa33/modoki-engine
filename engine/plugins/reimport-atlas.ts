/** Atlas reimport handler — packs an `.atlas.json`'s member sprites into one or a few
 *  generated pages and persists the derived bookkeeping to the sidecar.
 *
 *  Pipeline: read the authored `.atlas.json` (members + pack options) → resolve each
 *  member sprite GUID to its parent texture + slice rect (via the project asset index in
 *  `ctx.listAssets`) → `packAtlas` decides the layout → `sharp` composites each member
 *  onto its page with `extrude` px of edge-replication bleed → each page PNG is encoded
 *  through `convertTexture` into the shared texture cache at the synthetic page url path
 *  → the frame map + per-page hashes/variants are written to `<name>.atlas.json.meta.json`.
 *
 *  Registered for the `atlas` asset type. Skips re-encoding when the atlas content hash
 *  is unchanged and every page variant is already cached. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { packAtlas, type PackInput, type AtlasSource, type AtlasCacheBlock } from '../packages/modoki/src/runtime/loaders/spriteAtlas';
import {
  resolveTextureSettings, TEXTURE_MAX_SIZES,
  type TextureImportSettings, type TextureMaxSize,
} from '../packages/modoki/src/runtime/loaders/textureSettings';
import { convertTexture } from './texture-convert';
import { isPlayableBuild } from './playable-profile';
import { getCacheDir, cacheHit } from './texture-cache';
import { atlasHashKey, atlasPageUrlPath, type AtlasHashMember } from './atlas-cache';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler, ReimportAsset } from './reimport-registry';
import { nativeDynamicImport } from './native-dynamic-import';

export { readMetaSidecar } from './meta-sidecar';

/** Default page-encoding settings for an atlas: WebP (the 2D variant the PixiJS path
 *  decodes), no mipmaps (sprite frames drawn ~1:1; mips would cross-bleed between
 *  frames beyond the extrude gutter), clamp wrap. `maxSize` is forced ≥ pageSize so the
 *  converter never downscales the page (which would shift every frame rect). */
function pageSettings(src: AtlasSource): TextureImportSettings {
  const base = src.texture
    ? resolveTextureSettings({ texture: src.texture as unknown as Record<string, unknown> })
    : { format: 'webp', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' } as TextureImportSettings;
  const minMax = (TEXTURE_MAX_SIZES.find((s) => s >= src.pageSize) ?? 4096) as TextureMaxSize;
  const sized = { ...base, maxSize: Math.max(base.maxSize, minMax) as TextureMaxSize };
  // Playable: force WebP pages (browser-decoded) so an atlas authored with a `ktx2-*` texture
  // format doesn't ship KTX2 pages that need the pixi-ktx transcoder — which the playable profile
  // skips, 404ing offline. Only the FORMAT is overridden; keep the pageSize-derived maxSize (the
  // 512 cap in playableTextureSettings would downscale the page and shift every frame rect).
  return isPlayableBuild() ? { ...sized, format: 'webp' } : sized;
}

interface ResolvedMember {
  guid: string;
  textureAbs: string;
  rect: { x: number; y: number; w: number; h: number };
  pivot: { x: number; y: number };
}

/** Read + normalize the authored `.atlas.json`. */
function readAtlasSource(absPath: string): AtlasSource {
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as Partial<AtlasSource>;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    version: 1,
    members: Array.isArray(raw.members) ? raw.members.filter((m): m is string => typeof m === 'string') : [],
    pageSize: typeof raw.pageSize === 'number' && raw.pageSize > 0 ? raw.pageSize : 1024,
    padding: typeof raw.padding === 'number' && raw.padding >= 0 ? raw.padding : 2,
    extrude: typeof raw.extrude === 'number' && raw.extrude >= 0 ? raw.extrude : 1,
    ...(typeof raw.maxPages === 'number' ? { maxPages: raw.maxPages } : {}),
    ...(raw.texture ? { texture: raw.texture } : {}),
  };
}

/** Resolve each member sprite GUID → its parent texture's abs path + slice rect/pivot,
 *  using the project asset index. Members that don't resolve are skipped with a warning. */
function resolveMembers(src: AtlasSource, assets: ReimportAsset[]): ResolvedMember[] {
  const spriteByGuid = new Map<string, ReimportAsset>();
  const texAbsByGuid = new Map<string, string>();
  for (const a of assets) {
    if (a.type === 'sprite' && a.guid) spriteByGuid.set(a.guid, a);
    else if (a.type === 'texture' && a.guid && a.absPath) texAbsByGuid.set(a.guid, a.absPath);
  }
  const out: ResolvedMember[] = [];
  for (const guid of src.members) {
    const sprite = spriteByGuid.get(guid);
    if (!sprite?.sprite) { console.warn(`[atlas] member sprite not found: ${guid}`); continue; }
    const textureAbs = texAbsByGuid.get(sprite.sprite.texture);
    if (!textureAbs) { console.warn(`[atlas] member ${guid}: parent texture ${sprite.sprite.texture} not found`); continue; }
    out.push({ guid, textureAbs, rect: sprite.sprite.rect, pivot: sprite.sprite.pivot });
  }
  return out;
}

export const atlasReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const src = readAtlasSource(absPath);
  const assets = ctx.listAssets?.() ?? [];
  const members = resolveMembers(src, assets);
  const settings = pageSettings(src);
  const cacheDir = getCacheDir(ctx.projectRoot);

  // Cache gate: hash the members' bytes + rects + pack options; skip the whole pack when
  // unchanged AND every page variant is still on disk. Member texture bytes are read once
  // per distinct file (also reused for compositing below).
  const texBytes = new Map<string, Buffer>();
  const bytesFor = (abs: string): Buffer => {
    let b = texBytes.get(abs);
    if (!b) { b = fs.readFileSync(abs); texBytes.set(abs, b); }
    return b;
  };
  const hashMembers: AtlasHashMember[] = members.map((m) => ({ guid: m.guid, textureBytes: bytesFor(m.textureAbs), rect: m.rect, pivot: m.pivot }));
  const atlasHash = atlasHashKey(hashMembers, src);

  const prevMeta = readMetaSidecar(absPath);
  const prev = prevMeta.atlasCache as AtlasCacheBlock | undefined;
  const allPagesCached = (block: AtlasCacheBlock | undefined): boolean =>
    // Atlas pages are 2d (browser-previewable in the editor), so they emit a WebP sibling
    // for a ktx2 page — check the same '2d' variant set the emitter below produces.
    !!block && block.pages.every((_, i) => cacheHit(cacheDir, atlasPageUrlPath(sourceUrlPath, i), block.pages[i].hash, settings.format, '2d'));
  if (prev && prev.hash === atlasHash && allPagesCached(prev)) return; // up to date

  const result = packAtlas(
    members.map((m): PackInput => ({ guid: m.guid, w: m.rect.w, h: m.rect.h })),
    { pageSize: src.pageSize, padding: src.padding, extrude: src.extrude, ...(src.maxPages != null ? { maxPages: src.maxPages } : {}) },
  );
  if (result.overflow.length) {
    console.warn(`[atlas] ${sourceUrlPath}: ${result.overflow.length} member(s) didn't fit (page too small / maxPages) — omitted from the atlas.`);
  }

  const sharp = ((await nativeDynamicImport('sharp')) as typeof import('sharp')).default;
  // Group placed frames by page, each with its resolved member (source texture + slice).
  const memberByGuid = new Map(members.map((m) => [m.guid, m]));
  const framesByPage = new Map<number, { spriteGuid: string; rect: ResolvedMember['rect']; member: ResolvedMember }[]>();
  for (const f of result.frames) {
    const member = memberByGuid.get(f.spriteGuid);
    if (!member) continue;
    (framesByPage.get(f.page) ?? framesByPage.set(f.page, []).get(f.page)!).push({ spriteGuid: f.spriteGuid, rect: f.rect, member });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-atlas-'));
  const pages: AtlasCacheBlock['pages'] = [];
  const frames: AtlasCacheBlock['frames'] = {};
  try {
    for (let p = 0; p < result.pages.length; p++) {
      const { w, h } = result.pages[p];
      const composites: import('sharp').OverlayOptions[] = [];
      for (const fr of framesByPage.get(p) ?? []) {
        const e = src.extrude;
        // Extract the slice, THEN (a second sharp pass — chaining extract+extend in one
        // pipeline mis-orders the ops) replicate its edges outward by `extrude` px so
        // bilinear / mip sampling at the frame border samples the sprite's own pixels,
        // not a neighbour's. The extended buffer's inner content lands exactly at the
        // frame rect when composited at (rect.x - extrude, rect.y - extrude).
        const sr = fr.member.rect; // SOURCE rect (where to read from the texture)
        const slice = await sharp(fr.member.textureAbs)
          .extract({ left: sr.x, top: sr.y, width: sr.w, height: sr.h })
          .png()
          .toBuffer();
        const buf = e > 0
          ? await sharp(slice).extend({ top: e, bottom: e, left: e, right: e, extendWith: 'copy' }).png().toBuffer()
          : slice;
        composites.push({ input: buf, left: fr.rect.x - e, top: fr.rect.y - e });
        frames[fr.spriteGuid] = { page: p, rect: fr.rect, pivot: fr.member.pivot };
      }
      const pagePng = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(composites)
        .png()
        .toBuffer();
      const tmpPng = path.join(tmpDir, `page${p}.png`);
      fs.writeFileSync(tmpPng, pagePng);
      // Atlas pages are 2d — emit a WebP browser sibling alongside a ktx2 page so the
      // editor Canvas2D preview can draw an atlas-packed rig (the game uses the ktx2 page).
      const conv = await convertTexture({ projectRoot: ctx.projectRoot, sourceUrlPath: atlasPageUrlPath(sourceUrlPath, p), absSource: tmpPng, settings, textureType: '2d' });
      pages.push({ hash: conv.hash, variants: conv.variants, w, h });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const block: AtlasCacheBlock = { hash: atlasHash, pages, texture: settings, frames };
  const meta = { ...prevMeta };
  if (typeof meta.id !== 'string' && src.id) meta.id = src.id;
  meta.version = 2;
  meta.atlasCache = block;
  writeMetaSidecar(absPath, meta);
};
