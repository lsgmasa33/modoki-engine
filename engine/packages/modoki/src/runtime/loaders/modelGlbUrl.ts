/** Resolve a model GLB / LOD / processed-variant path to its served URL,
 *  appending the model's content hash as `?v=<hash>` in PRODUCTION builds so a
 *  re-import (new hash → new URL) busts immutable browser/CDN caches — the
 *  model-side mirror of `resolveTextureVariantUrl`.
 *
 *  Derived paths (`<model>.glb.processed.glb` / `.glb.lod<N>.glb`) carry no
 *  manifest entry of their own, so the hash is derived from the base model
 *  entry. Dev + the packaged editor serve via the Vite dev server
 *  (query-agnostic, no immutable caching), so no `?v` is added there.
 *
 *  This lives in its own leaf module (depending only on `assetManifest` +
 *  `assetUrl`) so BOTH the static `meshTemplateCache` and the rigged
 *  `riggedModelCache` can use it without a circular import — meshTemplateCache
 *  imports riggedModelCache, so the helper can't live in either cache. */

import { getAssetEntry, resolveRef, isGuid } from './assetManifest';
import { assetUrl, withCacheBust } from './assetUrl';

/** Resolve a ref to a concrete path, warning ONCE per unresolved guid.
 *  Shared core for both caches' `refToPath` (F12): a missing/typo'd guid
 *  otherwise renders nothing (invisible mesh / black material) with only
 *  repeated console noise; this surfaces it once, clearly. External URLs and
 *  internal-path rejection are handled by `resolveRef`. `label` is the caller's
 *  log tag (e.g. `MeshCache`/`RiggedCache`); `seen` is the caller's own
 *  one-time-warned set (kept per-cache so the warning fires once per cache).
 *  Returns undefined if a GUID isn't in the manifest. */
export function resolveRefWarnOnce(
  ref: string | undefined | null,
  label: string,
  seen: Set<string>,
): string | undefined {
  if (!ref) return undefined;
  const path = resolveRef(ref);
  if (isGuid(ref) && !path && !seen.has(ref)) {
    seen.add(ref);
    console.warn(`[${label}] Unknown asset guid: ${ref}\n  (not in the manifest — dropped from the build, renamed, or never assigned an id?)`);
  }
  return path;
}

export function modelGlbUrl(path: string): string {
  let hash = getAssetEntry(path)?.hash;
  if (!hash) {
    const base = path.replace(/\.processed\.glb$|\.lod\d+\.glb$/, '');
    if (base !== path) hash = getAssetEntry(base)?.hash;
  }
  return withCacheBust(assetUrl(path), hash);
}
