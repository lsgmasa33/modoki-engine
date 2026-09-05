/** #719 — `invalidateModel` used to dispose ONLY `tmpl.geometry`, dropping
 *  `tmpl.material` (the GLB-embedded `MeshStandardMaterial`, carrying the
 *  model's base-colour / normal / ORM textures) on the floor. It now also
 *  disposes `tmpl.material` via the module-private `disposeMaterial` helper,
 *  which walks every texture-valued property (+ `userData.textures`),
 *  releases shared-cache textures via `releaseTexture3D` and directly
 *  disposes + dedupes the rest, then disposes the material itself.
 *
 *  Modeled on `meshTemplateModelIndex.test.ts`'s harness (stubbed GLTFLoader
 *  driving the real `loadModelTemplates`), but with an explicit mesh-spec
 *  scene builder so tests can control material/texture SHARING across
 *  meshes — the model-index test's `makeScene` always mints a fresh material
 *  per mesh and can't exercise the dedupe sets.
 *
 *  A plain `new THREE.Texture()` carries no `userData` shared-cache stamp
 *  (that stamp is set only inside `loadTexture3D`, which a GLTFLoader parse
 *  never goes through), so `isSharedTexture` is false for it and it takes
 *  the direct-dispose + dedupe branch in `disposeMaterial` — exactly how a
 *  GLB-embedded texture behaves in production.
 *
 *  Assertions are all on `vi.spyOn(obj, 'dispose')` spies, never on internal
 *  cache state. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

interface MeshSpec { name: string; material: THREE.Material; }

/** Build a GLTF stub scene from explicit mesh specs. */
function makeScene(specs: MeshSpec[]): { scene: THREE.Object3D } {
  const root = new THREE.Group();
  for (const spec of specs) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), spec.material);
    mesh.name = spec.name;
    root.add(mesh);
  }
  return { scene: root };
}

/** Drive loadModelTemplates with a stubbed GLTFLoader so no network is hit.
 *  Mirrors meshTemplateModelIndex.test.ts's `load` helper. */
async function load(
  cache: typeof import('../../src/runtime/loaders/meshTemplateCache'),
  path: string,
  specs: MeshSpec[],
): Promise<void> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
    (_url: string, onLoad: (gltf: any) => void) => {
      onLoad(makeScene(specs));
    },
  );
  try {
    await cache.loadModelTemplates(path, undefined, 'none', false);
  } finally {
    spy.mockRestore();
  }
}

