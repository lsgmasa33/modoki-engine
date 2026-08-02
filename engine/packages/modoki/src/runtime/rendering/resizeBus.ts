/** resizeBus — a tiny module-level fan-out for "re-run every surface's resize handler NOW".
 *
 *  Why this exists: `Canvas2DMount.measure()` and `Scene3D`'s ResizeObserver callback both
 *  already re-read `getRenderSettings()` every time they run — they never cache or diff the
 *  settings themselves. So a LIVE render-settings change (e.g. a pixel-ratio-cap flip) doesn't
 *  need anything to observe or diff the config; it only needs those handlers re-invoked once,
 *  synchronously, on demand. This module is that trigger: a plain registry of "please
 *  re-measure" callbacks with one broadcast function.
 *
 *  Current caller: the debug menu's Device tab (a QA control for A/B-ing 2D vs 3D backing
 *  resolution on-device without a rebuild) — NOT gameplay. Nothing in normal game/editor code
 *  should need to force a resize; the ResizeObserver/DOM already drive it.
 *
 *  COVERAGE, if you extend the flip to another setting: a broadcast reaches exactly the two
 *  handlers registered here (Canvas2DMount, Scene3D), which is total for `pixelRatioCap`
 *  because they are its only consumers. It is NOT total for `rendering.web`: the shipped
 *  shell's letterbox container is sized by `app/useWebCanvasSizing.ts`, which listens to
 *  window resize and is not on this bus — so a live `sizeMode` flip would restyle nothing
 *  and look broken. Register it there rather than assuming this bus is exhaustive.
 *  (`makeWebGPURenderer` and `canvas2DPool` read settings at CREATION — backend/antialias
 *  cannot change without rebuilding the renderer, so they are deliberately unreachable here.)
 */

const listeners = new Set<() => void>();

export function onForceResize(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function forceResizeAllSurfaces(): void {
  // Iterate a COPY: a listener that unsubscribes itself (or another listener) during the
  // callback must not corrupt the live Set's iteration or skip a sibling.
  for (const cb of [...listeners]) {
    cb();
  }
}
