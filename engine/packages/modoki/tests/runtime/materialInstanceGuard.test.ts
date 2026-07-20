/** syncMaterial `isInstanced` guard, exercised through syncRenderables (mirrors
 *  tintSync.test.ts). materialInstanceSystem binds a per-entity CLONE to the mesh; the
 *  render loop must NOT reset that clone back to the shared base each frame. The guard is
 *  what suppresses syncMaterial's per-frame "rebind to resolved base" for an entity with a
 *  MaterialInstance PROP override. A non-instanced control proves the reset normally happens,
 *  so the guard is the load-bearing difference; and removing the prop override restores the base. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function setup() {
  const fakeBase: any = { uuid: 'base', dispose: vi.fn() };

  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(),
    resolveMaterialForMesh: vi.fn(),
    resolveMaterial: vi.fn(() => fakeBase),
    getCachedEnvironment: vi.fn(),
    acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { fakeBase, world: createWorld(), traits, sync };
}

function makeMockMesh() {
  let mat: unknown = null;
  const mesh: any = { position: { set: vi.fn() }, rotation: { set: vi.fn() }, scale: { set: vi.fn() } };
  Object.defineProperty(mesh, 'material', { get: () => mat, set: (v) => { mat = v; } });
  return mesh;
}

/** Seed the render state so syncRenderables takes the "object exists, ref unchanged" path
 *  (prevMat === curMat) — i.e. syncMaterial's per-frame async-resolve rebind branch. The
 *  mesh starts bound to a stand-in CLONE (what materialInstanceSystem would have bound). */
function seed(sync: any, id: number, mesh: any, clone: unknown) {
  mesh.material = clone;
  const state = sync.createRenderState();
  state.ecsObjects.set(id, mesh);
  state.ecsSprites.set(id, 'ship.glb');       // matches rend.mesh → obj not recreated
  state.ecsMaterials.set(id, 'base.mat.json'); // prevMat === curMat → the else-if branch
  return state;
}

describe('syncRenderables — MaterialInstance isInstanced guard', () => {
  it('does NOT reset the clone to the base for an entity with a prop override', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, MaterialInstance } = traits;
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
    );
    const mesh = makeMockMesh();
    const clone = { uuid: 'clone' };
    const state = seed(sync, e.id(), mesh, clone);
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).toBe(clone);       // guard held — NOT reset to base
    expect(mesh.material).not.toBe(fakeBase);
  });

  it('control: WITHOUT a prop override the same setup IS reset to the base', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, MaterialInstance } = traits;
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      // A uniform-only MaterialInstance is NOT instanced (no clone) → guard off.
      MaterialInstance({ overrides: [{ target: 'glow', kind: 'uniform', source: { type: 'constant', value: 1 } }] }),
    );
    const mesh = makeMockMesh();
    const state = seed(sync, e.id(), mesh, { uuid: 'stale' });
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).toBe(fakeBase);    // reset to the resolved base (guard NOT applied)
  });

  it('takes precedence over Tint when the entity has BOTH (mesh stays the clone, not a Tint clone)', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, MaterialInstance, Tint } = traits;
    // Entity carries BOTH a Tint AND a MaterialInstance prop override. isMaterialInstanced(entity)
    // is true, so scene3DSync forces `tinted = false` — the MaterialInstance clone owns the material
    // and the Tint block is skipped (no Tint clone binds).
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      Tint({ color: 0xff0000, amount: 1 }),
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
    );
    const mesh = makeMockMesh();
    const clone = { uuid: 'mi-clone' };
    const state = seed(sync, e.id(), mesh, clone);
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).toBe(clone);        // MaterialInstance wins — clone kept
    expect(mesh.material).not.toBe(fakeBase);  // not the resolved base (guard held)
  });

  it('mutating the trait to uniform-only (prop dropped) flips isMaterialInstanced→false and restores the base', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, MaterialInstance } = traits;
    // Distinct from the "remove the whole trait" test: the trait is KEPT but its overrides are
    // mutated from a prop override to a uniform-only one, so hasPropOverride flips false in place.
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
    );
    const mesh = makeMockMesh();
    const state = seed(sync, e.id(), mesh, { uuid: 'clone' });
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).not.toBe(fakeBase); // prop present → guard held

    e.set(MaterialInstance, { overrides: [{ target: 'glow', kind: 'uniform', source: { type: 'constant', value: 1 } }] });
    sync.syncRenderables(world, scene, state); // uniform-only → not instanced → base restored
    expect(mesh.material).toBe(fakeBase);
  });

  it('restores the base when the prop override / trait is removed', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, MaterialInstance } = traits;
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0.5 } }] }),
    );
    const mesh = makeMockMesh();
    const state = seed(sync, e.id(), mesh, { uuid: 'clone' });
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).not.toBe(fakeBase); // guard held while instanced

    e.remove(MaterialInstance);
    sync.syncRenderables(world, scene, state); // no longer instanced → base restored
    expect(mesh.material).toBe(fakeBase);
  });
});
