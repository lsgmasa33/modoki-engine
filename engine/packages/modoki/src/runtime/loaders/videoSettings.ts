/** Video import settings — the single source of truth shared by the editor Video
 *  Inspector, the dev-server conversion service (ffmpeg), the build tree-shaker,
 *  and the runtime video URL resolver. Mirrors `audioSettings.ts`.
 *
 *  Settings live in a video's `.meta.json` sidecar (`video` block) and are baked
 *  into the asset manifest so the runtime can pick the converted variant (and the
 *  delivery path) without an extra per-clip fetch.
 *
 *  **There is no output-format knob.** Video is deliberately H.264/mp4 only — it
 *  is the sole codec that plays in the iOS WKWebView (VP9/WebM does not), so a
 *  format enum would only offer choices that break a platform. See
 *  docs/video.md.
 *
 *  Two orthogonal groups of knobs, and the split decides the cache key:
 *   - `delivery`/`policy` fork the DELIVERY path only (bundled vs fetched; streamed
 *     vs downloaded-then-played). They do NOT affect the converted bytes, so they
 *     are deliberately excluded from the cache hash — flipping one must not force a
 *     re-encode. (Same reasoning as audio's `loadType`.)
 *   - everything else drives the ffmpeg CONVERSION and IS hashed. */

/** Where the converted file is served from.
 *  - `bundled` — ships inside the game build.
 *  - `remote`  — published to a host and fetched at runtime, subject to `policy`
 *    and the per-game cache budget. */
export type VideoDelivery = 'bundled' | 'remote';

/** How a `remote` video reaches the player. Ignored for `bundled`.
 *  - `stream`   — point the element at the URL; the browser does progressive HTTP.
 *                 Near-instant start, no local copy, needs the network every play.
 *  - `download` — fetch to local storage first (with progress), then play from
 *                 disk. Survives offline; counts against the cache budget.
 *  - `auto`     — `stream` above {@link AUTO_DOWNLOAD_MAX_BYTES}, else `download`. */
export type VideoDeliveryPolicy = 'stream' | 'download' | 'auto';

/** x264 speed/compression trade-off. Slower = smaller file for the same quality.
 *  `veryfast` is the default: import should not stall the editor, and the size win
 *  from `slow` is not worth multiplying every reimport by 4×. */
export type VideoPreset = 'ultrafast' | 'veryfast' | 'fast' | 'medium' | 'slow';

/** What happens to the source audio track. */
export type VideoAudioMode = 'keep' | 'strip';

export interface VideoImportSettings {
  delivery: VideoDelivery;
  policy: VideoDeliveryPolicy;
  /** Constant Rate Factor (0–51, lower = better). CRF is used instead of a target
   *  bitrate because these are VOD-style assets, not a live stream — quality-targeted
   *  encoding gives a predictable *look* and lets simple footage cost fewer bytes. */
  quality: number;
  preset: VideoPreset;
  /** Downscale so neither dimension exceeds these. `0` keeps the source size.
   *  Aspect ratio is always preserved; this is a bound, not a resize. */
  maxWidth: number;
  maxHeight: number;
  /** Cap the frame rate. `0` keeps the source rate. */
  maxFps: number;
  /** Keyframe interval in SECONDS. Load-bearing for `policy: 'stream'` — seeking
   *  can only land on a keyframe, so a long interval makes scrubbing coarse, while a
   *  short one costs bytes. */
  keyframeIntervalSec: number;
  audio: VideoAudioMode;
  /** Audio bitrate in kbps. Ignored when `audio` is `'strip'`. */
  audioBitrate: number;
  /** Where a `delivery: 'remote'` clip is fetched from. Authored (or written by a
   *  future publish step) — the build cannot invent it.
   *
   *  The host MUST send `Access-Control-Allow-Origin`, and this is not a formality:
   *  a video used as a GPU texture is loaded with `crossOrigin='anonymous'`, so a
   *  host without CORS fails the load outright — while omitting the flag taints the
   *  canvas and makes the texture unusable instead. Measured: GitHub *Releases* sends
   *  range requests but NO CORS, so it cannot host video; jsDelivr and archive.org
   *  both send `ACAO: *`. Ignored when `delivery` is `'bundled'`. */
  remoteUrl?: string;
}

