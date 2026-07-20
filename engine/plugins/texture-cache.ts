/** Content-addressed cache for converted textures.
 *
 *  Derived files are NOT committed — they live under the project's own `.cache/`
 *  (per-game, at the project root) and are regenerated on demand (editor Apply /
 *  reimport) and at build time. Project-root rather than node_modules/.cache so
 *  a flat one-game project — which has no node_modules of its own (deps come
 *  from the editor) — still gets a writable, self-contained cache. The cache key
 *  is a hash of the source bytes + import settings + encoder version, so an
 *  unchanged texture is never re-encoded. Cache layout mirrors the asset URL path:
 *    <cacheDir>/<urlPath>/<hash>/<variant>.<ext>
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  variantExtension, variantsToEmit, resolveWebpQuality, resolveUastcLevel, resolveUastcRdoLambda,
  type TextureImportSettings, type TextureFormat, type TextureType, type TextureVariant,
} from '../packages/modoki/src/runtime/loaders/textureSettings';

/** Bump when encoder flags / the converter pipeline change so stale cache
 *  entries are invalidated automatically. */
export const ENCODER_VERSION = 'tex-2'; // tex-2: snap dimensions to multiple of 4

export function getCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-textures');
}

function stableSettings(s: TextureImportSettings): string {
  const base = [s.format, s.maxSize, s.mipmaps, s.wrapS, s.wrapT, s.colorspace].join('|');
  // Append flip flags ONLY when set, so existing textures (no flips) hash exactly
  // as before and don't force a mass re-conversion when this field was introduced.
  const flips = `${s.flipY ? 'fy' : ''}${s.flipGreen ? 'fg' : ''}`;
  // WebP quality, ONLY when explicitly set (same reason as the flips): a texture with
  // no `webpQuality` hashes as before. Without this the encoder input (webp quality)
  // wouldn't be in the content key, so a quality edit would hit the cache and never
  // re-encode. Emitted regardless of format — cheap, and format is already in `base`.
  const q = s.webpQuality !== undefined ? `q${resolveWebpQuality(s.webpQuality)}` : '';
  // UASTC level / RDO lambda, ONLY when explicitly set — same backward-compat contract
  // (an unset knob hashes as before, so existing UASTC textures don't mass re-convert).
  const u = s.uastcLevel !== undefined ? `u${resolveUastcLevel(s.uastcLevel)}` : '';
  const r = s.uastcRdoLambda !== undefined ? `r${resolveUastcRdoLambda(s.uastcRdoLambda)}` : '';
  const extras = `${flips}${q}${u}${r}`;
  return extras ? `${base}|${extras}` : base;
}

/** Stable 16-hex content key for (source bytes, settings, encoder version). */
export function hashKey(srcBytes: Buffer, settings: TextureImportSettings): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(ENCODER_VERSION)
    .digest('hex').slice(0, 16);
}

/** Absolute path of a cached variant file. */
export function cachePathFor(cacheDir: string, sourceUrlPath: string, hash: string, variant: TextureVariant): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash, `${variant}.${variantExtension(variant)}`);
}

/** True when every variant this texture emits (GPU + any WebP browser sibling for a
 *  2d/ui texture) already exists for this hash. Type-aware so a newly-added WebP sibling
 *  is treated as a cache miss until it's produced.
 *
 *  A variant must exist AND be NON-EMPTY: an interrupted encode (e.g. the external
 *  toktx process killed mid-write) can leave a 0-byte file at the final cache path.
 *  Counting that as a hit would (a) skip re-encoding forever on reimport and (b) ship
 *  an empty KTX2 that fails to load at runtime with a cryptic `{}` error. Treating a
 *  0-byte variant as a MISS self-heals the poisoned cache on the next import/build. */
export function cacheHit(cacheDir: string, sourceUrlPath: string, hash: string, format: TextureFormat, type: TextureType): boolean {
  return variantsToEmit(format, type).every(v => {
    const p = cachePathFor(cacheDir, sourceUrlPath, hash, v);
    try { return fs.statSync(p).size > 0; } catch { return false; }
  });
}
