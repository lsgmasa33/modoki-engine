/** Audio conversion service (runs in Node — dev server + build).
 *
 *  Pipeline: ffmpeg transcodes the source into the chosen format (default MP3),
 *  optionally downmixing to mono, applying EBU R128 loudness normalization, and
 *  trimming leading/trailing silence. The single converted file lands in the
 *  content cache (see audio-cache.ts); cache hits skip all work. ffmpeg is an
 *  external prerequisite — {@link ensureFfmpeg} surfaces a clear install hint
 *  when it's missing (unlike toktx, ffmpeg IS in Homebrew: `brew install ffmpeg`).
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  audioFormatExtension, wavPcmCodec, nearestOpusSampleRate,
  type AudioImportSettings,
} from '../packages/modoki/src/runtime/loaders/audioSettings';
import {
  getAudioCacheDir, audioHashKey, audioCachePathFor, audioCacheHit,
} from './audio-cache';
import { detect } from '../toolchain';

const FFMPEG_MISSING_MSG = 'ffmpeg not found. Install it from the Build Support dialog (the editor provisions its own), set MODOKI_FFMPEG to a binary path, or install it on PATH (dev: `brew install ffmpeg`).';

let ffmpegCheck: { ok: boolean; cli: string } | null = null;

/** Resolve a native CLI: an explicit env override wins (bundled/hand-set), else the
 *  editor's provisioned toolchain copy (`install('ffmpeg')` → userData npm-tools),
 *  else the bare name on PATH (dev). detect() re-probes the current filesystem, so an
 *  on-demand install is picked up without restarting. */
function resolveTool(envVar: string, id: 'ffmpeg' | 'ffprobe', fallback: string): string {
  const override = process.env[envVar];
  if (override) return override;
  try {
    const d = detect(id);
    if (d.present && d.command) return d.command;
  } catch { /* toolchain module unavailable → PATH fallback */ }
  return fallback;
}

function ffmpegBinary(): string {
  return resolveTool('MODOKI_FFMPEG', 'ffmpeg', 'ffmpeg');
}

function ffprobeBinary(): string {
  return resolveTool('MODOKI_FFPROBE', 'ffprobe', 'ffprobe');
}

/** For tests — forget the cached CLI-availability probe. */
export function __resetFfmpegCheck(): void { ffmpegCheck = null; }

/** Ensure `ffmpeg` is callable; returns the CLI path/name or throws with an install hint. */
export function ensureFfmpeg(): string {
  const cli = ffmpegBinary();
  if (ffmpegCheck && ffmpegCheck.cli === cli) {
    if (!ffmpegCheck.ok) throw new Error(FFMPEG_MISSING_MSG);
    return ffmpegCheck.cli;
  }
  try {
    execFileSync(cli, ['-version'], { stdio: 'pipe' });
    ffmpegCheck = { ok: true, cli };
    return cli;
  } catch {
    ffmpegCheck = { ok: false, cli };
    throw new Error(FFMPEG_MISSING_MSG);
  }
}

/** Build the `-af` filter chain (comma-joined) for the settings. Empty ⇒ no `-af`. */
function buildFilters(settings: AudioImportSettings): string[] {
  const filters: string[] = [];
  if (settings.trimSilence) {
    // Trim near-silence off both ends. stop_periods=-1 applies the trim to every
    // trailing silence run; thresholds in dBFS.
    filters.push('silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:stop_periods=-1:stop_threshold=-50dB:stop_silence=0.05');
  }
  if (settings.normalize) {
    // EBU R128 loudness target (streaming-friendly): -16 LUFS integrated, -1.5 dBTP.
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }
  return filters;
}

