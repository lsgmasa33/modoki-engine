/** Guard: every bare `THREE.WebGLRenderer` construction site also calls `forceContextLoss`.
 *
 *  In the pinned `three@0.185.1`, `WebGLRenderer.dispose()` (`WebGLRenderer.js:1074-1097`) removes
 *  canvas listeners and disposes JS-side caches but does NOT release the underlying GL context —
 *  the only call to `WEBGL_lose_context.loseContext()` is inside `forceContextLoss()`
 *  (`WebGLRenderer.js:595-600`). Chrome caps live WebGL contexts (~16); exceeding it blacks out
 *  previews AND the main SceneView.
 *
 *  `gpuContextTracking.ts:15-21` already NAMES `previewScene.ts` and `ModelPreview.tsx` as the two
 *  standalone-`WebGLRenderer` sites in the editor — so the seam was documented TWICE and guarded
 *  nowhere, which is how `ModelPreview.tsx` shipped without the call (#776) while `previewScene.ts`
 *  had it. `ModelPreview.tsx`'s teardown has now been patched three times for three different
 *  resource kinds: #534 (the source-model branch), #537 (GLB/LOD textures), #776 (the GL context)
 *  — a guard is cheaper than a fourth.
 *
 *  Deliberately NOT covered: `makeWebGPURenderer`'s `WebGPURenderer` has no `forceContextLoss`
 *  API — it wraps `dispose` instead (`scene3DSync.ts:4752-4756`); PixiJS `Application` teardown in
 *  `ShaderPreview.tsx`; and `@monogrid/gainmap-js` creates its own throwaway renderer internally in
 *  `editor/panels/assetViews/encodeUltraHDR.ts:29`, invisible to our tracking and editor-only,
 *  short-lived. The `ShaderPreview.tsx` Pixi `Application` gap named above is now covered by the
 *  sibling guard, `rendererLossHandling.test.ts` (#795) — RELEASE-on-teardown (this file) and
 *  DETECT-on-construction (that one) are different properties over the same construction sites.
 *
 *  The scan runs on comment-stripped source, so a `forceContextLoss` mentioned only in a comment
 *  (e.g. a stale TODO) cannot satisfy the pairing. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { censusRendererSources } from './rendererConstructionCensus';

// Matches `new THREE.WebGLRenderer(` and a bare `new WebGLRenderer(`, but not
// `WebGPURenderer` (e.g. `new WebGPURenderer(` / `new WebGPURendererMod(`) — that class has no
// `forceContextLoss` and is handled by wrapping `dispose` instead (see header note above).
const CONSTRUCT_RE = /\bnew\s+(?:THREE\.)?WebGLRenderer\s*\(/;

describe('GL context release — every bare THREE.WebGLRenderer site must call forceContextLoss', () => {
  it('every WebGLRenderer construction site also calls forceContextLoss', () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const { file, stripped } of censusRendererSources()) {
      if (!CONSTRUCT_RE.test(stripped)) continue;
      sites++;
      if (!/\bforceContextLoss\s*\(/.test(stripped)) offenders.push(path.relative(process.cwd(), file));
    }
    // The guard is worthless if the query stopped matching anything — pin that it still finds
    // the surfaces it is meant to police (previewScene.ts + ModelPreview.tsx today).
    expect(sites).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
