/** SEAM: scene3DSync (what object an entity becomes) ↔ outlineSourceGeometry (what the
 *  SceneView edges for the selection outline / mesh-collider wireframe).
 *
 *  Neither side is wrong on its own, which is exactly how the outline regression shipped:
 *  scene3DSync builds a THREE.LOD for ANY model whose meta carries a non-empty
 *  modelCache.lodPaths — including `lodCount: 1`, which looks like a plain mesh — and a
 *  THREE.LOD has no `geometry` of its own. SceneView's guard read `obj.geometry`, so every
 *  imported model silently lost its outline while primitives kept theirs.
 *
 *  A unit test on either module alone passes through that. This one crosses the seam: it
 *  runs the REAL sync to produce the object, then feeds that object to the REAL resolver.
 *  Change either side's assumption and this fails.
 *
 *  Scope: only the LOD branch. The no-LOD branch (plain THREE.Mesh → its own geometry) can't
 *  be reached here — populating meshAssetCache without a modelCache goes through the real GLB
 *  fetch, not a seedable template — and it's already pinned by outlineSourceGeometry's unit
 *  test. The LOD branch is the one that broke. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => { vi.resetModules(); });

/** Load scene3DSync with only the IO/global-state edges stubbed (the mesh cache stays REAL
 *  — it's half the seam under test). */
async function setup() {
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(), transformPropagationSystem: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(() => undefined), ensureRiggedModelLoaded: vi.fn(),
  }));
  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  const { outlineSourceGeometry } = await import('../../src/editor/scene/sceneViewMath');
  return { world: createWorld(), traits, sync, cache, manifest, outlineSourceGeometry };
}

/** Register a model with `lodPaths` LOD levels and seed a loaded template per level.
 *  Returns the level geometries in LOD order (index 0 = highest detail). */
async function seedModel(
  cache: typeof import('../../src/runtime/loaders/meshTemplateCache'),
  manifest: typeof import('../../src/runtime/loaders/assetManifest'),
  opts: { guid: string; sourceGlb: string; meshName: string; lodPaths: string[] },
): Promise<THREE.BufferGeometry[]> {
  const { guid, sourceGlb, meshName, lodPaths } = opts;
  manifest.registerAsset(guid, sourceGlb, 'model', undefined, {
    modelCache: { hash: 'h', processedPath: lodPaths[0], lodPaths, lodDistances: lodPaths.map((_, i) => i * 100), triCounts: [], lodBytes: [] },
  });
  const cacheMap = (globalThis as { __meshTemplateCache?: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> }).__meshTemplateCache!;
  expect(cacheMap, 'meshTemplateCache must expose __meshTemplateCache in DEV').toBeDefined();

  const geoms: THREE.BufferGeometry[] = [];
  for (const p of lodPaths) {
    const g = new THREE.BufferGeometry();
    cacheMap.set(`${p}::${meshName}`, { geometry: g, material: new THREE.MeshStandardMaterial(), name: meshName });
    geoms.push(g);
  }
  (globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async (url: string | URL) =>
    String(url).endsWith('.mesh.json')
      ? new Response(JSON.stringify({ version: 1, model: sourceGlb, mesh: meshName, postprocessor: 'none' }), { status: 200 })
      : new Response('', { status: 404 }),
  ) as unknown as typeof fetch;
  cache.resolveMeshTemplate(`/x/${meshName}.mesh.json`); // populates meshAssetCache
  await new Promise<void>((r) => setTimeout(r, 0));
  return geoms;
}

/** Spawn a Renderable3D entity, run the real sync, return the object it became. */
function syncOne(
  world: ReturnType<typeof import('koota').createWorld>,
  traits: typeof import('../../src/runtime/traits'),
  sync: typeof import('../../src/runtime/rendering/scene3DSync'),
  meshRef: string,
): THREE.Object3D | undefined {
  const e = world.spawn(traits.Transform(), traits.Renderable3D({ mesh: meshRef, material: '', isVisible: true }));
  const state = sync.createRenderState();
  sync.syncSceneRenderables3D(world, new THREE.Scene(), state);
  return state.ecsObjects.get(e.id()) as THREE.Object3D | undefined;
}

describe('selection-outline seam: scene3DSync object → outlineSourceGeometry', () => {
  it('a single-level LOD model (lodCount: 1) still yields outline geometry', async () => {
    // THE regression. lodPaths has one entry, so this model renders identically to a plain
    // mesh — but sync wraps it in a THREE.LOD, and the outline guard used to skip it.
    const { world, traits, sync, cache, manifest, outlineSourceGeometry } = await setup();
    const [lod0] = await seedModel(cache, manifest, {
      guid: '11111111-1111-4111-8111-111111111111',
      sourceGlb: '/x/island.glb', meshName: 'island',
      lodPaths: ['/x/island.glb.processed.glb'],
    });

    const obj = syncOne(world, traits, sync, '/x/island.mesh.json');
    expect((obj as THREE.LOD).isLOD, 'sync must build a THREE.LOD for a lodPaths model').toBe(true);
    expect((obj as THREE.Mesh).geometry, 'a THREE.LOD carries no geometry of its own').toBeUndefined();
    // The seam: despite no own geometry, the outline resolves to LOD level 0.
    expect(outlineSourceGeometry(obj)).toBe(lod0);
  });

  it('a multi-level LOD model outlines the HIGHEST-detail level, not a decimated one', async () => {
    const { world, traits, sync, cache, manifest, outlineSourceGeometry } = await setup();
    const geoms = await seedModel(cache, manifest, {
      guid: '22222222-2222-4222-8222-222222222222',
      sourceGlb: '/x/palm.glb', meshName: 'palm',
      lodPaths: ['/x/palm.glb.processed.glb', '/x/palm.glb.lod1.glb', '/x/palm.glb.lod2.glb'],
    });

    const obj = syncOne(world, traits, sync, '/x/palm.mesh.json');
    expect((obj as THREE.LOD).isLOD).toBe(true);
    expect(outlineSourceGeometry(obj)).toBe(geoms[0]);
    expect(outlineSourceGeometry(obj)).not.toBe(geoms[1]);
  });

});
