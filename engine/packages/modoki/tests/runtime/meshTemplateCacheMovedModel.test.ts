/** Integration regression for the "moved model 404s" bug.
 *
 *  A model's `.meta.json` bakes absolute variant URLs (`modelCache.processedPath`/
 *  `lodPaths`) from its import-time location. Moving/renaming the source updates the
 *  guid→path map but NOT those baked strings, so the runtime loader used to fetch
 *  the OLD location and 404 (GLTFLoader → "Unexpected token '<'"). The fix derives
 *  variant URLs from the asset's CURRENT path in `assetManifest.registerAsset`; this
 *  test proves the WHOLE chain honours it — `acquireModel` (a real consumer) must
 *  ask the GLTFLoader for the current-path variants, never the stale ones.
 *
 *  Mocks the GLTFLoader to capture the URLs it is asked to load and resolve with an
 *  empty scene (no binary needed), mirroring meshTemplateCacheDispose.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Captures every URL the runtime asks the GLTFLoader to fetch.
const loadedUrls: string[] = [];

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    setKTX2Loader(_d: unknown) {}
    load(url: string, onLoad: (g: { scene: THREE.Group }) => void) {
      loadedUrls.push(url);
      // An empty scene (no meshes) is enough — we assert on the requested URLs,
      // which are captured on this call before any parse work runs.
      onLoad({ scene: new THREE.Group() });
    }
  },
}));

/** A modelCache whose baked variant paths point at a STALE (pre-move) location. */
const staleCacheAt = (oldBase: string) => ({
  hash: 'cafef00d',
  processedPath: `${oldBase}.processed.glb`,
  lodPaths: [`${oldBase}.processed.glb`, `${oldBase}.lod1.glb`, `${oldBase}.lod2.glb`],
  lodDistances: [0, 80, 250],
  triCounts: [2060, 824, 308],
  lodBytes: [37508, 21312, 11704],
});

beforeEach(async () => {
  vi.resetModules();
  loadedUrls.length = 0;
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

describe('meshTemplateCache — a moved model loads its CURRENT-path variants (stale-processedPath 404 regression)', () => {
  it('acquireModel requests the variant URLs derived from the model current path, not the baked stale ones', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');

    const guid = manifest.newGuid();
    // Model was imported at /assets/models/pad.gltf (baked cache below), then MOVED
    // into pad/ — the meta's baked paths still say the old top-level location.
    manifest.registerAsset(guid, '/assets/models/pad/pad.gltf', 'model', undefined, {
      modelCache: staleCacheAt('/assets/models/pad.gltf'),
    });

    await cache.acquireModel('scene-1', guid);

    // Three LOD GLBs fetched, all from the CURRENT pad/ location, none stale.
    expect(loadedUrls).toHaveLength(3);
    expect(loadedUrls.every((u) => u.includes('/assets/models/pad/pad.gltf'))).toBe(true);
    expect(loadedUrls.some((u) => u.includes('/assets/models/pad.gltf.processed.glb'))).toBe(false);
    expect(loadedUrls.some((u) => u.endsWith('/assets/models/pad/pad.gltf.processed.glb') || u.includes('/assets/models/pad/pad.gltf.processed.glb'))).toBe(true);
    expect(loadedUrls.some((u) => u.includes('/assets/models/pad/pad.gltf.lod1.glb'))).toBe(true);
    expect(loadedUrls.some((u) => u.includes('/assets/models/pad/pad.gltf.lod2.glb'))).toBe(true);
  });

  it('re-registering the guid at a newer path shifts the requested URLs to that path', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');

    const guid = manifest.newGuid();
    manifest.registerAsset(guid, '/assets/models/pad.gltf', 'model', undefined, {
      modelCache: staleCacheAt('/assets/models/pad.gltf'),
    });
    // Move again → deeper folder. Baked cache unchanged (still stale).
    manifest.registerAsset(guid, '/assets/models/sub/pad.gltf', 'model', undefined, {
      modelCache: staleCacheAt('/assets/models/pad.gltf'),
    });

    await cache.acquireModel('scene-2', guid);

    expect(loadedUrls).toHaveLength(3);
    expect(loadedUrls.every((u) => u.includes('/assets/models/sub/pad.gltf'))).toBe(true);
  });
});
