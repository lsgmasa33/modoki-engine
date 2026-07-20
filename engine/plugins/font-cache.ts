/** Content-addressed cache for converted fonts (msdf-atlas-gen output).
 *
 *  Derived files (mtsdf atlas PNG + Chlumsky JSON metrics) are NOT committed —
 *  they live under the project's own `.cache/` (per-game, at the project root)
 *  and are regenerated on demand (editor Apply / reimport) and at build time.
 *  Project-root rather than node_modules/.cache so a flat one-game project — which
 *  has no node_modules of its own — still gets a writable, self-contained cache.
 *  The cache key is a hash of the source bytes + import settings + encoder
 *  version, so an unchanged font is never re-encoded. Cache layout mirrors the
 *  asset URL path:
 *    <cacheDir>/<urlPath>/<hash>/{atlas.png, metrics.json}
 *
 *  Note: `mode` (baked vs dynamic) is deliberately NOT part of the key — both
 *  modes bake the identical atlas; dynamic only adds runtime generation on top —
 *  so toggling mode never forces a re-bake.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { FontImportSettings } from '../packages/modoki/src/runtime/loaders/fontSettings';
import { expandCharset } from '../packages/modoki/src/runtime/loaders/fontSettings';

/** Bump when msdf-atlas-gen flags / the converter pipeline change so stale cache
 *  entries are invalidated automatically. */
export const FONT_ENCODER_VERSION = 'font-4'; // font-4: errorcorrection distance-full (kill corner clash nicks)

export function getFontCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-fonts');
}

/** The settings that actually affect the baked atlas bytes (mode excluded — see
 *  the module note). Charset is expanded so a preset and an equivalent custom set
 *  hash the same. */
function stableSettings(s: FontImportSettings): string {
  return [s.fieldType, s.size, s.pxRange, s.atlasMax, expandCharset(s)].join('|');
}

/** Stable 16-hex content key for (source bytes, settings, encoder version). */
export function hashKey(srcBytes: Buffer, settings: FontImportSettings): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(FONT_ENCODER_VERSION)
    .digest('hex').slice(0, 16);
}

function cacheBase(cacheDir: string, sourceUrlPath: string, hash: string): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash);
}

export function atlasCachePath(cacheDir: string, sourceUrlPath: string, hash: string): string {
  return path.join(cacheBase(cacheDir, sourceUrlPath, hash), 'atlas.png');
}

export function metricsCachePath(cacheDir: string, sourceUrlPath: string, hash: string): string {
  return path.join(cacheBase(cacheDir, sourceUrlPath, hash), 'metrics.json');
}

/** True when both derived files already exist for this hash. */
export function fontCacheHit(cacheDir: string, sourceUrlPath: string, hash: string): boolean {
  return (
    fs.existsSync(atlasCachePath(cacheDir, sourceUrlPath, hash)) &&
    fs.existsSync(metricsCachePath(cacheDir, sourceUrlPath, hash))
  );
}
