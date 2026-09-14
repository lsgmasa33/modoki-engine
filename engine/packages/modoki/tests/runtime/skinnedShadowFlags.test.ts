/** Shadow flags on SKINNED models (#183).
 *
 *  This is the headline fix of that issue and it had NO test: `applyShadowFlags` was called
 *  from three places, all inside `syncRenderables` (LOD / GLB mesh / primitive), and never for
 *  skinned models — so every rigged character in every project kept THREE's defaults and cast
 *  no shadow on any tier. A close-out mutation check found both new calls could be deleted with
 *  4096 tests still green, i.e. the fix was held up by live verification alone.
 *
 *  Drives the real `syncSkinnedModels` against a real koota world + real traits + a real
 *  THREE.Scene, mocking only the GLB seam (`riggedModelCache`) — the prototype is a genuine
 *  THREE graph so `cloneSkeleton` and the `traverse` inside `applyShadowFlags` are the real
 *  ones. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

// koota caps a process at 16 live worlds and every setup() mints one — release them per test
// so adding a case here can never make an unrelated one fail with "Too many worlds created".
const _worlds: { destroy: () => void }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
});

afterEach(() => {
  for (const w of _worlds.splice(0)) { try { w.destroy(); } catch { /* already torn down */ } }
});

/** A minimal but REAL rig prototype: a group with one opaque mesh, plus one alpha-blended mesh
 *  so the `'auto'` rule (opaque casts, transparent does not) has something to discriminate. */
function makePrototype() {
  const root = new THREE.Group();
  const opaque = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  opaque.name = 'Body';
  const blended = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true }));
  blended.name = 'Visor';
  root.add(opaque, blended);
  return root;
}

async function setup() {
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    registerEnvDisposeHook: vi.fn(), // (#739) envPmrem.ts registers with this at module scope
    resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
  }));
  // A REAL mesh, so an entity can carry a primitive renderer AND a rig at once (the
  // two-caches case below drives both passes over one entity id).
  vi.doMock('../../src/runtime/loaders/primitives', () => ({
    createPrimitiveMesh: vi.fn(() => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())),
  }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
  }));
  const prototype = makePrototype();
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(() => ({ prototype, animations: [] })),
    ensureRiggedModelLoaded: vi.fn(), ensureRiggedModelLoadedFor: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const world = createWorld();
  _worlds.push(world);
  return { world, traits, sync, scene: new THREE.Scene(), state: sync.createRenderState() };
}

/** Every mesh in the rig clone, which is what `applyShadowFlags` traverses. */
function meshesOf(state: { skinned: { peekId(id: number): { root: THREE.Object3D } | undefined } }, id: number) {
  const out: THREE.Mesh[] = [];
  state.skinned.peekId(id)?.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}

describe('syncSkinnedModels — shadow flags (#183)', () => {
  it('flags a rig on creation instead of leaving THREE\'s no-shadow defaults', async () => {
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel } = traits;
    const id = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true })).id();

    sync.syncSkinnedModels(world, scene, state);

    const meshes = meshesOf(state, id);
    expect(meshes.length).toBe(2);
    // receiveShadow is THE tell for this bug class: applyShadowFlags sets it true
    // unconditionally, so `false` proves the function never ran on that mesh.
    for (const m of meshes) expect(m.receiveShadow).toBe(true);
    // 'auto' still discriminates by material — the opaque body casts, the blended visor doesn't.
    expect(meshes.find((m) => m.name === 'Body')!.castShadow).toBe(true);
    expect(meshes.find((m) => m.name === 'Visor')!.castShadow).toBe(false);
  });

  it('does not thrash when one entity carries BOTH a rig and a mesh renderer', async () => {
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel, Renderable3DPrimitive } = traits;
    // Nothing declares these mutually exclusive, and the two passes own DIFFERENT THREE objects
    // under the one entity id. On a shared cache each pass saw the other's key, mismatched, and
    // re-applied — a per-frame traverse of the whole rig that renders CORRECTLY, so nothing
    // would ever have surfaced it.
    const e = world.spawn(
      Transform(),
      SkinnedModel({ model: 'rig', isVisible: true, castShadow: 'auto' }),
      Renderable3DPrimitive({ mesh: 'cube', isVisible: true, castShadow: 'off' }),
    );
    const id = e.id();

    for (let frame = 0; frame < 3; frame++) {
      sync.syncRenderables(world, scene, state);
      sync.syncSkinnedModels(world, scene, state);
    }

    // Each pass holds its OWN settled key, so neither invalidates the other next frame.
    expect(state.skinnedShadowFlags.get(id)).toBe('auto:true');
    expect(state.ecsShadowFlags.get(id)).toBe('off:true');
    // …and each object still carries the flags its own trait asked for.
    expect(meshesOf(state, id).find((m) => m.name === 'Body')!.castShadow).toBe(true);
    expect((state.ecsObjects.get(id) as THREE.Mesh).castShadow).toBe(false);
  });

  it('honours an explicit castShadow override on a rig', async () => {
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel } = traits;
    const id = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true, castShadow: 'off' })).id();

    sync.syncSkinnedModels(world, scene, state);

    for (const m of meshesOf(state, id)) expect(m.castShadow).toBe(false);
  });

  it('re-applies when the authored flags change on an EXISTING rig (the live-edit path)', async () => {
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel } = traits;
    const e = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true }));

    sync.syncSkinnedModels(world, scene, state);
    expect(meshesOf(state, e.id()).find((m) => m.name === 'Body')!.castShadow).toBe(true);

    // Inspector edit between frames — the rig already exists, so only the re-apply path can
    // deliver this. Without it the Inspector field would look authored and do nothing.
    e.set(SkinnedModel, { ...e.get(SkinnedModel)!, castShadow: 'off', receiveShadow: false });
    sync.syncSkinnedModels(world, scene, state);

    for (const m of meshesOf(state, e.id())) {
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
    }
  });
});

