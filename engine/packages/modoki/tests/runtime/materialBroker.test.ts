/** materialBroker unit tests — the render-surface registry + the getEntityObjects /
 *  getEntityMaterials fan-out. Injects a fake mesh-collector via setEntityMeshCollector
 *  (the seam scene3DSync uses at load) so the test exercises the broker's OWN logic
 *  (world filtering, multi-surface fan-out, material de-dup, unregister) without loading
 *  the heavy renderer module. collectEntityMeshes itself is covered in scene3DSync.test.ts. */

import { describe, it, expect, beforeEach } from 'vitest';

// A RenderState is opaque to the broker — it only forwards it to the collector.
// Model one as { meshes: Map<id, THREE.Mesh[]> } and have the fake collector read it.
type FakeState = { meshes: Map<number, unknown[]> };

import {
  registerRenderSurface,
  getEntityObjects,
  getEntityMaterials,
  clearRenderSurfaces,
  setEntityMeshCollector,
} from '../../src/runtime/rendering/materialBroker';

// Minimal mesh stand-in: only `.material` is read by getEntityMaterials.
const mesh = (material?: unknown) => ({ material });

// Cast helpers keep the test readable while satisfying the real signatures.
const state = (m: FakeState) => m as unknown as Parameters<typeof registerRenderSurface>[1];
const asWorld = (w: object) => w as unknown as Parameters<typeof getEntityObjects>[0];

beforeEach(() => {
  clearRenderSurfaces();
  // Inject the fake collector (in the real runtime, scene3DSync does this at load).
  setEntityMeshCollector((state, id) => (state as FakeState).meshes.get(id) ?? []);
});

describe('materialBroker', () => {
  it('returns an entity\'s objects from its surface', () => {
    const world = {};
    const m = mesh();
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [m]]]) }));
    expect(getEntityObjects(asWorld(world), 1)).toEqual([m]);
    expect(getEntityObjects(asWorld(world), 2)).toEqual([]); // unknown id → empty
  });

  it('fans out over multiple surfaces of the same world', () => {
    const world = {};
    const a = mesh(), b = mesh();
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [a]]]) })); // GameView
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [b]]]) })); // SceneView
    const objs = getEntityObjects(asWorld(world), 1);
    expect(objs).toHaveLength(2);
    expect(objs).toEqual(expect.arrayContaining([a, b]));
  });

  it('filters surfaces by world (a stale/other world contributes nothing)', () => {
    const worldA = {}, worldB = {};
    registerRenderSurface(() => asWorld(worldA), state({ meshes: new Map([[1, [mesh()]]]) }));
    registerRenderSurface(() => asWorld(worldB), state({ meshes: new Map([[1, [mesh()]]]) }));
    expect(getEntityObjects(asWorld(worldA), 1)).toHaveLength(1);
  });

  it('follows the world resolver across a scene swap', () => {
    let current = {};
    registerRenderSurface(() => asWorld(current), state({ meshes: new Map([[1, [mesh()]]]) }));
    const swapped = {};
    current = swapped; // simulate the two-world atomic swap
    expect(getEntityObjects(asWorld(swapped), 1)).toHaveLength(1); // matches the NEW world
  });

  it('collects live materials and de-dups a shared instance across surfaces', () => {
    const world = {};
    const shared = {}; // same material instance assigned in both surfaces (shared cache)
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [mesh(shared)]]]) }));
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [mesh(shared)]]]) }));
    expect(getEntityMaterials(asWorld(world), 1)).toEqual([shared]); // once, not twice
  });

  it('expands a material array (multi-slot mesh)', () => {
    const world = {};
    const m1 = {}, m2 = {};
    registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [mesh([m1, m2])]]]) }));
    expect(getEntityMaterials(asWorld(world), 1)).toEqual(expect.arrayContaining([m1, m2]));
    expect(getEntityMaterials(asWorld(world), 1)).toHaveLength(2);
  });

  it('unregister removes the surface', () => {
    const world = {};
    const dispose = registerRenderSurface(() => asWorld(world), state({ meshes: new Map([[1, [mesh()]]]) }));
    expect(getEntityObjects(asWorld(world), 1)).toHaveLength(1);
    dispose();
    expect(getEntityObjects(asWorld(world), 1)).toEqual([]);
  });
});
