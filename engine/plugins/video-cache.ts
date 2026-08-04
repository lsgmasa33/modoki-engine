/** Content-addressed cache for converted video clips.
 *
 *  Mirrors audio-cache.ts: derived files are NOT committed — they live under the
 *  project's own `.cache/modoki-video/` (per-game, at the project root) and are
 *  regenerated on demand (editor Apply / reimport) and at build time. The cache key
 *  is a hash of the source bytes + conversion settings + encoder version, so an
 *  unchanged clip with unchanged settings is never re-encoded. Cache layout mirrors
 *  the asset URL path:
 *    <cacheDir>/<urlPath>/<hash>/video.mp4
 *
 *  NOTE: `delivery` and `policy` are deliberately EXCLUDED from the hash — they fork
 *  how the file REACHES the player (bundled vs fetched, streamed vs downloaded) but
 *  do not change the converted bytes, so toggling either must not invalidate the
 *  cache. Same reasoning as audio's `loadType`. */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  VIDEO_EXTENSION,
  type VideoImportSettings,
} from '../packages/modoki/src/runtime/loaders/videoSettings';

/** Bump when ffmpeg flags / the converter pipeline change so stale cache entries are
 *  invalidated automatically. */
export const VIDEO_ENCODER_VERSION = 'vid-1';

export function getVideoCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-video');
}

/** The conversion-affecting subset of the settings (delivery/policy excluded — see
 *  file header). `audioBitrate` is only meaningful when the audio track is kept, so
 *  it is excluded for `strip` — otherwise a bitrate left over from toggling audio
 *  off would needlessly re-hash a clip whose bytes are identical. */
function stableSettings(s: VideoImportSettings): string {
  const base = [
    s.quality, s.preset, s.maxWidth, s.maxHeight, s.maxFps, s.keyframeIntervalSec, s.audio,
  ].join('|');
  return s.audio === 'keep' ? `${base}|ab${s.audioBitrate}` : base;
}

/** Stable 16-hex content key for (source bytes, settings, encoder version). */
export function videoHashKey(srcBytes: Buffer, settings: VideoImportSettings): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(VIDEO_ENCODER_VERSION)
    .digest('hex').slice(0, 16);
}

/** Absolute path of the cached converted file. */
export function videoCachePathFor(
  cacheDir: string, sourceUrlPath: string, hash: string,
): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash, `video.${VIDEO_EXTENSION}`);
}

/** True when the converted file already exists for this hash. */
export function videoCacheHit(
  cacheDir: string, sourceUrlPath: string, hash: string,
): boolean {
  return fs.existsSync(videoCachePathFor(cacheDir, sourceUrlPath, hash));
}
