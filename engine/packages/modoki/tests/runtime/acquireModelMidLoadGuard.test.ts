/**
 * Regression for #488 site 2: `acquireModel` adds its sceneId owner BEFORE
 * awaiting `loadModelTemplates`. `releaseAllForScene` is synchronous and can
 * land inside that window — it removes the owner and disposes what was
 * cached, and the resumed load then repopulates `cache` with owner-less
 * geometry that nothing will ever release again. `acquireModel` now carries a
 * post-await guard (mirroring acquireMesh's, #485) that detects this and
 * invalidates the model instead of letting it strand.
 *
 * Uses the same deferred-onLoad GLTFLoader mock as meshTemplateGenGuard.test.ts
 * so the release can be interleaved between the load() call and its resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForLoaderImport } from '../helpers/flushLoaderImport';
import * as THREE from 'three';

// Deferred GLTFLoader: stash onLoad so the test fires it after releasing.
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

const ISLAND = '/island.glb';
const ISLAND_GUID = '30000000-0000-4000-8000-000000000010';

beforeEach(async () => {
  vi.resetModules();
  h.pending.length = 0;
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(ISLAND_GUID, ISLAND, 'model');
});

describe('acquireModel — post-await release guard (#488 site 2)', () => {
  it('drops + disposes when releaseAllForScene lands inside the load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.acquireModel(1, ISLAND_GUID);
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1); // lands inside the load, before the owner is consumed
    h.pending[0].fire();
    await p;

    expect(cache.getResourceStats().models[ISLAND]).toBeUndefined();
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
  });

  it('keeps the model when a second live scene shares the in-flight load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p1 = cache.acquireModel(1, ISLAND_GUID);
    const p2 = cache.acquireModel(2, ISLAND_GUID); // shares the in-flight load
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1);
    h.pending[0].fire();
    await Promise.all([p1, p2]);

    expect(cache.getResourceStats().models[ISLAND]).toBe(1);
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(1);
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled();
  });

  it('keeps the model with no release at all (ordinary load)', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.acquireModel(1, ISLAND_GUID);
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    h.pending[0].fire();
    await p;

    expect(cache.getResourceStats().models[ISLAND]).toBe(1);
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(1);
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled();
  });

  it('drops + disposes every LOD SIBLING, not just the base model, when releaseAllForScene lands inside the load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    // Re-register ISLAND_GUID with a baked LOD chain (2 levels) — registerAsset
    // re-derives lodPaths from the CURRENT path via lodUrlSuffix, so the actual
    // paths end up `${ISLAND}.processed.glb` / `${ISLAND}.lod1.glb` regardless
    // of what's passed here (see assetManifest.ts's deriveModelCacheVariantPaths).
    manifest.registerAsset(
      ISLAND_GUID, ISLAND, 'model', undefined,
      {
        modelCache: {
          hash: 'h', processedPath: ISLAND + '.processed.glb',
          lodPaths: [ISLAND + '.processed.glb', ISLAND + '.lod1.glb'],
          lodDistances: [0, 80], triCounts: [0, 0], lodBytes: [0, 0],
        },
      },
    );
    const lod0 = ISLAND + '.processed.glb';
    const lod1 = ISLAND + '.lod1.glb';

    const p = cache.acquireModel(1, ISLAND_GUID);
    // acquireModel's LOD branch loads both LOD GLBs via Promise.allSettled — a single
    // wait is enough because both continuations land in the same microtask batch,
    // behind the ONE shared loader-module import.
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(2);

    cache.releaseAllForScene(1); // lands inside the load, before the owner is consumed
    // Simulate the manifest entry being torn down during the same window (rename /
    // reimport-with-id-change / world swap — invalidateModel's own doc comment names
    // these) so it no longer carries modelCache.lodPaths by the time the guard runs.
    // This is what makes the re-seat line load-bearing: registerAsset PRESERVES a
    // prior modelCache block when one isn't passed and the type is unchanged, so
    // merely re-registering can't clear it — clearManifest() is what actually drops
    // it, matching what a torn-down entry looks like to invalidateModel's fallback
    // (:432-434). acquireModel already resolved glbPath/lodPaths locally before this
    // point, so the mutation only affects what invalidateModel's fallback can see.
    manifest.clearManifest();
    manifest.registerAsset(ISLAND_GUID, ISLAND, 'model'); // re-add with no modelCache
    h.pending[0].fire();
    h.pending[1].fire();
    await p;

    // Base entry: no owner, no templates.
    expect(cache.getResourceStats().models[ISLAND]).toBeUndefined();
    // Every LOD sibling: templates gone, geometry disposed — not just LOD0.
    expect(cache.getTemplatesForModel(lod0).size).toBe(0);
    expect(cache.getTemplatesForModel(lod1).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
    expect(h.pending[1].geoDispose).toHaveBeenCalled();
  });
});
