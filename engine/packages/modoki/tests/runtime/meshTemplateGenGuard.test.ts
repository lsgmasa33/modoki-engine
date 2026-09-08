/**
 * Regression for asset-loaders F11: a GLB whose load resolves AFTER a
 * `disposeAllCachedResources` (scene swap mid-load) must NOT promote its templates
 * into the freshly-cleared cache — that would strand owner-less geometry until the
 * next teardown (a GPU leak). `loadModelTemplates` snapshots `cacheGeneration` and
 * bails + disposes if it moved.
 *
 * Uses a deferred-onLoad GLTFLoader mock so the dispose can be interleaved between
 * the load() call and its resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForLoaderImport } from '../helpers/flushLoaderImport';
import * as THREE from 'three';

// Deferred GLTFLoader: stash onLoad so the test fires it after disposing.
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

describe('loadModelTemplates — cacheGeneration guard (F11)', () => {
  it('promotes templates when no teardown raced the load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
    // The loader module is imported on demand (#254), so the load parks asynchronously — wait
    // for that import to settle rather than for a fixed task hop (a slow import outruns one).
    // Count-free on purpose: a `>= 1` wait would let this assertion pass while a SECOND load
    // was still in flight, which is exactly the regression it exists to catch.
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);
    h.pending[0].fire(); // load resolves with no intervening dispose
    await p;
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(1); // promoted
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled(); // geometry kept (owned)
  });

  it('drops + disposes templates when a teardown bumped the generation mid-load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
    // The loader module is imported on demand (#254), so the load parks asynchronously — wait
    // for that import to settle rather than for a fixed task hop (a slow import outruns one).
    // Count-free on purpose: a `>= 1` wait would let this assertion pass while a SECOND load
    // was still in flight, which is exactly the regression it exists to catch.
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    // Scene swap completes while the GLB is still in flight.
    cache.disposeAllCachedResources();

    h.pending[0].fire(); // NOW the load resolves — into a stale generation
    await p;

    // Nothing stranded in the cache, and the parsed geometry/material were freed.
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
    expect(h.pending[0].matDispose).toHaveBeenCalled();
  });

  // #863: `invalidateModel` (an editor re-import) used to bump ONLY the module-wide generation
  // (never — it didn't touch cacheToken at all), so a load carrying the PRE-import bytes that
  // resolved after the re-import re-cached the stale template on top of the fresh one. Distinct
  // from the two tests above: those cover the FULL-teardown path (`disposeAllCachedResources`,
  // which already bumped `cacheToken` wholesale); this one is the PER-KEY path that had no
  // liveness check at all before #863.
  it('drops + disposes the stale load when invalidateModel evicts the SAME path mid-load, not just on full teardown', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    // A re-import lands while the OLD parse is still in flight — a per-key evict, not a full
    // disposeAllCachedResources.
    cache.invalidateModel(ISLAND);

    h.pending[0].fire(); // the pre-invalidation bytes resolve AFTER the evict
    await p;

    // FAILS before #863: the stale load would re-populate the cache with the old template.
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
    expect(h.pending[0].matDispose).toHaveBeenCalled();
  });

  it('an invalidateModel on an UNRELATED path does not refuse this path\'s in-flight load (per-key, not module-wide)', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.invalidateModel('/other-model.glb'); // unrelated path — must not supersede ISLAND's load

    h.pending[0].fire();
    await p;

    expect(cache.getTemplatesForModel(ISLAND).size).toBe(1); // promoted, not refused
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled();
  });

  it('a full teardown still supersedes even an UNRELATED in-flight load (invalidateAll wins over any per-key state)', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
    await waitForLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.disposeAllCachedResources(); // full teardown — must drop ISLAND's load too, no invalidateModel(ISLAND) call at all

    h.pending[0].fire();
    await p;

    expect(cache.getTemplatesForModel(ISLAND).size).toBe(0);
    expect(h.pending[0].geoDispose).toHaveBeenCalled();
    expect(h.pending[0].matDispose).toHaveBeenCalled();
  });
});
