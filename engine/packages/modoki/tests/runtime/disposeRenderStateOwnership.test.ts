/** Render-state teardown may dispose only the materials THAT SURFACE minted.
 *
 *  ⚠️ **The bug this pins.** `disposeRenderState` used to take a `disposeMeshMaterials` flag that
 *  the editor SceneView passed `true` for — on every world swap and on unmount — and it disposed
 *  the material of every owned-geometry mesh UNCONDITIONALLY. A primitive owns its geometry
 *  whatever its material is, so that reached three things the surface does not own:
 *
 *   1. the **shared cached `.mat.json` material**, still held by the material cache and still
 *      bound by the other render loop (the editor runs SceneView AND the Game panel's Scene3D on
 *      one world). Worse at swap time specifically: a material shared across a scene swap
 *      deliberately SURVIVES the release, so this tore down a material about to be re-bound.
 *   2. **`primitives._placeholderMaterial`** — the module-level sentinel a primitive holds while
 *      its authored material is still loading, or forever if the ref never resolves. Its own
 *      definition says "must never be disposed".
 *   3. `_defaultMaterial`, the module-level fallback for an empty material ref.
 *
 *  All three are process-wide, so ONE panel unmounting broke them for every panel. The ownership
 *  set the per-entity removal path already consults is the only safe discriminator — and it moved
 *  onto the RenderState here, because a module-global one let either loop clear the other's
 *  ownership record and leak its materials instead.
 *
 *  Driven through the REAL material cache and the REAL sync, not a hand-set state: which material
 *  a primitive ends up holding (cache instance vs sentinel) IS the thing under test, and a fixture
 *  that assigns it has already assumed the answer. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { resolveMaterial, disposeAllCachedResources } from '../../src/runtime/loaders/meshTemplateCache';
import { createRenderState, disposeRenderState, syncRenderables, clearOwnedMaterials } from '../../src/runtime/rendering/scene3DSync';
import { Transform, Renderable3DPrimitive } from '../../src/runtime/traits';

const MAT_GUID = '11111111-2222-4333-8444-666666666666';
const MAT_PATH = '/games/g/assets/mat/shared.mat.json';
/** Well-formed, and deliberately absent from the manifest — `resolveMaterial` never resolves it,
 *  so the primitive keeps the placeholder sentinel it was built with. */
const MISSING_GUID = '99999999-2222-4333-8444-777777777777';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** One world for the file — koota caps a process at 16. */
let world: ReturnType<typeof createWorld> | null = null;
const getWorld = () => (world ??= createWorld());

beforeEach(() => {
  clearManifest();
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ version: 1, id: MAT_GUID, type: 'pbr' }),
  } as never)));
});

