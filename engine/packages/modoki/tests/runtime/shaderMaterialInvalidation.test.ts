/** meshTemplateCache — shader → material reverse index (#864).
 *
 *  THE DEFECT: a `space:'3d'` file shader compiled into a `type:'custom'` `THREE.Material` had
 *  NO invalidation path at all. The material is cached in `materialCache`, keyed by the
 *  `.mat.json` path, not the shader's — and `spriteMaterialCache`'s `invalidateShader` (the
 *  entire `shader` live-reload path) only ever reached the 2D Pixi program cache. `fetchMaterial`
 *  now records a matPath↔shaderPath edge so a shader invalidation can find and invalidate every
 *  material built from it, via the shared `assetInvalidation` event registry (NOT a direct
 *  import — `spriteMaterialCache` must stay free of `meshTemplateCache`/three.js).
 *
 *  Driven through the REAL `spriteMaterialCache.invalidateShader` — the function a live-reload
 *  edit actually calls — rather than a bare `emitAssetInvalidated('shader', …)`, so a regression
 *  in ITS emit call fails these tests too, not just a defect in the reverse index itself.
 *  `pixiShaderBuilder` (2D, irrelevant here) and `fileShaderBuilder` (the WebGPU/TSL builder,
 *  irrelevant to the INDEX under test) are mocked; assetManifest, materialPresets and
 *  meshTemplateCache are real. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  resolveMaterial, invalidateMaterial, retiredMaterials3D, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { invalidateShader } from '../../src/runtime/loaders/spriteMaterialCache';

// spriteMaterialCache's own unit tests mock this too (no Pixi/GPU context in this suite) — we
// only need invalidateShader's GUID-resolution + emit behaviour, not a real compiled program.
vi.mock('../../src/runtime/rendering/pixiShaderBuilder', () => ({
  buildPixiShaderProgram: vi.fn(),
  invalidatePixiShaderProgram: vi.fn(),
}));

// materialPresets.customBuilder dynamic-imports this for a `.shader.json` ref — stub it so the
// test exercises fetchMaterial's edge bookkeeping without the WebGPU/TSL node pipeline.
const { buildFileShaderMaterial } = vi.hoisted(() => ({ buildFileShaderMaterial: vi.fn() }));
vi.mock('../../src/runtime/loaders/fileShaderBuilder', () => ({ buildFileShaderMaterial }));

const MAT_GUID = '11111111-2222-4333-8444-555555555555';
const MAT_PATH = '/games/g/assets/mat/holo.mat.json';
const SHADER_GUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const SHADER_PATH = '/games/g/assets/shaders/holo.shader.json';
const SHADER2_GUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const SHADER2_PATH = '/games/g/assets/shaders/other.shader.json';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

// Mutable so a "re-import" mid-test can change which shader the next fetch sees.
let matShaderRef = SHADER_GUID;

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ version: 1, id: MAT_GUID, type: 'custom', shader: matShaderRef }),
  } as never)));
}

beforeEach(() => {
  clearManifest();
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  registerAsset(SHADER_GUID, SHADER_PATH, 'shader');
  registerAsset(SHADER2_GUID, SHADER2_PATH, 'shader');
  matShaderRef = SHADER_GUID;
  buildFileShaderMaterial.mockReset();
  buildFileShaderMaterial.mockImplementation(async () => new THREE.Material());
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('shader → material reverse index (#864)', () => {
  it('records the edge for a custom material naming a file shader; invalidating that shader evicts it', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID);
    expect(first, 'fixture must build a material, or this test proves nothing').toBeTruthy();

    invalidateShader(SHADER_PATH);

    // Evicted: a cache miss kicks off a fresh fetch synchronously.
    expect(resolveMaterial(MAT_GUID)).toBeUndefined();
    await settle();
    const second = resolveMaterial(MAT_GUID);
    expect(second, 'must recover once refetched').toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('survives the shader being MOVED — the edge is keyed by GUID, not by path', async () => {
    // #864 close-out. The index was path-keyed at first, while everything else in the shader
    // system is GUID-keyed. Move or rename a `.shader.json` in the asset browser WITHOUT touching
    // the `.mat` that names it (the .mat holds a guid, so it needs no edit): the manifest rebuild
    // gives the same GUID a new path, and a path recorded at material-fetch time no longer matches
    // the path resolved at invalidation time. The 2D half recovered — being GUID-keyed — while the
    // 3D material silently kept its stale compiled NodeMaterial. And it failed SILENTLY rather
    // than safe: `invalidateShader`'s unresolved branch wholesale-clears for 2D, but a missed
    // lookup in this index just finds nothing at all.
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID);
    expect(first, 'fixture must build a material, or this test proves nothing').toBeTruthy();

    // The move: same GUID, new path — exactly what a rebuildManifest after a rename produces.
    const MOVED_PATH = '/games/g/assets/shaders/renamed/holo.shader.json';
    registerAsset(SHADER_GUID, MOVED_PATH, 'shader');

    invalidateShader(MOVED_PATH);

    // FAILS on a path-keyed index: `shaderToMaterials.get(MOVED_PATH)` misses the edge recorded
    // under the ORIGINAL path, so the material is never evicted and `resolveMaterial` keeps
    // handing back the stale instance.
    expect(resolveMaterial(MAT_GUID), 'the moved shader must still reach its material').toBeUndefined();
    await settle();
    const second = resolveMaterial(MAT_GUID);
    expect(second, 'must recover once refetched').toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('invalidating a DIFFERENT shader leaves the material cached', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID);
    expect(first).toBeTruthy();

    invalidateShader(SHADER2_PATH);

    expect(resolveMaterial(MAT_GUID)).toBe(first);
  });

  it('a .mat re-imported to a DIFFERENT shader no longer responds to the OLD shader (pruning)', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID);
    expect(first).toBeTruthy();

    // Re-import: the .mat.json on disk now names the OTHER shader. invalidateMaterial is what a
    // real re-import calls before the next fetch reads the new bytes.
    matShaderRef = SHADER2_GUID;
    invalidateMaterial(MAT_PATH);
    resolveMaterial(MAT_GUID);
    await settle();
    const second = resolveMaterial(MAT_GUID);
    expect(second, 'must rebuild against the new shader ref').toBeTruthy();
    expect(second).not.toBe(first);

    // The OLD shader's invalidation must now be a no-op — its edge was pruned.
    invalidateShader(SHADER_PATH);
    expect(resolveMaterial(MAT_GUID), 'the stale edge must not still answer for this material').toBe(second);

    // Sanity: the NEW shader's invalidation still reaches it.
    invalidateShader(SHADER2_PATH);
    expect(resolveMaterial(MAT_GUID)).toBeUndefined();
  });

  it('invalidateMaterial still RETIRES (not disposes) a material reached via the shader path (#317)', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    const disp = vi.spyOn(first, 'dispose');

    invalidateShader(SHADER_PATH);

    expect(disp, 'the material must be retired, not destroyed — #317').not.toHaveBeenCalled();
    expect(retiredMaterials3D().has(first)).toBe(true);
  });
});
