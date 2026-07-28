/** The active-renderer handle — extracted out of `loaders/textureResolver.ts` (P7 C7) since it's
 *  a plain global registry (same shape as `core/playState.ts`), not something owned by texture
 *  loading. `loaders/textureResolver.ts` keeps its own `setActiveRenderer` wrapper (it still runs
 *  the KTX2 `detectSupport` side effect there) but delegates the handle + ready-state bookkeeping
 *  here, so the GPU particle backend (`particles/particleBackend.ts`) can read `getActiveRenderer`
 *  directly instead of reaching into `loaders/` for a renderer handle it has nothing else to do
 *  with. */

import type { WebGPURenderer } from 'three/webgpu';
import type * as THREE from 'three';

let activeRenderer: WebGPURenderer | THREE.WebGLRenderer | null = null;

/** Resolves on the FIRST `setActiveRendererHandle` call. Editor bootstrap awaits this before
 *  calling `sceneManager.loadScene()` so the KTX2 transcoder has the GPU caps it needs before
 *  any texture load fires — without that ordering, scene preload races renderer init and
 *  KTX2Loader.loadAsync throws "Missing initialization with .detectSupport()" on the first
 *  ASTC-variant material. Public so callers can await it directly. */
let _rendererReadyResolve: () => void;
export const rendererReady: Promise<void> = new Promise((r) => { _rendererReadyResolve = r; });
let rendererReadyFired = false;

/** The most recently activated renderer, or null before init. Used by the GPU
 *  particle backend to dispatch compute passes (the CPU backend needs no renderer
 *  ref — it uploads via instanced attributes at render time). */
export function getActiveRenderer(): WebGPURenderer | THREE.WebGLRenderer | null {
  return activeRenderer;
}

/** True once the renderer has been activated at least once. Callers that need to run a
 *  detection side effect exactly once on first activation gate on this. */
export function isRendererReadyFired(): boolean {
  return rendererReadyFired;
}

/** Store the active renderer handle and, on the FIRST call only, resolve `rendererReady`.
 *  Idempotent + cheap — safe to call from every renderer creation site. */
export function setActiveRendererHandle(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  activeRenderer = renderer;
  if (!rendererReadyFired) {
    rendererReadyFired = true;
    _rendererReadyResolve();
  }
}

/** Subscribe to the FIRST renderer activation. Used by callers that need to react once the
 *  renderer is known, without keeping their own ready-state bookkeeping. */
export function onRendererReady(fn: () => void): void {
  if (rendererReadyFired) { fn(); return; }
  rendererReady.then(fn);
}
