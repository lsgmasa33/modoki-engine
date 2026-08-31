/** #480 review (R1) — the second "disposed of by confinement" claim, MEASURED rather than
 *  assumed: `attachInvalidationListener` deletes `ecsMaterials` for every evicted entity on
 *  re-import, which forces `syncMaterial`'s branch 1 to re-run on the rebuild. Before the clone
 *  was confined to primitives, that meant a GLB with an empty material ref minted a FRESH
 *  `cloneDerived(_defaultMaterial, _defaultMaterial)` on every re-import — and nothing ever
 *  disposed the one from the PREVIOUS re-import (the evicted mesh is simply dropped, its
 *  material untouched), so `state.ownedMaterials` grew by one leaked clone per re-import,
 *  unbounded across a session. With the clone confined to primitives, a GLB never mints one in
 *  the first place, so there is nothing for a re-import to orphan.
 *
 *  Modeled on `syncSceneRenderables3D.test.ts`'s "attachInvalidationListener — re-import
 *  eviction" fixture (mocked `meshTemplateCache`, real `scene3DSync` via dynamic import so
 *  `vi.doMock` takes effect) — driven through the REAL `syncRenderables` + `attachInvalidationListener`
 *  pair this time, because whether a clone gets minted is a `syncMaterial` behaviour the other
 *  file's fixture (which pokes `state.ecsObjects` by hand) never exercises. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const inval: { listener?: (path: string, targets: Set<string>) => void; assets: Map<string, { model: string }> } = { assets: new Map() };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  inval.listener = undefined;
  inval.assets.clear();
});

async function setup() {
  const templateMat = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BoxGeometry();

  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    // Always resolves — the "does this GLB build a mesh at all" question is not what's under
    // test here; whether it MINTS A MATERIAL for an empty ref is.
    resolveMeshTemplate: vi.fn(() => ({ geometry, material: templateMat })),
    resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => undefined), // empty ref → no override
    resolveMaterial: vi.fn(() => undefined),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    retiredEnvironments: () => new Set(), disposeRetiredEnvironment: vi.fn(),
    retiredMaterials3D: () => new Set(), disposeRetiredMaterial: vi.fn(),
    onModelInvalidated: (cb: (p: string, t: Set<string>) => void) => { inval.listener = cb; return () => { inval.listener = undefined; }; },
    getMeshAsset: (ref: string) => inval.assets.get(ref),
  }));
  vi.doMock('../../src/runtime/loaders/assetManifest', () => ({
    resolveRef: (r: string) => r, onFontInvalidated: () => () => {},
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({
    createPrimitiveMesh: vi.fn(), isPrimitive: () => false, PRIMITIVE_NAMES: [],
  }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { world: createWorld(), traits, sync };
}

describe('a GLB with an empty ref, re-imported repeatedly', () => {
  it('keeps ownedMaterials FLAT at 0 — nothing was ever minted to leak', async () => {
    const { world, traits, sync } = await setup();
    const { Transform, Renderable3D } = traits;
    inval.assets.set('thing.mesh.json', { model: '/thing.glb' });

    world.spawn(Transform(), Renderable3D({ mesh: 'thing.mesh.json', material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.attachInvalidationListener(state, scene);

    sync.syncRenderables(world, scene, state);
    expect(state.ownedMaterials.size, 'no clone minted for a GLB — it binds the shared default').toBe(0);

    for (let i = 0; i < 5; i++) {
      inval.listener!('/thing.glb', new Set(['/thing.glb'])); // simulate a re-import
      sync.syncRenderables(world, scene, state); // rebuilt from scratch
    }

    expect(state.ownedMaterials.size,
      'FLAT across 5 re-imports — before confinement this grew by one leaked clone per cycle')
      .toBe(0);
  });
});
