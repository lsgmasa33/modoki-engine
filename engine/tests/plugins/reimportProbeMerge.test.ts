/** The reimport handlers MERGE their cache block instead of replacing it (#1300).
 *
 *  ## The defect
 *
 *  `probeStats` (both `audio-convert.ts` and `video-convert.ts`) wraps its whole ffprobe call in
 *  `try { … } catch { return {}; }`, and nothing gates ffprobe the way `ensureFfmpeg()` gates
 *  ffmpeg — `ffprobeBinary()` just returns a name. The handlers then wrote
 *  `meta.audioCache = { … }` wholesale with conditional spreads that omit absent keys, so on a
 *  machine whose ffprobe is missing or erroring a reimport DELETED `channels`/`sampleRate` from the
 *  committed sidecar (and `width`/`height`/`fps`/`hasAudio` for video). The machine that does have
 *  ffprobe restored them on its next bake: the non-converging ping-pong between clones that #127
 *  and #1289 exist to stop.
 *
 *  ## Why these drive the REAL writeMetaSidecar
 *
 *  The merge has to hold through the actual committed/local split, not just in the handler's local
 *  object — a peeled key that the split drops on the way to disk would look merged here and be gone
 *  on the file. Only `convertAudio`/`convertVideo` are mocked, standing in for "ffmpeg ran, ffprobe
 *  did not".
 *
 *  ⚠️ ffmpeg-present/ffprobe-absent is CONSTRUCTIBLE but was never observed on a real machine (the
 *  two are separate auto-installs, `engine/toolchain/index.ts`) — #1300 records that honestly, and
 *  so does this file. What is observed is the consequence: driving the real writer with the block a
 *  no-ffprobe reimport produces is what these tests do. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

/** "ffmpeg converted the file; ffprobe told us nothing." `bytes` still arrives — it comes from
 *  `statSync(outPath).size`, not from the probe, which is why it was the ONLY stat to survive a
 *  missing ffprobe before this fix. */
const audioResult = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const videoResult = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../plugins/audio-convert', () => ({
  convertAudio: vi.fn(async () => audioResult.value),
  buildFfmpegArgs: vi.fn(),
}));
vi.mock('../../plugins/video-convert', () => ({
  convertVideo: vi.fn(async () => videoResult.value),
}));

import { audioReimportHandler } from '../../plugins/reimport-audio';
import { videoReimportHandler } from '../../plugins/reimport-video';
import { readMetaSidecar } from '../../plugins/meta-sidecar';

let tmpRoot: string;
let absPath: string;
const ctx = { projectRoot: '/proj' } as never;

beforeEach(() => {
  tmpRoot = makeScratchDir('modoki-reimport-');
  audioResult.value = {};
  videoResult.value = {};
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('audio reimport merges rather than replaces (#1300)', () => {
  beforeEach(() => { absPath = path.join(tmpRoot, 'clip.wav'); });

  it('a probe that returns NOTHING leaves committed channels/sampleRate intact', () => {
    // The exact failure: every one of the 29 migrated sidecars lost both fields on such a machine.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'guid-1', version: 2,
      audioCache: { hash: 'old', ext: 'mp3', channels: 1, sampleRate: 22050 },
    }));
    audioResult.value = { hash: 'new', ext: 'mp3', bytes: 2527 }; // no durationSec/channels/sampleRate

    return audioReimportHandler('/assets/clip.wav', absPath, ctx).then(() => {
      const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
      expect(committed.audioCache.channels, 'a failed probe must not DELETE a committed value').toBe(1);
      expect(committed.audioCache.sampleRate).toBe(22050);
      // The conversion's own outputs still win — a stale hash can never survive a reimport.
      expect(committed.audioCache.hash).toBe('new');
    });
  });

  it('a probe that DOES report wins over the committed value — merge is not "old value always"', () => {
    // The accept side, and the one that matters: a merge which merely preferred the existing value
    // would pass the test above and freeze every sidecar at its first reading forever.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'guid-1', version: 2,
      audioCache: { hash: 'old', ext: 'mp3', channels: 1, sampleRate: 22050 },
    }));
    audioResult.value = { hash: 'new', ext: 'mp3', bytes: 4000, channels: 2, sampleRate: 44100 };

    return audioReimportHandler('/assets/clip.wav', absPath, ctx).then(() => {
      const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
      expect(committed.audioCache.channels).toBe(2);
      expect(committed.audioCache.sampleRate).toBe(44100);
    });
  });

  it('a first import with no prior sidecar still works — merge must not require an existing block', () => {
    audioResult.value = { hash: 'h', ext: 'mp3', bytes: 100, channels: 1, sampleRate: 22050 };
    return audioReimportHandler('/assets/clip.wav', absPath, ctx).then(() => {
      const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
      expect(committed.audioCache).toEqual({ hash: 'h', ext: 'mp3', channels: 1, sampleRate: 22050 });
      expect(typeof committed.id).toBe('string');
    });
  });
});

describe('video reimport merges rather than replaces (#1300)', () => {
  beforeEach(() => { absPath = path.join(tmpRoot, 'clip.mp4'); });

  it('a probe that returns NOTHING leaves width/height/fps/hasAudio intact', () => {
    // Video carries MORE probe-only fields than audio, so a wholesale replacement erased four
    // values rather than two.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'guid-2', version: 2,
      videoCache: { hash: 'old', ext: 'mp4', bytes: 10, width: 640, height: 360, fps: 24, hasAudio: true },
    }));
    videoResult.value = { hash: 'new', ext: 'mp4', bytes: 1745855 };

    return videoReimportHandler('/assets/clip.mp4', absPath, ctx).then(() => {
      const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
      expect(committed.videoCache.width).toBe(640);
      expect(committed.videoCache.height).toBe(360);
      expect(committed.videoCache.fps).toBe(24);
      expect(committed.videoCache.hasAudio).toBe(true);
      expect(committed.videoCache.hash).toBe('new');
      // `bytes` is load-bearing for resolveDeliveryPolicy and stays COMMITTED, unlike durationSec.
      expect(committed.videoCache.bytes).toBe(1745855);
    });
  });

  it('a durationSec the probe DID report survives the round trip via the local sidecar', () => {
    // Peeled, not dropped: it must come back through readMetaSidecar for the Inspector's row.
    videoResult.value = { hash: 'h', ext: 'mp4', bytes: 10, durationSec: 24.009002 };
    return videoReimportHandler('/assets/clip.mp4', absPath, ctx).then(() => {
      const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
      expect(committed.videoCache, 'durationSec must NOT be committed — it tracks the machine').not.toHaveProperty('durationSec');
      expect(readMetaSidecar(absPath).videoCache).toMatchObject({ durationSec: 24.009002 });
    });
  });
});
