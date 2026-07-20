/** Draw-call probe — makes per-frame draw-call / triangle stats accurate under
 *  multi-pass rendering (the NPR composer + WebGPU).
 *
 *  Three's renderer resets `renderer.info` at the START of every `render()`. With
 *  post-processing there are MANY render()s per frame, so by the time you read
 *  `info.render.drawCalls` it reflects only the last pass (≈0 for a fullscreen
 *  composite). And on WebGPU `info.render.calls` is a LIFETIME cumulative counter
 *  (three.js #32031), which is why the raw number "kept climbing".
 *
 *  The official fix (three.js Info docs): set `info.autoReset = false` and call
 *  `info.reset()` ONCE per frame. We do that from a frame callback scheduled just
 *  before the 3D render (PRIORITY_RENDER_3D − 1), so drawCalls/triangles accumulate
 *  across all of the frame's passes. Nothing else in the engine reads `renderer.info`,
 *  so flipping autoReset here is safe. Installed when the (enabled) debug menu loads.
 *
 *  Single-renderer (shipped game) → exact. The editor has a second on-demand renderer
 *  (SceneView); we reset whichever `getActiveRenderer()` reports, so the editor number
 *  is best-effort. */

import { registerFrameCallback, PRIORITY_RENDER_3D } from '../rendering/frameDriver';
import { getActiveRenderer } from '../loaders/textureResolver';

let installed = false;

interface InfoLike {
  autoReset: boolean;
  reset(): void;
}

export function installDrawCallProbe(): void {
  if (installed) return;
  installed = true;
  registerFrameCallback(
    'debug-drawcall-probe',
    () => {
      const r = getActiveRenderer() as unknown as { info?: InfoLike } | null;
      if (!r?.info) return;
      // Turn off per-render() auto-reset (idempotent) and clear once per frame, so the
      // upcoming render passes accumulate a true per-frame draw-call/triangle total.
      r.info.autoReset = false;
      r.info.reset();
    },
    PRIORITY_RENDER_3D - 1,
  );
}
