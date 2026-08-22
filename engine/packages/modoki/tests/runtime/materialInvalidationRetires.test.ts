/** A material re-import must not DESTROY the material a live mesh still binds (#317).
 *
 *  THE DEFECT THIS PINS, and it was MEASURED, not theorised. `invalidateMaterial` disposed the
 *  cached `THREE.Material` synchronously — and `disposeMaterial` also releases the material's
 *  shared textures — while `mesh.material` still pointed at that instance. `syncMaterial` cannot
 *  save it: a re-import keeps the same GUID, so it takes the unchanged-ref branch, where
 *  `resolveMaterial` returns undefined until the async refetch lands and the re-bind body is
 *  skipped entirely.
 *
 *  Live on `games/3d-test` before the fix: a texture re-import (which reaches
 *  `invalidateMaterial` through the material-side consumer added in `b780b9e99`) left the
 *  rotating cube drawing a DISPOSED material for **4 rendered frames** before the rebuilt one
 *  was bound.
 *
 *  Third instance of the family, after `invalidateTexture` (`62aca63b4`) and
 *  `invalidateEnvironment` (#315), and it takes the #315 shape: retire, then free once no live
 *  surface binds it. Driven through the REAL `syncSceneRenderables3D` sweep rather than by
 *  poking the cache — a cache-only test cannot tell "retired" from "leaked". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  resolveMaterial, invalidateMaterial, retiredMaterials3D, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { syncSceneRenderables3D, createRenderState, retiredMaterialSweepTraversals } from '../../src/runtime/rendering/scene3DSync';

const MAT_GUID = '55555555-6666-4777-8888-999999999999';
const MAT_PATH = '/games/g/assets/mat/rock.mat.json';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** A surface holding one mesh bound to `mat` — the shape the sweep has to see through. */
function surfaceBinding(mat: THREE.Material): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
  return scene;
}

/** Run the real sweep for `scene`. An empty world is enough: the sweep is at the tail of
 *  syncSceneRenderables3D and runs whatever the world contains. ONE shared world for the whole
 *  file — koota caps a process at 16, and the backoff test alone renders 20 frames. */
let frameWorld: ReturnType<typeof createWorld> | null = null;
const renderFrame = (scene: THREE.Scene) => {
  frameWorld ??= createWorld();
  return syncSceneRenderables3D(frameWorld, scene, createRenderState());
};

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

