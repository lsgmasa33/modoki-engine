/** loadGLB — GUID-only invariant for spawned Renderable3D refs.
 *
 *  loadGLB must store GUIDs (never literal asset paths) in Renderable3D.mesh /
 *  .material — the runtime resolver rejects internal paths. The import pipeline
 *  registers every mesh/material before spawning, so the guid always resolves;
 *  on a (regression-only) miss, loadGLB mints + registers a guid and never
 *  stores the path.
 *
 *  Drives the cached-hierarchy branch (getModelHierarchy) so no GLB parse is
 *  needed. World + traits are mocked to capture the spawned trait data;
 *  assetManifest is REAL so registerAsset/getGuidForPath exercise real
 *  resolution. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture trait data passed to world.spawn.
const spawned: Record<string, any>[] = [];
let nextId = 1;

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => ({
    spawn: (...traits: any[]) => {
      const merged: Record<string, any> = {};
      for (const t of traits) Object.assign(merged, t);
      spawned.push(merged);
      const id = nextId++;
      return { id: () => id };
    },
  }),
  registerEntity: vi.fn(),
}));

// Tag each trait so the merged spawn object exposes the ref fields by name.
vi.mock('../../src/runtime/traits', () => ({
  Transform: (d: any) => ({ Transform: d }),
  Renderable3D: (d: any) => ({ Renderable3D: d }),
  EntityAttributes: (d: any) => ({ EntityAttributes: d }),
}));

let hierarchy: any[] | null = null;
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  getModelHierarchy: () => hierarchy,
  findNearestMeshAncestor: vi.fn(),
  decomposeLocalTransform: vi.fn(),
}));

vi.mock('../../src/runtime/loaders/modelPostprocessorRegistry', () => ({
  getModelPostprocessor: () => null,
}));

async function getLoadGLB() {
  return (await import('../../src/runtime/loaders/loadGLB')).loadGLB;
}
async function getManifest() {
  return import('../../src/runtime/loaders/assetManifest');
}

function entry(name: string) {
  return { name, parentName: '', color: 0xffffff, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

describe('loadGLB — GUID-only Renderable3D refs', () => {
  beforeEach(() => {
    spawned.length = 0;
    nextId = 1;
    hierarchy = [entry('Hull')];
    vi.restoreAllMocks();
  });

  it('stores registered mesh/material GUIDs, never the paths', async () => {
    const { registerAsset } = await getManifest();
    const meshGuid = 'd1000000-0000-4000-8000-000000000001';
    const matGuid = 'd1000000-0000-4000-8000-000000000002';
    registerAsset(meshGuid, '/d/meshes/Hull.mesh.json', 'mesh');
    registerAsset(matGuid, '/d/materials/Hull.mat.json', 'material');

    const loadGLB = await getLoadGLB();
    await loadGLB('/model.glb', 'ship', {}, { meshDir: '/d/meshes', materialDir: '/d/materials' });

    expect(spawned).toHaveLength(1);
    expect(spawned[0].Renderable3D.mesh).toBe(meshGuid);
    expect(spawned[0].Renderable3D.material).toBe(matGuid);
  });

  it('mints a GUID (never a path) when a ref is unregistered, and warns', async () => {
    const { isGuid } = await getManifest();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loadGLB = await getLoadGLB();
    // Unique unregistered dirs so nothing resolves from prior tests.
    await loadGLB('/model2.glb', 'ship', {}, { meshDir: '/unreg/meshes', materialDir: '/unreg/materials' });

    const r = spawned[0].Renderable3D;
    expect(isGuid(r.mesh)).toBe(true);
    expect(isGuid(r.material)).toBe(true);
    expect(r.mesh.startsWith('/')).toBe(false);
    expect(r.material.startsWith('/')).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});
