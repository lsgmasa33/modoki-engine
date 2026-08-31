/** Defects in `syncMaterial` / the primitive rebuild path, each MEASURED against a real koota
 *  world + the real material cache, not theorised from reading the source:
 *
 *  - **#480**: `syncMaterial` bound the shared `_defaultMaterial` singleton — not a copy — for
 *    any entity whose material ref cleared to `''`. Two such primitives then shared ONE material
 *    object, and the primitive colour block writes `material.color.setHex(...)` straight into it,
 *    so the last one synced each frame won and the pollution outlived both entities.
 *  - **#480 review (R1)**: the first fix made the clone UNCONDITIONAL, which also hit every GLB
 *    (`Renderable3D`) entity with no material override — nothing writes into a GLB's material in
 *    place, so it should keep sharing `_defaultMaterial`. Confining the clone to primitives (a new
 *    `mintsPrivateDefault` parameter on `syncMaterial`) is what this file's GLB-vs-primitive tests
 *    pin, along with the batching regression and the two orphan risks that widening caused —
 *    see `scene3DSyncGlbReimportOwnership.test.ts` for the re-import half of that.
 *  - **#479**: the ref was recorded into `ecsMaterials` on the FIRST frame a change was seen,
 *    whether or not `resolveMaterial` actually returned anything. An entity whose branch-1 re-bind
 *    is otherwise skipped (MaterialInstance/`isInstanced`, Tint, light-masked) then never got a
 *    second chance: the ref looked "already handled" forever, even once the `.mat.json` finished
 *    loading.
 *  - **#482**: a `Renderable3DPrimitive.mesh` naming a shape `createPrimitiveMesh` doesn't
 *    recognize (a hand-edited scene, or a primitive kind renamed since the scene was authored)
 *    tore the OLD mesh down — `scene.remove` + geometry dispose — before discovering the
 *    replacement couldn't be built, then dereferenced the `null` with a bare `!`.
 *  - **#482 review (R2)**: the first fix's rebuild gate still let a KNOWN size change tear the
 *    entity down when paired with an unknown mesh name (`sizeChanged || (kindChanged &&
 *    meshKnown)` — the `sizeChanged` half didn't check `meshKnown` at all), including via the
 *    two-step Inspector path (set a bad name, which survives on its own, THEN change size on the
 *    now-permanently-`kindChanged` entity). Gating the WHOLE condition on `meshKnown` closes it. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  resolveMaterial, disposeAllCachedResources, registerRuntimeMeshTemplate, unregisterRuntimeMeshTemplate,
} from '../../src/runtime/loaders/meshTemplateCache';
import { createRenderState, syncRenderables } from '../../src/runtime/rendering/scene3DSync';
import { Transform, Renderable3D, Renderable3DPrimitive, MaterialInstance } from '../../src/runtime/traits';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';

const MAT_GUID = '11111111-2222-4333-8444-666666666666';
const MAT_PATH = '/games/g/assets/mat/shared.mat.json';
const PENDING_GUID = '22222222-2222-4333-8444-666666666666';
const PENDING_PATH = '/games/g/assets/mat/pending.mat.json';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** One world for the file — koota caps a process at 16. */
let world: ReturnType<typeof createWorld> | null = null;
const getWorld = () => (world ??= createWorld());

/** Resolves the SAME in-flight fetch for `PENDING_PATH` once `releasePendingLoad()` is called —
 *  `resolveMaterial` caches the in-flight promise per ref, so a fresh never-resolving Promise on
 *  a later call would just be ignored; the caller has to unblock the ORIGINAL one. */
let releasePendingLoad: () => void = () => {};

beforeEach(() => {
  clearManifest();
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  registerAsset(PENDING_GUID, PENDING_PATH, 'material');
  const pendingGate = new Promise<void>((resolve) => { releasePendingLoad = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === PENDING_PATH) await pendingGate;
    const id = url === PENDING_PATH ? PENDING_GUID : MAT_GUID;
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({ version: 1, id, type: 'pbr' }),
    } as unknown as Response;
  }));
});