/** Build the ffmpeg argument vector. Pure — unit tested. */
export function buildFfmpegArgs(
  settings: AudioImportSettings, inPath: string, outPath: string,
): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath];
  // Deterministic, reproducible output: strip source metadata and force bitexact
  // encoding + muxing. Without this the Ogg/Opus muxer stamps a RANDOM stream serial
  // number per run (and encoders embed version/timestamp strings), so the SAME clip
  // re-encodes to different bytes every import — the content cache never hits and
  // builds aren't reproducible. mp3/aac were already stable; opus was not. Applied
  // uniformly so every format is byte-stable for a given (source, settings, ffmpeg).
  args.push('-map_metadata', '-1', '-flags', '+bitexact', '-fflags', '+bitexact');
  const filters = buildFilters(settings);
  if (filters.length) args.push('-af', filters.join(','));
  if (settings.forceMono) args.push('-ac', '1');
  // Resample when an explicit rate is set (0/undefined keeps the source rate).
  // opus only accepts a fixed set of rates — forcing any other via -ar aborts the
  // encode, so snap to the nearest legal one (a stale rate from a format switch, or
  // an out-of-list value, can't crash the reimport).
  if (settings.sampleRate && settings.sampleRate > 0) {
    const rate = settings.format === 'opus' ? nearestOpusSampleRate(settings.sampleRate) : settings.sampleRate;
    args.push('-ar', String(rate));
  }
  const bitrate = `${settings.quality}k`;
  switch (settings.format) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3');
      break;
    case 'aac':
      args.push('-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', '-f', 'mp4');
      break;
    case 'opus':
      args.push('-c:a', 'libopus', '-b:a', bitrate, '-f', 'opus');
      break;
    case 'wav':
      args.push('-c:a', wavPcmCodec(settings.bitDepth), '-f', 'wav');
      break;
    case 'flac':
      args.push('-c:a', 'flac', '-f', 'flac');
      break;
  }
  // Note: the switch never sets -b:a for wav/flac (lossless) — bitrate is ignored.
  args.push(outPath);
  return args;
}

export interface AudioConvertOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/audio-demo/assets/audio/music.mp3 */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source audio file. */
  absSource: string;
  settings: AudioImportSettings;
}

export interface AudioConvertResult {
  hash: string;
  /** Extension of the produced variant file (from `settings.format`). */
  ext: string;
  cached: boolean;
  bytes: number;
  durationSec?: number;
  channels?: number;
  sampleRate?: number;
}

/** Best-effort probe of the converted file's duration/channels/sampleRate via
 *  ffprobe. Returns `{}` when ffprobe is unavailable or errors — stats are
 *  cosmetic (inspector display), never load-bearing. */
function probeStats(file: string): { durationSec?: number; channels?: number; sampleRate?: number } {
  try {
    const out = execFileSync(ffprobeBinary(), [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels,sample_rate:format=duration',
      '-of', 'json', file,
    ], { stdio: 'pipe' }).toString();
    const json = JSON.parse(out) as {
      streams?: Array<{ channels?: number; sample_rate?: string }>;
      format?: { duration?: string };
    };
    const s = json.streams?.[0];
    const dur = json.format?.duration ? parseFloat(json.format.duration) : undefined;
    return {
      durationSec: dur != null && !Number.isNaN(dur) ? dur : undefined,
      channels: s?.channels,
      sampleRate: s?.sample_rate ? parseInt(s.sample_rate, 10) : undefined,
    };
  } catch {
    return {};
  }
}

/** Convert one source audio clip into its single converted variant, writing it
 *  into the content cache. Returns the hash + stats to persist in the meta. */
export async function convertAudio(opts: AudioConvertOptions): Promise<AudioConvertResult> {
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const srcBytes = fs.readFileSync(absSource);
  const hash = audioHashKey(srcBytes, settings);
  const ext = audioFormatExtension(settings.format);
  const cacheDir = getAudioCacheDir(projectRoot);
  const outPath = audioCachePathFor(cacheDir, sourceUrlPath, hash, ext);

  if (audioCacheHit(cacheDir, sourceUrlPath, hash, settings)) {
    return { hash, ext, cached: true, bytes: fs.statSync(outPath).size, ...probeStats(outPath) };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const cli = ensureFfmpeg();
  try {
    execFileSync(cli, buildFfmpegArgs(settings, absSource, outPath), { stdio: 'pipe' });
  } catch (e) {
    // Clean up a partial output so a later cache-hit check doesn't see a truncated file.
    try { fs.rmSync(outPath, { force: true }); } catch { /* noop */ }
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    throw new Error(`ffmpeg failed for ${sourceUrlPath}: ${stderr}`);
  }
  return { hash, ext, cached: false, bytes: fs.statSync(outPath).size, ...probeStats(outPath) };
}
