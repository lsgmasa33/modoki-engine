/** Audio reimport handler — reads import settings from the meta sidecar,
 *  converts the source clip into its derived variant via ffmpeg, and persists the
 *  cache bookkeeping back to the meta. Registered for the `audio` asset type. */

import { randomUUID } from 'crypto';
import { resolveAudioSettings } from '../packages/modoki/src/runtime/loaders/audioSettings';
import { convertAudio } from './audio-convert';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import type { ReimportHandler } from './reimport-registry';

export const audioReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  const meta = readMetaSidecar(absPath);
  const settings = resolveAudioSettings(meta as { audio?: Record<string, unknown> });
  const result = await convertAudio({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
  });
  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.version = 2;
  meta.audio = settings;
  meta.audioCache = {
    hash: result.hash,
    ext: result.ext,
    bytes: result.bytes,
    ...(result.durationSec != null ? { durationSec: result.durationSec } : {}),
    ...(result.channels != null ? { channels: result.channels } : {}),
    ...(result.sampleRate != null ? { sampleRate: result.sampleRate } : {}),
  };
  writeMetaSidecar(absPath, meta);
};
