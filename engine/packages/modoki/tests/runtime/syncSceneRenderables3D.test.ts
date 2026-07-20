/** syncSceneRenderables3D — the shared renderable+skeletal core of the per-frame
 *  ECS→Three sync (cross-cutting theme T2 / runtime-rendering-3d.md F1, F3).
 *
 *  Two guards:
 *  1. FUNCTIONAL — the helper runs syncRenderables (transform applied to a
 *     pre-seeded object) and threads the caller's `renderables`/`skinned`
 *     callbacks through to the right sub-call.
 *  2. STRUCTURAL anti-drift — the runtime Scene3D (renderFrame + offscreen
 *     capture) and the editor SceneView all route through this ONE helper, and
 *     none of them call syncSkinnedModels/syncBones/syncBoneAttachments directly.
 *     This is the regression guard for F1: the offscreen `render_scene` capture
 *     had silently dropped the skeletal trio, so rigged scenes captured empty or
 *     frozen. A bare `syncRenderables(` re-added to the capture (or the helper
 *     removed from either loop) re-fails this test. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../src');

// Hoisted holders shared with doMock factories below (kept at top level so vitest
// doesn't warn about nested hoisting). Used by the skinned-lifecycle (#5) and
// invalidation (#8) suites.
const rigs = vi.hoisted(() => ({ byRef: new Map<string, unknown>() }));
const ensureSpy = vi.hoisted(() => ({ fn: undefined as undefined | ((ref: string) => void) }));
const inval = vi.hoisted(() => ({ listener: undefined as undefined | ((p: string, t: Set<string>) => void), assets: new Map<string, { model: string }>() }));

/** Strip block + line comments so a function name mentioned in prose (this
 *  subsystem documents the divergence heavily) doesn't count as a call site —
 *  mirrors determinismGuard.test.ts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countCalls(code: string, fn: string): number {
  return (code.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) ?? []).length;
}

// ── 1. Functional ──────────────────────────────────────────────────────────

beforeEach(() => { vi.resetModules(); });

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMaterialForMesh: vi.fn(),
    resolveMaterial: vi.fn(() => ({ uuid: 'm', color: { setHex: vi.fn() }, nprColorPreserve: 0, dispose: vi.fn() })),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
  // No real GLB fetch for the skeletal path: rig "not loaded" → skinned sync
  // skips the entity (exercises the trio without IO).
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(() => undefined), ensureRiggedModelLoaded: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { world: createWorld(), traits, sync };
}

function makeMockMesh() {
  return { position: { set: vi.fn() }, rotation: { set: vi.fn() }, scale: { set: vi.fn() }, material: null } as any;
}

describe('syncSceneRenderables3D — functional', () => {
  it('runs syncRenderables (applies transform to a pre-seeded object)', async () => {
    const { world, traits, sync } = await setup();
    const { Transform, Renderable3D } = traits;
    const e = world.spawn(
      Transform({ x: 1, y: 2, z: 3 }),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
    );
    const mesh = makeMockMesh();
    const state = sync.createRenderState();
    state.ecsObjects.set(e.id(), mesh);
    state.ecsSprites.set(e.id(), 'ship.glb'); // matches rend.mesh → reuse, no GLB load
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    sync.syncSceneRenderables3D(world, scene, state);
    expect(mesh.position.set).toHaveBeenCalledWith(1, 2, 3);
  });

  it('threads the renderables.shouldUpdateTransform callback through', async () => {
    const { world, traits, sync } = await setup();
    const { Transform, Renderable3D } = traits;
    const e = world.spawn(
      Transform({ x: 1, y: 2, z: 3 }),
      Renderable3D({ mesh: 'ship.glb', material: 'base.mat.json', isVisible: true }),
    );
    const mesh = makeMockMesh();
    const state = sync.createRenderState();
    state.ecsObjects.set(e.id(), mesh);
    state.ecsSprites.set(e.id(), 'ship.glb');
    const scene: any = { add: vi.fn(), remove: vi.fn() };

    // gizmo-controlled → caller asks the helper to skip the transform write
    sync.syncSceneRenderables3D(world, scene, state, {
      renderables: { shouldUpdateTransform: () => false },
    });
    expect(mesh.position.set).not.toHaveBeenCalled();
  });

  it('runs the skeletal trio without throwing when a SkinnedModel has no loaded rig', async () => {
    const { world, traits, sync } = await setup();
    const { Transform, SkinnedModel } = traits;
    world.spawn(Transform(), SkinnedModel({ model: 'missing.glb', isVisible: true }));
    const state = sync.createRenderState();
    const scene: any = { add: vi.fn(), remove: vi.fn() };
    // syncSkinnedModels → syncBones → syncBoneAttachments must all run (no rig
    // loaded → no entry created, but no throw either).
    expect(() => sync.syncSceneRenderables3D(world, scene, state)).not.toThrow();
    expect(state.skinned.size).toBe(0);
  });
});

// ── 2. Structural anti-drift guard ─────────────────────────────────────────

describe('syncSceneRenderables3D — orchestrators route through the shared helper (F1 anti-drift)', () => {
  const scene3D = stripComments(readFileSync(join(SRC, 'runtime/rendering/Scene3D.tsx'), 'utf8'));
  const sceneView = stripComments(readFileSync(join(SRC, 'editor/panels/SceneView.tsx'), 'utf8'));

  it('Scene3D uses the helper in BOTH renderFrame and the offscreen capture', () => {
    expect(countCalls(scene3D, 'syncSceneRenderables3D')).toBeGreaterThanOrEqual(2);
  });

  it('SceneView.animate uses the helper', () => {
    expect(countCalls(sceneView, 'syncSceneRenderables3D')).toBeGreaterThanOrEqual(1);
  });

  it('neither orchestrator calls the skeletal sync fns directly (only via the helper)', () => {
    for (const [name, code] of [['Scene3D.tsx', scene3D], ['SceneView.tsx', sceneView]] as const) {
      for (const fn of ['syncSkinnedModels', 'syncBones', 'syncBoneAttachments', 'syncRenderables']) {
        expect(countCalls(code, fn), `${name} should not call ${fn} directly — route through syncSceneRenderables3D`).toBe(0);
      }
    }
  });
});

// ── 3. syncBoneAttachments transform composition (animation Missing Test #7) ──

describe('syncBoneAttachments — transform composition', () => {
  async function THREE() { return import('three'); }

  async function buildAttachment(boneQuatEuler: [number, number, number], bonePos: [number, number, number]) {
    const { world, traits, sync } = await setup();
    const T = await THREE();
    const { Transform, BoneAttachment, EntityAttributes } = traits;

    // Target rig entity (guid 'rig') + a posed bone in its skeleton.
    const rig = world.spawn(EntityAttributes({ name: 'Rig', guid: 'rig' }));
    const bone = new T.Bone();
    const bq = new T.Quaternion().setFromEuler(new T.Euler(...boneQuatEuler));
    bone.matrixWorld.compose(new T.Vector3(...bonePos), bq, new T.Vector3(3, 3, 3)); // bake scale 3
    const root = new T.Object3D(); // standalone → updateMatrixWorld(true) won't reset bone

    const state = sync.createRenderState();
    state.skinned.set(rig.id(), { root, bones: new Map([['Bone1', bone]]) } as any);

    // Attached prop: local offset (1,0,0), no local rotation, own scale 2.
    const att = world.spawn(
      Transform({ x: 1, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 2, sy: 2, sz: 2 }),
      BoneAttachment({ target: 'rig', bone: 'Bone1' }),
      EntityAttributes({ name: 'Prop', guid: 'prop' }),
    );
    const obj = new T.Object3D();
    state.ecsObjects.set(att.id(), obj);

    sync.syncBoneAttachments(world, { add() {}, remove() {} } as any, state);
    return { obj, bq };
  }

  it('follows bone world position + the prop offset, keeps the prop OWN scale (not bone bake scale)', async () => {
    const { obj } = await buildAttachment([0, 0, 0], [10, 0, 0]); // identity bone rotation
    // pos = bonePos(10,0,0) + offset(1,0,0) rotated by identity = (11,0,0)
    expect(obj.position.x).toBeCloseTo(11, 5);
    expect(obj.position.y).toBeCloseTo(0, 5);
    expect(obj.position.z).toBeCloseTo(0, 5);
    // scale is the entity's own (2), NOT the rig's 3× bake scale
    expect(obj.scale.x).toBeCloseTo(2, 5);
    expect(obj.scale.y).toBeCloseTo(2, 5);
  });

  it('rotates the offset into the bone orientation and composes rotation', async () => {
    // Bone rotated +90° about Z → offset (1,0,0) maps to (0,1,0).
    const { obj, bq } = await buildAttachment([0, 0, Math.PI / 2], [10, 0, 0]);
    // offset (1,0,0) rotated +90°Z → (0,1,0); + bonePos(10,0,0) = (10,1,0)
    expect(obj.position.x).toBeCloseTo(10, 5);
    expect(obj.position.y).toBeCloseTo(1, 5);
    expect(obj.position.z).toBeCloseTo(0, 5);
    // prop has no local rotation → obj.quaternion == boneQuat
    expect(obj.quaternion.x).toBeCloseTo(bq.x, 5);
    expect(obj.quaternion.y).toBeCloseTo(bq.y, 5);
    expect(obj.quaternion.z).toBeCloseTo(bq.z, 5);
    expect(obj.quaternion.w).toBeCloseTo(bq.w, 5);
  });

  // Missing Test #6 — early-outs + the once-per-frame pose guard.
  it('leaves the prop untouched when the target guid resolves to no rig', async () => {
    const { world, traits, sync } = await setup();
    const T = await THREE();
    const { Transform, BoneAttachment, EntityAttributes } = traits;
    // A skinned entry must exist (else the size===0 guard returns first) — but it's
    // a DIFFERENT rig id than the attachment's target guid resolves to.
    const state = sync.createRenderState();
    state.skinned.set(999, { root: new T.Object3D(), bones: new Map() } as any);
    const att = world.spawn(
      Transform({ x: 5, y: 6, z: 7 }),
      BoneAttachment({ target: 'no-such-rig', bone: 'Bone1' }),
      EntityAttributes({ name: 'Prop', guid: 'prop' }),
    );
    const obj = new T.Object3D();
    obj.position.set(123, 123, 123); // sentinel
    state.ecsObjects.set(att.id(), obj);

    sync.syncBoneAttachments(world, { add() {}, remove() {} } as any, state);
    expect(obj.position.x).toBe(123); // no target match → no write
  });

  it('leaves the prop untouched when the bone name is absent from the rig', async () => {
    const { world, traits, sync } = await setup();
    const T = await THREE();
    const { Transform, BoneAttachment, EntityAttributes } = traits;
    const rig = world.spawn(EntityAttributes({ name: 'Rig', guid: 'rig' }));
    const state = sync.createRenderState();
    // Rig exists but has NO 'Bone1'.
    state.skinned.set(rig.id(), { root: new T.Object3D(), bones: new Map() } as any);
    const att = world.spawn(
      Transform({ x: 5, y: 6, z: 7 }),
      BoneAttachment({ target: 'rig', bone: 'Bone1' }),
      EntityAttributes({ name: 'Prop', guid: 'prop' }),
    );
    const obj = new T.Object3D();
    obj.position.set(123, 123, 123);
    state.ecsObjects.set(att.id(), obj);

    sync.syncBoneAttachments(world, { add() {}, remove() {} } as any, state);
    expect(obj.position.x).toBe(123); // bone missing → no write
  });

  it('force-poses each target rig at most once per frame (two attachments share one rig)', async () => {
    const { world, traits, sync } = await setup();
    const T = await THREE();
    const { Transform, BoneAttachment, EntityAttributes } = traits;
    const rig = world.spawn(EntityAttributes({ name: 'Rig', guid: 'rig' }));
    const bone = new T.Bone();
    bone.matrixWorld.compose(new T.Vector3(0, 0, 0), new T.Quaternion(), new T.Vector3(1, 1, 1));
    const root = new T.Object3D();
    const poseSpy = vi.spyOn(root, 'updateMatrixWorld'); // count force-poses
    const state = sync.createRenderState();
    state.skinned.set(rig.id(), { root, bones: new Map([['Bone1', bone]]) } as any);

    for (const name of ['A', 'B']) {
      const att = world.spawn(
        Transform({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 }),
        BoneAttachment({ target: 'rig', bone: 'Bone1' }),
        EntityAttributes({ name, guid: `prop-${name}` }),
      );
      state.ecsObjects.set(att.id(), new T.Object3D());
    }

    sync.syncBoneAttachments(world, { add() {}, remove() {} } as any, state);
    // Two attachments, ONE rig → the rig's matrixWorld is force-refreshed once.
    expect(poseSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 5. syncSkinnedModels lifecycle (Missing Test #5) ──

describe('syncSkinnedModels — lifecycle', () => {
  // Uses the top-level `rigs` / `ensureSpy` holders: a mutable rig the
  // riggedModelCache mock hands back per model ref (doMock is not hoisted, so its
  // factory closes over these holders, resolved at import time).
  async function setupSkinned() {
    vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
    vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
    vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
      worldTransforms: new Map(), deactivatedEntities: new Set(),
    }));
    vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
      resolveMeshTemplate: vi.fn(), resolveMaterialForMesh: vi.fn(), resolveMaterial: vi.fn(),
      getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
      onModelInvalidated: vi.fn(() => () => {}), getMeshAsset: vi.fn(),
    }));
    vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
    vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
    const ensure = vi.fn((ref: string) => { void ref; });
    ensureSpy.fn = ensure;
    vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
      getRiggedModel: vi.fn((ref: string) => rigs.byRef.get(ref)),
      ensureRiggedModelLoaded: ensure,
    }));
    const { createWorld } = await import('koota');
    const traits = await import('../../src/runtime/traits');
    const sync = await import('../../src/runtime/rendering/scene3DSync');
    const T = await import('three');
    return { world: createWorld(), traits, sync, T };
  }

  function makeProto(T: typeof import('three'), boneName: string, clipName: string) {
    const proto = new T.Group();
    const bone = new T.Bone(); bone.name = boneName;
    proto.add(bone);
    const animations = [new T.AnimationClip(clipName, -1, [])];
    return { prototype: proto as unknown as import('three').Object3D, animations };
  }

  beforeEach(() => { rigs.byRef.clear(); ensureSpy.fn = undefined; });

  it('builds an entry from the prototype: clone in scene, actions + bones mapped, autoplays the first clip', async () => {
    const { world, traits, sync, T } = await setupSkinned();
    rigs.byRef.set('alien.glb', makeProto(T, 'Root', 'Idle'));
    const { Transform, SkinnedModel } = traits;
    const e = world.spawn(Transform(), SkinnedModel({ model: 'alien.glb', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new T.Scene();

    sync.syncSkinnedModels(world, scene, state);

    const entry = state.skinned.get(e.id())!;
    expect(entry).toBeDefined();
    expect(entry.modelRef).toBe('alien.glb');
    expect([...entry.actions.keys()]).toEqual(['Idle']);
    expect(entry.bones.has('Root')).toBe(true);
    expect(scene.children).toContain(entry.root); // clone added to the scene
    // No SkeletalAnimator trait → autoplay the first clip.
    expect(entry.current).toBe('Idle');
    expect(entry.actions.get('Idle')!.isRunning()).toBe(true);
  });

  it('skips an entity whose rig is not loaded yet and kicks a lazy load', async () => {
    const { world, traits, sync, T } = await setupSkinned();
    // No rig registered for 'pending.glb' → getRiggedModel returns undefined.
    const { Transform, SkinnedModel } = traits;
    world.spawn(Transform(), SkinnedModel({ model: 'pending.glb', isVisible: true }));
    const state = sync.createRenderState();
    sync.syncSkinnedModels(world, new T.Scene(), state);

    expect(state.skinned.size).toBe(0);
    expect(ensureSpy.fn).toHaveBeenCalledWith('pending.glb');
  });

  it('rebuilds the entry when the model ref changes (old disposed, new clone added)', async () => {
    const { world, traits, sync, T } = await setupSkinned();
    rigs.byRef.set('a.glb', makeProto(T, 'Root', 'Idle'));
    rigs.byRef.set('b.glb', makeProto(T, 'Spine', 'Walk'));
    const { Transform, SkinnedModel } = traits;
    const e = world.spawn(Transform(), SkinnedModel({ model: 'a.glb', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new T.Scene();

    sync.syncSkinnedModels(world, scene, state);
    const first = state.skinned.get(e.id())!;
    expect(first.modelRef).toBe('a.glb');

    e.set(SkinnedModel, { ...e.get(SkinnedModel)!, model: 'b.glb' });
    sync.syncSkinnedModels(world, scene, state);
    const second = state.skinned.get(e.id())!;
    expect(second).not.toBe(first);          // rebuilt, not mutated in place
    expect(second.modelRef).toBe('b.glb');
    expect(second.bones.has('Spine')).toBe(true);
    expect(scene.children).toContain(second.root);
    expect(scene.children).not.toContain(first.root); // old clone removed
  });

  it('reaps the entry when the entity is deactivated', async () => {
    const { world, traits, sync, T } = await setupSkinned();
    rigs.byRef.set('alien.glb', makeProto(T, 'Root', 'Idle'));
    const { Transform, SkinnedModel } = traits;
    const e = world.spawn(Transform(), SkinnedModel({ model: 'alien.glb', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncSkinnedModels(world, scene, state);
    const root = state.skinned.get(e.id())!.root;
    expect(state.skinned.size).toBe(1);

    e.set(SkinnedModel, { ...e.get(SkinnedModel)!, isVisible: false });
    sync.syncSkinnedModels(world, scene, state);
    expect(state.skinned.size).toBe(0);             // reaped
    expect(scene.children).not.toContain(root);     // clone removed from scene
  });
});

// ── 6. attachInvalidationListener eviction (Missing Test #8) ──

describe('attachInvalidationListener — re-import eviction', () => {
  // Uses the top-level `inval` holder to capture the listener the cache registers,
  // plus a getMeshAsset stub.
  async function setupInval() {
    vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
    vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
    vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
      worldTransforms: new Map(), deactivatedEntities: new Set(),
    }));
    vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
      resolveMeshTemplate: vi.fn(), resolveMaterialForMesh: vi.fn(), resolveMaterial: vi.fn(),
      getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
      onModelInvalidated: (cb: (p: string, t: Set<string>) => void) => { inval.listener = cb; return () => { inval.listener = undefined; }; },
      getMeshAsset: (ref: string) => inval.assets.get(ref),
    }));
    // resolveRef is identity here (asset.model already a path) so targets.has matches.
    vi.doMock('../../src/runtime/loaders/assetManifest', () => ({ resolveRef: (r: string) => r, onFontInvalidated: () => () => {} }));
    vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
    vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
    const sync = await import('../../src/runtime/rendering/scene3DSync');
    const T = await import('three');
    return { sync, T };
  }

  beforeEach(() => { inval.listener = undefined; inval.assets.clear(); });

  it('evicts ecsObjects whose backing model was invalidated, leaving unrelated meshes', async () => {
    const { sync, T } = await setupInval();
    inval.assets.set('rock.mesh.json', { model: '/rock.glb' });
    inval.assets.set('tree.mesh.json', { model: '/tree.glb' });
    const state = sync.createRenderState();
    const scene = new T.Scene();

    const rock = new T.Mesh(); scene.add(rock);
    state.ecsObjects.set(1, rock); state.ecsSprites.set(1, 'rock.mesh.json');
    state.ecsMaterials.set(1, 'r.mat'); state.ownsGeometry.add?.(1);
    const tree = new T.Mesh(); scene.add(tree);
    state.ecsObjects.set(2, tree); state.ecsSprites.set(2, 'tree.mesh.json');

    sync.attachInvalidationListener(state, scene);
    expect(inval.listener).toBeDefined();
    // Re-import of /rock.glb → its LOD-target set includes '/rock.glb'.
    inval.listener!('/rock.glb', new Set(['/rock.glb']));

    // rock evicted from every map + the scene; tree untouched.
    expect(state.ecsObjects.has(1)).toBe(false);
    expect(state.ecsSprites.has(1)).toBe(false);
    expect(state.ecsMaterials.has(1)).toBe(false);
    expect(scene.children).not.toContain(rock);
    expect(state.ecsObjects.get(2)).toBe(tree);
    expect(scene.children).toContain(tree);
  });

  it('evicts a skinned entry whose GLB was invalidated (before geometry is freed)', async () => {
    const { sync, T } = await setupInval();
    const state = sync.createRenderState();
    const scene = new T.Scene();
    const root = new T.Group(); scene.add(root);
    const mixer = { stopAllAction: vi.fn(), uncacheRoot: vi.fn() };
    state.skinned.set(5, { modelRef: '/alien.glb', root, mixer, bones: new Map() } as any);

    sync.attachInvalidationListener(state, scene);
    inval.listener!('/alien.glb', new Set(['/alien.glb']));

    expect(state.skinned.has(5)).toBe(false);     // entry evicted
    expect(mixer.stopAllAction).toHaveBeenCalled(); // disposeSkinnedEntry ran
    expect(scene.children).not.toContain(root);
  });
});

// ── 4. syncEnvironment change-gating (rendering-3d F5 + Missing Test #4) ──

describe('syncEnvironment — cached branch is change-gated', () => {
  async function setupEnv(cachedTex: unknown) {
    // scene3DSync queries the REAL three/traits/Environment, so spawn that exact trait
    // (it only needs koota, no heavy deps). A prior describe's setup() doMock'd it to
    // `{}` and doMock survives resetModules — restore the original explicitly here.
    vi.doMock('../../src/three/traits/Environment', async (orig: () => Promise<unknown>) => await orig());
    // scene3DSync now reads getEnvFormat → getAssetEntry (assetManifest) to apply the
    // UltraHDR intensity boost. A prior describe's setup doMock'd assetManifest to a
    // partial (no getAssetEntry) and doMock survives resetModules — restore the real
    // module so getAssetEntry exists (returns undefined for an unregistered path → boost 1).
    vi.doMock('../../src/runtime/loaders/assetManifest', async (orig: () => Promise<unknown>) => await orig());
    vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
    vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
      worldTransforms: new Map(), deactivatedEntities: new Set(),
    }));
    const acquireEnvironment = vi.fn();
    vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
      resolveMeshTemplate: vi.fn(), resolveMaterialForMesh: vi.fn(), resolveMaterial: vi.fn(),
      getCachedEnvironment: vi.fn(() => cachedTex), acquireEnvironment,
    }));
    vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
    vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
    vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
      getRiggedModel: vi.fn(() => undefined), ensureRiggedModelLoaded: vi.fn(),
    }));
    const { createWorld } = await import('koota');
    const { Environment } = await import('../../src/three/traits/Environment');
    const sync = await import('../../src/runtime/rendering/scene3DSync');
    return { world: createWorld(), Environment, sync, acquireEnvironment };
  }

  // A scene stub that COUNTS writes to the env-related fields.
  function makeScene() {
    const writes = { environment: 0, environmentIntensity: 0, background: 0, backgroundIntensity: 0, backgroundBlurriness: 0 };
    const store: any = { environment: null, environmentIntensity: 1, background: null, backgroundIntensity: 1, backgroundBlurriness: 0 };
    const scene: any = {};
    for (const k of Object.keys(writes) as (keyof typeof writes)[]) {
      Object.defineProperty(scene, k, { get: () => store[k], set: (v) => { store[k] = v; writes[k]++; }, configurable: true });
    }
    return { scene, writes };
  }

  it('applies env on the first frame, then writes nothing on a second unchanged frame', async () => {
    const tex = { isTexture: true };
    const { world, Environment, sync } = await setupEnv(tex);
    world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 2, showAsBackground: true, backgroundIntensity: 1.5, backgroundBlurriness: 0.2 }));
    const { scene, writes } = makeScene();

    sync.syncEnvironment(world, scene);
    expect(scene.environment).toBe(tex);
    expect(scene.environmentIntensity).toBe(2);
    expect(scene.background).toBe(tex);
    const after1 = { ...writes };

    sync.syncEnvironment(world, scene); // nothing changed
    // No field re-assigned on the second frame (the F5 guard).
    expect(writes).toEqual(after1);
  });

  it('applies NO boost to an hdr env (intensity passes through 1:1)', async () => {
    // '/sky.hdr' is unregistered → getEnvFormat undefined → boost 1. (Paired with the
    // ultrahdr case below so the format gate is pinned from both sides.)
    const { world, Environment, sync } = await setupEnv({ isTexture: true });
    world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 2, showAsBackground: true, backgroundIntensity: 4 }));
    const { scene } = makeScene();
    sync.syncEnvironment(world, scene);
    expect(scene.environmentIntensity).toBe(2);
    expect(scene.backgroundIntensity).toBe(4);
  });

  it('boosts environment + background intensity for an UltraHDR env (display-referred compensation)', async () => {
    const { world, Environment, sync } = await setupEnv({ isTexture: true });
    const { registerAsset, clearManifest } = await import('../../src/runtime/loaders/assetManifest');
    const guid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    registerAsset(guid, '/uhdr-sky.hdr', 'environment', undefined, { environment: { format: 'ultrahdr', maxSize: 1024 } });
    try {
      world.spawn(Environment({ hdrPath: guid, intensity: 2, showAsBackground: true, backgroundIntensity: 4, backgroundBlurriness: 0 }));
      const { scene } = makeScene();
      sync.syncEnvironment(world, scene);
      // ULTRAHDR_INTENSITY_BOOST = 1.5 → 2×1.5 = 3, 4×1.5 = 6.
      expect(scene.environmentIntensity).toBe(3);
      expect(scene.backgroundIntensity).toBe(6);
    } finally {
      clearManifest();
    }
  });

  it('writes only the changed scalar when intensity changes', async () => {
    const tex = { isTexture: true };
    const { world, Environment, sync } = await setupEnv(tex);
    const e = world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 2, showAsBackground: false }));
    const { scene, writes } = makeScene();
    sync.syncEnvironment(world, scene);
    const baseIntensityWrites = writes.environmentIntensity;

    e.set(Environment, { ...e.get(Environment)!, intensity: 3 });
    sync.syncEnvironment(world, scene);
    expect(scene.environmentIntensity).toBe(3);
    expect(writes.environmentIntensity).toBe(baseIntensityWrites + 1); // exactly one more write
  });
});
