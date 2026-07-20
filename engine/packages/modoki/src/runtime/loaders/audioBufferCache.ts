/** Audio buffer cache — scene-scoped, refcounted, mirrors the HDR-environment
 *  cache in `meshTemplateCache.ts` (a parallel resource cache with its own
 *  `Map<path, Set<sceneId>>` ownership, like `riggedModelCache`).
 *
 *  Only `loadType: 'buffer'` clips are decoded + held here (short SFX): the file
 *  is fetched once and `decodeAudioData`'d into an `AudioBuffer`. `loadType:
 *  'stream'` clips (long music/ambience) are NEVER decoded — the service plays
 *  them via an `HTMLMediaElement`, so acquire only registers ownership (so the
 *  build tree-shaker keeps the file) and resolves the URL on demand.
 *
 *  Headless/SSR (no `AudioContext`): acquire still registers the owner but skips
 *  the decode — deterministic no-op, matching the texture/particle acquire cases.
 *
 *  Release is wholesale per scene (`releaseAudioForScene`), exactly like every
 *  other cache here — there is no mid-scene per-entity release. */

import { assetUrl, withCacheBust } from './assetUrl';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { addToOwnerSet, removeFromOwnerSet } from './ownerSet';
import { getAssetEntry, getAudioLoadType } from './assetManifest';
import { getAudioContext } from '../audio/audioContext';

type SceneId = number;

const audioBufferCache = new Map<string, AudioBuffer>();
const audioLoadPromises = new Map<string, Promise<void>>();
const audioOwners = new Map<string, Set<SceneId>>();

// Bumped by disposeAllAudioBuffers so an in-flight fetch/decode that resolves
// after a teardown is dropped instead of re-populating a dead cache.
let audioGeneration = 0;

const unknownGuidSeen = new Set<string>();
function refToPath(ref: string | undefined | null): string | undefined {
  return resolveRefWarnOnce(ref, 'AudioCache', unknownGuidSeen);
}

/** Look up a decoded buffer. Accepts guid or path. `undefined` if not preloaded
 *  (streaming clips, headless, or a still-in-flight decode). */
export function getCachedAudioBuffer(ref: string): AudioBuffer | undefined {
  const path = refToPath(ref);
  if (!path) return undefined;
  return audioBufferCache.get(path);
}

/** Map a source asset path to its actually-served URL. When the clip has been
 *  through the converter (its manifest entry carries a variant `ext` + content
 *  `hash`), that's the `~audio.<ext>?v=<hash>` variant the dev server / prod build
 *  serve in place of the (dropped) source; otherwise the source file itself. Used
 *  by BOTH streaming playback and the buffer decode so they never fetch a source
 *  that a production build dropped in favour of the converted variant. */
function servedAudioUrl(path: string): string {
  const entry = getAssetEntry(path);
  const audio = entry?.audio;
  if (audio?.ext && entry?.hash) {
    // Convention (matches modelGlbUrl / resolveTextureVariantUrl): the `~audio.<ext>`
    // variant URL is always used when converted; the `?v=<hash>` cache-bust is
    // appended ONLY in a production build (dev + editor serve via Vite, no immutable
    // caching), so `withCacheBust` is a no-op in dev/tests. assetUrl() wraps the FULL
    // served-variant path (not just the source) so a playable single-file build resolves
    // it to the inlined blob: URL — the __PLAYABLE_ASSETS__ map is keyed by the served path.
    return withCacheBust(assetUrl(`${path}~audio.${audio.ext}`), entry.hash);
  }
  return assetUrl(path);
}

/** Resolve an audio ref (guid or path) to a fetchable URL, for streaming playback. */
export function resolveAudioUrl(ref: string): string | undefined {
  const path = refToPath(ref);
  return path ? servedAudioUrl(path) : undefined;
}

/** Acquire an audio clip for a scene. `stream` clips register ownership only;
 *  `buffer` clips (default) also fetch + decode into the cache. Accepts guid or path. */
export async function acquireAudio(
  sceneId: SceneId,
  ref: string,
  loadType: 'buffer' | 'stream' = 'buffer',
): Promise<void> {
  const path = refToPath(ref);
  if (!path) return;
  addToOwnerSet(audioOwners, path, sceneId);
  if (loadType === 'stream') return; // played via HTMLMediaElement — never decoded here
  await fetchAudioBuffer(path);
}

/** Release a scene's holds on every audio clip it acquired. Disposes buffers whose
 *  last owner is gone. Called from `releaseAllForScene` in meshTemplateCache. */
export function releaseAudioForScene(sceneId: SceneId): void {
  for (const path of [...audioOwners.keys()]) {
    if (audioOwners.get(path)?.has(sceneId)) {
      const wasLast = removeFromOwnerSet(audioOwners, path, sceneId);
      if (wasLast) {
        audioBufferCache.delete(path);
        audioLoadPromises.delete(path);
      }
    }
  }
}

