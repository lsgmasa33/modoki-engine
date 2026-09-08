/**
 * Regression for #552: `acquireMesh`'s OWN transitive-model acquisition block
 * (as opposed to `fetchMeshAsset`'s internal preload, or `acquireModel`'s own
 * post-await guard) adds a model owner and then awaits `loadModelTemplates`
 * with no post-await guard. `releaseAllForScene` is synchronous and can land
 * inside that await — it removes the owner (via the mesh-asset release
 * cascade in `releaseMeshByPath`) and the resumed load then repopulates the
 * template cache with owner-less geometry that nothing will ever release
 * again.
 *
 * This window is distinct from the ones #488 already closed:
 *  - "site 1" (inside `await fetchMeshAsset(...)`) is guarded by the
 *    mesh-owner check right above it in `acquireMesh`.
 *  - "site 2" is `acquireModel`'s own post-await guard, exercised by
 *    `acquireModelMidLoadGuard.test.ts`.
 *  - "site 3" is the F6 sync render-path resolver — working as designed.
 * This is a FOURTH window: `acquireMesh`'s own model block, reached only
 * when `fetchMeshAsset` short-circuits on an already-cached `.mesh.json`
 * (comment at acquireMesh's model block: "if the mesh-asset entry was cached
 * from a prior (now-evicted) scene, fetchMeshAsset short-circuits and never
 * (re)loads templates") and the underlying model still needs a fresh load.
 *
 * Constructed here by resolving the model's guid only AFTER an initial
 * warm-up `acquireMesh` call — the warm-up caches the `.mesh.json` (so a
 * later `acquireMesh` for the same path skips `fetchMeshAsset`'s fetch
 * entirely) without being able to resolve, and therefore preload, its model
 * (an unregistered guid resolves to `undefined` and `fetchMeshAsset`'s model
 * branch is skipped). Registering the model guid afterward and then calling
 * `acquireMesh` again reaches `acquireMesh`'s OWN model-load block as a
 * genuinely fresh (interleavable) load — exactly the state the comment
 * describes.
 *
 * Uses the same deferred-onLoad GLTFLoader mock as acquireModelMidLoadGuard.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForLoaderImport } from '../helpers/flushLoaderImport';
import * as THREE from 'three';

const h = vi.hoisted(() => {
  const pending: { fire: () => void; geoDispose: ReturnType<typeof vi.fn>; matDispose: ReturnType<typeof vi.fn> }[] = [];
  return { pending };
});

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    load(path: string, onLoad: (gltf: any) => void) {
      const geoDispose = vi.fn();
      const matDispose = vi.fn();
      // Build the mesh ONCE and return the same instance from every traverse, so
      // the kept-geometry/material dedup (object identity) behaves like real Three.
      const mesh: any = {
        isMesh: true, name: `mesh_${path.split('/').pop()}`,
        geometry: { uuid: `geo-${path}`, dispose: geoDispose },
        material: { uuid: `mat-${path}`, dispose: matDispose },
        position: { set: () => {} }, rotation: { set: () => {} }, scale: { set: () => {} },
        removeFromParent: () => {},
        matrixWorld: new THREE.Matrix4(), // identity → origin/identity/unit-scale
      };
      const scene = {
        position: { set: () => {} }, rotation: { set: () => {} }, scale: { setScalar: () => {} },
        updateMatrixWorld: () => {},
        clear: () => {},
        traverse: (cb: (child: any) => void) => cb(mesh),
      };
      mesh.parent = scene; // hierarchy extraction walks up to the model root
      h.pending.push({ fire: () => onLoad({ scene }), geoDispose, matDispose });
    }
  },
}));

const MESH_GUID = '55555555-2222-4333-8444-666666666666';
const MESH_PATH = '/games/g/assets/mesh/mid-load.mesh.json';
const MODEL_GUID = '66666666-2222-4333-8444-666666666666';
const MODEL_PATH = '/games/g/assets/model/mid-load.glb';

function stubMeshFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.includes(MESH_PATH)) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({ version: 1, id: MESH_GUID, model: MODEL_GUID }),
    } as unknown as Response;
  }));
}

beforeEach(async () => {
  vi.resetModules();
  h.pending.length = 0;
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(MESH_GUID, MESH_PATH, 'mesh');
  stubMeshFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Warm meshAssetCache with MESH_PATH's asset WITHOUT resolving (and therefore
 *  preloading) its model — MODEL_GUID is deliberately unregistered at this
 *  point, so `fetchMeshAsset`'s own model-preload branch never runs. Uses a
 *  scene id that is never released, so the cache entry stays warm (an owned
 *  `.mesh.json` is never evicted). */