describe('invalidateMaterial retires instead of destroying', () => {
  it('leaves a bound material alive across the re-import, then frees it once the mesh rebinds', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    expect(first, 'the material fixture must load, or this test proves nothing').toBeTruthy();
    const disp = vi.spyOn(first, 'dispose');

    const scene = surfaceBinding(first);
    invalidateMaterial(MAT_PATH);
    expect(disp, 'the bound material must NOT be destroyed — this is #317').not.toHaveBeenCalled();
    expect(retiredMaterials3D().has(first)).toBe(true);

    // Frames rendered in the gap before the refetch lands: the mesh keeps the old material
    // (there is nothing else to draw with) and the sweep must leave it alone. This is the
    // window that was measured at 4 frames on games/3d-test.
    renderFrame(scene);
    renderFrame(scene);
    expect(disp).not.toHaveBeenCalled();

    resolveMaterial(MAT_GUID);
    await settle();
    const second = resolveMaterial(MAT_GUID)!;
    expect(second).not.toBe(first);

    // The mesh rebinds (syncMaterial does this in production; the mesh here is standalone),
    // and the next frame's sweep can free the retiree.
    (scene.children[0] as THREE.Mesh).material = second;
    renderFrame(scene);
    expect(disp, 'freed exactly once, after nothing binds it').toHaveBeenCalledTimes(1);
    expect(retiredMaterials3D().size).toBe(0);
  });

  it('keeps it alive while a SECOND surface still binds it', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    const disp = vi.spyOn(first, 'dispose');

    // The editor draws SceneView and the Game panel from two different THREE.Scenes off one
    // material cache, so a free keyed to the first surface to rebind would destroy the other's.
    const sceneA = surfaceBinding(first);
    const sceneB = surfaceBinding(first);
    renderFrame(sceneA);
    renderFrame(sceneB);

    invalidateMaterial(MAT_PATH);
    resolveMaterial(MAT_GUID);
    await settle();
    const second = resolveMaterial(MAT_GUID)!;

    (sceneA.children[0] as THREE.Mesh).material = second;   // only A has rebound
    renderFrame(sceneA);
    expect(disp, "B still binds it").not.toHaveBeenCalled();

    (sceneB.children[0] as THREE.Mesh).material = second;
    renderFrame(sceneB);
    expect(disp).toHaveBeenCalledTimes(1);
  });

  it('sees a multi-material mesh — an array slot is a binding too', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    const disp = vi.spyOn(first, 'dispose');

    // A `mesh.material` ARRAY is the ordinary multi-material case; a sweep that only read the
    // single-material shape would free a material still drawn in slot 1.
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), [new THREE.MeshBasicMaterial(), first]));

    invalidateMaterial(MAT_PATH);
    renderFrame(scene);
    expect(disp).not.toHaveBeenCalled();

    (scene.children[0] as THREE.Mesh).material = [new THREE.MeshBasicMaterial()];
    renderFrame(scene);
    expect(disp).toHaveBeenCalledTimes(1);
  });

  it('an invalidate mid-flight retires the losing load instead of orphaning it', async () => {
    // `fetchMaterial` dedupes on `materialLoadPromises` alone, and `invalidateMaterial` clears
    // that entry — so an in-flight fetch stops deduping a second one and BOTH reach
    // `materialCache.set`. Orphaned, the loser is unreachable to the cache, to the sweep and to
    // `disposeAllCachedResources`, leaking the material AND every shared-texture ref it holds.
    // Twin of the same defect in `fetchEnvironment` (#315).
    resolveMaterial(MAT_GUID);              // fetch #1, deliberately NOT awaited
    invalidateMaterial(MAT_PATH);           // clears the in-flight promise
    resolveMaterial(MAT_GUID);              // fetch #2 starts alongside it
    await settle();

    const cached = resolveMaterial(MAT_GUID)!;
    expect(cached, 'one of the two loads must occupy the cache').toBeTruthy();
    const retired = [...retiredMaterials3D()];
    expect(retired.length, 'the loser is retired, not orphaned').toBe(1);
    expect(retired[0]).not.toBe(cached);
  });

  it('backs off once a retiree is legitimately PINNED, instead of traversing every surface forever', async () => {
    // A retiree can be pinned for good: if the refetch after an invalidation fails,
    // `fetchMaterial` caches MATERIAL_FAILED, `resolveMaterial` returns undefined for that path
    // permanently, and `syncMaterial` can never rebind — so the mesh keeps drawing the retiree
    // and keeping it alive is CORRECT. Without a backoff, `retired.size` never returns to 0 and
    // every surface pays a full scene.traverse() on every frame for the rest of the session.
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    const scene = surfaceBinding(first);      // this mesh never rebinds — the pinned case
    // One frame with nothing retired first: the sweep's counters are module state, and its
    // empty-set branch is what resets them. Without this the test inherits whatever backoff a
    // previous test left behind. (Self-healing in production for the same reason.)
    renderFrame(scene);
    invalidateMaterial(MAT_PATH);

    const before = retiredMaterialSweepTraversals();
    for (let i = 0; i < 20; i++) renderFrame(scene);
    const traversals = retiredMaterialSweepTraversals() - before;

    // The grace lets a few real sweeps run — that is what keeps an ordinary free immediate —
    // and then it must stop. One traverse per frame forever is the cost being avoided.
    expect(traversals, 'the grace sweeps must actually run').toBeGreaterThan(0);
    expect(traversals, '20 frames must not cost 20 traversals').toBeLessThanOrEqual(5);
    expect(retiredMaterials3D().size, 'and it is still correctly alive').toBe(1);
  });

  it('drains retirees on disposeAllCachedResources, so a surface that stops rendering cannot strand one', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const first = resolveMaterial(MAT_GUID)!;
    const disp = vi.spyOn(first, 'dispose');
    surfaceBinding(first);

    invalidateMaterial(MAT_PATH);
    expect(retiredMaterials3D().size).toBe(1);

    // The sweep only runs from syncSceneRenderables3D; nothing renders again here.
    disposeAllCachedResources();
    expect(disp).toHaveBeenCalledTimes(1);
    expect(retiredMaterials3D().size).toBe(0);
  });
});