export const DEFAULT_VIDEO_SETTINGS: VideoImportSettings = {
  delivery: 'bundled',
  policy: 'auto',
  quality: 23,
  preset: 'veryfast',
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 0,
  keyframeIntervalSec: 2,
  audio: 'keep',
  audioBitrate: 128,
};

/** `policy: 'auto'` streams anything above this and downloads anything below it.
 *  8 MB is roughly where a download's wait stops being invisible on a mobile
 *  connection — below it, prefer the offline-capable path. */
export const AUTO_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

/** Selectable CRF values surfaced in the inspector. Lower = better quality/bigger. */
export const VIDEO_QUALITIES: number[] = [18, 20, 23, 26, 30];

export const VIDEO_PRESETS: VideoPreset[] = ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'];

/** Selectable max-dimension bounds (px). `0` = keep the source size. */
export const VIDEO_MAX_DIMENSIONS: number[] = [0, 640, 1280, 1920, 3840];

/** Selectable frame-rate caps. `0` = keep the source rate. */
export const VIDEO_MAX_FPS: number[] = [0, 24, 30, 60];

/** The one and only container/codec. */
export const VIDEO_EXTENSION = 'mp4';
export const VIDEO_MIME = 'video/mp4';

/** Suffix appended to the source path to form the deterministic served URL, e.g.
 *  `intro.mp4` + `~video.mp4`. Dev server and production build both serve the
 *  converted variant here, so the runtime computes it without knowing the hash. */
export function videoVariantSuffix(): string {
  return `~video.${VIDEO_EXTENSION}`;
}

/** Whether this asset is fetched at runtime rather than shipped in the build. */
export function isRemoteDelivery(s: VideoImportSettings): boolean {
  return s.delivery === 'remote';
}

/** Resolve `policy: 'auto'` against a known encoded size. `bundled` video is never
 *  fetched, so it always reports `'stream'` (i.e. "play it straight from its URL").
 *  Returns a concrete policy the runtime can act on. */
export function resolveDeliveryPolicy(
  s: VideoImportSettings, encodedBytes: number | undefined,
): Exclude<VideoDeliveryPolicy, 'auto'> {
  if (s.delivery === 'bundled') return 'stream';
  if (s.policy !== 'auto') return s.policy;
  // Unknown size → prefer streaming; it cannot blow a cache budget we can't measure.
  if (encodedBytes == null) return 'stream';
  return encodedBytes > AUTO_DOWNLOAD_MAX_BYTES ? 'stream' : 'download';
}

/** Cache bookkeeping persisted in the video's meta sidecar (`videoCache`). `hash`
 *  keys the content cache (source bytes + settings + encoder version); the rest are
 *  post-conversion stats surfaced in the inspector and used to resolve `'auto'`. */
export interface VideoCacheInfo {
  hash: string;
  /** Extension of the produced variant file. Always `mp4` — carried for symmetry
   *  with audio, and so a future container change is representable in old sidecars. */
  ext: string;
  /** On-disk byte size of the converted variant. Feeds `resolveDeliveryPolicy` and
   *  the editor's per-game remote-footprint report. */
  bytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** True when the converted file actually carries an audio track. Lets a caller
   *  know whether playback will be gated by the autoplay policy without probing. */
  hasAudio?: boolean;
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial `video`
 *  block (a clip with no import settings → all defaults). */
export function resolveVideoSettings(
  meta: { video?: Partial<VideoImportSettings> } | null | undefined,
): VideoImportSettings {
  return { ...DEFAULT_VIDEO_SETTINGS, ...(meta?.video ?? {}) };
}
