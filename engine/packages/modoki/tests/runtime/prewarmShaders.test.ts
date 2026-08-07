/** prewarmShadersForWorld — guarantees a NORMAL material is the renderer's first
 *  compile so the NPR MRT pass is never the first compile (which re-triggers the
 *  WGSL `unresolved type 'OutputType'` bug). The F4 regression: an empty / particle-
 *  only / skinned-only scene used to early-return with `count === 0`, compiling
 *  nothing — so we assert the empty-world path STILL compiles a plain standard mesh.
 *
 *  Heavy GPU siblings scene3DSync imports at module load are mocked; the renderer is
 *  a stub whose `compileAsync` captures the scene it was handed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, unknown>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
});

async function setup(opts: { primitives?: boolean } = {}) {
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(() => null), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(() => null),
    getCachedEnvironment: vi.fn(() => null), acquireEnvironment: vi.fn(),
  }));
  // A primitive factory that returns a REAL mesh, so the dedupe test can count the
  // placeholders that actually reached the compile. Each call yields a fresh object,
  // mirroring the real factory (which mints geometry + material per call — the very
  // per-entity cost the dedupe exists to avoid).
  const createPrimitiveMesh = vi.fn(() =>
    opts.primitives ? new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()) : null,
  );
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const { Renderable3DPrimitive } = await import('../../src/runtime/traits');
  return { world: createWorld(), sync, Renderable3DPrimitive, createPrimitiveMesh };
}

/** A renderer stub that records, AT compile time, a snapshot of the scene it was
 *  handed (prewarm clears the scene afterwards, so post-call inspection is empty). */
function makeRendererStub() {
  const compiledScenes: THREE.Scene[] = [];
  const standardMeshCounts: number[] = [];
  const renderer = {
    compileAsync: vi.fn(async (scene: THREE.Scene) => {
      compiledScenes.push(scene);
      standardMeshCounts.push(
        scene.children.filter(
          (o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material instanceof THREE.MeshStandardMaterial,
        ).length,
      );
    }),
  };
  return { renderer, compiledScenes, standardMeshCounts };
}

const camera = new THREE.PerspectiveCamera();

describe('prewarmShadersForWorld — F4 empty-scene first-compile guarantee', () => {
  it('still compiles a plain standard mesh when the world has no Renderable3D/Primitive', async () => {
    const { world, sync } = await setup();
    const { renderer, compiledScenes, standardMeshCounts } = makeRendererStub();

    // Empty world (e.g. a particle-only / skinned-only NPR scene).
    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    expect(renderer.compileAsync).toHaveBeenCalledTimes(1); // did NOT early-return
    expect(compiledScenes).toHaveLength(1);
    expect(standardMeshCounts[0]).toBeGreaterThanOrEqual(1); // placeholder normal material compiled first
  });

  it('leaves the prewarm scene clean afterwards (placeholder disposed + removed)', async () => {
    const { world, sync } = await setup();
    const { renderer, compiledScenes } = makeRendererStub();

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    // The captured scene is cleared after compile — no lingering children.
    expect(compiledScenes[0].children).toHaveLength(0);
  });
});

/** #154 P4a. `compileAsync` walks its render list object-by-object (node build,
 *  bindings, pipeline, `yieldToMain()`), so its cost scales with the OBJECT count
 *  even when every object compiles the identical cached program. 271 placeholders
 *  for ~15 distinct pairs is what produced a 3926 ms boot stall on a Y6 2019. */
describe('prewarmShadersForWorld — one placeholder per distinct (mesh, material) pair', () => {
  it('collapses many entities sharing a mesh+material into a single placeholder', async () => {
    const { world, sync, Renderable3DPrimitive, createPrimitiveMesh } = await setup({ primitives: true });
    // Count AT compile time (`standardMeshCounts`) — prewarm clears the scene afterwards,
    // so inspecting `compiledScenes[0].children` post-call always reads 0.
    const { renderer, standardMeshCounts } = makeRendererStub();

    for (let i = 0; i < 40; i++) {
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: i, color: i, material: '' }));
    }

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    // Size/colour differ across all 40 — they are uniforms and vertex VALUES, so they
    // cannot change the compiled program and must not split the key.
    expect(standardMeshCounts[0]).toBe(1);
    expect(createPrimitiveMesh).toHaveBeenCalledTimes(1); // the per-entity mint is skipped too
  });

  it('keeps one placeholder per distinct pair — a different material still compiles', async () => {
    const { world, sync, Renderable3DPrimitive } = await setup({ primitives: true });
    const { renderer, standardMeshCounts } = makeRendererStub();

    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: 1, color: 0, material: '' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: 1, color: 0, material: 'guid-a' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'sphere', size: 1, color: 0, material: '' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'sphere', size: 1, color: 0, material: '' })); // dup

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    expect(standardMeshCounts[0]).toBe(3);
  });
});
