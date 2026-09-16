/** createPreviewEnvironment — the neutral RoomEnvironment IBL both editor 3D previews use,
 *  with the one thing they each got wrong: ownership of the PMREM OUTPUT (#1277).
 *
 *  `PMREMGenerator.fromScene()` returns a **WebGLRenderTarget**, and that target is the caller's
 *  to free. Neither of the two disposals that LOOK like they cover it actually does:
 *
 *  - `generator.dispose()` frees the generator's own scratch (`_pingPongRenderTarget`, the LOD
 *    meshes, the blur/GGX/cubemap materials — `PMREMGenerator._dispose()`) and deliberately NOT
 *    the target it just handed back. `runtime/rendering/envPmrem.ts` says the same in situ.
 *  - `target.texture.dispose()` frees nothing either, and this is the non-obvious half. three
 *    registers `onTextureDispose` inside `initTexture` — the normal upload path — while a render
 *    target's texture is set up by `setupRenderTarget`, which registers `onRenderTargetDispose`
 *    on the TARGET instead. So an RT texture never gets `__webglInit`, and `deallocateTexture`
 *    opens with `if ( textureProperties.__webglInit === undefined ) return;`, making the call a
 *    no-op. (Read from three 0.185.1's `WebGLTextures.js` — the three functions named above are
 *    where each half lives; `deallocateTexture` carries the early return.)
 *
 *  Same target-vs-texture asymmetry #1269 hit in the post-FX stack — `docs/rendering.md`
 *  § "Disposal: a rebuild must free what three's OWN node dispose() misses".
 *
 *  ⚠️ LATENT today, and worth knowing why before "verifying" it: both previews build their own
 *  short-lived `WebGLRenderer` and `forceContextLoss()` it on teardown, which drops the whole GL
 *  context and takes the orphaned target with it. It becomes a real per-open leak the moment
 *  either preview re-IBLs without a teardown, or runs on a renderer handed back by
 *  `rendererLease.ts` across remounts. So a live `renderer.info.memory.renderTargets` watch shows
 *  nothing on today's path — the defect is established by reading three's source, not by a
 *  measurement.
 *
 *  Extracted rather than patched twice: the five-line block was copy-pasted into both panels,
 *  which is precisely why one defect sat in two files. `previewEnvOwnership.test.ts` census-guards
 *  against a third copy. */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { type TeardownScope } from '../../runtime/core/teardownScope';

/** Build the preview IBL for `renderer` and return the texture to assign to `scene.environment`.
 *  The PMREM output target it came from is released by `scope`, so a caller must NOT dispose the
 *  returned texture instead — on a render-target texture that call does nothing (see above), and
 *  believing otherwise is the whole of #1277. */
export function createPreviewEnvironment(renderer: THREE.WebGLRenderer, scope: TeardownScope): THREE.Texture {
  // Both constructed OUTSIDE the try so `finally` can always reach them: `fromScene()` is a real
  // GPU op, and by the time it can throw three has already allocated the ping-pong render target,
  // the LOD meshes and their materials. Neither caller freed those on a throw — both disposed on
  // the normal path only.
  //
  // ⚠️ What this `finally` does NOT buy, because the obvious reading is wrong and cost a review
  // round: it does **not** restore the renderer's previous render target. That restore lives in
  // `_cleanup()`, which three calls as the last statement of `fromScene()`/`_fromTexture()` — the
  // NORMAL path only. `dispose()` calls `_dispose()` (materials, ping-pong target, LOD geometries)
  // and never `_cleanup()`, in both the core and the WebGPU generator. So a throw mid-derivation
  // still strands the renderer on the PMREM's internal cube target; freeing the scratch is all
  // that is on offer here. Harmless for these two previews — the whole renderer dies on the same
  // teardown — but see `envPmrem.ts`, where the same gap sits on the LIVE shared renderer.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  try {
    const target = pmrem.fromScene(roomEnv, 0.04);
    scope.add(() => target.dispose());
    return target.texture;
  } finally {
    roomEnv.dispose();
    pmrem.dispose();
  }
}
