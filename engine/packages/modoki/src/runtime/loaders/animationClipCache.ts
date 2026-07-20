/**
 * Loads + caches `.anim.json` clip definitions, resolving GUID/path refs through
 * the shared asset manifest. Mirrors particleCache: the first call kicks off an
 * async fetch and returns null until it resolves; the per-frame animation system
 * simply retries next frame. Clips are plain data — nothing to GPU-dispose.
 */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { normalizeAnimationClip, type AnimationClipDef } from '../animation/types';

const cache = new Map<string, AnimationClipDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like particleCache). */
function clipCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

/** Resolve a clip ref to its parsed definition, or null if not yet loaded. */
export function getAnimationClip(ref: string): AnimationClipDef | null {
  if (!ref) return null;
  const path = clipCacheKey(ref);
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
        const id = (json as Partial<AnimationClipDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'animation');
        cache.set(path, normalizeAnimationClip(json as Partial<AnimationClipDef>));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
        console.warn(`[animationClipCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Directly seed/override a cached clip by path or GUID (editor live-preview + post-save). */
export function setAnimationClip(refOrPath: string, def: AnimationClipDef): void {
  const path = clipCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeAnimationClip(def));
  failed.delete(path);
}

/** Drop a cached clip so the next access re-fetches (e.g. after an external edit). */
export function invalidateAnimationClip(refOrPath: string): void {
  const path = clipCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached clips (scene swap / full resource disposal). */
export function clearAnimationClipCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
