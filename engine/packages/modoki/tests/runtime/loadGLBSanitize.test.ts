/**
 * Regression for asset-loaders F7: loadGLB's direct-parse FALLBACK (hit when
 * loadModelTemplates wasn't called first) must run sanitizeGeometryAttributes on each
 * mesh — parity with loadModelTemplates — or a quantized GLB reaching the GPU via this
 * path triggers the WebGPU "Vertex format not supported yet" freeze.
 *
 * Drives the fallback by making getModelHierarchy return null and mocking the GLTFLoader.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sanitizeSpy = vi.fn();
const geometries: { dispose: ReturnType<typeof vi.fn> }[] = [];

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => ({ spawn: () => ({ id: () => 1 }) }),
  registerEntity: vi.fn(),
}));
vi.mock('../../src/runtime/traits', () => ({
  Transform: (d: any) => ({ Transform: d }),
  Renderable3D: (d: any) => ({ Renderable3D: d }),
  EntityAttributes: (d: any) => ({ EntityAttributes: d }),
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  getModelHierarchy: () => null, // force the direct-parse fallback
  modelGlbUrl: (p: string) => p,
  sanitizeGeometryAttributes: (g: unknown) => sanitizeSpy(g),
  findNearestMeshAncestor: () => null,
  decomposeLocalTransform: () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
}));
vi.mock('../../src/runtime/loaders/modelPostprocessorRegistry', () => ({
  getModelPostprocessor: () => null,
}));
vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    load(_url: string, onLoad: (gltf: any) => void) {
      const geometry = { uuid: 'geo-Hull', dispose: vi.fn() };
      geometries.push(geometry);
      const mesh = {
        isMesh: true, name: 'Hull', geometry,
        material: { color: { getHex: () => 0xffffff }, dispose: vi.fn() },
        position: { set: () => {} }, rotation: { set: () => {} }, scale: { set: () => {} },
      };
      const model = {
        position: { set: () => {} }, rotation: { set: () => {} }, scale: { setScalar: () => {} },
        updateMatrixWorld: () => {},
        traverse: (cb: (o: any) => void) => cb(mesh),
      };
      onLoad({ scene: model });
    }
  },
}));

async function getLoadGLB() {
  return (await import('../../src/runtime/loaders/loadGLB')).loadGLB;
}

beforeEach(() => {
  vi.resetModules();
  sanitizeSpy.mockClear();
  geometries.length = 0;
});

describe('loadGLB direct-parse fallback (F7)', () => {
  it('sanitizes each mesh geometry for the WebGPU pipeline', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    registerAsset('a0000000-0000-4000-8000-0000000000f7', '/models/hull.glb', 'model');
    const loadGLB = await getLoadGLB();

    await loadGLB('/models/hull.glb', 'hull');

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    expect(sanitizeSpy).toHaveBeenCalledWith(geometries[0]); // the mesh's geometry
  });
});
