/** Unit cover for the video converter's pure argument builder and its content-cache
 *  key. Both are pure, so they're testable without ffmpeg on PATH. */

import { describe, it, expect } from 'vitest';
import { buildVideoFfmpegArgs } from '../../plugins/video-convert';
import { videoHashKey } from '../../plugins/video-cache';
import {
  DEFAULT_VIDEO_SETTINGS,
  resolveDeliveryPolicy,
  resolveVideoSettings,
  AUTO_DOWNLOAD_MAX_BYTES,
  type VideoImportSettings,
} from '../../packages/modoki/src/runtime/loaders/videoSettings';

const settings = (over: Partial<VideoImportSettings> = {}): VideoImportSettings => ({
  ...DEFAULT_VIDEO_SETTINGS, ...over,
});

/** Value that follows `flag` in the arg vector. */
const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('buildVideoFfmpegArgs', () => {
  it('encodes H.264 into mp4 with the settings quality/preset', () => {
    const args = buildVideoFfmpegArgs(settings({ quality: 20, preset: 'fast' }), 'in.mov', 'out.mp4');
    expect(valueAfter(args, '-c:v')).toBe('libx264');
    expect(valueAfter(args, '-crf')).toBe('20');
    expect(valueAfter(args, '-preset')).toBe('fast');
    expect(valueAfter(args, '-f')).toBe('mp4');
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  it('always forces yuv420p — 4:4:4/10-bit decodes on desktop and goes black on iOS', () => {
    expect(valueAfter(buildVideoFfmpegArgs(settings(), 'i', 'o'), '-pix_fmt')).toBe('yuv420p');
  });

  it('always strips source metadata — GPS/creation-time survive a transcode and these ship publicly', () => {
    // Regression guard for the leak class in #103: a tagged source was measured
    // retaining `location`, `location-eng` and `comment` through an unflagged encode.
    for (const s of [settings(), settings({ audio: 'strip' }), settings({ maxWidth: 0, maxHeight: 0 })]) {
      const args = buildVideoFfmpegArgs(s, 'i', 'o');
      expect(valueAfter(args, '-map_metadata')).toBe('-1');
    }
  });

  it('always sets faststart — without it a streamed clip buffers the whole file first', () => {
    expect(valueAfter(buildVideoFfmpegArgs(settings(), 'i', 'o'), '-movflags')).toBe('+faststart');
  });

  describe('scaling', () => {
    it('emits no -vf when no bound and no fps cap are set', () => {
      const args = buildVideoFfmpegArgs(
        settings({ maxWidth: 0, maxHeight: 0, maxFps: 0 }), 'i', 'o',
      );
      expect(args).not.toContain('-vf');
    });

    it('bounds without upscaling, and rounds to even dimensions', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ maxWidth: 1280, maxHeight: 720 }), 'i', 'o'), '-vf');
      expect(vf).toContain('min(iw\\,1280)');
      expect(vf).toContain('min(ih\\,720)');
      expect(vf).toContain('force_original_aspect_ratio=decrease');
      // H.264 + yuv420p aborts on an odd dimension — the scale must not be able to
      // produce one.
      expect(vf).toContain('trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('caps frame rate only when maxFps is set', () => {
      expect(valueAfter(buildVideoFfmpegArgs(settings({ maxFps: 30 }), 'i', 'o'), '-vf')).toContain('fps=30');
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ maxFps: 0 }), 'i', 'o'), '-vf');
      expect(vf ?? '').not.toContain('fps=');
    });
  });

  describe('audio track', () => {
    it("strips with -an and emits no audio codec", () => {
      const args = buildVideoFfmpegArgs(settings({ audio: 'strip' }), 'i', 'o');
      expect(args).toContain('-an');
      expect(args).not.toContain('-c:a');
    });

    it('re-encodes to AAC at the configured bitrate when kept', () => {
      const args = buildVideoFfmpegArgs(settings({ audio: 'keep', audioBitrate: 96 }), 'i', 'o');
      expect(valueAfter(args, '-c:a')).toBe('aac');
      expect(valueAfter(args, '-b:a')).toBe('96k');
      expect(args).not.toContain('-an');
    });
  });

  it('forces keyframe spacing so stream-policy seeking lands predictably', () => {
    const args = buildVideoFfmpegArgs(settings({ keyframeIntervalSec: 2 }), 'i', 'o');
    expect(valueAfter(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
    expect(buildVideoFfmpegArgs(settings({ keyframeIntervalSec: 0 }), 'i', 'o'))
      .not.toContain('-force_key_frames');
  });
});

describe('videoHashKey', () => {
  const src = Buffer.from('fake-video-bytes');

  it('is stable for identical inputs', () => {
    expect(videoHashKey(src, settings())).toBe(videoHashKey(src, settings()));
  });

  it('changes when a conversion-affecting setting changes', () => {
    const base = videoHashKey(src, settings());
    expect(videoHashKey(src, settings({ quality: 30 }))).not.toBe(base);
    expect(videoHashKey(src, settings({ maxWidth: 640 }))).not.toBe(base);
    expect(videoHashKey(src, settings({ preset: 'slow' }))).not.toBe(base);
    expect(videoHashKey(src, settings({ audio: 'strip' }))).not.toBe(base);
  });

  it('does NOT change when only delivery/policy change — they move bytes, not make them', () => {
    // Flipping bundled↔remote or stream↔download must never force a re-encode.
    const base = videoHashKey(src, settings());
    expect(videoHashKey(src, settings({ delivery: 'remote' }))).toBe(base);
    expect(videoHashKey(src, settings({ policy: 'download' }))).toBe(base);
  });

  it('ignores audioBitrate when the track is stripped', () => {
    const a = videoHashKey(src, settings({ audio: 'strip', audioBitrate: 128 }));
    const b = videoHashKey(src, settings({ audio: 'strip', audioBitrate: 320 }));
    expect(a).toBe(b);
  });
});

describe('resolveDeliveryPolicy', () => {
  it('reports stream for bundled video regardless of policy', () => {
    expect(resolveDeliveryPolicy(settings({ delivery: 'bundled', policy: 'download' }), 10))
      .toBe('stream');
  });

  it('passes an explicit policy through', () => {
    expect(resolveDeliveryPolicy(settings({ delivery: 'remote', policy: 'download' }), 10))
      .toBe('download');
  });

  it('resolves auto by size', () => {
    const s = settings({ delivery: 'remote', policy: 'auto' });
    expect(resolveDeliveryPolicy(s, AUTO_DOWNLOAD_MAX_BYTES - 1)).toBe('download');
    expect(resolveDeliveryPolicy(s, AUTO_DOWNLOAD_MAX_BYTES + 1)).toBe('stream');
  });

  it('falls back to stream when the size is unknown — it cannot blow an unmeasurable budget', () => {
    expect(resolveDeliveryPolicy(settings({ delivery: 'remote', policy: 'auto' }), undefined))
      .toBe('stream');
  });
});

describe('resolveVideoSettings', () => {
  it('fills defaults for a missing or partial video block', () => {
    expect(resolveVideoSettings(null)).toEqual(DEFAULT_VIDEO_SETTINGS);
    expect(resolveVideoSettings({}).quality).toBe(DEFAULT_VIDEO_SETTINGS.quality);
    expect(resolveVideoSettings({ video: { quality: 18 } }))
      .toEqual({ ...DEFAULT_VIDEO_SETTINGS, quality: 18 });
  });
});
