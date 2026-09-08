/**
 * Loads + caches `.spriteanim.json` sprite (flipbook) animation sets, resolving
 * GUID/path refs through the shared asset manifest. Mirrors animSetCache: the
 * first access kicks off an async fetch and returns null until it resolves; while
 * a load is PENDING the per-frame sprite driver (`spriteAnimationSystem`) simply
 * retries next frame. Note a FAILED fetch is remembered in `failed` and is NOT
 * retried at runtime (only invalidate/clear resets it) — same accepted trade-off
 * as animSetCache/animationClipCache. Sprite-anim sets are plain DATA (named clips
 * of sprite-slice GUIDs + timing) — nothing to GPU-dispose.
 *
 * A `.spriteanim.json` holds a NAMED SET of sprite clips: `{ id, clips: { <name>:
 * { frames: sprite-GUID[], fps, mode, cycles } } }`. The `SpriteAnimator` trait
 * references one by GUID (`clipSet`) + an active `clip` name; CharacterAnimator2D
 * maps states → clip names within the same set.
 *
 * NOT to be confused with `.animset.json` (animSetCache — skeletal/bone clips) or
 * `.anim.json` (animationClipCache — transform keyframe tracks for `Animator`).
 */

import { isGuid, registerAsset } from './assetManifest';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { assetUrl } from './assetUrl';
import { defaultSpriteClip, type SpriteClip } from '../traits/SpriteAnimator';
import { parseAssetJson } from './assetFetch';
import { createTeardownToken } from '../core/liveness';

/** The subset of a SpriteAnimator instance the resolvers below read. */
export interface SpriteAnimSource {
  clipSet?: string;
  clip?: string;
}

/** A named set of sprite clips — the `.spriteanim.json` payload. */
export interface SpriteAnimDef {
  id?: string;
  clips: Record<string, SpriteClip>;
}

const cache = new Map<string, SpriteAnimDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
/** Teardown liveness, captured per PATH before each load and re-checked after.
 *
 *  `invalidateAll()` is `clearSpriteAnimCache`'s (the whole cache is gone). A per-key
 *  `invalidateSpriteAnim` must NOT refuse an in-flight load of a DIFFERENT key — this cache is
 *  driven by the editor's file watcher, so an author saving one sprite-anim set would otherwise
 *  make a concurrent load of an unrelated set silently drop it — so it calls `invalidateKey`
 *  alone. Cleared wholesale by `clearSpriteAnimCache`, so the per-key map cannot outgrow the
 *  cache it shadows. */
const liveness = createTeardownToken<string>();
// Parity fix, close-out sweep of QA-ANIM-0018: an unresolved guid used to fail silently here.
const unknownGuidSeen = new Set<string>();

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like animSetCache). */
function spriteAnimCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRefWarnOnce(refOrPath, 'spriteAnimCache', unknownGuidSeen) : refOrPath;
}

/** Coerce arbitrary JSON into a well-formed clip (drop invalid frames, fill
 *  timing defaults) so downstream code never sees a malformed SpriteClip. */
function normalizeClip(raw: unknown): SpriteClip {
  const d = defaultSpriteClip();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const c = raw as Partial<SpriteClip>;
  return {
    ...c,
    frames: Array.isArray(c.frames) ? c.frames.filter((f): f is string => typeof f === 'string') : d.frames,
    fps: typeof c.fps === 'number' ? c.fps : d.fps,
    mode: c.mode === 'once' || c.mode === 'loop' || c.mode === 'pingpong' ? c.mode : d.mode,
    cycles: typeof c.cycles === 'number' ? c.cycles : d.cycles,
  };
}

/** `...json` FIRST, then the normalized fields on top. The Sprite Anim Editor parks and writes
 *  THIS object, so a key this function does not name would be deleted from the
 *  `.spriteanim.json` on the first save (`xukhAP0gWNnD9MFRHb0P`). Mirrors
 *  `normalizeAnimationClip` / `normalizeTimeline`. */
export function normalizeSpriteAnim(json: Partial<SpriteAnimDef> | undefined): SpriteAnimDef {
  const clips: Record<string, SpriteClip> = {};
  const src = json?.clips;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [name, clip] of Object.entries(src)) clips[name] = normalizeClip(clip);
  }
  return { ...json, id: json?.id, clips };
}

/** Resolve a sprite-anim ref to its parsed definition, or null if not yet loaded.
 *  Kicks off a lazy fetch on first miss (retried each frame by the caller). */
export function getSpriteAnim(ref: string, opts?: { load?: boolean }): SpriteAnimDef | null {
  if (!ref) return null;
  const path = spriteAnimCacheKey(ref);
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
    const p = fetch(assetUrl(path))
      .then((r) => {
        return parseAssetJson(r, path);
      })
      .then((json) => {
        if (!stillLive()) return; // scene swap or per-key invalidation mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Partial<SpriteAnimDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'spriteanim');
        cache.set(path, normalizeSpriteAnim(json as Partial<SpriteAnimDef>));
      })
      .catch((e) => {
        if (stillLive()) failed.add(path);
        console.warn(`[spriteAnimCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Resolve a single named clip within a sprite-anim set, or undefined if the set
 *  isn't loaded yet or has no clip by that name. Empty `clipName` picks the first
 *  clip (stable insertion order), mirroring `spriteAnimatorActiveClip`. */
export function resolveSpriteClip(ref: string, clipName: string): SpriteClip | undefined {
  const set = getSpriteAnim(ref);
  if (!set) return undefined;
  const name = clipName || Object.keys(set.clips)[0];
  return name ? set.clips[name] : undefined;
}

/** Resolve the clip a SpriteAnimator should play right now: the active `clip` (or the
 *  first) within its `clipSet` asset, resolved via the cache. Returns undefined when
 *  there's no clipSet, the asset isn't loaded yet (caller retries next frame), or the
 *  named clip is absent. */
export function activeSpriteClip(anim: SpriteAnimSource): SpriteClip | undefined {
  return anim.clipSet ? resolveSpriteClip(anim.clipSet, anim.clip ?? '') : undefined;
}

/** Does this animator's clipSet asset have a clip by `name`? Used by the character
 *  system to switch tracks only to a clip that actually exists. */
export function spriteAnimHasClip(anim: SpriteAnimSource, name: string): boolean {
  if (!name || !anim.clipSet) return false;
  return !!getSpriteAnim(anim.clipSet)?.clips[name];
}

/** Directly seed/override a cached set by path or GUID (editor live-preview + post-save). */
export function setSpriteAnim(refOrPath: string, def: Partial<SpriteAnimDef>): void {
  const path = spriteAnimCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeSpriteAnim(def));
  failed.delete(path);
}

/** Drop a cached set so the next access re-fetches (e.g. after an external edit). */
export function invalidateSpriteAnim(refOrPath: string): void {
  const path = spriteAnimCacheKey(refOrPath);
  if (!path) return;
  // An in-flight load is carrying the PRE-import bytes — refuse it, or it re-caches the stale def
  // on top of the fresh one. Precedent: fontLoader.invalidateFontFace. Bumped PER-KEY (not the
  // module-wide `invalidateAll()`, which is `clearSpriteAnimCache`'s): this cache is driven by the
  // editor's file watcher, so invalidating one set must not also refuse an in-flight load of a
  // DIFFERENT set.
  liveness.invalidateKey(path);
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached sets (scene swap / full resource disposal). */
export function clearSpriteAnimCache(): void {
  liveness.invalidateAll();
  cache.clear();
  loading.clear();
  failed.clear();
}