afterEach(() => {
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

function spawnPrimitive(mesh: string, material: string, color: number) {
  const w = getWorld();
  return w.spawn(Transform(), Renderable3DPrimitive({ mesh, material, color, isVisible: true }));
}

describe('#480 — clearing a material ref must not bind the shared _defaultMaterial', () => {
  it('two primitives cleared to \'\' with different colours get DISTINCT materials, each showing its own colour', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    expect(resolveMaterial(MAT_GUID), 'the material fixture must load').toBeTruthy();

    const scene = new THREE.Scene();
    const state = createRenderState();
    const a = spawnPrimitive('cube', MAT_GUID, 0xff0000);
    const b = spawnPrimitive('sphere', MAT_GUID, 0x0000ff);
    syncRenderables(getWorld(), scene, state);

    const meshA = state.ecsObjects.get(a.id()) as THREE.Mesh;
    const meshB = state.ecsObjects.get(b.id()) as THREE.Mesh;
    expect(meshA.material, 'both start on the shared resolved material').toBe(meshB.material);

    // Clear both refs — the transition under test.
    a.set(Renderable3DPrimitive, { ...a.get(Renderable3DPrimitive)!, material: '' });
    b.set(Renderable3DPrimitive, { ...b.get(Renderable3DPrimitive)!, material: '' });
    syncRenderables(getWorld(), scene, state);

    const matA = meshA.material as THREE.MeshStandardMaterial;
    const matB = meshB.material as THREE.MeshStandardMaterial;
    expect(matA, 'each entity must get its OWN clone, not one shared object').not.toBe(matB);
    expect(matA.color.getHex(), 'A renders its own authored colour').toBe(0xff0000);
    expect(matB.color.getHex(), 'B renders its own authored colour').toBe(0x0000ff);

    // A third primitive, created fresh AFTER the clearing above, must be unaffected by whatever
    // A/B did to any shared state.
    const c = spawnPrimitive('cone', '', 0x00ff00);
    syncRenderables(getWorld(), scene, state);
    const matC = (state.ecsObjects.get(c.id()) as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(matC, 'and it is a THIRD distinct instance').not.toBe(matA);
    expect(matC, 'and it is a THIRD distinct instance').not.toBe(matB);
    expect(matC.color.getHex()).toBe(0x00ff00);
  });

  it('re-applies the authored colour on the clear transition even when `color` itself did not change (#480 — the ecsColors.delete)', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    expect(resolveMaterial(MAT_GUID)).toBeTruthy();

    const scene = new THREE.Scene();
    const state = createRenderState();
    // `color` is authored from the start and never changes across the transition below — only
    // `material` does. A fresh `_defaultMaterial.clone()` starts at the engine default grey
    // (0xcccccc); without forcing a re-apply, the primitive colour block would see
    // `ecsColors.get(id) === rend.color` (both still 0x123456 from creation) and skip the
    // `setHex` that would otherwise overwrite that grey.
    const e = spawnPrimitive('cube', MAT_GUID, 0x123456);
    syncRenderables(getWorld(), scene, state);

    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, material: '' });
    syncRenderables(getWorld(), scene, state);

    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHex(), 'the authored colour must land, not the default-material grey').toBe(0x123456);
  });

  it('mints the clone ONCE per entity, not once per frame — ownedMaterials stays flat', async () => {
    resolveMaterial(MAT_GUID);
    await settle();
    const scene = new THREE.Scene();
    const state = createRenderState();
    const e = spawnPrimitive('cube', MAT_GUID, 0x445566);
    syncRenderables(getWorld(), scene, state);

    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, material: '' });
    syncRenderables(getWorld(), scene, state); // the clear transition — mints the clone
    const sizeAfterClear = state.ownedMaterials.size;
    const matAfterClear = (state.ecsObjects.get(e.id()) as THREE.Mesh).material;
    expect(sizeAfterClear, 'sanity — something WAS minted').toBeGreaterThan(0);

    syncRenderables(getWorld(), scene, state);
    syncRenderables(getWorld(), scene, state);
    syncRenderables(getWorld(), scene, state);

    expect(state.ownedMaterials.size, 'no per-frame growth — a fix that clones every sync passes ' +
      'every OTHER test in this file while being a churn regression; this is the one that catches it')
      .toBe(sizeAfterClear);
    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material, 'and the SAME clone stays bound')
      .toBe(matAfterClear);
  });
});