/** Drop the decoded buffer for one clip (guid or path) so the next acquire
 *  re-fetches + re-decodes. Owners are kept — this is a content invalidation
 *  (e.g. the editor re-converted the clip via the Audio Inspector), not a
 *  release. Mirrors `invalidateTexture`. */
export function invalidateAudio(ref: string): void {
  const path = refToPath(ref);
  if (!path) return;
  // Bump the generation so an in-flight fetch/decode of the OLD bytes is discarded
  // by fetchAudioBuffer's `gen !== audioGeneration` guard instead of racing the
  // stale buffer back into the cache after we clear it (same reason
  // disposeAllAudioBuffers bumps it).
  audioGeneration++;
  audioBufferCache.delete(path);
  audioLoadPromises.delete(path);
}

/** Debug/test snapshot: per-path owner counts + decoded-buffer count. */
export function getAudioCacheStats(): { owners: Record<string, number>; buffers: number } {
  const owners: Record<string, number> = {};
  for (const [path, set] of audioOwners) owners[path] = set.size;
  return { owners, buffers: audioBufferCache.size };
}

/** Full teardown — drop every buffer + owner and invalidate in-flight decodes. */
export function disposeAllAudioBuffers(): void {
  audioGeneration++;
  audioBufferCache.clear();
  audioLoadPromises.clear();
  audioOwners.clear();
}

/** Re-attempt every owned buffer clip that has no decoded buffer yet. iOS/WKWebView
 *  rejects `decodeAudioData` while the AudioContext is still suspended, so the eager
 *  decodes fired at scene-load (before any user gesture) all fail there. Call this
 *  once the context has RESUMED (from `audioService.resume()`, on the first gesture)
 *  to decode them for real. Skips clips already cached or in-flight, so it's a cheap
 *  no-op on desktop (where the load-time decode already succeeded). */
export function retryFailedAudioDecodes(): void {
  for (const path of audioOwners.keys()) {
    // Only buffer clips are decoded; stream clips (played via HTMLMediaElement) are
    // owned but never cached, so skip them or we'd pointlessly try to decode music.
    if (getAudioLoadType(path) !== 'buffer') continue;
    if (!audioBufferCache.has(path) && !audioLoadPromises.has(path)) void fetchAudioBuffer(path);
  }
}

/** Fetch audio bytes over XHR. iOS/WKWebView returns audio-MIME content requested
 *  via `fetch()` as an UNREADABLE status-0 response (the bytes never arrive — verified
 *  on device: fetch→status 0/0B, XHR→2551B for the same clip), while a JSON asset
 *  fetches fine. So audio can't use the shared `fetch(assetUrl,…)` path. `XMLHttpRequest`
 *  with `responseType='arraybuffer'` reads it on every platform. The capacitor:// scheme
 *  often reports status 0 even on success, so accept any non-empty body. */
function xhrAudioBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const buf = xhr.response as ArrayBuffer | null;
      if (buf && buf.byteLength > 0) resolve(buf);
      else reject(new Error(`empty audio response (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`XHR error (HTTP ${xhr.status})`));
    xhr.send();
  });
}

function fetchAudioBuffer(path: string): Promise<void> {
  if (audioBufferCache.has(path)) return Promise.resolve();
  const inflight = audioLoadPromises.get(path);
  if (inflight) return inflight;

  const ctx = getAudioContext();
  if (!ctx) return Promise.resolve(); // headless — owner registered, no decode

  const gen = audioGeneration;
  const promise = (async () => {
    try {
      const bytes = await xhrAudioBytes(servedAudioUrl(path));
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bytes);
      } catch (decodeErr) {
        // decodeAudioData rejects with a DOMException that serializes to `{}` in the
        // native console — log its name/message + the byte count so an iOS-only decode
        // failure (e.g. WKWebView refusing a codec) is diagnosable from device logs.
        const e = decodeErr as { name?: string; message?: string };
        throw new Error(`decodeAudioData ${e?.name ?? 'error'}: ${e?.message ?? decodeErr} (${bytes.byteLength}B, ctx ${ctx.state} @${ctx.sampleRate}Hz)`);
      }
      // Dropped mid-load (teardown or last owner released)? Discard the result
      // rather than leaving an owner-less buffer resident forever.
      if (gen !== audioGeneration || !audioOwners.has(path)) return;
      audioBufferCache.set(path, buffer);
    } catch (err) {
      // Stringify the message — the Capacitor native console serializes a raw
      // Error/DOMException to `{}`, hiding WHICH step failed (fetch vs decode) and why.
      const e = err as { name?: string; message?: string };
      console.warn(`[AudioCache] load failed for ${path}: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`);
    }
  })().finally(() => {
    audioLoadPromises.delete(path);
  });

  audioLoadPromises.set(path, promise);
  return promise;
}
