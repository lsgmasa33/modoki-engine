/** Shared ffmpeg/ffprobe CLI resolution for the conversion services (runs in Node —
 *  dev server + build).
 *
 *  Extracted from audio-convert.ts when the video converter landed: both need the
 *  same lookup, and a second copy would be a constant shadowing another (the
 *  failure mode the single-source-of-truth rule exists to prevent).
 *
 *  ⚠️ **PINNED, never PATH (#1297).** A conversion runs the editor's provisioned,
 *  version-pinned copy (`install('ffmpeg')` → `<toolchain>/npm-tools`) or an explicit
 *  `MODOKI_FFMPEG`/`MODOKI_FFPROBE` override — and otherwise FAILS. It used to fall back
 *  to whatever `ffmpeg` was on PATH, and two builds of it produced different bytes under
 *  one cache hash (4 of 26 wordweave clips between Homebrew 8.1.1 and ffmpeg-static 6.0;
 *  ffprobe durations differed on all 26), so what a build shipped depended on which laptop
 *  converted it. The cache key does not name the binary, so the binary has to be the same
 *  everywhere instead. The env override stays: setting it is a deliberate act, not an
 *  accident of what happens to be installed. The resolution itself is shared with
 *  toktx/msdf-atlas-gen in `pinned-cli.ts`.
 *
 *  ⚠️ The ffmpeg binary must NEVER be bundled into the packaged editor. Every
 *  `ffmpeg-static` build is `--enable-gpl` (redistributable only under the GPL,
 *  incompatible with shipping inside the Apache-2.0 editor) and the darwin-arm64
 *  build is additionally `--enable-nonfree`, which is not redistributable under ANY
 *  licence. We are compliant precisely because the user's own machine provisions it
 *  on demand — see engine/scripts/before-pack.cjs and docs/video.md. */

import { pinnedConversionCli } from './pinned-cli';

/** The pinned `ffmpeg`, or throws with an install hint. */
export function ensureFfmpeg(): string {
  return pinnedConversionCli('ffmpeg');
}

/** The pinned `ffprobe`, or throws with an install hint. */
export function ensureFfprobe(): string {
  return pinnedConversionCli('ffprobe');
}

const warnedProbe = new Set<string>();

/** Run `probe` with the pinned ffprobe; `{}` when there is none or it fails on this file.
 *
 *  ⚠️ A MISSING probe is tolerated, not thrown — the owner chose that on 2026-09-16 (#1300:
 *  the reimport handlers MERGE, so an absent reading keeps the committed value instead of
 *  breaking the import). Pinning (#1297) does not reverse it: what it removes is the PATH
 *  fallback, so a missing pinned probe now yields no reading rather than a different build's
 *  reading. It is said once per process, so the gap is not silent. */
export function withFfprobe<T extends object>(probe: (cli: string) => T): T | Record<string, never> {
  let cli: string;
  try {
    cli = ensureFfprobe();
  } catch (e) {
    const msg = (e as Error).message;
    if (!warnedProbe.has(msg)) {
      warnedProbe.add(msg);
      console.warn(`[asset-convert] no stats probe — converted-file stats are left as they were. ${msg}`);
    }
    return {};
  }
  try {
    return probe(cli);
  } catch {
    return {};
  }
}
