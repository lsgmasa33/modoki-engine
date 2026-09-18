/** #1380 — the renderer half of a `.mesh.json` edit. `scene3DSync` builds an entity's object once
 *  and caches it keyed on the `Renderable3D.mesh` REF STRING, which an edit to the file does not
 *  change — so evicting the definition (`invalidateMeshAsset`) and refetching it would load the
 *  new binding and go on drawing the OLD mesh. `attachInvalidationListener`'s `'mesh'` branch is
 *  what tears the object down so the next sync rebuilds it.
 *
 *  Fixture shape from `scene3DSyncGlbReimportOwnership.test.ts` (mocked `meshTemplateCache`, real
 *  `scene3DSync` via dynamic import). The event registry is the REAL one: the listener subscribes
 *  to it directly, and the test fires the same `emitAssetInvalidated` the invalidator does. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

/** Entities carry the mesh GUID, as authored; the watcher's event carries the PATH. The listener's
 *  GUID → path resolve is the line that makes the fix work, so the mock keeps the two DISTINCT —
 *  an identity `resolveRef` let a `meshRef === meshPath` mutation stay green (close-out review). */
const EDITED = '44444444-5555-4666-8777-dddddddddddd';
const OTHER = '55555555-6666-4777-8888-eeeeeeeeeeee';
const PATHS: Record<string, string> = {
  [EDITED]: '/assets/models/meshes/edited.mesh.json',
  [OTHER]: '/assets/models/meshes/other.mesh.json',
};

/** What `resolveMeshTemplate` returns per ref right now — the test swaps an entry to stand for
 *  the edited file's new binding. */
const templates = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  templates.clear();
});

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    registerEnvDisposeHook: vi.fn(),
    resolveMeshTemplate: vi.fn((ref: string) => templates.get(ref)),
    resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => undefined),
    resolveMaterial: vi.fn(() => undefined),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    retiredEnvironments: () => new Set(), disposeRetiredEnvironment: vi.fn(),
    retiredMaterials3D: () => new Set(), disposeRetiredMaterial: vi.fn(),
    onModelInvalidated: () => () => {},
    getMeshAsset: () => undefined,
    getTemplatesForModel: () => new Map(),
  }));
  vi.doMock('../../src/runtime/loaders/assetManifest', () => ({
    resolveRef: (r: string) => PATHS[r] ?? r, onFontInvalidated: () => () => {},
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({
    createPrimitiveMesh: vi.fn(), isPrimitive: () => false, PRIMITIVE_NAMES: [],
  }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const { emitAssetInvalidated } = await import('../../src/runtime/core/assetInvalidation');
  return { world: createWorld(), traits, sync, emitAssetInvalidated };
}

const geometryOf = (obj: THREE.Object3D | undefined) => (obj as THREE.Mesh | undefined)?.geometry;

describe("attachInvalidationListener — a 'mesh' event (#1380)", () => {
  it('rebuilds the entity on the edited path with the NEW binding, with its ref string unchanged', async () => {
    const { world, traits, sync, emitAssetInvalidated } = await setup();
    const { Transform, Renderable3D } = traits;
    const oldGeo = new THREE.BoxGeometry();
    const newGeo = new THREE.SphereGeometry();
    const mat = new THREE.MeshStandardMaterial();
    templates.set(EDITED, { geometry: oldGeo, material: mat });

    const e = world.spawn(Transform(), Renderable3D({ mesh: EDITED, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    const off = sync.attachInvalidationListener(state, scene);

    sync.syncRenderables(world, scene, state);
    expect(geometryOf(state.ecsObjects.get(e.id())), 'sanity — built from the pre-edit template').toBe(oldGeo);

    templates.set(EDITED, { geometry: newGeo, material: mat }); // the edited file now resolves here
    sync.syncRenderables(world, scene, state);
    expect(geometryOf(state.ecsObjects.get(e.id())),
      'without the event the cached object is kept — the ref string did not change').toBe(oldGeo);

    emitAssetInvalidated('mesh', PATHS[EDITED]);
    sync.syncRenderables(world, scene, state);
    expect(geometryOf(state.ecsObjects.get(e.id())), 'rebuilt from the edited binding').toBe(newGeo);
    off();
  });

  it('leaves an entity on a DIFFERENT .mesh.json alone', async () => {
    const { world, traits, sync, emitAssetInvalidated } = await setup();
    const { Transform, Renderable3D } = traits;
    const mat = new THREE.MeshStandardMaterial();
    templates.set(EDITED, { geometry: new THREE.BoxGeometry(), material: mat });
    templates.set(OTHER, { geometry: new THREE.BoxGeometry(), material: mat });

    world.spawn(Transform(), Renderable3D({ mesh: EDITED, material: '', isVisible: true }));
    const other = world.spawn(Transform(), Renderable3D({ mesh: OTHER, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    const off = sync.attachInvalidationListener(state, scene);
    sync.syncRenderables(world, scene, state);
    const before = state.ecsObjects.get(other.id());
    expect(before, 'sanity — built').toBeDefined();

    emitAssetInvalidated('mesh', PATHS[EDITED]);
    expect(state.ecsObjects.get(other.id()), 'same object — not torn down').toBe(before);
    expect(scene.children).toContain(before);
    off();
  });

  it('an empty-ref entity SWAPPED to another mesh keeps the engine default, not the new baked material (#1385)', async () => {
    // The swap branch cleared every per-entity row but the material record, so `syncMaterial`
    // saw `'' === ''`, never re-ran, and the new mesh drew its baked material live — grey again
    // only after a reload. The owner's ruling: an empty ref renders the default.
    const { world, traits, sync } = await setup();
    const { Transform, Renderable3D } = traits;
    const bakedA = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const bakedB = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    templates.set(EDITED, { geometry: new THREE.BoxGeometry(), material: bakedA });
    templates.set(OTHER, { geometry: new THREE.SphereGeometry(), material: bakedB });
    const e = world.spawn(Transform(), Renderable3D({ mesh: EDITED, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const first = (state.ecsObjects.get(e.id()) as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(first.color.getHex(), 'sanity — an empty ref draws the default').toBe(0xcccccc);

    e.set(Renderable3D, { mesh: OTHER });
    sync.syncRenderables(world, scene, state);
    const after = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect(after.geometry, 'sanity — rebuilt on the new mesh').toBe(templates.get(OTHER)!.geometry);
    expect(after.material, 'the new mesh drew its BAKED material').not.toBe(bakedB);
    expect(after.material).toBe(first);
  });

  it('unsubscribes the mesh branch too — a teardown that dropped only the model half would leak it', async () => {
    const { world, traits, sync, emitAssetInvalidated } = await setup();
    const { Transform, Renderable3D } = traits;
    templates.set(EDITED, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(Transform(), Renderable3D({ mesh: EDITED, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    const off = sync.attachInvalidationListener(state, scene);
    sync.syncRenderables(world, scene, state);
    const built = state.ecsObjects.get(e.id());

    off();
    emitAssetInvalidated('mesh', PATHS[EDITED]);
    expect(state.ecsObjects.get(e.id()), 'a detached state is not touched').toBe(built);
  });
});
