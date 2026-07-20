/**
 * Loads + caches `.timeline.json` definitions, resolving GUID/path refs through the
 * shared asset manifest. Mirrors animationClipCache: the first call kicks off an async
 * fetch and returns null until it resolves; the per-frame timeline system simply retries
 * next frame. Timelines are plain data — nothing to GPU-dispose.
 */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { normalizeTimeline, type TimelineDef } from '../timeline/types';

const cache = new Map<string, TimelineDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like animationClipCache). */
function timelineCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

/** Resolve a timeline ref to its parsed definition, or null if not yet loaded. */
export function getTimeline(ref: string): TimelineDef | null {
  if (!ref) return null;
  const path = timelineCacheKey(ref);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  if (failed.has(path)) return null;
  if (!loading.has(path)) {
    const gen = generation;
    const p = fetch(assetUrl(path), ASSET_FETCH_INIT)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((json) => {
        if (gen !== generation) return;       // scene swap mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Partial<TimelineDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'timeline');
        cache.set(path, normalizeTimeline(json as Partial<TimelineDef>));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
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
  const gen = generation;
  try {
    const r = await fetch(assetUrl(path), ASSET_FETCH_INIT);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const json = (await r.json()) as Partial<TimelineDef>;
    if (gen !== generation) return null;
    const existing = cache.get(path);
    if (existing) return existing;
    const id = json?.id;
    if (id && isGuid(id)) registerAsset(id, path, 'timeline');
    const def = normalizeTimeline(json);
    cache.set(path, def);
    return def;
  } catch (e) {
    if (gen === generation) failed.add(path);
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
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached timelines (scene swap / full resource disposal). */
export function clearTimelineCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
