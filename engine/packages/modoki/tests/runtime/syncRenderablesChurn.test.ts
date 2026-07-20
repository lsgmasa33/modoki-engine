/** syncRenderables add/remove/recreate churn — the core per-frame ECS→Three
 *  state machine (runtime-rendering-3d.md Missing Test #1/#2).
 *
 *  tintSync.test.ts only seeds a single pre-existing object and never removes it,
 *  so the populate / reap / recreate transitions — exactly where leaks and
 *  stranded map entries hide — had no coverage. This drives the live
 *  `syncRenderables` against a real koota world + real traits, with only the GPU
 *  edges mocked (primitive factory, texture resolver, the three-side Light/Env
 *  traits), and asserts on the six RenderState maps + scene add/remove + owned
 *  geometry/material disposal + inline-texture refcount release.
 *
 *  Uses the PRIMITIVE path (Renderable3DPrimitive) because `createPrimitiveMesh`
 *  is the single mockable seam — no GLB template load needed; the mesh the sync
 *  stores in `ecsObjects` is the one we inspect for dispose() calls. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// A live Set the sync reads to decide "deactivated" — tests push ids into it.
const deactivatedEntities = new Set<number>();
// loadTexture3D / releaseTexture3D spies, observable across the module graph.
const loadTexture3D = vi.fn(async () => ({ __tex: true, isTexture: true }));
const releaseTexture3D = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
});

/** A primitive-mesh stand-in: real-enough shape for applyTransform / dispose
 *  reaping. Fresh geometry + material per call so dispose() is per-instance. */
function makeFakeMesh() {
  const mesh: Record<string, unknown> = {
    position: { set: vi.fn() }, rotation: { set: vi.fn() }, scale: { set: vi.fn() },
    geometry: { dispose: vi.fn() },
    material: { color: { setHex: vi.fn() }, dispose: vi.fn(), map: undefined as unknown },
    isMesh: true,
  };
  // applyShadowFlags() walks the object graph — a single primitive is its own subtree.
  mesh.traverse = (cb: (o: unknown) => void) => cb(mesh);
  return mesh;
}

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(),
    resolveMeshLodInfo: vi.fn(() => null),   // GLB path checks LOD first; default: no baked LODs
    resolveMaterialForMesh: vi.fn(() => null),
    resolveMaterial: vi.fn(),
    getCachedEnvironment: vi.fn(),
    acquireEnvironment: vi.fn(),
  }));
  // Each spawn gets its OWN mesh instance (so geometry/material dispose is per-entity).
  const created: ReturnType<typeof makeFakeMesh>[] = [];
  vi.doMock('../../src/runtime/loaders/primitives', () => ({
    createPrimitiveMesh: vi.fn(() => { const m = makeFakeMesh(); created.push(m); return m; }),
  }));
  // isImagePath drives the inline-texture branch; default false, overridden per test.
  const isImagePath = vi.fn(() => false);
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D, releaseTexture3D, setActiveRenderer: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const mtc = await import('../../src/runtime/loaders/meshTemplateCache');
  const scene: any = { add: vi.fn(), remove: vi.fn() };
  return { world: createWorld(), traits, sync, scene, created, isImagePath, mtc };
}

describe('syncRenderables — populate (add path)', () => {
  it('creates one object per active primitive and fills all six maps', async () => {
    const { world, traits, sync, scene } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const ids = [0, 1, 2].map((i) =>
      world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', size: 1 + i, color: 0x100 + i, isVisible: true })).id(),
    );
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);

    expect(scene.add).toHaveBeenCalledTimes(3);
    expect(state.ecsObjects.size).toBe(3);
    for (const id of ids) {
      expect(state.ecsObjects.has(id)).toBe(true);
      expect(state.ecsSprites.get(id)).toBe('cube');
      expect(state.ownsGeometry.has(id)).toBe(true);     // primitives own their geometry
      expect(state.ecsMaterials.get(id)).toBe('');        // default material, no override
      expect(state.ecsColors.has(id)).toBe(true);
      expect(state.ecsSizes.has(id)).toBe(true);
    }
  });

  it('is idempotent — a second frame neither recreates nor re-adds', async () => {
    const { world, traits, sync, scene, created } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'sphere', isVisible: true }));
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    sync.syncRenderables(world, scene, state);

    expect(created).toHaveLength(1);                 // createPrimitiveMesh called once
    expect(scene.add).toHaveBeenCalledTimes(1);      // added once
  });
});