describe('invalidateModel disposes the GLB-embedded material + textures (#719)', () => {
  it('disposes the template material', async () => {
    const cache = await getCache();
    const material = new THREE.MeshStandardMaterial();
    await load(cache, '/m/a.glb', [{ name: 'rock', material }]);

    const disposeSpy = vi.spyOn(material, 'dispose');
    cache.invalidateModel('/m/a.glb');

    // FAILS before the fix: the old invalidateModel never touched tmpl.material
    // at all, so this spy would never be called.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("disposes the material's textures", async () => {
    const cache = await getCache();
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map, normalMap });
    await load(cache, '/m/a.glb', [{ name: 'rock', material }]);

    const mapSpy = vi.spyOn(map, 'dispose');
    const normalSpy = vi.spyOn(normalMap, 'dispose');
    cache.invalidateModel('/m/a.glb');

    // FAILS before the fix: since the material itself was never reached, its
    // textures were never reached either — both slots take the direct-dispose
    // branch (non-shared textures), so this pins the whole reachability chain.
    expect(mapSpy).toHaveBeenCalledTimes(1);
    expect(normalSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes a material shared by two meshes in one model — disposed exactly once', async () => {
    const cache = await getCache();
    const material = new THREE.MeshStandardMaterial();
    await load(cache, '/m/a.glb', [
      { name: 'rock', material },
      { name: 'tree', material }, // same instance in both templates
    ]);

    const disposeSpy = vi.spyOn(material, 'dispose');
    cache.invalidateModel('/m/a.glb');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes a texture shared by two DIFFERENT materials in one model — disposed exactly once', async () => {
    const cache = await getCache();
    const sharedMap = new THREE.Texture();
    const matA = new THREE.MeshStandardMaterial({ map: sharedMap });
    const matB = new THREE.MeshStandardMaterial({ map: sharedMap }); // same texture instance
    await load(cache, '/m/a.glb', [
      { name: 'rock', material: matA },
      { name: 'tree', material: matB },
    ]);

    const texSpy = vi.spyOn(sharedMap, 'dispose');
    cache.invalidateModel('/m/a.glb');

    // FAILS if the disposedTex dedupe set were dropped: matA and matB are two
    // distinct materials, so without the dedupe this texture would try to
    // dispose twice (THREE's WebGLRenderer would warn/no-op on a second real
    // dispose, but the spy still records the extra call).
    expect(texSpy).toHaveBeenCalledTimes(1);
  });

  it('still disposes the geometry too — regression guard for the pre-existing behaviour', async () => {
    const cache = await getCache();
    const material = new THREE.MeshStandardMaterial();
    await load(cache, '/m/a.glb', [{ name: 'rock', material }]);

    const tmpl = [...cache.getTemplatesForModel('/m/a.glb').values()][0];
    const geoSpy = vi.spyOn(tmpl.geometry, 'dispose');
    cache.invalidateModel('/m/a.glb');

    expect(geoSpy).toHaveBeenCalledTimes(1);
  });

  it("does not touch a non-targeted model's material or textures", async () => {
    const cache = await getCache();
    const mapA = new THREE.Texture();
    const materialA = new THREE.MeshStandardMaterial({ map: mapA });
    const mapB = new THREE.Texture();
    const materialB = new THREE.MeshStandardMaterial({ map: mapB });
    await load(cache, '/m/a.glb', [{ name: 'rock', material: materialA }]);
    await load(cache, '/m/b.glb', [{ name: 'boat', material: materialB }]);

    const matSpyA = vi.spyOn(materialA, 'dispose');
    const texSpyA = vi.spyOn(mapA, 'dispose');
    const matSpyB = vi.spyOn(materialB, 'dispose');
    const texSpyB = vi.spyOn(mapB, 'dispose');

    cache.invalidateModel('/m/a.glb');

    expect(matSpyA).toHaveBeenCalledTimes(1);
    expect(texSpyA).toHaveBeenCalledTimes(1);
    // b.glb untouched — invalidateModel scopes to the target model's index only.
    expect(matSpyB).not.toHaveBeenCalled();
    expect(texSpyB).not.toHaveBeenCalled();
  });
  /** Pins the ownership boundary the `runtimeOwnedMaterial` flag exists for (#719 close-out).
   *
   *  ONE `cache` map holds two kinds of template with OPPOSITE material ownership: a GLB template
   *  owns its embedded material, a `registerRuntimeMeshTemplate` one BORROWS its material (a scene
   *  material by GUID, or a shared module constant like `games/sling`'s `COLLIDER_ONLY_MAT`).
   *  Before the flag, the only thing separating them was that no runtime key happened to contain
   *  `::`, so `modelPathOfKey` indexed it under itself and a GLB path never matched — a coincidence
   *  of naming, not an invariant. This test uses a key that DOES collide, so it fails the moment
   *  the flag stops being honoured. */
  it('never disposes a runtime-registered template\'s BORROWED material, even when its key collides with the invalidated model path', async () => {
    const cache = await getCache();
    // Deliberately hostile key: `modelPathOfKey` splits on the last '::', so this indexes under
    // '/m/a.glb' — exactly the model being invalidated.
    const borrowed = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const geo = new THREE.BufferGeometry();
    cache.registerRuntimeMeshTemplate('/m/a.glb::runtime-part', geo, borrowed);

    const matSpy = vi.spyOn(borrowed, 'dispose');
    const texSpy = vi.spyOn(borrowed.map!, 'dispose');
    const geoSpy = vi.spyOn(geo, 'dispose');

    cache.invalidateModel('/m/a.glb');

    // The material is the SCENE's, not this cache's — disposing it would break a live scene.
    expect(matSpy).not.toHaveBeenCalled();
    expect(texSpy).not.toHaveBeenCalled();
    // Geometry IS owned by the cache, so it is still freed — the flag scopes to the material only.
    expect(geoSpy).toHaveBeenCalledTimes(1);
  });
});
