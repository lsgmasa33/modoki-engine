/** Audio conversion tests — exact ffmpeg flag vectors per format + filters + the
 *  missing-CLI error. execFileSync is mocked so the CLI check is deterministic
 *  regardless of whether ffmpeg is installed on the test machine. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => {
  const execFileSync = vi.fn(() => { throw new Error('command not found'); });
  return { execFileSync, default: { execFileSync } };
});

import { buildFfmpegArgs, ensureFfmpeg, __resetFfmpegCheck } from '../../plugins/audio-convert';
import { DEFAULT_AUDIO_SETTINGS } from '../../packages/modoki/src/runtime/loaders/audioSettings';

const S = DEFAULT_AUDIO_SETTINGS;

describe('buildFfmpegArgs', () => {
  it('MP3 (default): libmp3lame + bitrate + mp3 muxer, input then output', () => {
    const args = buildFfmpegArgs(S, 'in.wav', 'out.mp3');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('in.wav');
    expect(args[args.indexOf('-c:a') + 1]).toBe('libmp3lame');
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k');
    expect(args[args.indexOf('-f') + 1]).toBe('mp3');
    expect(args[args.length - 1]).toBe('out.mp3');
  });

  it('AAC uses the aac codec + mp4 muxer + faststart', () => {
    const args = buildFfmpegArgs({ ...S, format: 'aac' }, 'i', 'o');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-f') + 1]).toBe('mp4');
    expect(args).toContain('+faststart');
  });

  it('WAV is lossless — pcm_s16le and NO bitrate flag', () => {
    const args = buildFfmpegArgs({ ...S, format: 'wav' }, 'i', 'o');
    expect(args[args.indexOf('-c:a') + 1]).toBe('pcm_s16le');
    expect(args).not.toContain('-b:a');
  });

  it('FLAC is lossless — flac codec and NO bitrate flag', () => {
    const args = buildFfmpegArgs({ ...S, format: 'flac' }, 'i', 'o');
    expect(args[args.indexOf('-c:a') + 1]).toBe('flac');
    expect(args).not.toContain('-b:a');
  });

  it('forceMono adds -ac 1', () => {
    expect(buildFfmpegArgs({ ...S, forceMono: true }, 'i', 'o')).toContain('-ac');
    expect(buildFfmpegArgs(S, 'i', 'o')).not.toContain('-ac');
  });

  it('normalize adds a loudnorm -af filter', () => {
    const args = buildFfmpegArgs({ ...S, normalize: true }, 'i', 'o');
    const af = args[args.indexOf('-af') + 1];
    expect(af).toMatch(/loudnorm/);
  });

  it('trimSilence + normalize chain both filters in one -af', () => {
    const args = buildFfmpegArgs({ ...S, normalize: true, trimSilence: true }, 'i', 'o');
    const af = args[args.indexOf('-af') + 1];
    expect(af).toMatch(/silenceremove/);
    expect(af).toMatch(/loudnorm/);
    expect(af).toContain(','); // comma-joined chain
  });

  it('no processing ⇒ no -af', () => {
    expect(buildFfmpegArgs(S, 'i', 'o')).not.toContain('-af');
  });

  it('custom bitrate is honored for lossy formats', () => {
    const args = buildFfmpegArgs({ ...S, quality: 320 }, 'i', 'o');
    expect(args[args.indexOf('-b:a') + 1]).toBe('320k');
  });

  it('sampleRate adds -ar; source (0/undefined) omits it', () => {
    expect(buildFfmpegArgs({ ...S, sampleRate: 22050 }, 'i', 'o')[
      buildFfmpegArgs({ ...S, sampleRate: 22050 }, 'i', 'o').indexOf('-ar') + 1
    ]).toBe('22050');
    expect(buildFfmpegArgs(S, 'i', 'o')).not.toContain('-ar');
    expect(buildFfmpegArgs({ ...S, sampleRate: 0 }, 'i', 'o')).not.toContain('-ar');
  });

  it('WAV bit depth selects the PCM codec (default 16-bit)', () => {
    const codec = (bd?: number) => {
      const a = buildFfmpegArgs({ ...S, format: 'wav', bitDepth: bd }, 'i', 'o');
      return a[a.indexOf('-c:a') + 1];
    };
    expect(codec(undefined)).toBe('pcm_s16le');
    expect(codec(24)).toBe('pcm_s24le');
    expect(codec(32)).toBe('pcm_f32le');
  });

  it('forces bitexact + strips metadata so output is deterministic (opus/Ogg had a random serial)', () => {
    for (const format of ['mp3', 'aac', 'opus', 'wav', 'flac'] as const) {
      const args = buildFfmpegArgs({ ...S, format }, 'i', 'o');
      // -flags/-fflags +bitexact and -map_metadata -1 must appear AFTER -i (output options).
      const inputIdx = args.indexOf('-i');
      expect(args.indexOf('-flags')).toBeGreaterThan(inputIdx);
      expect(args[args.indexOf('-flags') + 1]).toBe('+bitexact');
      expect(args[args.indexOf('-fflags') + 1]).toBe('+bitexact');
      expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
    }
  });

  it('opus snaps an unsupported -ar to the nearest legal opus rate (never crashes ffmpeg)', () => {
    const arOf = (fmt: 'opus' | 'mp3', rate: number) => {
      const a = buildFfmpegArgs({ ...S, format: fmt, sampleRate: rate }, 'i', 'o');
      return a[a.indexOf('-ar') + 1];
    };
    expect(arOf('opus', 44100)).toBe('48000'); // 44100 → nearest legal 48000
    expect(arOf('opus', 22050)).toBe('24000'); // 22050 → nearest legal 24000
    expect(arOf('mp3', 44100)).toBe('44100');  // non-opus keeps the requested rate
  });
});

describe('ensureFfmpeg', () => {
  it('throws a clear install hint when the CLI is absent', () => {
    __resetFfmpegCheck();
    expect(() => ensureFfmpeg()).toThrow(/ffmpeg/);
  });
});
