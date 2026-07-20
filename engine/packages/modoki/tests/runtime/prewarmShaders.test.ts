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

async function setup() {
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(() => null), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(() => null),
    getCachedEnvironment: vi.fn(() => null), acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn(() => null) }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { world: createWorld(), sync };
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
