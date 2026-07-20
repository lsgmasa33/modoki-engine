/** Tint render-sync behavior in syncRenderables.
 *
 *  Uses a real koota world + real traits (so the ECS query matches) but mocks
 *  the material cache so resolveMaterial returns a fake material we can inspect.
 *  The mesh object is pre-seeded into the render state so syncRenderables takes
 *  the "object already exists" path (no THREE.Mesh / GLB load needed).
 *
 *  Verifies the M1 fix: a tinted entity gets ONE cached clone (color + amount
 *  applied), the clone is not rebuilt or reassigned every frame, and removing
 *  the Tint trait restores the base material. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function setup() {
  const fakeBase: any = { uuid: 'base', color: { setHex: vi.fn() }, nprColorPreserve: 0, dispose: vi.fn() };
  fakeBase.clone = vi.fn(() => ({ uuid: 'clone', color: { setHex: vi.fn() }, nprColorPreserve: 0, dispose: vi.fn() }));

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

/** A stand-in mesh that records every material assignment (to detect thrash). */
function makeMockMesh() {
  const assignments: unknown[] = [];
  let mat: unknown = null;
  const mesh: any = { position: { set: vi.fn() }, rotation: { set: vi.fn() }, scale: { set: vi.fn() } };
  Object.defineProperty(mesh, 'material', { get: () => mat, set: (v) => { mat = v; assignments.push(v); } });
  return { mesh, assignments };
}

function seed(sync: any, id: number, mesh: unknown) {
  const state = sync.createRenderState();
  state.ecsObjects.set(id, mesh);
  state.ecsSprites.set(id, 'ship.glb'); // matches rend.mesh so the obj isn't recreated
  state.ecsMaterials.set(id, '');        // empty prev → first frame is a material change
  return state;
}

describe('syncRenderables — Tint', () => {
  it('applies a cached tinted clone and does not reassign it each frame', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, Tint } = traits;

    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      Tint({ color: 0x0000ff, amount: 0.7 }),
    );
    const { mesh, assignments } = makeMockMesh();
    const state = seed(sync, e.id(), mesh);
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state); // frame 1
    const clone: any = mesh.material;
    expect(clone).toBeTruthy();
    expect(clone).not.toBe(fakeBase);                       // a clone, not the shared base
    expect(clone.color.setHex).toHaveBeenCalledWith(0x0000ff);
    expect(clone.nprColorPreserve).toBe(0.7);
    expect(fakeBase.clone).toHaveBeenCalledTimes(1);
    const assignsAfterFrame1 = assignments.length;

    sync.syncRenderables(world, scene, state); // frame 2
    expect(mesh.material).toBe(clone);                      // same clone instance
    expect(fakeBase.clone).toHaveBeenCalledTimes(1);        // cached, not rebuilt
    expect(assignments.length).toBe(assignsAfterFrame1);    // no per-frame thrash
  });

  it('reverts to the base material when the Tint trait is removed', async () => {
    const { fakeBase, world, traits, sync } = await setup();
    const { Transform, Renderable3D, Tint } = traits;

    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
      Tint({ color: 0x00ff00, amount: 0.5 }),
    );
    const { mesh } = makeMockMesh();
    const state = seed(sync, e.id(), mesh);
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncRenderables(world, scene, state);
    expect(mesh.material).not.toBe(fakeBase); // tinted clone

    e.remove(Tint);
    sync.syncRenderables(world, scene, state); // untinted → base restored
    expect(mesh.material).toBe(fakeBase);
  });
});
