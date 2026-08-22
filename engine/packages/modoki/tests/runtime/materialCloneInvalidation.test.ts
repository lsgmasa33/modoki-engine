/** A material re-import must reach the CLONES too — and must not free a base that only a clone
 *  still holds (#318, the other half of #317).
 *
 *  Three render paths bind a `base.clone()` instead of the shared cached material: tint clones,
 *  per-entity MaterialInstance prop clones, and light-mask variants. A `THREE.Material.clone()`
 *  copies texture REFERENCES, which gives two defects with one root cause — nothing told a clone
 *  its base had been replaced:
 *
 *  1. STALENESS. The tint cache keys on `basePath|color|amount`, and a re-import moves none of
 *     the three. A tinted mesh therefore kept the pre-reimport appearance for the rest of the
 *     session while an untinted mesh on the same `.mat.json` updated correctly.
 *  2. TEXTURES FREED UNDER A LIVE CLONE. `sweepRetiredMaterials` frees a retired base once no
 *     MESH binds it, and none of those caches is reachable from a `scene.traverse` — so a base
 *     whose only holders were clones was swept, and `disposeMaterial` released the textures the
 *     clones were still sampling. Not a regression from #317 (before it, the base died
 *     instantly), but the concrete trigger is in the issue: deactivate an entity carrying a prop
 *     override → re-import → reactivate.
 *
 *  Driven through the REAL sweep and the REAL material cache, for the reason
 *  `materialInvalidationRetires.test.ts` gives: a cache-only test cannot tell "retired" from
 *  "leaked". The light-mask half of defect 1 is in `lightMaskSync.test.ts` — it needs lights. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  resolveMaterial, invalidateMaterial, retiredMaterials3D, refreshedMaterial,
  disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { syncSceneRenderables3D, createRenderState, syncRenderables } from '../../src/runtime/rendering/scene3DSync';
import { markDerived, derivedBaseOf, collectDerivedChain, resetDerivedMaterials } from '../../src/runtime/rendering/derivedMaterials';
import { applyPropOverride, resetMaterialInstanceClones } from '../../src/runtime/rendering/materialInstanceClones';
import { Transform, Renderable3D, Tint } from '../../src/runtime/traits';

const MAT_GUID = '11111111-2222-4333-8444-555555555555';
const MAT_PATH = '/games/g/assets/mat/rock.mat.json';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** Run the real sweep over `scene`. ONE shared world for the file — koota caps a process at 16. */
let frameWorld: ReturnType<typeof createWorld> | null = null;
const renderFrame = (scene: THREE.Scene) => {
  frameWorld ??= createWorld();
  return syncSceneRenderables3D(frameWorld, scene, createRenderState());
};

/** Render until `done()`, or give up after `max` frames.
 *
 *  The sweep's idle BACKOFF is module state that outlives a test: three fruitless sweeps in a row
 *  arm a 30-frame skip, and a test that only asserts "still alive" leaves it armed for the next
 *  one. So a test asserting a material IS freed must be prepared to wait it out rather than
 *  assume the very next frame sweeps — which is a property of test ORDER, not of the fix. */
const renderUntil = (scene: THREE.Scene, done: () => boolean, max = 40) => {
  for (let i = 0; i < max && !done(); i++) renderFrame(scene);
};

/** Load the material fixture and hand back the live instance. */
async function loadBase(): Promise<THREE.Material> {
  resolveMaterial(MAT_GUID);
  await settle();
  const m = resolveMaterial(MAT_GUID);
  expect(m, 'the material fixture must load, or these tests prove nothing').toBeTruthy();
  return m!;
}

beforeEach(() => {
  clearManifest();
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ version: 1, id: MAT_GUID, type: 'pbr' }),
  } as never)));
});

afterEach(() => {
  resetMaterialInstanceClones();
  resetDerivedMaterials();
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('the sweep sees a base held only through a clone', () => {
  it('does not free a retired base while a mesh binds a clone of it', async () => {
    const base = await loadBase();
    const disp = vi.spyOn(base, 'dispose');

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), markDerived(base.clone(), base)));

    invalidateMaterial(MAT_PATH);
    expect(retiredMaterials3D().has(base)).toBe(true);

    renderFrame(scene);
    renderFrame(scene);
    renderFrame(scene);
    expect(disp, 'the clone shares this base\'s textures — freeing it releases them').not.toHaveBeenCalled();
    expect(retiredMaterials3D().has(base)).toBe(true);
  });

  it('frees it once the mesh moves off the clone', async () => {
    // The other side of the same claim: the chain walk must not PIN a base forever, or #317's
    // sweep degenerates into a leak. A test that only asserts "still alive" cannot see that.
    const base = await loadBase();
    const disp = vi.spyOn(base, 'dispose');
    const clone = markDerived(base.clone(), base);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clone);
    const scene = new THREE.Scene();
    scene.add(mesh);

    invalidateMaterial(MAT_PATH);
    renderFrame(scene);
    expect(disp).not.toHaveBeenCalled();

    mesh.material = new THREE.MeshStandardMaterial();
    renderUntil(scene, () => disp.mock.calls.length > 0);
    expect(disp, 'freed exactly once, after nothing holds it').toHaveBeenCalledTimes(1);
    expect(retiredMaterials3D().size).toBe(0);
  });

  it('walks the chain transitively — a variant of a tint clone holds the base too', async () => {
    // The real composition: `applyLightMask` derives from whatever the entity settled on, so a
    // masked+tinted mesh binds a clone of a clone. One link of walking would free the base.
    const base = await loadBase();
    const disp = vi.spyOn(base, 'dispose');
    const tint = markDerived(base.clone(), base);
    const variant = markDerived(tint.clone(), tint);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), variant));

    invalidateMaterial(MAT_PATH);
    renderFrame(scene);
    renderFrame(scene);
    expect(disp).not.toHaveBeenCalled();
  });

  it('terminates on a self-referential stamp rather than hanging the sweep', () => {
    // `markDerived` refuses to stamp a material with itself, and the walk is depth-capped, so a
    // cycle introduced by some future clone site degrades to a bounded walk. Asserted because a
    // hung sweep is a hung frame, and nothing else in the suite would catch it.
    const a = new THREE.MeshStandardMaterial();
    markDerived(a, a);
    expect(derivedBaseOf(a), 'a material must never be stamped with itself').toBeUndefined();

    const b = new THREE.MeshStandardMaterial();
    markDerived(a, b);
    markDerived(b, a);
    const out = new Set<THREE.Material>();
    collectDerivedChain(a, out);
    expect(out).toEqual(new Set([a, b]));
  });
});