describe('syncSkinnedModels — recycled entity index (#868)', () => {
  it('a same-model rig respawned on a dead one\'s index between two frames gets its OWN clone and mixer', async () => {
    // The rebuild gate compared only the model ref and library key, so a same-model respawn kept
    // the dead entity's entry: its running AnimationMixer clock and current clip, a suppressed
    // @anim-start, and mixer listeners closed over the dead rig entity.
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel } = traits;
    const a = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true }));
    sync.syncSkinnedModels(world, scene, state);
    const entryA = state.skinned.get(a)!;
    expect(entryA).toBeDefined();

    a.destroy();
    const b = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    sync.syncSkinnedModels(world, scene, state);

    const entryB = state.skinned.get(b)!;
    expect(entryB).toBeDefined();
    expect(entryB.mixer).not.toBe(entryA.mixer);
    expect(entryB.root).not.toBe(entryA.root);
    expect(entryA.root.parent).toBeNull();               // the dead clone left the scene
    expect(scene.children.filter((c) => c === entryB.root)).toHaveLength(1);
  });

  it('a live rig keeps its clone across frames, and a removed rig leaves no shadow-flags row behind', async () => {
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, SkinnedModel } = traits;
    const e = world.spawn(Transform(), SkinnedModel({ model: 'rig', isVisible: true }));
    sync.syncSkinnedModels(world, scene, state);
    const first = state.skinned.get(e)!;
    sync.syncSkinnedModels(world, scene, state);
    sync.syncSkinnedModels(world, scene, state);
    expect(state.skinned.get(e)).toBe(first);            // not swept and rebuilt every frame
    expect(first.root.parent).toBe(scene);

    const id = e.id();
    expect(state.skinnedShadowFlags.has(id)).toBe(true);
    e.destroy();
    sync.syncSkinnedModels(world, scene, state);
    expect(state.skinned.hasId(id)).toBe(false);
    expect(state.skinnedShadowFlags.has(id)).toBe(false); // the row goes with its entry
  });
});

describe('syncRenderables — recycled entity index (#868)', () => {
  it('a same-shape primitive respawned on a dead one\'s index between two frames gets its OWN object', async () => {
    // The rebuild gates compare only mesh kind and size, so the respawn kept the dead entity's
    // THREE object — and with it whatever was written onto it: MaterialInstance uniform overrides
    // live in `obj.userData` and are never cleared, and a prop override leaves a bound clone.
    const { world, traits, sync, scene, state } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    const a = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true }));
    sync.syncRenderables(world, scene, state);
    const objA = state.ecsObjects.get(a.id())!;
    expect(objA).toBeDefined();
    objA.userData.uTint = 0.5;                            // what a MaterialInstance uniform override writes

    a.destroy();
    const b = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'cube', isVisible: true }));
    expect(b.id()).toBe(a.id());
    expect(b.valueOf()).not.toBe(a.valueOf());
    sync.syncRenderables(world, scene, state);

    const objB = state.ecsObjects.get(b.id())!;
    expect(objB).toBeDefined();
    expect(objB).not.toBe(objA);
    expect(objB.userData.uTint).toBeUndefined();
    expect(objA.parent).toBeNull();                       // the dead object left the scene
  });
});