afterEach(() => {
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

/** Spawn one primitive, sync it, and hand back the mesh the surface built for it. */
function primitive(material: string, scene: THREE.Scene) {
  const w = getWorld();
  const e = w.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', material, isVisible: true }));
  const state = createRenderState();
  syncRenderables(w, scene, state);
  const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
  expect(mesh, 'the primitive must actually be built, or this test proves nothing').toBeTruthy();
  return { state, mesh };
}

describe('disposeRenderState', () => {
  it('leaves the SHARED cached material alone', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const shared = resolveMaterial(MAT_GUID);
    expect(shared, 'the material fixture must load').toBeTruthy();

    const scene = new THREE.Scene();
    const { state, mesh } = primitive(MAT_GUID, scene);
    expect(mesh.material, 'the primitive binds the cache instance, not a copy').toBe(shared);

    const disp = vi.spyOn(shared!, 'dispose');
    disposeRenderState(state, scene);

    expect(disp, 'the cache owns it and the other render loop may still bind it').not.toHaveBeenCalled();
    expect(resolveMaterial(MAT_GUID), 'and the cache still serves the same live instance').toBe(shared);
  });

  it('leaves the shared placeholder sentinel alone when the ref never resolves', () => {
    const scene = new THREE.Scene();
    const { state, mesh } = primitive(MISSING_GUID, scene);
    const sentinel = mesh.material as THREE.Material;
    const disp = vi.spyOn(sentinel, 'dispose');

    disposeRenderState(state, scene);

    // A module-level singleton every later primitive-with-override is built with: disposing it
    // once poisons every panel for the rest of the process.
    expect(disp, 'primitives._placeholderMaterial must never be disposed').not.toHaveBeenCalled();

    const scene2 = new THREE.Scene();
    const after = primitive(MISSING_GUID, scene2);
    expect(after.mesh.material, 'still the same sentinel — so the assertion above is load-bearing')
      .toBe(sentinel);
  });

  it('DOES dispose the default material it minted itself', () => {
    const scene = new THREE.Scene();
    const { state, mesh } = primitive('', scene); // no override → the surface mints the material
    const owned = mesh.material as THREE.Material;
    expect(state.ownedMaterials.has(owned), 'an inline material is tracked as owned').toBe(true);
    const disp = vi.spyOn(owned, 'dispose');

    disposeRenderState(state, scene);

    expect(disp, 'nothing else holds it — teardown is where it is freed').toHaveBeenCalled();
    expect(state.ownedMaterials.size, 'and the tracking is cleared with it').toBe(0);
  });
});

/** The seam this actually ships through: TWO surfaces on ONE world.
 *
 *  The editor mounts SceneView and the Game panel's Scene3D against the same world, and each
 *  builds its own THREE meshes — so each mints its OWN inline materials for the same entity.
 *  While ownership lived in a module-global Set, one surface's teardown deleted the other's
 *  entries from it, and those materials were then untracked: not disposed at that surface's own
 *  teardown, and unreachable afterwards. That is what made the unconditional dispose look like
 *  the only workable option. Per-state ownership is what closes it, and nothing else asserts it. */
describe('two render surfaces on one world', () => {
  it('each frees only its OWN inline material, and neither touches the shared one', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const shared = resolveMaterial(MAT_GUID)!;
    const sharedDisp = vi.spyOn(shared, 'dispose');

    const w = getWorld();
    w.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', material: MAT_GUID, isVisible: true }));
    // The one entity this test reads back. The world is shared across the file (koota caps a
    // process at 16), so address it by ID rather than by counting the ownership sets.
    const inlineId = w.spawn(Transform(),
      Renderable3DPrimitive({ mesh: 'sphere', material: '', isVisible: true })).id();

    // Two surfaces, two scenes, one world — as the editor runs it.
    const sceneA = new THREE.Scene(), stateA = createRenderState();
    const sceneB = new THREE.Scene(), stateB = createRenderState();
    syncRenderables(w, sceneA, stateA);
    syncRenderables(w, sceneB, stateB);

    const matA = (stateA.ecsObjects.get(inlineId) as THREE.Mesh).material as THREE.Material;
    const matB = (stateB.ecsObjects.get(inlineId) as THREE.Mesh).material as THREE.Material;
    expect(stateA.ownedMaterials.has(matA), 'each surface owns the material it minted').toBe(true);
    expect(stateB.ownedMaterials.has(matB)).toBe(true);
    expect(matB, 'and they are DISTINCT instances — each surface built its own mesh').not.toBe(matA);

    const dispA = vi.spyOn(matA, 'dispose');
    const dispB = vi.spyOn(matB, 'dispose');

    disposeRenderState(stateA, sceneA);
    expect(dispA, 'surface A frees what it minted').toHaveBeenCalled();
    expect(dispB, "THE REGRESSION: A's teardown must not reach B's material").not.toHaveBeenCalled();
    expect(stateB.ownedMaterials.has(matB), "…nor erase B's record of owning it").toBe(true);

    // Scene3D's world-swap handler calls this for its OWN surface right after its teardown. With
    // one module-global set it emptied the record for EVERY surface, so a surface that had not yet
    // run its teardown lost track of its material and never freed it.
    clearOwnedMaterials(stateA);
    expect(stateB.ownedMaterials.has(matB), "one surface's clear must not reach another's record")
      .toBe(true);

    disposeRenderState(stateB, sceneB);
    expect(dispB, 'and B still frees its own at its own teardown').toHaveBeenCalled();
    expect(sharedDisp, 'the cached material outlives both surfaces').not.toHaveBeenCalled();
  });
});
