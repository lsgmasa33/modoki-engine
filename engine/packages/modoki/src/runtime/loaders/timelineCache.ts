/**
 * Loads + caches `.timeline.json` definitions, resolving GUID/path refs through the
 * shared asset manifest. Mirrors animationClipCache: the first call kicks off an async
 * fetch and returns null until it resolves; the per-frame timeline system simply retries
 * next frame. Timelines are plain data — nothing to GPU-dispose.
 */

import { isGuid, registerAsset } from './assetManifest';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT, parseAssetJson } from './assetFetch';
import { normalizeTimeline, type TimelineDef } from '../timeline/types';

const cache = new Map<string, TimelineDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;
/** Per-PATH invalidation epoch, checked alongside `generation` by every in-flight load.
 *
 *  `generation` is module-wide and belongs to `clearTimelineCache` (the whole cache is gone). A
 *  per-key `invalidateTimeline` must NOT refuse an in-flight load of a DIFFERENT key: this cache
 *  is driven by the editor's file watcher, so an author saving one timeline would otherwise make
 *  a concurrent scene load silently drop an unrelated one. Cleared wholesale by
 *  `clearTimelineCache`, so it cannot outgrow the cache it shadows. */
const keyEpoch = new Map<string, number>();
const epochOf = (path: string): number => keyEpoch.get(path) ?? 0;
// Parity fix, close-out sweep of QA-ANIM-0018: an unresolved guid used to fail silently here.
const unknownGuidSeen = new Set<string>();

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like animationClipCache). */
function timelineCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRefWarnOnce(refOrPath, 'timelineCache', unknownGuidSeen) : refOrPath;
}

/** Resolve a timeline ref to its parsed definition, or null if not yet loaded. */
export function getTimeline(ref: string, opts?: { load?: boolean }): TimelineDef | null {
  if (!ref) return null;
  const path = timelineCacheKey(ref);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  if (failed.has(path)) return null;
  // `load:false` — PEEK the cache without starting a fetch. For callers whose contract is "what is
  // in the live cache right now" (the `read-asset-def` agent op): the default getter treats a miss
  // as "not loaded YET" and kicks off a background load, so asking about an absent asset queued a
  // fetch that could only fail, and logged a warning into the human's console for a question the
  // caller had already decided to answer with a refusal.
  if (opts?.load === false) return null;
  if (!loading.has(path)) {
    const gen = generation;
    const ep = epochOf(path);
    const p = fetch(assetUrl(path), ASSET_FETCH_INIT)
      .then((r) => {
        return parseAssetJson(r, path);
      })
      .then((json) => {
        if (gen !== generation || ep !== epochOf(path)) return; // scene swap or per-key invalidation mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Partial<TimelineDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'timeline');
        cache.set(path, normalizeTimeline(json as Partial<TimelineDef>));
      })
      .catch((e) => {
        if (gen === generation && ep === epochOf(path)) failed.add(path);
        console.warn(`[timelineCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Fetch + cache a timeline by GUID or resolved PATH and RETURN its parsed def (or null on
 *  failure). Used by SceneManager's transitive-ref walk, which needs the def synchronously-
 *  awaitably to pull out its audio-cue GUIDs (getTimeline's return is null-until-loaded).
 *  Resolves a GUID through the manifest (like getTimeline) so every caller is covered.
 *  Idempotent — a cache hit resolves immediately. */
export async function loadTimelineNow(refOrPath: string): Promise<TimelineDef | null> {
  const path = timelineCacheKey(refOrPath);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  return loadTimelineNowAttempt(path, 1);
}

/** Bounded retry helper for {@link loadTimelineNow}. A generation/epoch mismatch after the fetch
 *  settles means "the bytes I fetched are stale, refetch" — NOT "this timeline does not exist".
 *  `loadTimelineNow` is one-shot (unlike the other five caches' getters, which are read through a
 *  per-frame retry loop that self-heals a refusal next frame), and its single consumer
 *  (`SceneManager.ts`'s transitive-ref walk) reads a `null` as "this timeline has no refs" and
 *  swallows it with no retry — so a refusal here must retry itself instead of surfacing null. */
const LOAD_TIMELINE_NOW_MAX_ATTEMPTS = 3;
async function loadTimelineNowAttempt(path: string, attempt: number): Promise<TimelineDef | null> {
  const gen = generation;
  const ep = epochOf(path);
  try {
    const r = await fetch(assetUrl(path), ASSET_FETCH_INIT);
    // A missing asset arrives as 200 OK index.html (dev server SPA fallback) — parseAssetJson detects it.
    const json = (await parseAssetJson(r, path)) as Partial<TimelineDef>;
    if (gen !== generation || ep !== epochOf(path)) {
      if (attempt >= LOAD_TIMELINE_NOW_MAX_ATTEMPTS) {
        console.warn(`[timelineCache] ${path} was invalidated ${attempt} times while loading; giving up — its refs will be missing from the scene's resource manifest`);
        return null;
      }
      return loadTimelineNowAttempt(path, attempt + 1);
    }
    const existing = cache.get(path);
    if (existing) return existing;
    const id = json?.id;
    if (id && isGuid(id)) registerAsset(id, path, 'timeline');
    const def = normalizeTimeline(json);
    cache.set(path, def);
    return def;
  } catch (e) {
    if (gen === generation && ep === epochOf(path)) failed.add(path);
    console.warn(`[timelineCache] failed to load ${path}:`, e);
    return null;
  }
}

/** Directly seed/override a cached timeline by path or GUID (editor live-preview + post-save). */
export function setTimeline(refOrPath: string, def: TimelineDef): void {
  const path = timelineCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeTimeline(def));
  failed.delete(path);
}

/** Drop a cached timeline so the next access re-fetches (e.g. after an external edit). */
export function invalidateTimeline(refOrPath: string): void {
  const path = timelineCacheKey(refOrPath);
  if (!path) return;
  // An in-flight load is carrying the PRE-import bytes — refuse it, or it re-caches the stale def
  // on top of the fresh one. Precedent: fontLoader.invalidateFontFace. Bumped PER-KEY (not the
  // module-wide `generation`, which is `clearTimelineCache`'s): this cache is driven by the
  // editor's file watcher, so invalidating one timeline must not also refuse an in-flight load of
  // a DIFFERENT timeline.
  keyEpoch.set(path, epochOf(path) + 1);
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached timelines (scene swap / full resource disposal). */
export function clearTimelineCache(): void {
  generation++;
  keyEpoch.clear();
  cache.clear();
  loading.clear();
  failed.clear();
}
