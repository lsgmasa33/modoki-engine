/**
 * Loads + caches `.anim.json` clip definitions, resolving GUID/path refs through
 * the shared asset manifest. Mirrors particleCache: the first call kicks off an
 * async fetch and returns null until it resolves; the per-frame animation system
 * simply retries next frame. Clips are plain data — nothing to GPU-dispose.
 */

import { isGuid, registerAsset } from './assetManifest';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT, parseAssetJson } from './assetFetch';
import { normalizeAnimationClip, type AnimationClipDef } from '../animation/types';
import { createTeardownToken } from '../core/liveness';

const cache = new Map<string, AnimationClipDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
/** Teardown liveness, captured per PATH before each load and re-checked after.
 *
 *  `invalidateAll()` is `clearAnimationClipCache`'s (the whole cache is gone). A per-key
 *  `invalidateAnimationClip` must NOT refuse an in-flight load of a DIFFERENT key — this cache is
 *  driven by the editor's file watcher, so an author saving one clip would otherwise make a
 *  concurrent load of an unrelated clip silently drop it — so it calls `invalidateKey` alone.
 *  Cleared wholesale by `clearAnimationClipCache`, so the per-key map cannot outgrow the cache it
 *  shadows. */
const liveness = createTeardownToken<string>();

// `runtime/animation/**` had ZERO console.warn calls for an unresolved ref, unlike its 3D
// (`[MeshCache] Unknown asset guid: …`) and 2D-sprite siblings — an Animator whose bank
// references a deleted/renamed-away clip GUID posed nothing, with no trace in the console.
// `resolveRefWarnOnce` is the shared fix both those already use: warn once per guid, forget on
// resolve so a later genuine break warns again (QA-ANIM-0018).
const unknownGuidSeen = new Set<string>();

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like particleCache). */
function clipCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRefWarnOnce(refOrPath, 'animationClipCache', unknownGuidSeen) : refOrPath;
}

/** Resolve a clip ref to its parsed definition, or null if not yet loaded. */
export function getAnimationClip(ref: string, opts?: { load?: boolean }): AnimationClipDef | null {
  if (!ref) return null;
  const path = clipCacheKey(ref);
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
    const stillLive = liveness.capture(path);
    const p = fetch(assetUrl(path), ASSET_FETCH_INIT)
      .then((r) => {
        return parseAssetJson(r, path);
      })
      .then((json) => {
        if (!stillLive()) return; // scene swap or per-key invalidation mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Partial<AnimationClipDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'animation');
        cache.set(path, normalizeAnimationClip(json as Partial<AnimationClipDef>));
      })
      .catch((e) => {
        if (stillLive()) failed.add(path);
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
  // An in-flight load is carrying the PRE-import bytes — refuse it, or it re-caches the stale def
  // on top of the fresh one. Precedent: fontLoader.invalidateFontFace. Bumped PER-KEY (not the
  // module-wide `invalidateAll()`, which is `clearAnimationClipCache`'s): this cache is driven by the
  // editor's file watcher, so invalidating one clip must not also refuse an in-flight load of a
  // DIFFERENT clip.
  liveness.invalidateKey(path);
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached clips (scene swap / full resource disposal). */
export function clearAnimationClipCache(): void {
  liveness.invalidateAll();
  cache.clear();
  loading.clear();
  failed.clear();
}
