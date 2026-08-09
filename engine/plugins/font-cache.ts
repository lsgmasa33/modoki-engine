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
import type { FontImportSettings } from '../packages/modoki/src/runtime/core/fontSettings';
import { expandCharset } from '../packages/modoki/src/runtime/core/fontSettings';

/** Bump when msdf-atlas-gen flags / the converter pipeline change so stale cache
 *  entries are invalidated automatically. */
export const FONT_ENCODER_VERSION = 'font-5'; // font-5: variable-font axis instancing (hb-subset)

export function getFontCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-fonts');
}

/** Axis map → a stable string. Key order must not affect the hash, so tags are sorted;
 *  `{}` and absent hash identically (both mean "the font's default instance"). */
function stableAxes(axes: FontImportSettings['variationAxes']): string {
  const entries = Object.entries(axes ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([tag, v]) => `${tag}=${v}`).join(',');
}

/** The settings that actually affect the baked atlas bytes (mode excluded — see
 *  the module note). Charset is expanded so a preset and an equivalent custom set
 *  hash the same.
 *
 *  This is an ALLOWLIST, not a spread of the settings object: a new field that changes
 *  the output must be added here or an edit to it will silently serve the stale cached
 *  atlas. `variationAxes` changes the glyph OUTLINES, so it is very much one of those. */
function stableSettings(s: FontImportSettings): string {
  return [s.fieldType, s.size, s.pxRange, s.atlasMax, expandCharset(s), stableAxes(s.variationAxes)].join('|');
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

/** The instanced (axis-pinned) source font, produced only when `variationAxes` is set.
 *  Served/copied at the `~instance.ttf` variant URL for the DYNAMIC runtime generator,
 *  which rasterizes source bytes and so cannot apply axes itself. */
export function instanceCachePath(cacheDir: string, sourceUrlPath: string, hash: string): string {
  return path.join(cacheBase(cacheDir, sourceUrlPath, hash), 'instance.ttf');
}

/** True when every derived file for this hash already exists. The instanced font counts
 *  only when axes are authored — otherwise nothing produces it and requiring it would
 *  make every plain font a permanent cache miss. */
export function fontCacheHit(
  cacheDir: string,
  sourceUrlPath: string,
  hash: string,
  settings?: FontImportSettings,
): boolean {
  const needsInstance = Object.keys(settings?.variationAxes ?? {}).length > 0;
  return (
    fs.existsSync(atlasCachePath(cacheDir, sourceUrlPath, hash)) &&
    fs.existsSync(metricsCachePath(cacheDir, sourceUrlPath, hash)) &&
    (!needsInstance || fs.existsSync(instanceCachePath(cacheDir, sourceUrlPath, hash)))
  );
}
