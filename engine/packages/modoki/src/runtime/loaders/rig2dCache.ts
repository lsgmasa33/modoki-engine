/** Loads + caches `.rig2d.json` 2D skinning rigs, resolving GUID/path refs through
 *  the shared asset manifest. Mirrors `spriteAnimCache`: the first access kicks off
 *  an async fetch and returns null until it resolves; while a load is PENDING the
 *  per-frame deform driver (`skin2DSystem`) simply retries next frame. A FAILED
 *  fetch is remembered in `failed` and NOT retried at runtime (only invalidate/clear
 *  resets it). A rig is plain DATA (mesh + bind-pose bones + weights) — nothing to
 *  GPU-dispose; the backing texture is owned by the sprite/scene-resource lifecycle.
 *
 *  The rig TYPES + normalization moved to `skinning/rig2dTypes.ts` (P7 C13) — re-exported
 *  here for existing callers. This file keeps only the fetch/cache lifecycle. */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';
import { normalizeRig2D, type Rig2DFile, type ParsedRig2D } from '../skinning/rig2dTypes';
import { parseAssetJson } from './assetFetch';

export {
  type Rig2DBone, type Rig2DPart, type Rig2DFile, type ParsedRig2DPart, type ParsedRig2D,
  normalizeRig2D, coerceRigBones,
} from '../skinning/rig2dTypes';

const cache = new Map<string, ParsedRig2D>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like spriteAnimCache). */
function rig2dCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

/** Resolve a rig ref to its parsed rig, or null if not yet loaded. Kicks off a lazy
 *  fetch on first miss (retried each frame by the caller). */
export function getRig2D(ref: string, opts?: { load?: boolean }): ParsedRig2D | null {
  if (!ref) return null;
  const path = rig2dCacheKey(ref);
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
    const p = fetch(assetUrl(path))
      .then((r) => {
        return parseAssetJson(r, path);
      })
      .then((json) => {
        if (gen !== generation) return;       // scene swap mid-flight
        if (cache.has(path)) return;          // editor live-preview seeded it
        const id = (json as Rig2DFile)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'rig2d');
        cache.set(path, normalizeRig2D(json as Rig2DFile));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
        console.warn(`[rig2dCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Directly seed/override a cached rig by path or GUID (editor live-preview +
 *  post-save + tests). */
export function setRig2D(refOrPath: string, def: Rig2DFile): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeRig2D(def));
  failed.delete(path);
}

/** Drop a cached rig so the next access re-fetches (e.g. after an external edit). */
export function invalidateRig2D(refOrPath: string): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached rigs (scene swap / full resource disposal / test teardown). */
export function clearRig2DCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
