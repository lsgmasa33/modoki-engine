/** Resolve a video ref (GUID or path) to the URL actually served.
 *
 *  Mirrors `servedAudioUrl` in audioBufferCache.ts. When the clip has been through the
 *  converter (its manifest entry carries a variant `ext` + content `hash`), the served
 *  file is the `~video.mp4?v=<hash>` variant — the production build DROPS the source in
 *  favour of it, so fetching the source path would 404 in prod while working in dev.
 *  That asymmetry is the whole reason this helper exists rather than a bare `assetUrl`. */

import { getAssetEntry } from './assetManifest';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { assetUrl, withCacheBust } from './assetUrl';
import { VIDEO_EXTENSION, resolveVideoSettings, resolveDeliveryPolicy } from './videoSettings';

function servedVideoUrl(path: string): string {
  const entry = getAssetEntry(path);
  const video = entry?.video;
  if (video?.ext && entry?.hash) {
    // `assetUrl()` wraps the FULL served-variant path (not just the source) so a
    // playable single-file build resolves it to the inlined blob: URL — the
    // __PLAYABLE_ASSETS__ map is keyed by the served path. `withCacheBust` is a no-op
    // in dev/editor (Vite serves without immutable caching).
    return withCacheBust(assetUrl(`${path}~video.${video.ext ?? VIDEO_EXTENSION}`), entry.hash);
  }
  return assetUrl(path);
}

/** Resolve a video ref to a fetchable URL. Undefined when the ref doesn't resolve. */
const unknownGuidSeen = new Set<string>();

export function resolveVideoUrl(ref: string): string | undefined {
  const path = resolveRefWarnOnce(ref, 'VideoUrl', unknownGuidSeen);
  return path ? servedVideoUrl(path) : undefined;
}

/** Everything the playback layer needs to decide HOW to get a clip's bytes.
 *
 *  Resolved here rather than in `videoSystem` because it needs the manifest, and the
 *  video subsystem is deliberately kept free of the loader stack. */
export interface VideoSource {
  url: string;
  /** `'auto'` is already resolved against the measured size — callers get a decision. */
  policy: 'stream' | 'download';
  /** Cache key: GUID + content hash, so a re-import is a DIFFERENT entry rather than
   *  silently serving stale bytes under the same key. */
  cacheKey: string;
  /** Encoded size when known, for progress + admission. */
  bytes?: number;
}

export function resolveVideoSource(ref: string): VideoSource | undefined {
  const path = resolveRefWarnOnce(ref, 'VideoUrl', unknownGuidSeen);
  if (!path) return undefined;
  const entry = getAssetEntry(path);
  const v = entry?.video;
  const url = servedVideoUrl(path);
  const settings = resolveVideoSettings(v ? { video: v } : null);
  const policy = resolveDeliveryPolicy(settings, v?.bytes);
  // A remote clip is fetched from its authored URL; the local path is only a fallback
  // for a clip marked remote that nobody gave a URL (which would otherwise 404 in a
  // production build, since the source is dropped in favour of the variant).
  const remote = settings.delivery === 'remote' ? settings.remoteUrl : undefined;
  return {
    url: remote ?? url,
    policy,
    // The hash is what makes a re-imported clip a new entry. Falling back to the path
    // alone would serve the OLD bytes forever after a re-import.
    cacheKey: `${entry?.guid ?? path}@${entry?.hash ?? 'nohash'}`,
    bytes: v?.bytes,
  };
}
