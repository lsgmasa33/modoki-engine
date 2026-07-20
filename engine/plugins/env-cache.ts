/** Content-addressed cache for converted (downscaled) environment HDRs. Mirrors
 *  texture-cache.ts: the derived `~env.hdr` variant lives under the project's
 *  gitignored `.cache/modoki-env/<urlPath>/<hash>/env.hdr`, keyed on source bytes +
 *  settings + encoder version, so an unchanged HDR is never re-encoded. */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { EnvImportSettings } from '../packages/modoki/src/runtime/loaders/environmentSettings';

/** Bump when the encoder / downscale recipe changes so stale entries regenerate. */
export const ENV_ENCODER_VERSION = 'env-1';

export function getEnvCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-env');
}

function stableSettings(s: EnvImportSettings): string {
  return [s.format, s.maxSize].join('|');
}

/** Stable 16-hex content key for (source bytes, settings, encoder version). */
export function envHashKey(srcBytes: Buffer, settings: EnvImportSettings): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(ENV_ENCODER_VERSION)
    .digest('hex').slice(0, 16);
}

/** Absolute path of the cached `~env.hdr` variant for a source + hash. */
export function envCachePathFor(cacheDir: string, sourceUrlPath: string, hash: string): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash, 'env.hdr');
}

export function envCacheHit(cacheDir: string, sourceUrlPath: string, hash: string): boolean {
  return fs.existsSync(envCachePathFor(cacheDir, sourceUrlPath, hash));
}
