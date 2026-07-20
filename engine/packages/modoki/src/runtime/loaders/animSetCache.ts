/**
 * Loads + caches `.animset.json` skeletal animation sets, resolving GUID/path
 * refs through the shared asset manifest. Mirrors animationClipCache: the first
 * access kicks off an async fetch and returns null until it resolves; the
 * per-frame skeletal sync (`driveAnimator`) simply retries next frame. Animsets
 * are plain DATA (per-clip playback params) — nothing to GPU-dispose.
 *
 * An animset annotates the clips of a rigged GLB with per-clip playback defaults
 * (speed / loop / fadeDuration). The clips themselves still live in the model's
 * GLB (loaded via riggedModelCache); the animset only carries the params. Its
 * `source` (the GLB the clips belong to) is informational in P5 — P6's shared
 * clip library uses it to pull clips from a DIFFERENT GLB.
 *
 * NOT to be confused with `.anim.json` (animationClipCache): that's transform-
 * track animation for the `Animator` trait; this is skeletal/bone animation for
 * the `SkeletalAnimator` on a `SkinnedModel`.
 */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';

/** Per-clip playback parameters within an animset. All optional — a missing
 *  field falls back to the engine default (see ANIMSET_DEFAULTS), which is also
 *  the SkeletalAnimator trait default, so an entity that leaves a field at its
 *  default inherits the animset value. */
export interface AnimSetClipDef {
  name: string;
  speed?: number;
  loop?: boolean;
  fadeDuration?: number;
}

export interface AnimSetDef {
  id?: string;
  /** GLB ref the clips belong to (GUID/path). Informational in P5. */
  source?: string;
  clips: AnimSetClipDef[];
}

/** Fully-resolved per-clip params — every field present. */
export interface ResolvedAnimParams {
  speed: number;
  loop: boolean;
  fadeDuration: number;
}

/** Engine defaults for skeletal playback params. MUST match the SkeletalAnimator
 *  trait defaults — `driveAnimator` treats "field equals this default" as "no
 *  per-entity override, inherit the animset's per-clip value". */
export const ANIMSET_DEFAULTS: ResolvedAnimParams = Object.freeze({
  speed: 1,
  loop: true,
  fadeDuration: 0,
});

const cache = new Map<string, AnimSetDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like animationClipCache). */
function animSetCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

function normalizeAnimSet(json: Partial<AnimSetDef> | undefined): AnimSetDef {
  const clips = Array.isArray(json?.clips) ? json!.clips.filter((c) => c && typeof c.name === 'string') : [];
  return { id: json?.id, source: json?.source, clips };
}

/** Resolve an animset ref to its parsed definition, or null if not yet loaded.
 *  Kicks off a lazy fetch on first miss (retried each frame by the caller). */
export function getAnimSet(ref: string): AnimSetDef | null {
  if (!ref) return null;
  const path = animSetCacheKey(ref);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  if (failed.has(path)) return null;
  if (!loading.has(path)) {
    const gen = generation;
    const p = fetch(assetUrl(path))
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((json) => {
        if (gen !== generation) return;       // scene swap mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Partial<AnimSetDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'animset');
        cache.set(path, normalizeAnimSet(json as Partial<AnimSetDef>));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
        console.warn(`[animSetCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Resolve the playback params for a named clip within an animset, with engine
 *  defaults filled for every field. ALWAYS returns a full param object:
 *   - empty ref / not-yet-loaded / clip not listed → engine defaults
 *   - clip listed → its fields merged over engine defaults
 *
 *  So `driveAnimator` can apply `field !== default ? perEntity : resolved.field`
 *  uniformly: with no animset the resolved value IS the default, so the per-entity
 *  field always wins (today's behaviour); with an animset, leaving a field at its
 *  default inherits the per-clip value. */
export function resolveAnimSetParams(ref: string, clipName: string): ResolvedAnimParams {
  if (!ref) return ANIMSET_DEFAULTS;
  const set = getAnimSet(ref);
  if (!set) return ANIMSET_DEFAULTS;
  const clip = set.clips.find((c) => c.name === clipName);
  if (!clip) return ANIMSET_DEFAULTS;
  return {
    speed: clip.speed ?? ANIMSET_DEFAULTS.speed,
    loop: clip.loop ?? ANIMSET_DEFAULTS.loop,
    fadeDuration: clip.fadeDuration ?? ANIMSET_DEFAULTS.fadeDuration,
  };
}

/** Directly seed/override a cached animset by path or GUID (editor live-preview + post-save). */
export function setAnimSet(refOrPath: string, def: Partial<AnimSetDef>): void {
  const path = animSetCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeAnimSet(def));
  failed.delete(path);
}

/** Drop a cached animset so the next access re-fetches (e.g. after an external edit). */
export function invalidateAnimSet(refOrPath: string): void {
  const path = animSetCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached animsets (scene swap / full resource disposal). */
export function clearAnimSetCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
