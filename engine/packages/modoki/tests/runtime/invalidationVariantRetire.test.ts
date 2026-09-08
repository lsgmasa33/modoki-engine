/** `attachInvalidationListener` narrows light-mask-variant retirement to `disposedMats` —
 *  exactly the materials `invalidateModel` is about to dispose (its owned template materials,
 *  excluding `runtimeOwnedMaterial` ones) — rather than retiring by evicted OBJECT.
 *
 *  WHY THE NARROWING MATTERS: `scene3DSync` binds a mesh's material-OVERRIDE to the shared cached
 *  `.mat.json` instance, which `invalidateModel` never disposes. Retiring variants on that base
 *  would delete light-mask variants belonging to OTHER, still-live entities sharing the override —
 *  each then re-mints a clone + pipeline and renders UNLIT while it compiles. So narrowing to
 *  `disposedMats` is a correctness guard, not an optimisation (see `scene3DSync.ts`,
 *  `attachInvalidationListener`, the comment above the `materialsOf` loop).
 *
 *  Drives the REAL `invalidateModel` (`meshTemplateCache.ts`) over a stubbed `GLTFLoader` +
 *  `fetch`, mirroring `meshTemplateModelIndex.test.ts` / `meshTemplateMaterialRelease.test.ts`'s
 *  harness, and the REAL `lightMaskVariants` cache — no internals are asserted directly, only
 *  observable cache state (`getLightMaskStats().variants`) and instance identity. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';
import {
  disposeAllCachedResources, invalidateModel, getTemplatesForModel, registerRuntimeMeshTemplate,
  whenMeshTemplate,
} from '../../src/runtime/loaders/meshTemplateCache';
import { clearAssetInvalidationListeners } from '../../src/runtime/core/assetInvalidation';
import { createRenderState, attachInvalidationListener } from '../../src/runtime/rendering/scene3DSync';
import {
  beginLightMaskFrame, getMaskedMaterial, resetLightMaskVariants, getLightMaskStats,
  type LightingFactory,
} from '../../src/runtime/rendering/lightMaskVariants';

const MODEL_GUID = '11111111-2222-4333-8444-000000000001';
const MODEL_PATH = '/games/g/assets/model/a.glb';
/** Both the mesh asset's `id` (self-registered by `fetchMeshAsset` on load, mirroring
 *  production) AND the value an `ecsSprites` entry carries — `getMeshAsset` resolves the ref via
 *  `resolveRef`, which rejects a literal internal asset path (GUID-only refs invariant), so the
 *  entity's mesh reference must be this GUID, not `MESH_JSON_PATH` itself. */
const MESH_GUID = '11111111-2222-4333-8444-000000000002';
const MESH_JSON_PATH = '/games/g/assets/mesh/rock.mesh.json';

function stubFactory(): LightingFactory {
  return { lighting: { createNode: () => ({}) } };
}

/** Two lights on disjoint masks so `getMaskedMaterial(base, 0b01, f)` always needs a real
 *  variant (the selection is narrower than the full light set). */
function armMasking(): void {
  beginLightMaskFrame(
    [{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }],
    true,
  );
}

/** Stub the GLTFLoader + fetch chain so `whenMeshTemplate(MESH_JSON_PATH)` populates BOTH the
 *  mesh-asset cache (what `getMeshAsset` inside `attachInvalidationListener` reads) and the
 *  model's templates (`getTemplatesForModel`) — exactly what a live editor re-import listener
 *  sees. `MODEL_GUID` (not a literal path) because `resolveRef` rejects a literal internal asset
 *  path (GUID-only refs invariant). */
async function seedModelAndMeshAsset(meshNames: string[]): Promise<void> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const root = new THREE.Group();
  for (const name of meshNames) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    mesh.name = name;
    root.add(mesh);
  }
  // Cast rather than `any`: three types `load`'s onLoad as `(data: GLTF) => void`, and the stub
  // supplies only the `scene` field the loader path under test reads.
  const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
    ((_url: string, onLoad: (gltf: { scene: THREE.Object3D }) => void) => onLoad({ scene: root })
    ) as unknown as typeof GLTFLoader.prototype.load,
  );
  registerAsset(MODEL_GUID, MODEL_PATH, 'model');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({
      version: 1, id: MESH_GUID, model: MODEL_GUID, mesh: meshNames[0], postprocessor: 'none',
    }),
  } as unknown as Response)));
  try {
    await whenMeshTemplate(MESH_JSON_PATH);
  } finally {
    loadSpy.mockRestore();
  }
}

let unsubscribers: Array<() => void> = [];

beforeEach(() => {
  clearManifest();
  resetLightMaskVariants();
  unsubscribers = [];
});

afterEach(() => {
  for (const u of unsubscribers) u();
  clearAssetInvalidationListeners();
  disposeAllCachedResources();
  clearManifest();
  resetLightMaskVariants();
  vi.unstubAllGlobals();
});

