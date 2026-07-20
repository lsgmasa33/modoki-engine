/** Content-addressed cache for converted audio clips.
 *
 *  Mirrors texture-cache.ts: derived files are NOT committed — they live under
 *  the project's own `.cache/modoki-audio/` (per-game, at the project root) and
 *  are regenerated on demand (editor Apply / reimport) and at build time. The
 *  cache key is a hash of the source bytes + conversion settings + encoder
 *  version, so an unchanged clip with unchanged settings is never re-encoded.
 *  Cache layout mirrors the asset URL path:
 *    <cacheDir>/<urlPath>/<hash>/audio.<ext>
 *
 *  NOTE: `loadType` is deliberately EXCLUDED from the hash — it forks the runtime
 *  path (buffer vs stream) but does not change the converted bytes, so toggling it
 *  must not invalidate the cache. */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  audioFormatExtension,
  type AudioImportSettings,
} from '../packages/modoki/src/runtime/loaders/audioSettings';

/** Bump when ffmpeg flags / the converter pipeline change so stale cache
 *  entries are invalidated automatically. */
export const AUDIO_ENCODER_VERSION = 'aud-2'; // aud-2: bitexact + strip metadata (deterministic opus/Ogg)

export function getAudioCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.cache', 'modoki-audio');
}

/** The conversion-affecting subset of the settings (loadType excluded — see file
 *  header). Lossy bitrate is only meaningful for lossy formats but is always
 *  hashed; a wav/flac clip simply ignores it. */
function stableSettings(s: AudioImportSettings): string {
  const base = [s.format, s.quality, s.forceMono, s.normalize, s.trimSilence].join('|');
  // Sample rate / wav bit depth, ONLY when explicitly set — so a clip without them
  // hashes exactly as before and doesn't force a mass re-convert when these landed.
  // bitDepth is wav-only (the encoder ignores it otherwise), so exclude it from the
  // key for non-wav formats — else a bit depth left over from a format switch would
  // needlessly re-hash an mp3/aac clip whose bytes are identical.
  const sr = s.sampleRate ? `sr${s.sampleRate}` : '';
  const bd = s.format === 'wav' && s.bitDepth !== undefined ? `bd${s.bitDepth}` : '';
  const extras = `${sr}${bd}`;
  return extras ? `${base}|${extras}` : base;
}

/** Stable 16-hex content key for (source bytes, settings, encoder version). */
export function audioHashKey(srcBytes: Buffer, settings: AudioImportSettings): string {
  return createHash('sha256')
    .update(srcBytes).update('\0')
    .update(stableSettings(settings)).update('\0')
    .update(AUDIO_ENCODER_VERSION)
    .digest('hex').slice(0, 16);
}

/** Absolute path of the cached converted file. */
export function audioCachePathFor(
  cacheDir: string, sourceUrlPath: string, hash: string, ext: string,
): string {
  const rel = sourceUrlPath.replace(/^\/+/, '');
  return path.join(cacheDir, rel, hash, `audio.${ext}`);
}

/** True when the converted file already exists for this hash + format. */
export function audioCacheHit(
  cacheDir: string, sourceUrlPath: string, hash: string, settings: AudioImportSettings,
): boolean {
  return fs.existsSync(audioCachePathFor(cacheDir, sourceUrlPath, hash, audioFormatExtension(settings.format)));
}
