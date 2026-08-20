/** A FAILED model load must not be cached forever (#254 close-out).
 *
 *  `loadModelTemplates` stores its in-flight promise in the module's `loading` map, and that map
 *  is also what makes a second acquire of the same GLB dedupe rather than re-parse. Nothing
 *  removes an entry on failure — only `invalidateModel` (an explicit editor re-import) and
 *  `disposeAllCachedResources` (teardown) ever delete. So a rejected promise sat there for the
 *  life of the page and every later acquire got it back with no new attempt.
 *
 *  That was survivable while the only way to reject was a missing or corrupt GLB — a permanent
 *  condition, where caching the "no" is right. #254 added a plausibly TRANSIENT cause: the
 *  loader's own code-split chunk fetch. `threeLoaderModules` already drops its memo on rejection
 *  so it self-heals, and `riggedModelCache` does the same — this pins that the recovery is not
 *  stranded one layer short of the caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const gltf = vi.hoisted(() => ({ attempts: 0, failNext: true }));

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    load(
      _p: string,
      onLoad: (g: unknown) => void,
      _onProgress?: unknown,
      onError?: (e: unknown) => void,
    ) {
      gltf.attempts++;
      // First attempt fails the way a transient chunk/network failure does; later ones succeed.
      if (gltf.failNext) { gltf.failNext = false; setTimeout(() => onError?.(new Error('transient')), 0); return; }
      // A real Group: `onGltf` calls `updateMatrixWorld`/`traverse` on it, so a bare object
      // literal fails inside the success path and would make the retry look like a failure.
      const scene = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      mesh.name = 'm';
      scene.add(mesh);
      setTimeout(() => onLoad({ scene }), 0);
    }
  },
}));

import { loadModelTemplates, disposeAllCachedResources } from '../../src/runtime/loaders/meshTemplateCache';

const PATH = '/models/retry.glb';

beforeEach(() => {
  disposeAllCachedResources();
  gltf.attempts = 0;
  gltf.failNext = true;
});

describe('loadModelTemplates — a failed load is retryable (#254)', () => {
  it('does not hand the same rejected promise to every later acquire', async () => {
    await expect(loadModelTemplates(PATH)).rejects.toThrow();
    expect(gltf.attempts).toBe(1);

    // The retry is the whole point: with the rejection left in `loading`, this resolves to the
    // SAME rejected promise, `attempts` stays at 1, and the model is unloadable until a reload.
    await expect(loadModelTemplates(PATH)).resolves.toBeUndefined();
    expect(gltf.attempts).toBe(2);
  });

  it('still dedupes a SUCCESSFUL load — the eviction must not cost the cache', async () => {
    gltf.failNext = false;
    const a = loadModelTemplates(PATH);
    const b = loadModelTemplates(PATH);
    expect(b).toBe(a); // one in-flight parse shared
    await Promise.all([a, b]);
    await loadModelTemplates(PATH); // and a later acquire still does not re-parse
    expect(gltf.attempts).toBe(1);
  });
});