describe('attachInvalidationListener — light-mask variant retirement', () => {
  it('retires a variant whose base IS a template material of the invalidated model', async () => {
    await seedModelAndMeshAsset(['rock']);
    const tmpl = [...getTemplatesForModel(MODEL_PATH).values()][0];
    const baseMat = tmpl.material;

    const f = stubFactory();
    armMasking();
    const variant = getMaskedMaterial(baseMat, 0b01, f);
    expect(variant, 'setup: masking must actually mint a variant').not.toBeNull();
    expect(getLightMaskStats().variants).toBe(1);

    const scene = new THREE.Scene();
    const state = createRenderState();
    const evictedMesh = new THREE.Mesh(new THREE.BufferGeometry(), baseMat);
    state.ecsObjects.set(1, evictedMesh);
    state.ecsSprites.set(1, MESH_GUID);
    unsubscribers.push(attachInvalidationListener(state, scene));

    invalidateModel(MODEL_PATH);

    expect(getLightMaskStats().variants, 'the variant derived from a disposed template material must be gone').toBe(0);
  });

  it('does NOT retire a variant whose base is a shared .mat.json override — not in disposedMats', async () => {
    await seedModelAndMeshAsset(['rock']);
    // A material completely outside any model template — stands in for a shared `.mat.json`
    // material bound via `resolveMaterialForMesh` as a per-mesh override. `invalidateModel` never
    // disposes this, so retiring on it would wrongly hit other, still-live entities sharing it.
    const overrideMat = new THREE.MeshStandardMaterial();

    const f = stubFactory();
    armMasking();
    const variant = getMaskedMaterial(overrideMat, 0b01, f);
    expect(variant).not.toBeNull();

    const scene = new THREE.Scene();
    const state = createRenderState();
    const evictedMesh = new THREE.Mesh(new THREE.BufferGeometry(), overrideMat);
    state.ecsObjects.set(1, evictedMesh);
    state.ecsSprites.set(1, MESH_GUID);
    unsubscribers.push(attachInvalidationListener(state, scene));

    invalidateModel(MODEL_PATH);

    expect(getLightMaskStats().variants, 'the override\'s variant must survive the eviction').toBe(1);
    expect(getMaskedMaterial(overrideMat, 0b01, f), 'and the SAME instance is still served').toBe(variant);
  });

  it('does NOT retire for a runtimeOwnedMaterial template — its material is borrowed', async () => {
    await seedModelAndMeshAsset(['rock']);
    const borrowedMat = new THREE.MeshStandardMaterial();
    const borrowedGeo = new THREE.BufferGeometry();
    // Registers a template UNDER the same model path, but flagged runtimeOwnedMaterial — the
    // material is borrowed (a scene/shared material), so `invalidateModel` leaves it alone.
    registerRuntimeMeshTemplate(`${MODEL_PATH}::runtime-part`, borrowedGeo, borrowedMat);

    const f = stubFactory();
    armMasking();
    const variant = getMaskedMaterial(borrowedMat, 0b01, f);
    expect(variant).not.toBeNull();

    const scene = new THREE.Scene();
    const state = createRenderState();
    const evictedMesh = new THREE.Mesh(new THREE.BufferGeometry(), borrowedMat);
    state.ecsObjects.set(1, evictedMesh);
    state.ecsSprites.set(1, MESH_GUID);
    unsubscribers.push(attachInvalidationListener(state, scene));

    invalidateModel(MODEL_PATH);

    expect(getLightMaskStats().variants, 'a borrowed template material must not drive retirement').toBe(1);
  });

  it('materialsOf reaches child meshes — an evicted Group/LOD is not read at the root', async () => {
    await seedModelAndMeshAsset(['rock']);
    const tmpl = [...getTemplatesForModel(MODEL_PATH).values()][0];
    const baseMat = tmpl.material;

    const f = stubFactory();
    armMasking();
    const variant = getMaskedMaterial(baseMat, 0b01, f);
    expect(variant).not.toBeNull();

    const scene = new THREE.Scene();
    const state = createRenderState();
    // The evicted object is a Group (stands in for a THREE.LOD) whose material lives on a CHILD
    // mesh — the root itself carries no `.material`.
    const group = new THREE.Group();
    const child = new THREE.Mesh(new THREE.BufferGeometry(), baseMat);
    group.add(child);
    state.ecsObjects.set(1, group);
    state.ecsSprites.set(1, MESH_GUID);
    unsubscribers.push(attachInvalidationListener(state, scene));

    invalidateModel(MODEL_PATH);

    expect(getLightMaskStats().variants, 'the child mesh\'s material must still be reached').toBe(0);
  });

  it('array materials on a mesh are ALL visited — both entries get retired', async () => {
    await seedModelAndMeshAsset(['rock', 'tree']);
    const templates = [...getTemplatesForModel(MODEL_PATH).values()];
    expect(templates).toHaveLength(2);
    const [matA, matB] = templates.map((t) => t.material);

    const f = stubFactory();
    armMasking();
    const variantA = getMaskedMaterial(matA, 0b01, f);
    const variantB = getMaskedMaterial(matB, 0b01, f);
    expect(variantA).not.toBeNull();
    expect(variantB).not.toBeNull();
    expect(getLightMaskStats().variants).toBe(2);

    const scene = new THREE.Scene();
    const state = createRenderState();
    // A single multi-material mesh binding BOTH template materials as an array.
    const evictedMesh = new THREE.Mesh(new THREE.BufferGeometry(), [matA, matB]);
    state.ecsObjects.set(1, evictedMesh);
    state.ecsSprites.set(1, MESH_GUID);
    unsubscribers.push(attachInvalidationListener(state, scene));

    invalidateModel(MODEL_PATH);

    expect(getLightMaskStats().variants, 'every material in the array must have been visited').toBe(0);
  });
});
