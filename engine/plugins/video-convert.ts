/** Video conversion service (runs in Node — dev server + build).
 *
 *  Pipeline: ffmpeg transcodes the source into H.264/mp4, optionally downscaling,
 *  capping the frame rate, and stripping or re-encoding the audio track. The single
 *  converted file lands in the content cache (see video-cache.ts); cache hits skip
 *  all work. ffmpeg resolution is shared with the audio converter (ffmpeg-tool.ts).
 *
 *  **H.264/mp4 is the only output.** It is the sole codec that plays in the iOS
 *  WKWebView, so there is no format knob to get wrong. See
 *  docs/video.md.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  VIDEO_EXTENSION, resolveScalePercent,
  type VideoImportSettings,
} from '../packages/modoki/src/runtime/loaders/videoSettings';
import {
  getVideoCacheDir, videoHashKey, videoCachePathFor, videoCacheHit,
} from './video-cache';
import { ensureFfmpeg, ffprobeBinary } from './ffmpeg-tool';

/** Build the `-vf` filter chain (comma-joined) for the settings. Empty ⇒ no `-vf`. */
function buildFilters(settings: VideoImportSettings): string[] {
  const filters: string[] = [];
  const { maxWidth, maxHeight } = settings;
  if (settings.resizeMode === 'percent') {
    // Percentage of the source, both axes together — aspect is preserved by
    // construction, so there is no force_original_aspect_ratio to apply.
    //
    // The even-dimension requirement (H.264 + yuv420p) is folded into the SAME
    // expression rather than chained as a second scale: `trunc(iw*p/200)*2` is
    // `trunc(iw*p/100 / 2) * 2`, i.e. the scaled width rounded down to a multiple of
    // 2. Doing it in one pass keeps the arithmetic integer — a `scale=iw*0.33` with a
    // float literal is where rounding disagreements between ffmpeg builds come from.
    //
    // At 100% this degenerates to `trunc(iw/2)*2`, which is exactly the even-rounding
    // an odd-dimensioned source needs anyway. So "100%" is not a no-op filter, and
    // that is deliberate: without it an odd source aborts the encode.
    const p = resolveScalePercent(settings);
    filters.push(`scale=trunc(iw*${p}/200)*2:trunc(ih*${p}/200)*2`);
  } else if (maxWidth > 0 || maxHeight > 0) {
    // Bound, don't resize: scale down to fit the box, preserve aspect, and NEVER
    // upscale (`force_original_aspect_ratio=decrease` + `min(iw,…)`) — enlarging a
    // small source just costs bytes for no detail.
    const w = maxWidth > 0 ? `min(iw\\,${maxWidth})` : 'iw';
    const h = maxHeight > 0 ? `min(ih\\,${maxHeight})` : 'ih';
    filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
    // H.264 with yuv420p requires EVEN dimensions; an odd result from the scale above
    // aborts the encode ("width not divisible by 2"). Round both down to a multiple
    // of 2 rather than letting a 1-px oddity fail the import.
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  if (settings.maxFps > 0) filters.push(`fps=${settings.maxFps}`);
  return filters;
}

/** Build the ffmpeg argument vector. Pure — unit tested. */
export function buildVideoFfmpegArgs(
  settings: VideoImportSettings, inPath: string, outPath: string,
): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath];

  // Strip ALL source metadata, and encode/mux bitexact.
  //
  // Unlike audio (where the Ogg muxer's random stream serial broke the content
  // cache), measured H.264/mp4 output is already byte-stable run to run — so this is
  // NOT primarily a determinism fix here. It is a LEAK fix: source metadata survives
  // a transcode, and real footage carries plenty. Measured on a tagged mp4, the
  // output retained `location`/`location-eng` (GPS coordinates), the source tool's
  // `comment`, and creation timestamps. A demo video is published to a PUBLIC repo,
  // so shipping the shooting location of the owner's house is the same class of
  // mistake as the device-id leak swept in #103. `-map_metadata -1` removes them.
  args.push('-map_metadata', '-1', '-flags', '+bitexact', '-fflags', '+bitexact');

  const filters = buildFilters(settings);
  if (filters.length) args.push('-vf', filters.join(','));

  args.push('-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.quality));
  // yuv420p (not the source's possible yuv444p/10-bit): the only pixel format with
  // universal browser + iOS decode support. A "High 4:4:4" file plays on the desktop
  // dev machine and shows a black frame on the phone.
  args.push('-pix_fmt', 'yuv420p');

  // Keyframe interval, expressed in seconds by the settings but in FRAMES by x264.
  // Without a source frame rate to multiply by, `-g` would be meaningless — so drive
  // it off the OUTPUT rate when capped, else let ffmpeg's expression evaluate against
  // the source rate at encode time. `-force_key_frames` guarantees the spacing even
  // when x264's scene-cut detection would otherwise place them elsewhere, which is
  // what makes `policy: 'stream'` seeking land where the player expects.
  if (settings.keyframeIntervalSec > 0) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${settings.keyframeIntervalSec})`);
  }

  if (settings.audio === 'strip') {
    args.push('-an');
  } else {
    args.push('-c:a', 'aac', '-b:a', `${settings.audioBitrate}k`);
  }

  // faststart moves the moov atom to the front of the file. Without it, progressive
  // HTTP playback (`policy: 'stream'`) must download the whole file before the first
  // frame renders — which defeats the entire point of streaming.
  args.push('-movflags', '+faststart', '-f', 'mp4');
  args.push(outPath);
  return args;
}

export interface VideoConvertOptions {
  projectRoot: string;
  /** Source URL path, e.g. /demos/video-demo/assets/video/intro.mp4 */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source video file. */
  absSource: string;
  settings: VideoImportSettings;
}

export interface VideoConvertResult {
  hash: string;
  /** Extension of the produced variant file. Always `mp4`. */
  ext: string;
  cached: boolean;
  bytes: number;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}

interface ProbeStats {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}

/** Parse ffprobe's `r_frame_rate` ("30000/1001") into a number. */
function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const [num, den] = raw.split('/');
  const n = parseFloat(num);
  const d = den === undefined ? 1 : parseFloat(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  const fps = n / d;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : undefined;
}

/** Best-effort probe of the converted file's dimensions/duration/fps via ffprobe.
 *  Returns `{}` when ffprobe is unavailable or errors.
 *
 *  Unlike audio's equivalent these stats are NOT purely cosmetic: `bytes` +
 *  `durationSec` feed `resolveDeliveryPolicy`'s `'auto'` decision and the editor's
 *  per-game remote-footprint report. A missing probe degrades `'auto'` to `'stream'`
 *  (see resolveDeliveryPolicy) rather than guessing wrong. */
function probeStats(file: string): ProbeStats {
  try {
    const out = execFileSync(ffprobeBinary(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
      '-of', 'json', file,
    ], { stdio: 'pipe' }).toString();
    const json = JSON.parse(out) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video');
    const dur = json.format?.duration ? parseFloat(json.format.duration) : undefined;
    return {
      durationSec: dur != null && !Number.isNaN(dur) ? dur : undefined,
      width: v?.width,
      height: v?.height,
      fps: parseFrameRate(v?.r_frame_rate),
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
  } catch {
    return {};
  }
}

/** Convert one source video into its single converted variant, writing it into the
 *  content cache. Returns the hash + stats to persist in the meta. */
export async function convertVideo(opts: VideoConvertOptions): Promise<VideoConvertResult> {
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const srcBytes = fs.readFileSync(absSource);
  const hash = videoHashKey(srcBytes, settings);
  const cacheDir = getVideoCacheDir(projectRoot);
  const outPath = videoCachePathFor(cacheDir, sourceUrlPath, hash);

  if (videoCacheHit(cacheDir, sourceUrlPath, hash)) {
    return {
      hash, ext: VIDEO_EXTENSION, cached: true,
      bytes: fs.statSync(outPath).size, ...probeStats(outPath),
    };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const cli = ensureFfmpeg();
  try {
    execFileSync(cli, buildVideoFfmpegArgs(settings, absSource, outPath), { stdio: 'pipe' });
  } catch (e) {
    // Clean up a partial output so a later cache-hit check doesn't see a truncated file.
    try { fs.rmSync(outPath, { force: true }); } catch { /* noop */ }
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    throw new Error(`ffmpeg failed for ${sourceUrlPath}: ${stderr}`, { cause: e });
  }
  return {
    hash, ext: VIDEO_EXTENSION, cached: false,
    bytes: fs.statSync(outPath).size, ...probeStats(outPath),
  };
}