describe('MaterialInstance prop clones', () => {
  it('keeps the base alive across the deactivate → re-import → reactivate trigger', async () => {
    // The mechanism from the issue: `materialInstanceSystem` returns early for an entity with no
    // live 3D objects, so an INACTIVE entity's base stops being refreshed while its clone stays
    // in the module Map — invisible to a mesh-based sweep, and freed underneath the clone.
    const base = await loadBase();
    const disp = vi.spyOn(base, 'dispose');
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());
    applyPropOverride(7, [mesh], base, 'opacity', 0.5);
    expect(mesh.material, 'the entity must be on a clone, not the shared base').not.toBe(base);

    const scene = new THREE.Scene();
    scene.add(mesh);
    invalidateMaterial(MAT_PATH);
    renderFrame(scene);
    renderFrame(scene);
    expect(disp).not.toHaveBeenCalled();
  });

  it('rebuilds the clone from the successor once the refetch lands', async () => {
    const base = await loadBase();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());
    applyPropOverride(8, [mesh], base, 'opacity', 0.5);
    const staleClone = mesh.material as THREE.Material;

    invalidateMaterial(MAT_PATH);
    await loadBase();
    const fresh = refreshedMaterial(base)!;
    expect(fresh, 'the retired base must forward to its successor').toBeTruthy();

    applyPropOverride(8, [mesh], fresh, 'opacity', 0.5);
    expect(mesh.material).not.toBe(staleClone);
  });
});

describe('Tint clones', () => {
  /** A tinted entity whose mesh is pre-seeded, so no GLB load is involved. */
  function tintedEntity(world: ReturnType<typeof createWorld>, scene: THREE.Scene) {
    const e = world.spawn(
      Transform(),
      Renderable3D({ mesh: 'ship.glb', material: MAT_GUID, isVisible: true }),
      Tint({ color: 0x00ff00, amount: 0.5 }),
    );
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    scene.add(mesh);
    const state = createRenderState();
    state.ecsObjects.set(e.id(), mesh);
    state.ecsSprites.set(e.id(), 'ship.glb');
    state.ecsMaterials.set(e.id(), MAT_GUID); // settled ref — a re-import never changes it
    return { mesh, state, world };
  }

  it('re-clones from the re-imported base instead of serving the old clone forever', async () => {
    const base = await loadBase();
    const world = createWorld();
    const scene = new THREE.Scene();
    const { mesh, state } = tintedEntity(world, scene);

    syncRenderables(world, scene, state);
    const stale = mesh.material as THREE.Material;
    expect(stale).not.toBe(base);

    invalidateMaterial(MAT_PATH);
    // In the gap the base is unresolvable, so the mesh keeps what it has — old bytes beat none.
    syncRenderables(world, scene, state);
    expect(mesh.material).toBe(stale);

    await loadBase();
    syncRenderables(world, scene, state);
    const fresh = mesh.material as THREE.Material;
    expect(fresh, 'THE DEFECT: the key never moves, so the stale clone was served forever').not.toBe(stale);

    // …and it settles: a second frame must not clone again.
    syncRenderables(world, scene, state);
    expect(mesh.material).toBe(fresh);
  });

  it('retires the superseded clone rather than disposing it under the mesh, then frees it', async () => {
    await loadBase();
    const world = createWorld();
    const scene = new THREE.Scene();
    const { mesh, state } = tintedEntity(world, scene);

    syncRenderables(world, scene, state);
    const stale = mesh.material as THREE.Material;
    const disp = vi.spyOn(stale, 'dispose');

    invalidateMaterial(MAT_PATH);
    await loadBase();
    syncRenderables(world, scene, state);
    expect(disp, 'disposing here is #317 one level out').not.toHaveBeenCalled();

    // The mesh has already been rebound by the line above, so a sweep can free it.
    renderUntil(scene, () => disp.mock.calls.length > 0);
    expect(disp).toHaveBeenCalledTimes(1);
  });
});
