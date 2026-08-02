/** A throwaway WebGPU/WebGL2 renderer created SOLELY to run `KTX2Loader.detectSupport` when no
 *  real viewport ever registers one (see `ensureKtx2Caps` in `../loaders/textureResolver.ts`).
 *
 *  Uses `makeWebGPURenderer` — the SAME backend-selection path a real SceneView/GameView
 *  viewport uses — so the detected caps match what a real renderer would report. Verified against
 *  `node_modules/three/examples/jsm/loaders/KTX2Loader.js`: `detectSupport()` copies capability
 *  BOOLEANS into `workerConfig` synchronously and keeps no reference to the renderer, so the
 *  caller may dispose the probe immediately afterward with no dangling-reference risk. */

import type { WebGPURenderer } from 'three/webgpu';
import { makeWebGPURenderer } from './scene3DSync';

/** Create a probe renderer, purely for capability detection. The container div is briefly
 *  attached to `document.body` — off-screen and non-interactive — because `makeWebGPURenderer`
 *  sizes the renderer from `container.clientWidth`/`clientHeight`, which is always `0` for an
 *  element that was never part of the document, regardless of inline style. The container is
 *  detached again before this resolves; the returned renderer is the caller's to dispose. */
export async function createCapsProbeRenderer(): Promise<WebGPURenderer> {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;pointer-events:none;';
  document.body.appendChild(container);
  try {
    return await makeWebGPURenderer(container);
  } finally {
    container.remove();
  }
}
