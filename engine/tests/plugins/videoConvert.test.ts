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

    it('scales by percentage of the source, both axes together, in ONE even-rounded expression', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'percent', scalePercent: 50 }), 'i', 'o'), '-vf');
      // trunc(iw*50/200)*2 === trunc(iw*0.5 / 2) * 2 — half the width, rounded down to
      // an even number. Integer arithmetic throughout: no float literal to round.
      expect(vf).toBe('scale=trunc(iw*50/200)*2:trunc(ih*50/200)*2');
    });

    it('still emits the even-rounding scale at 100% — an odd-dimensioned source aborts the encode otherwise', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'percent', scalePercent: 100 }), 'i', 'o'), '-vf');
      expect(vf).toBe('scale=trunc(iw*100/200)*2:trunc(ih*100/200)*2');
    });

    it('ignores the pixel bounds entirely in percent mode — the two do not compose', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(
        settings({ resizeMode: 'percent', scalePercent: 50, maxWidth: 640, maxHeight: 480 }), 'i', 'o'), '-vf');
      expect(vf).not.toContain('640');
      expect(vf).not.toContain('force_original_aspect_ratio');
    });

    it('clamps a hand-authored scalePercent instead of emitting scale=0:0', () => {
      // `0` means "keep the source" for maxWidth/maxHeight/maxFps, so it is an inviting
      // thing to write here — where it would mean a zero-pixel encode.
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'percent', scalePercent: 0 }), 'i', 'o'), '-vf');
      expect(vf).toBe('scale=trunc(iw*10/200)*2:trunc(ih*10/200)*2');
      expect(vf).not.toContain('*0/');
    });

    it('clamps above 100 — there is no upscale', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'percent', scalePercent: 400 }), 'i', 'o'), '-vf');
      expect(vf).toBe('scale=trunc(iw*100/200)*2:trunc(ih*100/200)*2');
    });

    it('rounds a fractional percentage to an integer — the expression is integer arithmetic', () => {
      const vf = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'percent', scalePercent: 33.4 }), 'i', 'o'), '-vf');
      expect(vf).toBe('scale=trunc(iw*33/200)*2:trunc(ih*33/200)*2');
    });

    it('ignores scalePercent entirely in bounds mode', () => {
      const a = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'bounds', scalePercent: 25 }), 'i', 'o'), '-vf');
      const b = valueAfter(buildVideoFfmpegArgs(settings({ resizeMode: 'bounds', scalePercent: 100 }), 'i', 'o'), '-vf');
      expect(a).toBe(b);
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

  it('changes when the resize mode or the active percentage changes', () => {
    const bounds = videoHashKey(src, settings());
    expect(videoHashKey(src, settings({ resizeMode: 'percent' }))).not.toBe(bounds);
    expect(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 50 })))
      .not.toBe(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 25 })));
  });

  it('hashes the CLAMPED percentage, so the key cannot disagree with the filter', () => {
    // Two out-of-range values that clamp to the same encode must share a cache entry —
    // otherwise the key promises different bytes than ffmpeg is asked to produce.
    expect(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 0 })))
      .toBe(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 5 })));
    expect(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 400 })))
      .toBe(videoHashKey(src, settings({ resizeMode: 'percent', scalePercent: 100 })));
  });

  it('ignores the INACTIVE half of the resize mode — it changes no bytes', () => {
    // A maxWidth left over from before the switch to percentage must not re-encode.
    expect(videoHashKey(src, settings({ resizeMode: 'percent', maxWidth: 640 })))
      .toBe(videoHashKey(src, settings({ resizeMode: 'percent', maxWidth: 3840 })));
    expect(videoHashKey(src, settings({ resizeMode: 'bounds', scalePercent: 25 })))
      .toBe(videoHashKey(src, settings({ resizeMode: 'bounds', scalePercent: 100 })));
  });

  /** The whole reason `stableSettings` keeps the bounds branch byte-identical to its
   *  pre-percentage form: every clip already converted defaults to `bounds`, and a key
   *  change would silently re-encode every video in every project on the next build. */
  it('is UNCHANGED for a sidecar written before percentage scaling existed', () => {
    const legacy = resolveVideoSettings({
      video: {
        quality: 23, preset: 'veryfast', maxWidth: 1920, maxHeight: 1080,
        maxFps: 0, keyframeIntervalSec: 2, audio: 'keep', audioBitrate: 128,
      },
    });
    expect(legacy.resizeMode).toBe('bounds');
    // Pinned to the value the pre-percentage `stableSettings` produced for
    // `23|veryfast|1920|1080|0|2|keep|ab128` — computed from the old string, not from
    // the new code, so this genuinely detects a drift rather than restating it.
    expect(videoHashKey(src, legacy)).toBe('43200ef0e65bbe83');
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
