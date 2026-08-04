/** Shared ffmpeg/ffprobe CLI resolution for the conversion services (runs in Node —
 *  dev server + build).
 *
 *  Extracted from audio-convert.ts when the video converter landed: both need the
 *  same "env override → provisioned toolchain → PATH" lookup and the same cached
 *  availability probe, and a second copy would be a constant shadowing another (the
 *  failure mode the single-source-of-truth rule exists to prevent).
 *
 *  ⚠️ The ffmpeg binary must NEVER be bundled into the packaged editor. Every
 *  `ffmpeg-static` build is `--enable-gpl` (redistributable only under the GPL,
 *  incompatible with shipping inside the Apache-2.0 editor) and the darwin-arm64
 *  build is additionally `--enable-nonfree`, which is not redistributable under ANY
 *  licence. We are compliant precisely because the user's own machine provisions it
 *  on demand — see engine/scripts/before-pack.cjs and docs/video.md. */

import { execFileSync } from 'child_process';
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

export function ffmpegBinary(): string {
  return resolveTool('MODOKI_FFMPEG', 'ffmpeg', 'ffmpeg');
}

export function ffprobeBinary(): string {
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
