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

import { isGuid, registerAsset } from './assetManifest';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { assetUrl } from './assetUrl';
import { normalizeRig2D, type Rig2DFile, type ParsedRig2D } from '../skinning/rig2dTypes';
import { parseAssetJson } from './assetFetch';

export {
  type Rig2DBone, type Rig2DPart, type Rig2DFile, type ParsedRig2DPart, type ParsedRig2D,
  normalizeRig2D, coerceRigBones, resetRig2DWarningsForTests,
} from '../skinning/rig2dTypes';

const cache = new Map<string, ParsedRig2D>();
/** The AUTHORED doc each cached rig was parsed from, kept beside the parsed form.
 *
 *  `ParsedRig2D` is a runtime structure — packed `Float32Array`s, weights renormalized, v1
 *  promoted to v2 parts — so it is the wrong answer to "what does this asset say?". The agent
 *  read op (`read-asset-def`) reported it anyway, and every other asset kind's cache hands back
 *  the authored def, so rig2d was the one type whose answer did not match its file: weights came
 *  back at float32 precision and a QA run read that as the editor CORRUPTING the rig on load
 *  (QA-ASSET-0015 — the real disk churn was `removeBone`, elsewhere). Keeping the source makes the
 *  two questions separately answerable.
 *
 *  THE COST, stated rather than discovered: this retains the parsed JSON for every loaded rig, on
 *  the same lifetime as the parsed form (both are dropped together by `invalidateRig2D` /
 *  `clearRig2DCache`), in a shipped game as well as the editor. Bounded by the rig files
 *  themselves — 11 KB for `bar.rig2d.json`, 208 KB for `zombie.rig2d.json`, and a scene's rigs are
 *  released at the swap. Accepted over gating it on `__MODOKI_EDITOR__`: no `runtime/**` module
 *  references that global, and it resolves TRUE under vitest AND a plain `npm run dev`, so the
 *  gate would be wrong exactly where a developer runs their own game (the reasoning
 *  `tierCalibration.setTierFrameCapEnabled` records for the same trap). If rig memory ever
 *  matters, the sanctioned shape is an injected flag, not the build-time global. */
const sourceCache = new Map<string, Rig2DFile>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
let generation = 0;
// Parity fix, close-out sweep of QA-ANIM-0018: an unresolved guid used to fail silently here.
const unknownGuidSeen = new Set<string>();

/** Resolve a cache key. A GUID resolves through the manifest; the editor seeds /
 *  invalidates by file path directly (like spriteAnimCache). */
function rig2dCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRefWarnOnce(refOrPath, 'rig2dCache', unknownGuidSeen) : refOrPath;
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
        sourceCache.set(path, json as Rig2DFile);
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

/** The AUTHORED rig doc behind a cached rig — the file's own JSON (or the editor's live,
 *  unsaved def), NOT the runtime-parsed form {@link getRig2D} returns. PEEKs only: a rig
 *  nothing has loaded is `null`, never a fetch. For callers reporting what the asset SAYS
 *  (the `read-asset-def` agent op) rather than what the deform driver consumes. */
export function getRig2DSource(refOrPath: string): Rig2DFile | null {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return null;
  return sourceCache.get(path) ?? null;
}

/** Directly seed/override a cached rig by path or GUID (editor live-preview +
 *  post-save + tests). */
export function setRig2D(refOrPath: string, def: Rig2DFile): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  sourceCache.set(path, def);
  cache.set(path, normalizeRig2D(def));
  failed.delete(path);
}

/** Drop a cached rig so the next access re-fetches (e.g. after an external edit). */
export function invalidateRig2D(refOrPath: string): void {
  const path = rig2dCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  sourceCache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached rigs (scene swap / full resource disposal / test teardown). */
export function clearRig2DCache(): void {
  generation++;
  cache.clear();
  sourceCache.clear();
  loading.clear();
  failed.clear();
}
