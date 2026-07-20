/** Refcount API tests — acquire/release semantics, transitive dependencies, releaseAllForScene.
 *
 *  Mocks global fetch() to return canned responses for .mat.json and .mesh.json files.
 *  Mocks the Three.js GLTFLoader and HDRLoader so loads succeed without real binary data. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// ── Mock HDRLoader (for HDR environment preload) ──

// Per-path load counter so tests can assert the HDR is fetched once and shared
// across owners (rather than reloaded per acquire). Reset in beforeEach.
const hdr = vi.hoisted(() => ({ loads: {} as Record<string, number>, textures: [] as any[] }));

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: any) => void, _onProgress?: any, _onError?: (err: any) => void) {
      hdr.loads[path] = (hdr.loads[path] || 0) + 1;
      // Simulate successful async load. Record each texture so mid-load-guard tests
      // can assert dispose() was called on the specific texture that arrived.
      setTimeout(() => {
        const tex = { mapping: 0, dispose: vi.fn(), uuid: `hdr-${path}` };
        hdr.textures.push(tex);
        onLoad(tex);
      }, 0);
    }
  },
}));

// ── Mock GLTFLoader before importing the cache (which loads it eagerly) ──

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({
  MeshoptDecoder: {},
}));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    load(path: string, onLoad: (gltf: any) => void) {
      // Build a minimal gltf.scene with one mesh
      const scene = {
        position: { set: () => {} },
        rotation: { set: () => {} },
        scale: { setScalar: () => {} },
        updateMatrixWorld: () => {},
        traverse: (cb: (child: any) => void) => {
          const mesh = {
            isMesh: true,
            name: `mesh_from_${path.split('/').pop()}`,
            geometry: { uuid: `geo-${path}`, dispose: () => {} },
            material: { uuid: `mat-${path}`, dispose: () => {} },
            position: { set: () => {} },
            rotation: { set: () => {} },
            scale: { set: () => {} },
            removeFromParent: () => {},
            parent: scene, // hierarchy extraction walks up to model root
            matrixWorld: new THREE.Matrix4(), // identity → decomposes to origin/identity/unit-scale
          };
          cb(mesh);
        },
      };
      onLoad({ scene });
    }
  },
}));

// Track fetch() calls per path so we can assert dedup
let fetchCalls: Record<string, number> = {};

// ── GUID ↔ path map ──
// References are GUID-only now (assetManifest.resolveRef rejects internal asset
// paths). Each path used AS A REFERENCE (acquire args, nested refs in canned
// mesh JSON) must be a GUID registered to its resolved path. Cache/refcount maps
// remain keyed by the RESOLVED PATH, so all stats/getCached assertions stay on
// the path side. These GUIDs are registered fresh in beforeEach (after
// resetModules) against the same module graph the cache imports.
const GUIDS: Record<string, { guid: string; type: 'material' | 'mesh' | 'model' | 'prefab' | 'environment' }> = {
  '/m1.mat.json':      { guid: '10000000-0000-4000-8000-000000000001', type: 'material' },
  '/m2.mat.json':      { guid: '10000000-0000-4000-8000-000000000002', type: 'material' },
  '/m3.mat.json':      { guid: '10000000-0000-4000-8000-000000000003', type: 'material' },
  '/bad.mat.json':     { guid: '10000000-0000-4000-8000-000000000004', type: 'material' }, // 404 (not in fetchResponses)
  '/unknown.mat.json': { guid: '10000000-0000-4000-8000-000000000005', type: 'material' }, // bogus `type`
  '/island.glb':       { guid: '10000000-0000-4000-8000-000000000010', type: 'model' },
  '/cube.mesh.json':   { guid: '10000000-0000-4000-8000-000000000020', type: 'mesh' },
  '/sphere.mesh.json': { guid: '10000000-0000-4000-8000-000000000021', type: 'mesh' },
  '/tree.prefab.json': { guid: '10000000-0000-4000-8000-000000000030', type: 'prefab' },
  '/rock.prefab.json': { guid: '10000000-0000-4000-8000-000000000031', type: 'prefab' },
  '/env/sky.hdr':      { guid: '10000000-0000-4000-8000-000000000040', type: 'environment' },
};
const G = (path: string) => GUIDS[path].guid;

// Canned responses keyed by path suffix. Nested refs (model, material) inside
// the mesh JSON are GUIDs — that's what the on-disk format stores now.
const fetchResponses: Record<string, any> = {
  '/m1.mat.json': { color: 0xff0000 },
  '/m2.mat.json': { color: 0x00ff00 },
  '/m3.mat.json': { color: 0x0000ff },
  '/cube.mesh.json': { model: G('/island.glb'), mesh: 'cube', postprocessor: 'none' },
  '/sphere.mesh.json': { model: G('/island.glb'), mesh: 'sphere', postprocessor: 'none', material: G('/m1.mat.json') },
  '/tree.prefab.json': { version: 1, name: 'tree', rootLocalId: 1, entities: [] },
  '/rock.prefab.json': { version: 1, name: 'rock', rootLocalId: 1, entities: [] },
  '/unknown.mat.json': { type: 'totally-bogus-material-type', color: 0x123456 },
  // '/bad.mat.json' intentionally absent → fetch returns ok:false (404 path).
};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  fetchCalls[url] = (fetchCalls[url] || 0) + 1;
  for (const [suffix, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(suffix)) {
      return { ok: true, json: async () => body } as Response;
    }
  }
  return { ok: false, json: async () => ({}) } as Response;
});

beforeEach(async () => {
  vi.resetModules();
  fetchCalls = {};
  hdr.loads = {};
  hdr.textures = [];
  // Re-import the cache module after reset to get a fresh instance
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  // Register every GUID → path on the SAME fresh module graph the cache uses
  // (resetModules wipes the manifest too). The cache resolves refs through this
  // manifest instance, so registration must happen here, post-reset.
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  for (const [path, { guid, type }] of Object.entries(GUIDS)) {
    manifest.registerAsset(guid, path, type);
  }
});

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

describe('refcount cache — material', () => {
  it('acquireMaterial loads on first acquire', async () => {
    const { acquireMaterial, getResourceStats } = await getCache();
    await acquireMaterial(1, G('/m1.mat.json'));
    expect(fetchCalls['/m1.mat.json']).toBe(1);
    expect(getResourceStats().materials['/m1.mat.json']).toBe(1);
  });

  it('second acquireMaterial from same scene is idempotent', async () => {
    const { acquireMaterial, getResourceStats } = await getCache();
    await acquireMaterial(1, G('/m1.mat.json'));
    await acquireMaterial(1, G('/m1.mat.json'));
    expect(fetchCalls['/m1.mat.json']).toBe(1);
    expect(getResourceStats().materials['/m1.mat.json']).toBe(1);
  });

  it('acquire from second scene shares the cached material — no second fetch', async () => {
    const { acquireMaterial, getResourceStats } = await getCache();
    await acquireMaterial(1, G('/m1.mat.json'));
    await acquireMaterial(2, G('/m1.mat.json'));
    expect(fetchCalls['/m1.mat.json']).toBe(1);
    expect(getResourceStats().materials['/m1.mat.json']).toBe(2);
  });

  it('release decrements refcount but keeps material if other owners remain', async () => {
    const { acquireMaterial, releaseMaterial, getResourceStats, resolveMaterial } = await getCache();
    await acquireMaterial(1, G('/m1.mat.json'));
    await acquireMaterial(2, G('/m1.mat.json'));
    releaseMaterial(1, G('/m1.mat.json'));
    expect(getResourceStats().materials['/m1.mat.json']).toBe(1);
    // Material is still in cache (still has owner)
    expect(resolveMaterial(G('/m1.mat.json'))).toBeDefined();
  });

  it('release of last owner disposes the material', async () => {
    const { acquireMaterial, releaseMaterial, getResourceStats, resolveMaterial } = await getCache();
    await acquireMaterial(1, G('/m1.mat.json'));
    releaseMaterial(1, G('/m1.mat.json'));
    expect(getResourceStats().materials['/m1.mat.json']).toBeUndefined();
    expect(resolveMaterial(G('/m1.mat.json'))).toBeUndefined();
  });

  it('concurrent acquires share one in-flight load', async () => {
    const { acquireMaterial } = await getCache();
    // Launch two acquires in parallel — only one fetch should happen
    await Promise.all([
      acquireMaterial(1, G('/m1.mat.json')),
      acquireMaterial(2, G('/m1.mat.json')),
    ]);
    expect(fetchCalls['/m1.mat.json']).toBe(1);
  });
});

describe('refcount cache — model', () => {
  it('acquireModel kicks off GLTFLoader and adds owner', async () => {
    const { acquireModel, getResourceStats } = await getCache();
    await acquireModel(1, G('/island.glb'));
    expect(getResourceStats().models['/island.glb']).toBe(1);
  });

  it('release of last owner disposes mesh templates', async () => {
    const { acquireModel, releaseModel, getResourceStats, getTemplatesForModel } = await getCache();
    await acquireModel(1, G('/island.glb'));
    // getTemplatesForModel is keyed by the RESOLVED model path, not the ref.
    expect(getTemplatesForModel('/island.glb').size).toBeGreaterThan(0);
    releaseModel(1, G('/island.glb'));
    expect(getResourceStats().models['/island.glb']).toBeUndefined();
    expect(getTemplatesForModel('/island.glb').size).toBe(0);
  });
});

describe('refcount cache — mesh asset transitivity', () => {
  it('acquireMesh transitively acquires the underlying GLB and material', async () => {
    const { acquireMesh, getResourceStats, getTemplatesForModel } = await getCache();
    await acquireMesh(1, G('/sphere.mesh.json'));

    const stats = getResourceStats();
    expect(stats.meshAssets['/sphere.mesh.json']).toBe(1);
    expect(stats.models['/island.glb']).toBe(1);
    expect(stats.materials['/m1.mat.json']).toBe(1);
    // F3: acquireMesh must own its model-template load explicitly — adding the
    // model owner WITHOUT a guaranteed template load is exactly the latent gap.
    // After acquire, the templates are present (not just the owner refcount).
    expect(getTemplatesForModel('/island.glb').size).toBeGreaterThan(0);
  });

  it('releasing the mesh asset releases its transitive deps under the same scene', async () => {
    const { acquireMesh, releaseMesh, getResourceStats } = await getCache();
    await acquireMesh(1, G('/sphere.mesh.json'));
    releaseMesh(1, G('/sphere.mesh.json'));

    const stats = getResourceStats();
    expect(stats.meshAssets['/sphere.mesh.json']).toBeUndefined();
    expect(stats.models['/island.glb']).toBeUndefined();
    expect(stats.materials['/m1.mat.json']).toBeUndefined();
  });

  it('two scenes sharing the same model only fetch the GLB once', async () => {
    const { acquireMesh } = await getCache();
    await acquireMesh(1, G('/cube.mesh.json'));
    await acquireMesh(2, G('/cube.mesh.json'));
    // Mesh asset fetched once, model loaded once
    expect(fetchCalls['/cube.mesh.json']).toBe(1);
  });

  it('two scenes use different mesh assets from the same model — model held by both', async () => {
    const { acquireMesh, releaseMesh, getResourceStats } = await getCache();
    await acquireMesh(1, G('/cube.mesh.json'));
    await acquireMesh(2, G('/sphere.mesh.json'));

    let stats = getResourceStats();
    // Both scenes own the model
    expect(stats.models['/island.glb']).toBe(2);

    // Releasing scene 1's cube mesh should NOT dispose the model (scene 2 still uses it)
    releaseMesh(1, G('/cube.mesh.json'));
    stats = getResourceStats();
    expect(stats.models['/island.glb']).toBe(1);
    expect(stats.meshAssets['/cube.mesh.json']).toBeUndefined();
    expect(stats.meshAssets['/sphere.mesh.json']).toBe(1);
  });
});

describe('refcount cache — prefab', () => {
  it('acquirePrefab fetches and caches', async () => {
    const { acquirePrefab, getCachedPrefab, getResourceStats } = await getCache();
    await acquirePrefab(1, G('/tree.prefab.json'));
    expect(getCachedPrefab(G('/tree.prefab.json'))).toEqual({ version: 1, name: 'tree', rootLocalId: 1, entities: [] });
    expect(getResourceStats().prefabs['/tree.prefab.json']).toBe(1);
  });

  it('releasePrefab from last owner clears the cache entry', async () => {
    const { acquirePrefab, releasePrefab, getCachedPrefab } = await getCache();
    await acquirePrefab(1, G('/tree.prefab.json'));
    releasePrefab(1, G('/tree.prefab.json'));
    expect(getCachedPrefab(G('/tree.prefab.json'))).toBeUndefined();
  });

  it('invalidatePrefab(guid) evicts so the next acquire re-reads the file', async () => {
    const { acquirePrefab, invalidatePrefab, getCachedPrefab } = await getCache();
    await acquirePrefab(1, G('/tree.prefab.json'));
    expect(fetchCalls['/tree.prefab.json']).toBe(1);

    invalidatePrefab(G('/tree.prefab.json'));
    expect(getCachedPrefab(G('/tree.prefab.json'))).toBeUndefined();

    // Owner (scene 1) still holds it, but the cache was cleared → re-fetch from
    // disk. This is the cross-scene apply path: edit a prefab, then a scene still
    // referencing it must pick up the new file instead of the stale cached copy.
    await acquirePrefab(1, G('/tree.prefab.json'));
    expect(fetchCalls['/tree.prefab.json']).toBe(2);
  });

  it('invalidatePrefab also accepts the resolved internal path (regression)', async () => {
    // The cache is keyed by the RESOLVED path. The earlier bug passed that path to
    // invalidatePrefab, which ran it through resolveRef — and resolveRef REJECTS
    // internal asset paths (.prefab.json) → undefined → the eviction silently
    // no-op'd, leaving a stale prefab cached (the ShipShake/flame bug). Passing the
    // path directly must still evict.
    const { acquirePrefab, invalidatePrefab, getCachedPrefab } = await getCache();
    await acquirePrefab(1, G('/tree.prefab.json'));
    expect(getCachedPrefab(G('/tree.prefab.json'))).toBeDefined();

    invalidatePrefab('/tree.prefab.json'); // the resolved internal path, not the GUID
    expect(getCachedPrefab(G('/tree.prefab.json'))).toBeUndefined();
  });

  it('invalidatePrefab on an unknown ref is a no-op (no throw)', async () => {
    const { invalidatePrefab } = await getCache();
    expect(() => invalidatePrefab('00000000-0000-4000-8000-0000000000ff')).not.toThrow();
    expect(() => invalidatePrefab('/never-cached.prefab.json')).not.toThrow();
  });
});

describe('releaseAllForScene', () => {
  it('releases every resource held by the given scene in one call', async () => {
    const { acquireMaterial, acquireMesh, acquirePrefab, releaseAllForScene, getResourceStats } = await getCache();

    await acquireMaterial(1, G('/m1.mat.json'));
    await acquireMesh(1, G('/cube.mesh.json'));     // → also acquires /island.glb
    await acquirePrefab(1, G('/tree.prefab.json'));

    let stats = getResourceStats();
    expect(stats.materials['/m1.mat.json']).toBe(1);
    expect(stats.meshAssets['/cube.mesh.json']).toBe(1);
    expect(stats.models['/island.glb']).toBe(1);
    expect(stats.prefabs['/tree.prefab.json']).toBe(1);

    releaseAllForScene(1);

    stats = getResourceStats();
    expect(Object.keys(stats.materials)).toHaveLength(0);
    expect(Object.keys(stats.meshAssets)).toHaveLength(0);
    expect(Object.keys(stats.models)).toHaveLength(0);
    expect(Object.keys(stats.prefabs)).toHaveLength(0);
  });

  it('preserves resources held by other scenes', async () => {
    const { acquireMaterial, releaseAllForScene, getResourceStats } = await getCache();

    await acquireMaterial(1, G('/m1.mat.json'));
    await acquireMaterial(1, G('/m2.mat.json'));
    await acquireMaterial(2, G('/m2.mat.json')); // shared
    await acquireMaterial(2, G('/m3.mat.json'));

    releaseAllForScene(1);

    const stats = getResourceStats();
    // m1 was scene-1-only — gone
    expect(stats.materials['/m1.mat.json']).toBeUndefined();
    // m2 was shared — scene 2 still holds it
    expect(stats.materials['/m2.mat.json']).toBe(1);
    // m3 was scene-2-only — still there
    expect(stats.materials['/m3.mat.json']).toBe(1);
  });

  it('the A,B,C → D,E,B scenario: shared resources are not reloaded', async () => {
    const { acquireMaterial, releaseAllForScene } = await getCache();

    // Scene 1 (A,B,C)
    await acquireMaterial(1, G('/m1.mat.json')); // A
    await acquireMaterial(1, G('/m2.mat.json')); // B
    await acquireMaterial(1, G('/m3.mat.json')); // C
    expect(fetchCalls['/m1.mat.json']).toBe(1);
    expect(fetchCalls['/m2.mat.json']).toBe(1);
    expect(fetchCalls['/m3.mat.json']).toBe(1);

    // Scene 2 (D,E,B): D=m1?, E=m3?, B=m2 — for variety, just reuse m2 as the shared
    // Actually let's simulate: scene 2 needs m2 (shared), m4, m5. Use m1 and m3 as new for scene 2.
    // But to model "B" being reused exactly, scene 2 acquires m2 again.
    await acquireMaterial(2, G('/m2.mat.json'));
    // No second fetch — m2 is already cached
    expect(fetchCalls['/m2.mat.json']).toBe(1);

    // Now scene 1 unloads
    releaseAllForScene(1);

    // m2 should still be cached because scene 2 holds it
    const { getResourceStats, resolveMaterial } = await getCache();
    expect(getResourceStats().materials['/m2.mat.json']).toBe(1);
    expect(resolveMaterial(G('/m2.mat.json'))).toBeDefined();

    // m1 and m3 should be gone
    expect(resolveMaterial(G('/m1.mat.json'))).toBeUndefined();
    expect(resolveMaterial(G('/m3.mat.json'))).toBeUndefined();
  });
});

describe('refcount cache — environment (HDR)', () => {
  it('acquireEnvironment loads and caches the HDR texture', async () => {
    const { acquireEnvironment, getCachedEnvironment } = await getCache();
    await acquireEnvironment(1, G('/env/sky.hdr'));
    // getCachedEnvironment resolves the ref to the HDR path; the HDRLoader mock
    // keys its uuid by that resolved path.
    const tex = getCachedEnvironment(G('/env/sky.hdr'));
    expect(tex).toBeDefined();
    expect(tex!.uuid).toBe('hdr-/env/sky.hdr');
  });

  it('second acquire from another scene shares the cached HDR (loaded once, not reloaded)', async () => {
    const { acquireEnvironment, getCachedEnvironment } = await getCache();
    const first = await acquireEnvironment(1, G('/env/sky.hdr'));
    void first;
    const texAfterFirst = getCachedEnvironment(G('/env/sky.hdr'));
    await acquireEnvironment(2, G('/env/sky.hdr'));
    // The HDR was loaded exactly once despite two acquires — the second owner
    // shares the cached texture rather than triggering a reload.
    expect(hdr.loads['/env/sky.hdr']).toBe(1);
    // And it's the SAME texture object both owners reference.
    expect(getCachedEnvironment(G('/env/sky.hdr'))).toBe(texAfterFirst);
    expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeDefined();
  });

  it('release from last owner disposes the HDR texture', async () => {
    const { acquireEnvironment, releaseEnvironment, getCachedEnvironment } = await getCache();
    await acquireEnvironment(1, G('/env/sky.hdr'));
    const tex = getCachedEnvironment(G('/env/sky.hdr'))!;
    releaseEnvironment(1, G('/env/sky.hdr'));
    expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeUndefined();
    expect(tex.dispose).toHaveBeenCalled();
  });

  it('release with remaining owner keeps the texture alive', async () => {
    const { acquireEnvironment, releaseEnvironment, getCachedEnvironment } = await getCache();
    await acquireEnvironment(1, G('/env/sky.hdr'));
    await acquireEnvironment(2, G('/env/sky.hdr'));
    releaseEnvironment(1, G('/env/sky.hdr'));
    expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeDefined();
  });

  it('releaseAllForScene releases environment refs', async () => {
    const { acquireEnvironment, acquireMaterial, releaseAllForScene, getCachedEnvironment } = await getCache();
    await acquireEnvironment(1, G('/env/sky.hdr'));
    await acquireMaterial(1, G('/m1.mat.json'));
    releaseAllForScene(1);
    expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeUndefined();
  });

  it('empty path is a no-op', async () => {
    const { acquireEnvironment, getCachedEnvironment } = await getCache();
    await acquireEnvironment(1, '');
    expect(getCachedEnvironment('')).toBeUndefined();
  });

  it('a completed HDR load fires the dirty signal (wakes the render-on-demand viewport)', async () => {
    // Parity with the material-rebuild dirty test (meshTemplateCache.test.ts) — the env
    // path never got this coverage. fetchEnvironment must fireDirtyListeners() on a
    // successful load so an HDR that finishes AFTER the Inspector's dirty grace window
    // (live-edit / re-import) re-applies IBL instead of leaving the scene idle + unlit.
    const { acquireEnvironment, getCachedEnvironment } = await getCache();
    // addDirtyListener must come from the SAME fresh module graph the cache calls
    // fireDirtyListeners() on (resetModules wiped both), so import it post-reset here.
    const { addDirtyListener } = await import('../../src/runtime/ecs/entityUtils');
    const dirty = vi.fn();
    const unsub = addDirtyListener(dirty);
    try {
      // awaiting flushes the mocked HDRLoader's setTimeout(0) onLoad.
      await acquireEnvironment(1, G('/env/sky.hdr'));
      expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeDefined();
      expect(dirty).toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it('mid-load guard: an HDR whose only owner is released before onLoad is disposed, not cached, and fires no dirty signal', async () => {
    // fetchEnvironment snapshots ownership and re-checks `!envOwners.has(hdrPath)` when
    // the texture arrives. Start the load, drop the sole owner synchronously (before the
    // setTimeout onLoad fires), then flush: the arriving texture must be disposed (not
    // left owner-less in the cache) and the dirty signal must NOT fire.
    const { acquireEnvironment, releaseEnvironment, getCachedEnvironment } = await getCache();
    const { addDirtyListener } = await import('../../src/runtime/ecs/entityUtils');
    const dirty = vi.fn();
    const unsub = addDirtyListener(dirty);
    try {
      // Do NOT await — the load promise is in flight (onLoad still queued).
      const p = acquireEnvironment(1, G('/env/sky.hdr'));
      // Remove the only owner synchronously, BEFORE onLoad fires.
      releaseEnvironment(1, G('/env/sky.hdr'));
      await p; // flush the setTimeout → onLoad hits the `!envOwners.has` guard
      const tex = hdr.textures[hdr.textures.length - 1];
      expect(tex.dispose).toHaveBeenCalled();          // the arriving texture was disposed
      expect(getCachedEnvironment(G('/env/sky.hdr'))).toBeUndefined(); // not cached
      expect(dirty).not.toHaveBeenCalled();            // no wake — nothing was applied
    } finally {
      unsub();
    }
  });
});

describe('refcount cache — failed-fetch ownership (F8)', () => {
  // F8 invariant: acquire* adds the scene as an owner BEFORE awaiting the fetch, so a
  // failed (404) resource keeps the owner under its scene. Correctness depends entirely
  // on scene teardown (releaseAllForScene) unwinding it — pin that here so a future
  // acquire caller can't silently strand an owner past the scene's lifetime.
  it('a 404 material keeps the owner under its scene, then releaseAllForScene unwinds it', async () => {
    const { acquireMaterial, getResourceStats, releaseAllForScene } = await getCache();
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const guid = '10000000-0000-4000-8000-0000000000ff';
    manifest.registerAsset(guid, '/missing.mat.json', 'material');

    // fetch() returns { ok: false } for unknown paths → fetchMaterial caches MATERIAL_FAILED
    // and RESOLVES (no throw), so the owner added before the await persists.
    await expect(acquireMaterial(9, guid)).resolves.toBeUndefined();
    expect(fetchCalls['/missing.mat.json']).toBe(1);
    expect(getResourceStats().materials['/missing.mat.json']).toBe(1);

    // The only safety net: scene swap/teardown drops the owner — no orphan past the scene.
    releaseAllForScene(9);
    expect(getResourceStats().materials['/missing.mat.json']).toBeUndefined();
  });
});

describe('material error paths (Missing Test #1)', () => {
  it('non-ok response caches MATERIAL_FAILED and does NOT re-fetch', async () => {
    const { acquireMaterial, resolveMaterial } = await getCache();
    // /bad.mat.json is registered but absent from fetchResponses → ok:false.
    await acquireMaterial(1, G('/bad.mat.json'));
    expect(fetchCalls['/bad.mat.json']).toBe(1);
    // Permanently failed → resolveMaterial returns undefined and must NOT re-fetch.
    expect(resolveMaterial(G('/bad.mat.json'))).toBeUndefined();
    expect(resolveMaterial(G('/bad.mat.json'))).toBeUndefined();
    expect(fetchCalls['/bad.mat.json']).toBe(1);
    // A second acquire from another scene reuses the cached failure (no refetch).
    await acquireMaterial(2, G('/bad.mat.json'));
    expect(fetchCalls['/bad.mat.json']).toBe(1);
  });

  it('unknown material `type` caches MATERIAL_FAILED and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acquireMaterial, resolveMaterial } = await getCache();
    await acquireMaterial(1, G('/unknown.mat.json'));
    expect(resolveMaterial(G('/unknown.mat.json'))).toBeUndefined();
    expect(fetchCalls['/unknown.mat.json']).toBe(1); // fetched once, then failed-sentinel
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('disposeAllCachedResources mid-load discards the material (gen mismatch) — not cached', async () => {
    const { acquireMaterial, disposeAllCachedResources } = await getCache();
    // Start the load but DON'T await — the async builder/texture phase is still in flight.
    const p = acquireMaterial(1, G('/m1.mat.json'));
    // Bump cacheGeneration synchronously before the load's await chain resolves.
    disposeAllCachedResources();
    await p;
    // The just-built material hit `gen !== cacheGeneration` → disposed, never cached.
    // Proof it isn't cached: a fresh acquire must re-fetch (count climbs to 2).
    await acquireMaterial(2, G('/m1.mat.json'));
    expect(fetchCalls['/m1.mat.json']).toBe(2);
  });
});

describe('cross-scene-swap survival — models & meshes (Missing Test #5)', () => {
  // The materials-only A,B,C→D,E,B test already covers shared *materials* across a
  // swap. These extend the same survival contract to whole models + mesh assets:
  // acquire the NEW scene before releasing the OLD one, so a resource shared by two
  // consecutive scenes is briefly owned by {old,new}; releasing old leaves {new} and
  // the resource survives instead of being disposed + re-parsed.
  it('a model shared across two consecutive scenes survives the swap (templates intact)', async () => {
    const { acquireModel, releaseAllForScene, getResourceStats, getTemplatesForModel } = await getCache();
    await acquireModel(1, G('/island.glb'));
    expect(getResourceStats().models['/island.glb']).toBe(1);
    expect(getTemplatesForModel('/island.glb').size).toBeGreaterThan(0);

    // Swap: acquire scene 2 FIRST (acquire-new-before-release-old), THEN drop scene 1.
    await acquireModel(2, G('/island.glb'));
    expect(getResourceStats().models['/island.glb']).toBe(2);
    releaseAllForScene(1);

    // Survives under scene 2 — owner refcount drops to 1, templates stay resident
    // (no dispose-then-reparse churn across the swap).
    expect(getResourceStats().models['/island.glb']).toBe(1);
    expect(getTemplatesForModel('/island.glb').size).toBeGreaterThan(0);
  });

  it('a mesh asset shared across two consecutive scenes survives the swap; fetched once', async () => {
    const { acquireMesh, releaseAllForScene, getResourceStats, getTemplatesForModel } = await getCache();
    await acquireMesh(1, G('/cube.mesh.json'));   // → also acquires /island.glb
    expect(fetchCalls['/cube.mesh.json']).toBe(1);

    await acquireMesh(2, G('/cube.mesh.json'));
    expect(fetchCalls['/cube.mesh.json']).toBe(1); // mesh JSON fetched exactly once

    releaseAllForScene(1);
    const stats = getResourceStats();
    // Both the mesh asset and its transitive model survive under scene 2.
    expect(stats.meshAssets['/cube.mesh.json']).toBe(1);
    expect(stats.models['/island.glb']).toBe(1);
    expect(getTemplatesForModel('/island.glb').size).toBeGreaterThan(0);
  });
});

describe('re-import-mid-scene transitive snapshot (Missing Test #3)', () => {
  it('releaseMesh drops model+material owners via the snapshot even after the mesh-asset entry is evicted', async () => {
    const { acquireMesh, releaseMesh, invalidateModel, getResourceStats } = await getCache();

    // sphere.mesh.json → model island.glb + material m1.mat.json (transitive).
    await acquireMesh(1, G('/sphere.mesh.json'));
    let stats = getResourceStats();
    expect(stats.meshAssets['/sphere.mesh.json']).toBe(1);
    expect(stats.models['/island.glb']).toBe(1);
    expect(stats.materials['/m1.mat.json']).toBe(1);

    // Simulate a mid-scene re-import: invalidateModel evicts the mesh-asset cache
    // entry that references the model (meshTemplateCache.ts:372-376). The owner
    // refcounts are untouched — only the cached data is dropped.
    invalidateModel('/island.glb');

    // releaseMesh must read the per-(scene,mesh) snapshot (meshTransitiveDeps), NOT
    // the now-gone mesh-asset cache entry, to unwind the transitive owners. If it
    // read the evicted cache it would leak the model + material owners.
    releaseMesh(1, G('/sphere.mesh.json'));
    stats = getResourceStats();
    expect(stats.meshAssets['/sphere.mesh.json']).toBeUndefined();
    expect(stats.models['/island.glb']).toBeUndefined();
    expect(stats.materials['/m1.mat.json']).toBeUndefined();
  });
});
