/** assetInvalidation — the ONE event fired when an editor re-import rewrites the
 *  bytes behind an asset path, so caches and panels can drop what they derived
 *  from the old bytes.
 *
 *  WHY ONE EVENT AND NOT THREE (#304): the model half had `onModelInvalidated`
 *  and the texture + audio halves had nothing, so no texture-side panel could be
 *  told a re-import happened. `invalidateAudio` already documents itself as
 *  mirroring `invalidateTexture`, which made a third parallel one-off the default
 *  outcome. A single registry keyed by `kind` means the next invalidatable asset
 *  kind adds an emit call and nothing else.
 *
 *  L0 on purpose: it imports nothing, so every cache module in L3 `loaders/` can
 *  emit through it without an import cycle between them.
 *
 *  Listeners run BEFORE the emitting cache evicts anything. That ordering is
 *  load-bearing for models — a renderer must drop its live THREE.Mesh references
 *  before the underlying GPU geometry is disposed, or the next render dies on a
 *  freed buffer. Texture and audio have no such constraint, but they keep the
 *  same ordering: one rule to reason about beats three. */

export type InvalidatedAssetKind = 'model' | 'texture' | 'audio' | 'environment';

/** Not every re-importable asset type is here, and the absences were measured (#304
 *  close-out). `font` has its OWN channel — `onFontInvalidated` in `assetManifest`,
 *  fired when a manifest entry's hash changes, which both font caches already
 *  subscribe to — so a font re-import from any path already refreshes. `atlas` and
 *  `video` hold no engine-side cache to evict: atlas frames are read straight off the
 *  manifest, and a video streams from its URL. Add a kind here when a cache exists
 *  that a re-import would otherwise leave serving stale bytes. */

/** `path` is the source asset path whose bytes changed. `targets` names every
 *  path whose cached derivations are about to be dropped — for a model that is
 *  the source GLB PLUS its baked LOD siblings, so a subscriber keyed on an LOD
 *  file still matches; for texture/audio it is just the source path. */
export type AssetInvalidationListener = (
  kind: InvalidatedAssetKind,
  path: string,
  targets: ReadonlySet<string>,
) => void;

const listeners = new Set<AssetInvalidationListener>();

/** Subscribe to asset-invalidation events. Returns an unsubscribe function.
 *  Filter on `kind` yourself — a subscriber that cares about one kind is the
 *  common case, and `onModelInvalidated` is exactly that wrapper. */
export function onAssetInvalidated(fn: AssetInvalidationListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Fire the event. Call it BEFORE evicting, and let a throwing listener not take
 *  the eviction down with it — a panel that fails to refresh is a stale readout,
 *  while a half-evicted cache is a crash on the next frame. */
export function emitAssetInvalidated(
  kind: InvalidatedAssetKind,
  path: string,
  targets: ReadonlySet<string> = new Set([path]),
): void {
  for (const fn of listeners) {
    try { fn(kind, path, targets); }
    catch (e) { console.warn(`[assetInvalidation] ${kind} listener threw:`, e); }
  }
}

/** Test teardown only — drop every subscription. Production code unsubscribes
 *  through the function `onAssetInvalidated` returned. */
export function clearAssetInvalidationListeners(): void {
  listeners.clear();
}