describe('#480 review (R1) — the clone is confined to primitives; a GLB keeps sharing the singleton', () => {
  afterEach(() => {
    unregisterRuntimeMeshTemplate('glb-empty-a');
    unregisterRuntimeMeshTemplate('glb-empty-b');
    unregisterRuntimeMeshTemplate('glb-swap-a');
    unregisterRuntimeMeshTemplate('glb-swap-b');
  });

  it('two GLBs with an empty ref bind the SAME material; two primitives cleared to \'\' bind DIFFERENT ones', async () => {
    // The GLB half: `resolveMeshTemplate`'s legacy (non-`.mesh.json`) key path resolves
    // synchronously from a real cache entry — no async model/material load needed to exercise
    // `syncMaterial`, which is the only thing under test here.
    registerRuntimeMeshTemplate('glb-empty-a', new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    registerRuntimeMeshTemplate('glb-empty-b', new THREE.SphereGeometry(), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    const scene = new THREE.Scene();
    const state = createRenderState();
    const w = getWorld();
    const gA = w.spawn(Transform(), Renderable3D({ mesh: 'glb-empty-a', material: '', isVisible: true }));
    const gB = w.spawn(Transform(), Renderable3D({ mesh: 'glb-empty-b', material: '', isVisible: true }));
    syncRenderables(w, scene, state);

    const meshGA = state.ecsObjects.get(gA.id()) as THREE.Mesh;
    const meshGB = state.ecsObjects.get(gB.id()) as THREE.Mesh;
    expect(meshGA.material, 'GLBs with no override share the ENGINE DEFAULT, not a clone each')
      .toBe(meshGB.material);
    expect(state.ownedMaterials.has(meshGA.material as THREE.Material),
      'and it is the shared singleton — never tracked as owned/disposable').toBe(false);

    // The primitive half — #480's own repro, restated here so ONE test states the whole rule.
    resolveMaterial(MAT_GUID);
    await settle();
    const p1 = spawnPrimitive('cube', MAT_GUID, 0xaaaaaa);
    const p2 = spawnPrimitive('sphere', MAT_GUID, 0xbbbbbb);
    syncRenderables(w, scene, state);
    p1.set(Renderable3DPrimitive, { ...p1.get(Renderable3DPrimitive)!, material: '' });
    p2.set(Renderable3DPrimitive, { ...p2.get(Renderable3DPrimitive)!, material: '' });
    syncRenderables(w, scene, state);

    const meshP1 = state.ecsObjects.get(p1.id()) as THREE.Mesh;
    const meshP2 = state.ecsObjects.get(p2.id()) as THREE.Mesh;
    expect(meshP1.material, 'primitives get DISTINCT per-entity clones').not.toBe(meshP2.material);
    expect(meshP1.material, 'and NEITHER equals the GLBs\' shared material').not.toBe(meshGA.material);
    expect(meshP2.material, 'and NEITHER equals the GLBs\' shared material').not.toBe(meshGA.material);

    gA.destroy(); gB.destroy(); p1.destroy(); p2.destroy();
  });

  it('a GLB mesh-KIND swap never orphans a private clone — ownedMaterials stays flat at 0', () => {
    // Pins the review's two "disposed of by confinement" claims by MEASUREMENT rather than by
    // assuming them: the mesh-name-swap block (scene3DSync.ts, the GLB query) disposes no
    // material on swap, and `attachInvalidationListener` deletes `ecsMaterials` on re-import
    // (covered separately in `scene3DSyncGlbReimportOwnership.test.ts`, which needs the eviction
    // listener wired up). Both are only orphan/leak risks for an entity that OWNS a material —
    // with the clone confined to primitives, a GLB never does, so `ownedMaterials` never has
    // anything to leak for it in the first place. Verified here across a real creation + a real
    // kind-swap, not assumed from the confinement alone.
    registerRuntimeMeshTemplate('glb-swap-a', new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    registerRuntimeMeshTemplate('glb-swap-b', new THREE.SphereGeometry(), new THREE.MeshStandardMaterial());
    const scene = new THREE.Scene();
    const state = createRenderState();
    const w = getWorld();
    const e = w.spawn(Transform(), Renderable3D({ mesh: 'glb-swap-a', material: '', isVisible: true }));
    syncRenderables(w, scene, state);
    // Baseline, not a literal 0 — `w` is the FILE-SHARED world (koota caps a process at 16), so
    // this fresh `state` also rebuilds every primitive earlier tests spawned into it, and several
    // of those legitimately own a minted default material. What matters is that THIS entity's
    // creation adds NOTHING to that baseline, and the swap doesn't add anything either.
    const baseline = state.ownedMaterials.size;

    e.set(Renderable3D, { ...e.get(Renderable3D)!, mesh: 'glb-swap-b' }); // the kind swap
    syncRenderables(w, scene, state);
    expect(state.ownedMaterials.size, 'still flat after the swap — there was never anything to orphan').toBe(baseline);

    e.set(Renderable3D, { ...e.get(Renderable3D)!, mesh: 'glb-swap-a' }); // and back
    syncRenderables(w, scene, state);
    expect(state.ownedMaterials.size, 'flat across repeated swaps too').toBe(baseline);
    e.destroy();
  });
});

describe('#479 — an unresolved ref must keep being retried for entities the per-frame re-bind skips', () => {
  it('a MaterialInstance-driven primitive (branch-1-only re-bind) eventually binds once the load lands, with no flip-flop afterwards', async () => {
    const scene = new THREE.Scene();
    const state = createRenderState();
    const e = spawnPrimitive('cube', '', 0x888888);
    e.add(MaterialInstance({ overrides: [{ target: 'color', kind: 'prop' }] }));
    syncRenderables(getWorld(), scene, state); // creation frame — default material, owned+coloured

    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const beforeAssign = mesh.material;

    // Assign a ref whose load has not landed yet.
    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, material: PENDING_GUID });
    syncRenderables(getWorld(), scene, state);
    expect(resolveMaterial(PENDING_GUID), 'the fixture must genuinely be unresolved here').toBeFalsy();
    expect(mesh.material, 'nothing to bind yet — the mesh keeps what it had').toBe(beforeAssign);

    // A couple more frames while still unresolved: this is where the #479 defect bites — without
    // the fix, the ref got recorded on the FIRST attempt above and this retry never happens.
    syncRenderables(getWorld(), scene, state);
    syncRenderables(getWorld(), scene, state);
    expect(mesh.material, 'still not resolved — still nothing bound').toBe(beforeAssign);

    // The load lands.
    releasePendingLoad();
    await settle();
    const resolved = resolveMaterial(PENDING_GUID);
    expect(resolved, 'the fixture must now be loaded').toBeTruthy();

    syncRenderables(getWorld(), scene, state);
    expect(mesh.material, 'now it binds').toBe(resolved);

    // No flip-flop once bound — the ref is recorded, so later frames take the (skipped) re-bind
    // branch and leave it alone.
    syncRenderables(getWorld(), scene, state);
    syncRenderables(getWorld(), scene, state);
    expect(mesh.material, 'stable across further frames').toBe(resolved);
  });
});

describe('#482 — an unknown primitive mesh name must not free the old mesh, and must not throw', () => {
  // R3 review: `_warnedUnknownPrimitives` is a process-global dedupe with no reset, so these
  // tests used to pass independently ONLY because they picked different bad names — a fragile
  // coupling through module state that the real fix (`onWorldSwap` clears the set) makes
  // unnecessary. Force a real world-swap event before each test here, exactly like the app does
  // between scenes/sessions, rather than relying on distinct names to dodge the shared dedupe.
  beforeEach(() => { setCurrentWorld(createWorld()); });

  it('a valid primitive mutated to an unknown mesh name survives untouched, with one warning', async () => {
    const scene = new THREE.Scene();
    const state = createRenderState();
    const e = spawnPrimitive('cube', '', 0x00ffff);
    syncRenderables(getWorld(), scene, state);

    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const disposeSpy = vi.spyOn(mesh.geometry, 'dispose');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, mesh: 'not-a-primitive' });
    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();

    expect(state.ecsObjects.get(e.id()), 'the previous mesh is still tracked').toBe(mesh);
    expect(scene.children, 'and still in the scene').toContain(mesh);
    expect(disposeSpy, 'its geometry must not be disposed').not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // R3: the message must not read as naming the CURRENTLY broken entity — it dedupes by NAME,
    // so a later frame's `id` in the same message could belong to something else entirely by
    // then (koota reuses ids LIFO). "first seen on entity N" is honest about that scope.
    expect(warnSpy.mock.calls[0][0], 'the message must be honestly scoped, not "entity N has"')
      .toMatch(/first seen on entity \d+/);

    // A second sync with the same bad name must not warn again.
    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    disposeSpy.mockRestore();
    // `getWorld()` is the FILE-SHARED world — leaving this entity in it (still on the bad name)
    // would warn again in a LATER test once this describe's `beforeEach` resets the dedupe set,
    // inflating that test's warn count for a reason having nothing to do with what it tests.
    e.destroy();
  });

  it('an entity spawned with an unknown mesh name from the start never throws and never builds a mesh', () => {
    const scene = new THREE.Scene();
    const state = createRenderState();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Same bad name as the previous test would ALSO be fine now (R3 resets between tests via
    // `beforeEach` above) — kept distinct anyway so this test's intent reads standalone.
    const e = spawnPrimitive('still-not-a-primitive', '', 0xffffff);

    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();

    expect(state.ecsObjects.has(e.id()), 'no mesh is ever built for it').toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    e.destroy();
  });

  it('R2: a single mutation setting BOTH an unknown mesh name AND a new size leaves the mesh untouched', () => {
    const scene = new THREE.Scene();
    const state = createRenderState();
    const e = spawnPrimitive('cube', '', 0x123123);
    syncRenderables(getWorld(), scene, state);
    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const disposeSpy = vi.spyOn(mesh.geometry, 'dispose');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The old gate read `sizeChanged || (kindChanged && meshKnown)` — `sizeChanged` alone (no
    // `meshKnown` check) let THIS exact edit fall through and tear the entity down anyway.
    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, mesh: 'blob', size: 2 });
    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();

    expect(state.ecsObjects.get(e.id()), 'the previous mesh is still tracked').toBe(mesh);
    expect(scene.children, 'and still in the scene').toContain(mesh);
    expect(disposeSpy, 'its geometry must not be disposed').not.toHaveBeenCalled();

    warnSpy.mockRestore();
    disposeSpy.mockRestore();
    e.destroy();
  });

  it('R2: the two-step Inspector path — a bad name (survives alone), THEN a size change — still must not free the mesh', () => {
    const scene = new THREE.Scene();
    const state = createRenderState();
    const e = spawnPrimitive('cube', '', 0x321321);
    syncRenderables(getWorld(), scene, state);
    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const disposeSpy = vi.spyOn(mesh.geometry, 'dispose');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Step 1: an unknown name alone. The fix deliberately does NOT update `ecsSprites`, so this
    // entity is `kindChanged` FOREVER from here on — which is exactly what makes step 2 dangerous
    // under the old gate.
    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, mesh: 'blob' });
    syncRenderables(getWorld(), scene, state);
    expect(state.ecsObjects.get(e.id()), 'step 1 alone already survives').toBe(mesh);

    // Step 2: ONLY the size changes — the mesh NAME is untouched this frame. The old gate's
    // `sizeChanged` half fired anyway, on an entity permanently stuck `kindChanged`.
    e.set(Renderable3DPrimitive, { ...e.get(Renderable3DPrimitive)!, size: 2 });
    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();

    expect(state.ecsObjects.get(e.id()), 'still tracked after the LATER size-only edit').toBe(mesh);
    expect(scene.children).toContain(mesh);
    expect(disposeSpy, 'geometry still not disposed').not.toHaveBeenCalled();

    warnSpy.mockRestore();
    disposeSpy.mockRestore();
    e.destroy();
  });

  it('R3: the warn dedupe resets across a world swap, so a REUSED bad name warns again in a later "session"', () => {
    // Deliberately reuses THIS FILE'S first #482 test's bad name ('not-a-primitive') — that test
    // already put it in `_warnedUnknownPrimitives`. Without the `onWorldSwap` reset, this
    // describe's `beforeEach` swap would be a no-op for the dedupe and this entity would warn
    // ZERO times, exactly the failure mode the review measured in the editor (SceneView + the
    // Game panel sharing the dedupe; a reload warning nothing on a bug already there before).
    const scene = new THREE.Scene();
    const state = createRenderState();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = spawnPrimitive('not-a-primitive', '', 0x00ff00);

    expect(() => syncRenderables(getWorld(), scene, state)).not.toThrow();
    expect(warnSpy, 'a fresh "session" (this describe\'s world-swap beforeEach) must warn again')
      .toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    e.destroy();
  });
});