describe('syncRenderables — reap (remove path)', () => {
  it('reaps a deactivated entity: removes from scene, disposes owned geometry+material, clears every map', async () => {
    const { world, traits, sync, scene } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const keep = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true })).id();
    const drop = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true })).id();
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    const dropMesh: any = state.ecsObjects.get(drop);

    deactivatedEntities.add(drop);                   // simulate deactivation
    sync.syncRenderables(world, scene, state);

    expect(scene.remove).toHaveBeenCalledWith(dropMesh);
    expect(dropMesh.geometry.dispose).toHaveBeenCalledTimes(1);   // owned geometry freed
    expect(dropMesh.material.dispose).toHaveBeenCalledTimes(1);   // owned default material freed
    // All maps cleared for the dropped id…
    for (const m of [state.ecsObjects, state.ecsSprites, state.ecsMaterials, state.ecsColors] as Map<number, unknown>[]) {
      expect(m.has(drop)).toBe(false);
    }
    expect(state.ownsGeometry.has(drop)).toBe(false);
    // …but the survivor is untouched.
    expect(state.ecsObjects.has(keep)).toBe(true);
    expect(state.ecsObjects.size).toBe(1);
  });

  it('reaps an entity destroyed from the world (no longer visited by the query)', async () => {
    const { world, traits, sync, scene } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const e = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true }));
    const id = e.id();
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    const mesh: any = state.ecsObjects.get(id);

    e.destroy();
    sync.syncRenderables(world, scene, state);

    expect(scene.remove).toHaveBeenCalledWith(mesh);
    expect(mesh.geometry.dispose).toHaveBeenCalledTimes(1);
    expect(state.ecsObjects.size).toBe(0);
    expect(state.ownsGeometry.size).toBe(0);
  });

  it('fires the onMeshRemoved callback for the reaped entity', async () => {
    const { world, traits, sync, scene } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const id = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true })).id();
    const state = sync.createRenderState();
    const onMeshRemoved = vi.fn();

    sync.syncRenderables(world, scene, state, { onMeshRemoved });
    const mesh = state.ecsObjects.get(id);
    deactivatedEntities.add(id);
    sync.syncRenderables(world, scene, state, { onMeshRemoved });

    expect(onMeshRemoved).toHaveBeenCalledWith(id, mesh);
  });
});

describe('syncRenderables — recreate (size churn)', () => {
  it('disposes the old owned geometry and rebuilds when size changes (no leak)', async () => {
    const { world, traits, sync, scene, created } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const e = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', size: 1, isVisible: true }));
    const id = e.id();
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    const oldMesh: any = state.ecsObjects.get(id);

    e.set(Renderable3DPrimitive, { mesh: 'cube', size: 4, color: 0xffffff, material: '', isVisible: true });
    sync.syncRenderables(world, scene, state);

    expect(scene.remove).toHaveBeenCalledWith(oldMesh);
    expect(oldMesh.geometry.dispose).toHaveBeenCalledTimes(1);   // old geometry freed before recreate
    expect(created).toHaveLength(2);                              // rebuilt once
    const newMesh = state.ecsObjects.get(id);
    expect(newMesh).not.toBe(oldMesh);
    expect(state.ecsSizes.get(id)).toBe(4);
    expect(state.ownsGeometry.has(id)).toBe(true);
    expect(state.ecsObjects.size).toBe(1);
  });
});

describe('syncRenderables — GLB mesh-ref swap (Renderable3D)', () => {
  /** Build a template stand-in. Real BufferGeometry (THREE.Mesh's constructor
   *  reads geometry.morphAttributes) with a dispose spy so we can prove the swap
   *  branch does NOT dispose it — GLB geometry is template-owned, not state-owned. */
  let THREE: typeof import('three');
  async function template() {
    THREE ??= await import('three');
    const geometry = new THREE.BufferGeometry();
    vi.spyOn(geometry, 'dispose');
    return { geometry, material: undefined as unknown };
  }

  it('swaps to a new template object on mesh-ref change, removing the old WITHOUT disposing template geometry', async () => {
    const { world, traits, sync, scene, mtc } = await setup();
    const { Transform, Renderable3D } = traits;
    const tA = await template();
    const tB = await template();
    (mtc.resolveMeshTemplate as any).mockImplementation((ref: string) =>
      ref === 'meshA' ? tA : ref === 'meshB' ? tB : undefined,
    );

    const e = world.spawn(Transform(), Renderable3D({ mesh: 'meshA', material: '', isVisible: true }));
    const id = e.id();
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    const oldObj = state.ecsObjects.get(id) as any;
    expect(state.ecsSprites.get(id)).toBe('meshA');
    expect(oldObj.geometry).toBe(tA.geometry);
    expect(state.ownsGeometry.has(id)).toBe(false);    // GLB geometry is NOT owned by the render state

    // Swap the mesh ref → old object removed, new one built from template B.
    e.set(Renderable3D, { mesh: 'meshB', material: '', isVisible: true });
    sync.syncRenderables(world, scene, state);

    expect(scene.remove).toHaveBeenCalledWith(oldObj);
    const newObj = state.ecsObjects.get(id) as any;
    expect(newObj).not.toBe(oldObj);
    expect(newObj.geometry).toBe(tB.geometry);
    expect(state.ecsSprites.get(id)).toBe('meshB');
    // The swap must NOT dispose the shared template geometry (owned by the cache).
    expect(tA.geometry.dispose).not.toHaveBeenCalled();
    expect(state.ecsObjects.size).toBe(1);
  });

  it('reaps a GLB mesh without disposing its template geometry', async () => {
    const { world, traits, sync, scene, mtc } = await setup();
    const { Transform, Renderable3D } = traits;
    const t = await template();
    (mtc.resolveMeshTemplate as any).mockImplementation(() => t);

    const id = world.spawn(Transform(), Renderable3D({ mesh: 'meshA', material: '', isVisible: true })).id();
    const state = sync.createRenderState();

    sync.syncRenderables(world, scene, state);
    const obj = state.ecsObjects.get(id);

    deactivatedEntities.add(id);
    sync.syncRenderables(world, scene, state);

    expect(scene.remove).toHaveBeenCalledWith(obj);
    expect(t.geometry.dispose).not.toHaveBeenCalled();   // template geometry survives the reap
    expect(state.ecsObjects.size).toBe(0);
    expect(state.ecsSprites.has(id)).toBe(false);
  });
});

// NOTE: the inline-texture-path on Renderable3DPrimitive was removed — a mesh
// renderer references a `.mat.json` material only, never a texture directly
// (textures live on the material). The refcounted inline-texture material cache
// and its reap test went with it.
