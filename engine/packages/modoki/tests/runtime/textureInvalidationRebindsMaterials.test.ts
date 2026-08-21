/** A standalone TEXTURE re-import must make the live materials that bind it re-resolve.
 *
 *  THE GAP THIS PINS. `invalidateTexture` evicts the cache entry and RETIRES a still-referenced
 *  texture; the retired instance is freed by the last `releaseTexture3D`, which arrives through
 *  `meshTemplateCache.disposeMaterial` when a material rebuilds. Nothing consumed the
 *  `emitAssetInvalidated('texture', …)` announcement on the material side, so for a standalone
 *  texture re-import that release never came:
 *
 *    - the viewport kept sampling the PRE-reimport bytes (the re-import silently did not take)
 *    - the retired texture was never freed
 *
 *  A MODEL re-import hid it, because `modelImport` also calls `invalidateMaterial` per deduped
 *  material — which is exactly why the model-path live check could not have caught this. The
 *  standalone paths (`TextureAssetView`'s Convert/Re-import, and the batch `reimportPaths`)
 *  call `invalidateTexture` and nothing else.
 *
 *  Driven through the REAL material loader (`resolveMaterial` → `fetchMaterial` → the pbr
 *  builder → `loadTexture3D`) rather than by poking the cache, so it exercises the seam
 *  production uses. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  invalidateTexture, releaseTexture3D, getSharedTextureStats, disposeAllSharedTextures,
} from '../../src/runtime/loaders/textureResolver';
import { resolveMaterial, invalidateMaterial, disposeRetiredMaterial } from '../../src/runtime/loaders/meshTemplateCache';

const TEX_GUID = '22222222-2222-4222-8222-222222222222';
const TEX_PATH = '/games/g/assets/tex/grass.png';
const MAT_GUID = '33333333-3333-4333-8333-333333333333';
const MAT_PATH = '/games/g/assets/mat/grass.mat.json';

/** Let the material fetch + texture load + the consumer's microtask all settle. */
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

let loadAsyncSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearManifest();
  registerAsset(TEX_GUID, TEX_PATH, 'texture');
  // Materials are addressed by GUID (refToPath rejects a raw internal path), so the fixture has
  // to be a manifest entry or resolveMaterial returns undefined and the test proves nothing.
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  // Each load yields a DISTINCT instance, so "did the material rebind?" is answerable by
  // identity — the whole point of the assertion below.
  loadAsyncSpy = vi.spyOn(THREE.Loader.prototype, 'loadAsync')
    .mockImplementation(async () => new THREE.Texture() as never);
  // Only `.mat.json` is fetched here — the texture goes through the mocked THREE loader above.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ version: 1, id: MAT_GUID, type: 'pbr', texture: TEX_GUID }),
  } as never)));
});

afterEach(() => {
  invalidateMaterial(MAT_PATH);
  disposeAllSharedTextures();
  loadAsyncSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('invalidateTexture → materials rebind', () => {
  it('evicts a material that binds the retired texture, so it re-resolves to the fresh one', async () => {
    resolveMaterial(MAT_GUID);          // kicks off the async fetch
    await settle();
    const mat = resolveMaterial(MAT_GUID) as THREE.MeshStandardMaterial | undefined;
    expect(mat, 'the material fixture must actually load, or this test proves nothing').toBeTruthy();
    const firstTex = mat!.map;
    expect(firstTex, 'the material must actually bind a shared texture').toBeTruthy();

    invalidateTexture(TEX_GUID);
    await settle();                     // the consumer runs on a microtask (see meshTemplateCache)

    // The material was dropped from the cache, so the next resolve re-fetches and re-binds.
    resolveMaterial(MAT_GUID);
    await settle();
    const rebuilt = resolveMaterial(MAT_GUID) as THREE.MeshStandardMaterial | undefined;
    expect(rebuilt!.map).not.toBe(firstTex);   // a FRESH instance — the re-import took
  });

  it('releases the retired texture, so it does not leak for the session', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const mat = resolveMaterial(MAT_GUID) as THREE.MeshStandardMaterial | undefined;
    const firstTex = mat!.map!;
    const disp = vi.spyOn(firstTex, 'dispose');

    invalidateTexture(TEX_GUID);
    await settle();

    // TWO steps since #317, and the order matters. `invalidateMaterial` no longer disposes the
    // material — it RETIRES it, because a live mesh is still binding that instance — so the
    // material's texture refs are still held here. Freeing the texture at this point would be
    // exactly the use-after-free #317 fixes, one level down.
    expect(disp, 'the retired material still holds this ref').not.toHaveBeenCalled();

    // The release arrives when the material itself is freed — in production that is
    // `syncSceneRenderables3D`'s sweep, once no live mesh binds it.
    disposeRetiredMaterial(mat!);
    expect(disp).toHaveBeenCalledTimes(1);
    expect(getSharedTextureStats().refs).toBe(0);
  });

  it('leaves a texture no material binds alone — the sweep frees only what it orphaned', async () => {
    const { loadTexture3D } = await import('../../src/runtime/loaders/textureResolver');
    const orphan = await loadTexture3D(TEX_GUID);   // held by this test, not by a material
    const disp = vi.spyOn(orphan, 'dispose');

    invalidateTexture(TEX_GUID);
    await settle();

    expect(disp).not.toHaveBeenCalled();            // still referenced here → must survive
    releaseTexture3D(orphan);
    expect(disp).toHaveBeenCalledTimes(1);          // freed by the normal path
  });
});
