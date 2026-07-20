/** Audio import settings — the single source of truth shared by the editor
 *  Audio Inspector, the dev-server conversion service (ffmpeg), the build
 *  tree-shaker, and the runtime audio URL resolver. Mirrors `textureSettings.ts`.
 *
 *  Settings live in an audio clip's `.meta.json` sidecar (`audio` block) and are
 *  baked into the asset manifest so the runtime can pick the converted variant
 *  (and the buffer-vs-stream load path) without an extra per-clip fetch.
 *
 *  Two orthogonal knobs:
 *   - `loadType` forks the RUNTIME path only (buffer = decodeAudioData → PCM cache
 *     for short SFX; stream = HTMLMediaElement for long music). It does NOT affect
 *     the converted bytes, so it is deliberately excluded from the cache hash.
 *   - `format`/`quality`/`forceMono`/`normalize`/`trimSilence` drive the ffmpeg
 *     CONVERSION. The converter defaults to MP3 (license-free + universal on iOS),
 *     but any listed format is selectable — the runtime is format-agnostic. */

/** Output container/codec. Cross-platform-safe on iOS: mp3, aac(.m4a), wav, flac.
 *  `opus` is iOS 18.4+ only (see docs/audio-plan.md) — selectable, not default. */
export type AudioFormat = 'mp3' | 'aac' | 'opus' | 'wav' | 'flac';

/** How the runtime loads the clip. `buffer` (default) decodes to an `AudioBuffer`
 *  held in the refcounted cache (short SFX); `stream` plays via `HTMLMediaElement`
 *  (long music/ambience, tiny memory). */
export type AudioLoadType = 'buffer' | 'stream';

export interface AudioImportSettings {
  loadType: AudioLoadType;
  /** Converter target. Default `mp3` (license-free, decodes everywhere). */
  format: AudioFormat;
  /** Target bitrate in kbps for lossy formats (mp3/aac/opus). Ignored for wav/flac. */
  quality: number;
  /** Downmix to a single channel — halves the size of mono SFX captured in stereo. */
  forceMono: boolean;
  /** EBU R128 loudness normalization (`loudnorm`) so clips sit at a consistent level. */
  normalize: boolean;
  /** Trim leading/trailing digital silence (`silenceremove`). */
  trimSilence: boolean;
  /** Output sample rate in Hz (ffmpeg `-ar`). `undefined`/0 keeps the source rate.
   *  A big size lever for SFX — 22050 halves the data vs 44100 with little audible
   *  loss on most effects. */
  sampleRate?: number;
  /** PCM bit depth for the lossless `wav` format (16/24/32). Ignored for other
   *  formats. Default 16 (`pcm_s16le`). */
  bitDepth?: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioImportSettings = {
  loadType: 'buffer',
  format: 'mp3',
  quality: 192,
  forceMono: false,
  normalize: false,
  trimSilence: false,
};

/** Selectable bitrates (kbps) surfaced in the inspector for lossy formats. */
export const AUDIO_BITRATES: number[] = [96, 128, 160, 192, 256, 320];

/** Selectable output sample rates (Hz). `0` = keep the source rate (no resample). */
export const AUDIO_SAMPLE_RATES: number[] = [0, 22050, 32000, 44100, 48000];

/** libopus accepts ONLY these input rates — forcing any other via `-ar` aborts the
 *  encode. (With no `-ar`, ffmpeg auto-negotiates to a supported rate; the crash is
 *  specific to an explicit unsupported `-ar`.) */
export const OPUS_SAMPLE_RATES_LEGAL: number[] = [8000, 12000, 16000, 24000, 48000];

/** Opus sample-rate options for the inspector (0 = source, auto-negotiated). */
export const OPUS_SAMPLE_RATES: number[] = [0, 24000, 48000];

/** Snap a requested rate to the nearest opus-legal rate (for `format: 'opus'`). */
export function nearestOpusSampleRate(rate: number): number {
  return OPUS_SAMPLE_RATES_LEGAL.reduce((best, r) =>
    Math.abs(r - rate) < Math.abs(best - rate) ? r : best, OPUS_SAMPLE_RATES_LEGAL[0]);
}

/** Selectable PCM bit depths for the `wav` format. */
export const AUDIO_BIT_DEPTHS: number[] = [16, 24, 32];

/** ffmpeg PCM codec for a wav bit depth (32 = float). Defaults to 16-bit. */
export function wavPcmCodec(bitDepth: number | undefined): string {
  switch (bitDepth) {
    case 24: return 'pcm_s24le';
    case 32: return 'pcm_f32le';
    default: return 'pcm_s16le';
  }
}

export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'aac', 'opus', 'wav', 'flac'];

/** File extension for a converted variant of the given format. */
export function audioFormatExtension(format: AudioFormat): string {
  switch (format) {
    case 'mp3': return 'mp3';
    case 'aac': return 'm4a';
    case 'opus': return 'opus';
    case 'wav': return 'wav';
    case 'flac': return 'flac';
  }
}

/** MIME type for a converted variant — used to set the served Content-Type. */
export function audioFormatMime(format: AudioFormat): string {
  switch (format) {
    case 'mp3': return 'audio/mpeg';
    case 'aac': return 'audio/mp4';
    case 'opus': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
  }
}

/** Suffix appended to the source path to form the deterministic served URL,
 *  e.g. `music.mp3` + `~audio.mp3`. Dev server and production build both serve
 *  the converted variant at this URL, so the runtime computes it without the hash. */
export function audioVariantSuffix(format: AudioFormat): string {
  return `~audio.${audioFormatExtension(format)}`;
}

/** Whether a lossy bitrate applies to this format (wav/flac are lossless). */
export function audioFormatIsLossy(format: AudioFormat): boolean {
  return format === 'mp3' || format === 'aac' || format === 'opus';
}

/** Cache bookkeeping persisted in the clip's meta sidecar (`audioCache`). `hash`
 *  keys the content cache (source bytes + settings + encoder version); the rest
 *  are post-conversion stats surfaced in the inspector. */
export interface AudioCacheInfo {
  hash: string;
  /** Extension of the produced variant file (derived from `format`). */
  ext: string;
  /** On-disk byte size of the converted variant. */
  bytes?: number;
  /** Duration in seconds (probed from the converted file when available). */
  durationSec?: number;
  channels?: number;
  sampleRate?: number;
}

/** Merge persisted settings over the defaults. Tolerates a missing/partial
 *  `audio` block (a clip with no import settings → all defaults). */
export function resolveAudioSettings(
  meta: { audio?: Partial<AudioImportSettings> } | null | undefined,
): AudioImportSettings {
  return { ...DEFAULT_AUDIO_SETTINGS, ...(meta?.audio ?? {}) };
}
