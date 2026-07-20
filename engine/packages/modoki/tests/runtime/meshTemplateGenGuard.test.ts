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
    expect(h.pending).toHaveLength(1);
    h.pending[0].fire(); // load resolves with no intervening dispose
    await p;
    expect(cache.getTemplatesForModel(ISLAND).size).toBe(1); // promoted
    expect(h.pending[0].geoDispose).not.toHaveBeenCalled(); // geometry kept (owned)
  });

  it('drops + disposes templates when a teardown bumped the generation mid-load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.loadModelTemplates(ISLAND, undefined, 'none');
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
});
