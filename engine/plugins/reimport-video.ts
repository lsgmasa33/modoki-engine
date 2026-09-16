/** Video reimport handler — reads import settings from the meta sidecar, converts
 *  the source clip into its derived H.264/mp4 variant via ffmpeg, and persists the
 *  cache bookkeeping back to the meta. Registered for the `video` asset type.
 *  Mirrors reimport-audio.ts. */

import { randomUUID } from 'crypto';
import { resolveVideoSettings } from '../packages/modoki/src/runtime/loaders/videoSettings';
import { convertVideo } from './video-convert';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

export const videoReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const meta = readMetaSidecar(absPath);
  const settings = resolveVideoSettings(meta as { video?: Record<string, unknown> });
  const result = await convertVideo({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
  });
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.video = settings;
  // ⚠️ MERGE, never replace — the same mechanism as reimport-audio.ts, see the long note there
  // (#1300). Video's `probeStats` swallows ffprobe failures identically, and this block carries
  // MORE probe-only fields than audio's (`width`/`height`/`fps`/`hasAudio`), so a wholesale
  // replacement on a machine without ffprobe erased four values rather than two. `bytes` comes from
  // `statSync`, not the probe, so it survives either way — but it is the only one that did.
  const prevVideoCache = (meta.videoCache ?? {}) as Record<string, unknown>;
  meta.videoCache = {
    ...prevVideoCache,
    hash: result.hash,
    ext: result.ext,
    bytes: result.bytes,
    ...(result.durationSec != null ? { durationSec: result.durationSec } : {}),
    ...(result.width != null ? { width: result.width } : {}),
    ...(result.height != null ? { height: result.height } : {}),
    ...(result.fps != null ? { fps: result.fps } : {}),
    ...(result.hasAudio != null ? { hasAudio: result.hasAudio } : {}),
  };
  writeMetaSidecar(absPath, meta);
};
