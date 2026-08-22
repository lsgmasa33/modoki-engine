/** "A model's GPU-side data is now in a cache" — the completion edge of an async GLB load.
 *
 *  A leaf module with no imports on purpose: BOTH model caches fire it (`meshTemplateCache`
 *  for static mesh templates, `riggedModelCache` for skinned prototypes) and `meshTemplateCache`
 *  already imports `riggedModelCache`, so either cache owning the notifier would either create a
 *  cycle or split one concept across two names.
 *
 *  Why the edge needs a signal at all: the editor SceneView renders ON DEMAND. An editor
 *  re-import invalidates the cache and evicts the live meshes immediately (the renderer must drop
 *  its references before the GPU geometry is disposed), but the REBUILD only happens on a frame
 *  that actually runs. The viewport's dirty gate has a ~1s grace window and a GLB re-parse
 *  routinely outlasts it, so re-arming on the invalidation alone is not enough — the object
 *  vanished and stayed vanished, reading as data loss rather than a stale frame (QA-ASSET-0008,
 *  measured on games/space-console: 10s+, reproduced twice). The continuously-rendering GameView
 *  needs none of this. */

type ModelLoadedListener = (modelPath: string) => void;

const listeners = new Set<ModelLoadedListener>();

/** Subscribe to "this model's data is now in the cache". Returns an unsubscribe function. */
export function onModelTemplatesLoaded(fn: ModelLoadedListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Fire the load edge. Called by the caches AFTER the data is readable, never before — a
 *  redraw armed ahead of the cache write would draw the same empty frame and settle again.
 *  A throwing listener is contained: a load must not fail because an observer did. */
export function notifyModelTemplatesLoaded(modelPath: string): void {
  for (const fn of listeners) {
    try { fn(modelPath); }
    catch (e) { console.warn('[MeshCache] model-loaded listener threw:', e); }
  }
}
