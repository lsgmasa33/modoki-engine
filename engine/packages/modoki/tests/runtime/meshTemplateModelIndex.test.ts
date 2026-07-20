/** F9 — per-model template index.
 *
 *  `getTemplatesForModel` / `lookupTemplate` / `invalidateModel` used to full-scan
 *  the cache map (`startsWith` per entry). They now consult a
 *  `Map<modelPath, Set<templateKey>>` index kept in lockstep with the cache, so
 *  per-model lookups + invalidation are O(meshes-in-model). These tests drive the
 *  real `loadModelTemplates` path (which populates the cache + index) and assert
 *  the index-backed reads behave exactly like the old scan:
 *    - per-model lookups return only that model's meshes (no cross-model bleed),
 *    - the gltfpack-stripped single-mesh fallback still resolves,
 *    - `invalidateModel` drops exactly one model's entries + disposes its geometry,
 *  while a model that shares no prefix is untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

/** Build a GLTF stub scene with `meshNames.length` named meshes under a root. */
function makeScene(meshNames: string[]): { scene: THREE.Object3D } {
  const root = new THREE.Group();
  for (const name of meshNames) {
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    mesh.name = name;
    root.add(mesh);
  }
  return { scene: root };
}

/** Drive loadModelTemplates with a stubbed GLTFLoader so no network is hit. */
async function load(
  cache: typeof import('../../src/runtime/loaders/meshTemplateCache'),
  path: string,
  meshNames: string[],
): Promise<void> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
    (_url: string, onLoad: (gltf: { scene: THREE.Object3D }) => void) => {
      onLoad(makeScene(meshNames));
    },
  );
  try {
    await cache.loadModelTemplates(path, undefined, 'none', false);
  } finally {
    spy.mockRestore();
  }
}

describe('per-model template index (F9)', () => {
  it('getTemplatesForModel returns only the queried model\'s meshes', async () => {
    const cache = await getCache();
    await load(cache, '/m/a.glb', ['rock', 'tree']);
    await load(cache, '/m/b.glb', ['boat']);

    // a.glb has 2 meshes, b.glb has 1 — no cross-model bleed. (Template names
    // are derived by deriveTemplateName, not the stub's mesh.name, so assert
    // counts + per-model isolation rather than specific names.)
    expect(cache.getTemplatesForModel('/m/a.glb').size).toBe(2);
    expect(cache.getTemplatesForModel('/m/b.glb').size).toBe(1);

    // A model that shares a path-prefix but not the full path must not bleed in.
    // (keys are `${path}::${name}`, so the index keys on the exact model path.)
    expect(cache.getTemplatesForModel('/m/a').size).toBe(0);
    expect(cache.getTemplatesForModel('/m/nonexistent.glb').size).toBe(0);
  });

  it('single-mesh fallback (gltfpack-stripped name) still resolves via the index', async () => {
    const cache = await getCache();
    // gltfpack renamed the only mesh to 'mesh_0'; a .mesh.json referencing the
    // original 'rock' name misses the exact key and falls back to the lone
    // template for that model.
    await load(cache, '/m/single.glb', ['mesh_0']);
    const all = cache.getTemplatesForModel('/m/single.glb');
    // resolveMeshTemplate's lookupTemplate fallback relies on this: exactly one
    // template under the model, so a name-miss can resolve unambiguously.
    expect(all.size).toBe(1);
  });

  it('invalidateModel drops + disposes only the target model, leaving others intact', async () => {
    const cache = await getCache();
    await load(cache, '/m/a.glb', ['rock', 'tree']);
    await load(cache, '/m/b.glb', ['boat']);

    const aTemplates = cache.getTemplatesForModel('/m/a.glb');
    const disposeSpies = [...aTemplates.values()].map((t) =>
      vi.spyOn(t.geometry, 'dispose'),
    );

    cache.invalidateModel('/m/a.glb');

    // a.glb's entries are gone and their geometry disposed.
    expect(cache.getTemplatesForModel('/m/a.glb').size).toBe(0);
    for (const s of disposeSpies) expect(s).toHaveBeenCalledTimes(1);
    // hierarchy for the model is cleared too.
    expect(cache.getModelHierarchy('/m/a.glb')).toBeUndefined();

    // b.glb untouched — the index isolates invalidation to the target model.
    expect(cache.getTemplatesForModel('/m/b.glb').size).toBe(1);
  });

  it('re-loading a model after invalidate repopulates the index', async () => {
    const cache = await getCache();
    await load(cache, '/m/a.glb', ['rock', 'tree']);
    cache.invalidateModel('/m/a.glb');
    expect(cache.getTemplatesForModel('/m/a.glb').size).toBe(0);

    await load(cache, '/m/a.glb', ['rock', 'tree', 'extra']);
    expect(cache.getTemplatesForModel('/m/a.glb').size).toBe(3);
  });
});
