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
  meta.audio = settings;
  // ⚠️ MERGE, never replace (#1300). `probeStats` swallows every ffprobe failure and returns `{}`,
  // and nothing gates ffprobe the way `ensureFfmpeg()` gates ffmpeg — `ffprobeBinary()` just
  // returns a name. A wholesale replacement therefore DELETED `channels`/`sampleRate` from every
  // sidecar on a machine whose ffprobe is missing or errors, and the machine that does have one put
  // them back on its next bake: the non-converging ping-pong between clones that #127 and #1289
  // exist to stop. Spreading the previous block first means an absent probe reading leaves the
  // committed value alone instead of erasing it.
  //
  // The conversion's OWN outputs still win unconditionally — they are authoritative for the file
  // ffmpeg just produced, so a stale hash/ext/bytes can never survive a reimport.
  //
  // Accepted cost, chosen deliberately over making a missing ffprobe fail loudly (owner,
  // 2026-09-16): a clip re-encoded to different channels on a run where the probe fails keeps the
  // old reading until a run that can measure it. That is a stale number; the alternative was a
  // deleted one, plus imports breaking on machines that work today. This also covers the case
  // loud-failure would not — ffprobe present but erroring on one particular file.
  const prevAudioCache = (meta.audioCache ?? {}) as Record<string, unknown>;
  meta.audioCache = {
    ...prevAudioCache,
    hash: result.hash,
    ext: result.ext,
    bytes: result.bytes,
    ...(result.durationSec != null ? { durationSec: result.durationSec } : {}),
    ...(result.channels != null ? { channels: result.channels } : {}),
    ...(result.sampleRate != null ? { sampleRate: result.sampleRate } : {}),
  };
  writeMetaSidecar(absPath, meta);
};
