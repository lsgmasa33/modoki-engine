/** `disposeVideoTextures` (the 3D video-binding teardown) is actually WIRED — a mechanism nothing
 *  calls is not a fix.
 *
 *  This guard exists because its 2D twin, `disposeVideoTextures2D`, IS wired into `Scene2D.tsx`
 *  (`onWorldSwap` + `stop()`), but `disposeVideoTextures` had zero production callers (#534
 *  Phase 1): every 3D world swap / viewport unmount left the bound `THREE.VideoTexture`, the
 *  private material clone, and the `requestVideoFrameCallback` upload pump running forever —
 *  `release()`, which cancels the pump and restores the mesh's original material, is only ever
 *  reached through `disposeVideoTextures`.
 *
 *  Deliberately a source grep rather than a behavioural test: the unit tests in
 *  `videoTextureSync.test.ts` already prove the disposer itself works — what they cannot see is
 *  whether production actually calls it, which is exactly the class of bug this is.
 *
 *  Ordering matters too: `release()` restores `b.original` into the mesh's material slot, so the
 *  mesh must still exist when it runs — `disposeVideoTextures` must come BEFORE
 *  `disposeRenderState`, which is what tears the meshes down.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (rel: string) => readScannedSource(path.join(repoRoot, rel)).code;

// Each region is the smallest slice of the file containing one onWorldSwap/teardown site.
const sites: [label: string, rel: string, regionStart: string, regionEnd: string][] = [
  [
    'Scene3D.tsx onWorldSwap',
    'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx',
    'const unsubSwap = onWorldSwap(() => {',
    'sceneManager.registerBeforeSwap(prewarmHook);',
  ],
  [
    'Scene3D.tsx unmount teardown',
    'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx',
    "step('unregisterFrameCallback'",
    "step('scene.clear'",
  ],
  [
    'SceneView.tsx onWorldSwap',
    'engine/packages/modoki/src/editor/panels/SceneView.tsx',
    'const unsubSwap = onWorldSwap(() => {',
    // The statement immediately after `disposeRenderState` in that handler. It used to be the
    // inline `for (const [, outline] of outlineMeshes)` loop; #737 replaced the handler's four
    // inline disposal loops with one call to the shared helper, so the marker moved with it.
    'disposeSceneViewEntityObjects(scene,',
  ],
  [
    'SceneView.tsx effect-cleanup teardown',
    'engine/packages/modoki/src/editor/panels/SceneView.tsx',
    'gizmo.dispose();',
    'disposeParticleSyncState(particleState, scene);',
  ],
];

describe('disposeVideoTextures (3D) is reachable from production code', () => {
  it.each(sites)('%s calls disposeVideoTextures before disposeRenderState', (_label, rel, start, end) => {
    const src = read(rel);
    const from = src.indexOf(start);
    expect(from, `region start not found in ${rel}`).toBeGreaterThanOrEqual(0);
    const to = src.indexOf(end, from);
    expect(to, `region end not found in ${rel}`).toBeGreaterThan(from);
    const region = src.slice(from, to);

    const disposeVideoIdx = region.indexOf('disposeVideoTextures(');
    const disposeRenderIdx = region.indexOf('disposeRenderState(');
    expect(disposeVideoIdx, `disposeVideoTextures( not found in region`).toBeGreaterThanOrEqual(0);
    expect(disposeRenderIdx, `disposeRenderState( not found in region`).toBeGreaterThanOrEqual(0);
    expect(disposeVideoIdx, 'disposeVideoTextures must run before disposeRenderState — see file header').toBeLessThan(disposeRenderIdx);
  });

  it('both files import disposeVideoTextures from videoTextureSync', () => {
    const scene3D = read('engine/packages/modoki/src/runtime/rendering/Scene3D.tsx');
    expect(scene3D).toMatch(/import\s*\{\s*disposeVideoTextures\s*\}\s*from\s*'\.\/videoTextureSync'/);

    const sceneView = read('engine/packages/modoki/src/editor/panels/SceneView.tsx');
    expect(sceneView).toMatch(/import\s*\{\s*disposeVideoTextures\s*\}\s*from\s*'\.\.\/\.\.\/runtime\/rendering\/videoTextureSync'/);
  });
});