async function warmMeshAssetCacheWithUnresolvedModel() {
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  await cache.acquireMesh(999, MESH_GUID);
}

describe('acquireMesh — post-await guard on its OWN transitive-model block (#552)', () => {
  it('drops + disposes when releaseAllForScene lands inside the single-model await', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const manifest = await import('../../src/runtime/loaders/assetManifest');

    await warmMeshAssetCacheWithUnresolvedModel();
    manifest.registerAsset(MODEL_GUID, MODEL_PATH, 'model'); // now resolvable

    const p = cache.acquireMesh(1, MESH_GUID);
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1); // lands inside acquireMesh's OWN model-load await
    h.pending[0].fire();
    await p;

    expect(cache.getResourceStats().models[MODEL_PATH]).toBeUndefined();
    expect(cache.getTemplatesForModel(MODEL_PATH).size).toBe(0);
    expect(cache.getModelHierarchy(MODEL_PATH)).toBeUndefined();
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
  });

  it('drops + disposes every LOD sibling when releaseAllForScene lands inside the LOD await', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const manifest = await import('../../src/runtime/loaders/assetManifest');

    await warmMeshAssetCacheWithUnresolvedModel();
    manifest.registerAsset(
      MODEL_GUID, MODEL_PATH, 'model', undefined,
      {
        modelCache: {
          hash: 'h', processedPath: MODEL_PATH + '.processed.glb',
          lodPaths: [MODEL_PATH + '.processed.glb', MODEL_PATH + '.lod1.glb'],
          lodDistances: [0, 80], triCounts: [0, 0], lodBytes: [0, 0],
        },
      },
    );
    const lod0 = MODEL_PATH + '.processed.glb';
    const lod1 = MODEL_PATH + '.lod1.glb';

    const p = cache.acquireMesh(1, MESH_GUID);
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(2);

    cache.releaseAllForScene(1); // lands inside acquireMesh's OWN LOD-load await
    // Simulate the manifest entry being torn down during the same window (rename /
    // reimport-with-id-change / world swap), matching acquireModelMidLoadGuard's
    // sibling test — this makes the guard's re-seat of modelLodSnapshots
    // load-bearing rather than a no-op covered by the manifest fallback.
    manifest.clearManifest();
    manifest.registerAsset(MESH_GUID, MESH_PATH, 'mesh');
    manifest.registerAsset(MODEL_GUID, MODEL_PATH, 'model'); // re-add with no modelCache
    h.pending[0].fire();
    h.pending[1].fire();
    await p;

    expect(cache.getResourceStats().models[MODEL_PATH]).toBeUndefined();
    expect(cache.getTemplatesForModel(lod0).size).toBe(0);
    expect(cache.getTemplatesForModel(lod1).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
    expect(h.pending[1].geoDispose).toHaveBeenCalled();
  });

  it('keeps the model when a second live scene shares the in-flight load (?.size half of the guard)', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const manifest = await import('../../src/runtime/loaders/assetManifest');

    await warmMeshAssetCacheWithUnresolvedModel();
    manifest.registerAsset(MODEL_GUID, MODEL_PATH, 'model');

    const p1 = cache.acquireMesh(1, MESH_GUID);
    const p2 = cache.acquireMesh(2, MESH_GUID); // shares the in-flight load (loadModelTemplates dedupes)
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1);
    h.pending[0].fire();
    await Promise.all([p1, p2]);

    expect(cache.getResourceStats().models[MODEL_PATH]).toBe(1);
    expect(cache.getTemplatesForModel(MODEL_PATH).size).toBe(1);
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled();
  });
});
