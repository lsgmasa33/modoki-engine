/** scene3DSync unit tests — createRenderState, disposeRenderState, applyTransform,
 *  syncMaterial (indirectly via syncRenderables), resolveInlineTextureMaterial. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mock the heavy module-level deps scene3DSync imports so the module can be
 *  loaded in the node test env without a real ECS world / DOM. */
function mockSceneSyncDeps() {
  vi.doMock('../../src/runtime/traits', () => ({
    Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {}, Tint: {},
    SkinnedModel: {}, SkeletalAnimator: {}, AnimationLibrary: {}, BoneAttachment: {},
  }));
  vi.doMock('../../src/runtime/traits/EntityAttributes', () => ({ EntityAttributes: {} }));
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(), ensureRiggedModelLoaded: vi.fn(),
  }));
  vi.doMock('three/examples/jsm/utils/SkeletonUtils.js', () => ({ clone: vi.fn(), retargetClip: vi.fn() }));
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(), resolveMaterialForMesh: vi.fn(),
    resolveMaterial: vi.fn(), getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    onModelInvalidated: vi.fn(), getMeshAsset: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
  // setActiveRenderer is called by createRenderer (not makeWebGPURenderer); stub
  // it so the real textureResolver (KTX2Loader etc.) isn't pulled in.
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    setActiveRenderer: vi.fn(), loadTexture3D: vi.fn(), releaseTexture3D: vi.fn(),
    // riggedModelCache gates its load on this; fire immediately in tests.
    onRendererReady: (fn: () => void) => fn(),
  }));
}

// `three/webgpu` is unresolvable in the package's node test env (the `three`
// alias rewrites the subpath past its exports map), so we mock it with a hoisted
// factory keyed by specifier — no resolution needed. The fake's init() outcome
// is driven by the shared, per-test-mutable `state.initFor`.
const rendererMock = vi.hoisted(() => {
  const state = {
    instances: [] as any[],
    initFor: (_forceWebGL: boolean): Promise<void> => Promise.resolve(),
  };
  class FakeRenderer {
    domElement = { remove: vi.fn() };
    forceWebGL: boolean;
    dispose = vi.fn();
    toneMappingExposure = 1;
    shadowMap = { enabled: false };
    constructor(opts: { forceWebGL?: boolean }) {
      this.forceWebGL = !!opts?.forceWebGL;
      state.instances.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    set toneMapping(_v: unknown) {}
    init = vi.fn(() => state.initFor(this.forceWebGL));
  }
  return { state, FakeRenderer };
});

vi.mock('three/webgpu', () => ({ WebGPURenderer: rendererMock.FakeRenderer }));

// We test the pure helper functions that don't require a full ECS world.
// syncRenderables/syncCamera/syncLights are deeply coupled to ECS queries and
// Three.js scene graph — we focus on the utility functions and RenderState management.

describe('scene3DSync', () => {
  describe('createRenderState', () => {
    it('creates state with empty collections', async () => {
      // Mock heavy deps that scene3DSync imports at module level
      vi.doMock('../../src/runtime/traits', () => ({
        Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {},
      }));
      vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
      vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
      vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
        worldTransforms: new Map(),
        deactivatedEntities: new Set(),
      }));
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
        resolveMeshTemplate: vi.fn(),
        resolveMaterialForMesh: vi.fn(),
        resolveMaterial: vi.fn(),
        getCachedEnvironment: vi.fn(),
        acquireEnvironment: vi.fn(),
      }));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({
        createPrimitiveMesh: vi.fn(),
      }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
        isImagePath: (p: string) => /\.(png|jpe?g|webp|gif|svg)$/i.test(p) || p.startsWith('http'),
      }));

      const { createRenderState } = await import('../../src/runtime/rendering/scene3DSync');
      const state = createRenderState();

      expect(state.ecsObjects).toBeInstanceOf(Map);
      expect(state.ecsObjects.size).toBe(0);
      expect(state.ecsSprites).toBeInstanceOf(Map);
      expect(state.ecsMaterials).toBeInstanceOf(Map);
      expect(state.ecsColors).toBeInstanceOf(Map);
      expect(state.ownsGeometry).toBeInstanceOf(Set);
      expect(state.ownsGeometry.size).toBe(0);
    });
  });

  describe('disposeRenderState', () => {
    it('removes objects from scene and clears collections', async () => {
      vi.doMock('../../src/runtime/traits', () => ({
        Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {},
      }));
      vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
      vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
      vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
        worldTransforms: new Map(),
        deactivatedEntities: new Set(),
      }));
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
        resolveMeshTemplate: vi.fn(),
        resolveMaterialForMesh: vi.fn(),
        resolveMaterial: vi.fn(),
        getCachedEnvironment: vi.fn(),
        acquireEnvironment: vi.fn(),
      }));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({
        createPrimitiveMesh: vi.fn(),
      }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
        isImagePath: () => false,
      }));

      const { createRenderState, disposeRenderState } = await import('../../src/runtime/rendering/scene3DSync');
      const state = createRenderState();

      const mockGeometry = { dispose: vi.fn() };
      const mockMaterial = { dispose: vi.fn() };
      const mockObj = { geometry: mockGeometry, material: mockMaterial } as any;
      const mockScene = { remove: vi.fn() } as any;

      state.ecsObjects.set(1, mockObj);
      state.ownsGeometry.add(1);
      state.ecsSprites.set(1, 'mesh.glb');
      state.ecsMaterials.set(1, 'mat.json');
      state.ecsColors.set(1, 0xff0000);

      disposeRenderState(state, mockScene, true);

      expect(mockScene.remove).toHaveBeenCalledWith(mockObj);
      expect(mockGeometry.dispose).toHaveBeenCalled();
      expect(mockMaterial.dispose).toHaveBeenCalled();
      expect(state.ecsObjects.size).toBe(0);
      expect(state.ecsSprites.size).toBe(0);
      expect(state.ecsMaterials.size).toBe(0);
      expect(state.ecsColors.size).toBe(0);
      expect(state.ownsGeometry.size).toBe(0);
    });

    it('does not dispose geometry for non-owned objects', async () => {
      vi.doMock('../../src/runtime/traits', () => ({
        Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {},
      }));
      vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
      vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
      vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
        worldTransforms: new Map(),
        deactivatedEntities: new Set(),
      }));
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
        resolveMeshTemplate: vi.fn(),
        resolveMaterialForMesh: vi.fn(),
        resolveMaterial: vi.fn(),
        getCachedEnvironment: vi.fn(),
        acquireEnvironment: vi.fn(),
      }));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({
        createPrimitiveMesh: vi.fn(),
      }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
        isImagePath: () => false,
      }));

      const { createRenderState, disposeRenderState } = await import('../../src/runtime/rendering/scene3DSync');
      const state = createRenderState();

      const mockGeometry = { dispose: vi.fn() };
      const mockObj = { geometry: mockGeometry } as any;
      const mockScene = { remove: vi.fn() } as any;

      state.ecsObjects.set(5, mockObj);
      // NOT adding to ownsGeometry

      disposeRenderState(state, mockScene);

      expect(mockScene.remove).toHaveBeenCalledWith(mockObj);
      expect(mockGeometry.dispose).not.toHaveBeenCalled();
    });

    it('skips material dispose when disposeMeshMaterials is false', async () => {
      vi.doMock('../../src/runtime/traits', () => ({
        Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {},
      }));
      vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
      vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
      vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
        worldTransforms: new Map(),
        deactivatedEntities: new Set(),
      }));
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
        resolveMeshTemplate: vi.fn(),
        resolveMaterialForMesh: vi.fn(),
        resolveMaterial: vi.fn(),
        getCachedEnvironment: vi.fn(),
        acquireEnvironment: vi.fn(),
      }));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({
        createPrimitiveMesh: vi.fn(),
      }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
        isImagePath: () => false,
      }));

      const { createRenderState, disposeRenderState } = await import('../../src/runtime/rendering/scene3DSync');
      const state = createRenderState();

      const mockMaterial = { dispose: vi.fn() };
      const mockObj = { geometry: { dispose: vi.fn() }, material: mockMaterial } as any;
      const mockScene = { remove: vi.fn() } as any;

      state.ecsObjects.set(1, mockObj);
      state.ownsGeometry.add(1);

      disposeRenderState(state, mockScene, false);

      expect(mockMaterial.dispose).not.toHaveBeenCalled();
    });
  });

  // NOTE: the inline-texture material path (resolveInlineTextureMaterial /
  // disposeInlineTextureMaterials) was removed — a mesh renderer references a
  // `.mat.json` material only, never a texture directly.

  describe('collectEntityMeshes (material broker source)', () => {
    async function loadState() {
      mockSceneSyncDeps();
      const mod = await import('../../src/runtime/rendering/scene3DSync');
      return { createRenderState: mod.createRenderState, collectEntityMeshes: mod.collectEntityMeshes };
    }

    it('returns the plain renderable mesh for an id', async () => {
      const { createRenderState, collectEntityMeshes } = await loadState();
      const state = createRenderState();
      const m = { isMesh: true, material: {} } as any;
      state.ecsObjects.set(3, m);
      expect(collectEntityMeshes(state, 3)).toEqual([m]);
    });

    it('expands a LOD into its child meshes', async () => {
      const { createRenderState, collectEntityMeshes } = await loadState();
      const state = createRenderState();
      const c0 = { isMesh: true } as any, c1 = { isMesh: true } as any;
      const lod = { isLOD: true, children: [c0, c1, { isMesh: false }] } as any;
      state.ecsObjects.set(4, lod);
      const meshes = collectEntityMeshes(state, 4);
      expect(meshes).toEqual([c0, c1]); // the non-mesh child is skipped
    });

    it('includes billboard part meshes and text page meshes', async () => {
      const { createRenderState, collectEntityMeshes } = await loadState();
      const state = createRenderState();
      const bbMesh = { isMesh: true } as any;
      state.billboards.set(7, { meshes: [bbMesh] } as any);
      const pageMesh = { isMesh: true } as any;
      state.textMeshes.set(8, { pages: new Map([[0, pageMesh]]) } as any);
      expect(collectEntityMeshes(state, 7)).toEqual([bbMesh]);
      expect(collectEntityMeshes(state, 8)).toEqual([pageMesh]);
    });

    it('returns empty for an id with no 3D presence', async () => {
      const { createRenderState, collectEntityMeshes } = await loadState();
      expect(collectEntityMeshes(createRenderState(), 99)).toEqual([]);
    });
  });

  describe('clearOwnedMaterials', () => {
    it('is callable without error', async () => {
      vi.doMock('../../src/runtime/traits', () => ({
        Transform: {}, Renderable3D: {}, Renderable3DPrimitive: {}, Camera: {},
      }));
      vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
      vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
      vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
        worldTransforms: new Map(),
        deactivatedEntities: new Set(),
      }));
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
        resolveMeshTemplate: vi.fn(),
        resolveMaterialForMesh: vi.fn(),
        resolveMaterial: vi.fn(),
        getCachedEnvironment: vi.fn(),
        acquireEnvironment: vi.fn(),
      }));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({
        createPrimitiveMesh: vi.fn(),
      }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({
        isImagePath: () => false,
      }));

      const { clearOwnedMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      expect(() => clearOwnedMaterials()).not.toThrow();
    });
  });

  describe('makeWebGPURenderer', () => {
    beforeEach(() => {
      rendererMock.state.instances = [];
      rendererMock.state.initFor = () => Promise.resolve();
      vi.stubGlobal('window', { devicePixelRatio: 1 });
    });

    it('falls back to the WebGL2 backend when WebGPU init fails', async () => {
      const { instances } = rendererMock.state;
      // WebGPU attempt (forceWebGL=false) rejects; WebGL2 fallback (true) resolves.
      rendererMock.state.initFor = (forceWebGL) =>
        forceWebGL ? Promise.resolve() : Promise.reject(new Error('webgpu init failed'));
      vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported: async () => true }));
      mockSceneSyncDeps();

      const { makeWebGPURenderer } = await import('../../src/runtime/rendering/scene3DSync');
      const container: any = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() };
      const r = await makeWebGPURenderer(container);

      expect(instances).toHaveLength(2);
      expect(instances[0].forceWebGL).toBe(false); // first attempt: native WebGPU
      expect(instances[1].forceWebGL).toBe(true);  // retry: WebGL2 backend
      expect(instances[0].dispose).toHaveBeenCalled();          // dead renderer cleaned up
      expect(instances[0].domElement.remove).toHaveBeenCalled();
      expect(r).toBe(instances[1]);                              // returns the working one
      expect(container.appendChild).toHaveBeenCalledTimes(2);
    });

    it('disposes + detaches the WebGL2 fallback if its init ALSO fails, then rethrows', async () => {
      const { instances } = rendererMock.state;
      rendererMock.state.initFor = () => Promise.reject(new Error('init failed'));
      vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported: async () => true }));
      mockSceneSyncDeps();

      const { makeWebGPURenderer } = await import('../../src/runtime/rendering/scene3DSync');
      const container: any = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() };

      await expect(makeWebGPURenderer(container)).rejects.toThrow('init failed');
      // Both renderers constructed; the second (WebGL2 fallback) must not leak.
      expect(instances).toHaveLength(2);
      expect(instances[1].dispose).toHaveBeenCalled();
      expect(instances[1].domElement.remove).toHaveBeenCalled();
    });

    it('does not attempt a WebGL2 fallback when WebGPU was never supported (rethrows directly)', async () => {
      const { instances } = rendererMock.state;
      rendererMock.state.initFor = () => Promise.reject(new Error('gl init failed'));
      // Not supported → the single renderer is already forceWebGL; nothing to fall back to.
      vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({ getWebGPUSupported: async () => false }));
      mockSceneSyncDeps();

      const { makeWebGPURenderer } = await import('../../src/runtime/rendering/scene3DSync');
      const container: any = { clientWidth: 800, clientHeight: 600, appendChild: vi.fn() };

      await expect(makeWebGPURenderer(container)).rejects.toThrow('gl init failed');
      expect(instances).toHaveLength(1); // no second attempt
      expect(instances[0].forceWebGL).toBe(true);
    });
  });

  // ── Skeletal: per-clone skeleton disposal (A1) ──────────────
  describe('skinned entry disposal (boneTexture leak)', () => {
    /** A minimal SkinnedMesh-like object: traverse must visit it and report
     *  isSkinnedMesh so disposeSkinnedEntry calls its skeleton.dispose(). */
    function fakeSkinnedRoot(skeletons: { dispose: ReturnType<typeof vi.fn> }[]) {
      const children = skeletons.map((sk) => ({
        isSkinnedMesh: true,
        skeleton: sk,
        traverse(cb: (o: unknown) => void) { cb(this); },
      }));
      return {
        isSkinnedMesh: false,
        traverse(cb: (o: unknown) => void) { cb(this); children.forEach((c) => c.traverse(cb)); },
      } as unknown as import('three').Object3D;
    }

    it('disposes each clone skeleton (boneTexture) and stops the mixer on teardown', async () => {
      mockSceneSyncDeps();
      const { createRenderState, disposeRenderState } = await import('../../src/runtime/rendering/scene3DSync');
      const state = createRenderState();

      const skA = { dispose: vi.fn() };
      const skB = { dispose: vi.fn() };
      const mixer = { stopAllAction: vi.fn(), uncacheRoot: vi.fn() } as any;
      const root = fakeSkinnedRoot([skA, skB]);
      const scene = { remove: vi.fn() } as any;
      state.skinned.set(7, { modelRef: 'm.glb', root, mixer, actions: new Map(), firstClip: '', bones: new Map(), nodes: new Map() });

      disposeRenderState(state, scene);

      expect(mixer.stopAllAction).toHaveBeenCalled();
      expect(mixer.uncacheRoot).toHaveBeenCalledWith(root);
      expect(scene.remove).toHaveBeenCalledWith(root);
      expect(skA.dispose).toHaveBeenCalledTimes(1); // the leak guard
      expect(skB.dispose).toHaveBeenCalledTimes(1);
      expect(state.skinned.size).toBe(0);
    });
  });

  // ── Skeletal: animator clip selection / fade / fallback (A2, A4) ──
  describe('driveAnimator', () => {
    function fakeAction() {
      return {
        reset: vi.fn().mockReturnThis(), play: vi.fn(), stop: vi.fn(),
        crossFadeFrom: vi.fn(), setEffectiveWeight: vi.fn(), setLoop: vi.fn(),
        enabled: false, paused: false, timeScale: 1, clampWhenFinished: false,
      };
    }
    function entryWith(clips: string[]) {
      const actions = new Map<string, ReturnType<typeof fakeAction>>();
      for (const c of clips) actions.set(c, fakeAction());
      return { modelRef: 'm.glb', root: {} as any, mixer: {} as any, actions, firstClip: clips[0] ?? '', bones: new Map(), nodes: new Map() };
    }
    const anim = (clip: string, over: Partial<{ animSet: string; playing: boolean; speed: number; loop: boolean; fadeDuration: number }> = {}) =>
      ({ animSet: '', clip, playing: true, speed: 1, loop: true, fadeDuration: 0, ...over });

    /** Mock animSetCache with a per-clip param table BEFORE importing scene3DSync
     *  (vi.resetModules runs each test, so the doMock must precede the import).
     *  An empty `animSet` ref always resolves to engine defaults, matching prod. */
    function mockAnimSet(byClip: Record<string, Partial<{ speed: number; loop: boolean; fadeDuration: number }>>) {
      const DEFAULTS = { speed: 1, loop: true, fadeDuration: 0 };
      vi.doMock('../../src/runtime/loaders/animSetCache', () => ({
        ANIMSET_DEFAULTS: DEFAULTS,
        getAnimSet: vi.fn(),
        resolveAnimSetParams: (ref: string, clip: string) => {
          if (!ref) return DEFAULTS;
          const p = byClip[clip] ?? {};
          return { speed: p.speed ?? 1, loop: p.loop ?? true, fadeDuration: p.fadeDuration ?? 0 };
        },
      }));
    }

    it('plays the requested clip and stops the previous one (instant, no fade)', async () => {
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Walk']);
      driveAnimator(entry, anim('Idle'));
      driveAnimator(entry, anim('Walk'));
      expect(entry.actions.get('Walk')!.play).toHaveBeenCalled();
      expect(entry.actions.get('Walk')!.setEffectiveWeight).toHaveBeenCalledWith(1);
      expect(entry.actions.get('Idle')!.stop).toHaveBeenCalled();
      expect(entry.current).toBe('Walk');
    });

    it('crossfades without force-weighting the next clip (A4)', async () => {
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Walk']);
      driveAnimator(entry, anim('Idle'));
      driveAnimator(entry, anim('Walk', { fadeDuration: 0.3 }));
      const walk = entry.actions.get('Walk')!;
      expect(walk.crossFadeFrom).toHaveBeenCalledWith(entry.actions.get('Idle'), 0.3, false);
      expect(walk.play).toHaveBeenCalled();
      // must NOT pre-set full weight in the fade branch — that defeats the fade
      expect(walk.setEffectiveWeight).not.toHaveBeenCalled();
    });

    it('falls back to firstClip and warns once when the clip name is missing (A2)', async () => {
      mockSceneSyncDeps();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Walk']);
      driveAnimator(entry, anim('Nonexistent'));
      expect(entry.current).toBe('Idle'); // fell back, not left undefined
      expect(entry.actions.get('Idle')!.play).toHaveBeenCalled();
      driveAnimator(entry, anim('Nonexistent')); // second frame — still missing
      expect(warn).toHaveBeenCalledTimes(1); // warn-once, no per-frame spam
      warn.mockRestore();
    });

    it('does NOT warn while the rig has no clips yet (library still loading)', async () => {
      // A bare rig that gets its clips from an AnimationLibrary has an empty action
      // set for the first frames until the library's source GLB lazy-loads + merges.
      // The requested clip legitimately isn't there yet — warning on every scene load
      // is a false alarm (the reported "clip not found → (none)" noise).
      mockSceneSyncDeps();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith([]);            // zero clips — library hasn't merged yet
      driveAnimator(entry, anim('bent'));
      driveAnimator(entry, anim('bent'));     // a few frames before the merge
      expect(warn).not.toHaveBeenCalled();    // suppressed — not a real missing clip
      warn.mockRestore();
    });

    it('maps loop/speed/playing onto the active action', async () => {
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle']);
      driveAnimator(entry, anim('Idle', { playing: false, speed: 2, loop: false }));
      const idle = entry.actions.get('Idle')!;
      expect(idle.paused).toBe(true);
      expect(idle.timeScale).toBe(2);
      expect(idle.clampWhenFinished).toBe(true);
      expect(idle.setLoop).toHaveBeenLastCalledWith(expect.anything(), 1);
    });

    // ── P5: per-clip params from the animset ─────────────────────────────────
    it('applies each clip\'s own animset speed/loop when the trait fields are at default', async () => {
      mockAnimSet({
        Idle: { speed: 1, loop: true },
        Attack: { speed: 1.5, loop: false },
      });
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Attack']);
      // Trait fields left at default (speed 1, loop true) → inherit the animset.
      driveAnimator(entry, anim('Idle', { animSet: 'set' }));
      expect(entry.actions.get('Idle')!.timeScale).toBe(1);
      expect(entry.actions.get('Idle')!.setLoop).toHaveBeenLastCalledWith(expect.anything(), Infinity);
      driveAnimator(entry, anim('Attack', { animSet: 'set' }));
      const atk = entry.actions.get('Attack')!;
      expect(atk.timeScale).toBe(1.5);                 // ← clip's own authored speed
      expect(atk.clampWhenFinished).toBe(true);         // ← clip's own loop:false
      expect(atk.setLoop).toHaveBeenLastCalledWith(expect.anything(), 1);
    });

    it('a non-default trait field overrides the animset per-clip value', async () => {
      mockAnimSet({ Run: { speed: 2, loop: true } });
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Run']);
      // speed 0.25 ≠ default 1 → per-entity override wins; loop left at default → inherits animset.
      driveAnimator(entry, anim('Run', { animSet: 'set', speed: 0.25 }));
      const run = entry.actions.get('Run')!;
      expect(run.timeScale).toBe(0.25);                          // override, not the animset's 2
      expect(run.setLoop).toHaveBeenLastCalledWith(expect.anything(), Infinity); // inherited loop:true
    });

    it('uses the incoming clip\'s animset fadeDuration for the crossfade', async () => {
      mockAnimSet({ Idle: {}, Walk: { fadeDuration: 0.4 } });
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Walk']);
      driveAnimator(entry, anim('Idle', { animSet: 'set' }));
      // fadeDuration left at default 0 on the trait → inherit Walk's 0.4 from the animset.
      driveAnimator(entry, anim('Walk', { animSet: 'set' }));
      expect(entry.actions.get('Walk')!.crossFadeFrom).toHaveBeenCalledWith(entry.actions.get('Idle'), 0.4, false);
    });

    // ── P6: a LIBRARY clip resolves params from ITS source animset ───────────
    it('a library clip plays with its source animset\'s params, not the entity animSet', async () => {
      // Dance lives in a library animset; the mock keys params by clip name. With
      // clipParamSource('Dance')='lib' the resolver is consulted with 'lib' (truthy),
      // yielding Dance's authored speed. Without clipParamSource it'd fall to the
      // entity animSet ('' → engine defaults), so the non-default speed proves it.
      mockAnimSet({ Dance: { speed: 1.7, loop: false } });
      mockSceneSyncDeps();
      const { driveAnimator } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = entryWith(['Idle', 'Dance']) as any;
      entry.clipParamSource = new Map([['Dance', 'lib']]);
      // Entity has NO own animSet — the library clip still gets its authored params.
      driveAnimator(entry, anim('Dance'));
      const dance = entry.actions.get('Dance')!;
      expect(dance.timeScale).toBe(1.7);          // ← from the library animset
      expect(dance.clampWhenFinished).toBe(true); // ← library loop:false
    });
  });

  // ── P6: shared cross-model clip library ────────────────────────────────────
  describe('effectiveLibrary', () => {
    it('appends the SkeletalAnimator animSet so it provides clips (not just params)', async () => {
      mockSceneSyncDeps();
      const { effectiveLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      // No AnimationLibrary at all → the animSet alone is the clip source (a bare
      // rig with just SkeletalAnimator.animSet now gets clips).
      expect(effectiveLibrary(undefined, 'setA')).toEqual({ animSets: ['setA'], retarget: undefined, boneMaps: undefined });
      // Unions with the library's animSets, carrying retarget/boneMaps.
      expect(effectiveLibrary({ animSets: ['lib'], retarget: true, boneMaps: { lib: { a: 'b' } } }, 'setA'))
        .toEqual({ animSets: ['lib', 'setA'], retarget: true, boneMaps: { lib: { a: 'b' } } });
      // Already present → no duplicate (animset on BOTH library + animator).
      expect(effectiveLibrary({ animSets: ['setA'] }, 'setA').animSets).toEqual(['setA']);
      // No animSet → returns the library unchanged (identical legacy behaviour).
      const lib = { animSets: ['lib'] };
      expect(effectiveLibrary(lib, undefined)).toBe(lib);
      expect(effectiveLibrary(lib, '')).toBe(lib);
    });
  });

  describe('animationLibraryKey', () => {
    it('is empty for no/empty library and order-independent otherwise', async () => {
      mockSceneSyncDeps();
      const { animationLibraryKey } = await import('../../src/runtime/rendering/scene3DSync');
      expect(animationLibraryKey(undefined)).toBe('');
      expect(animationLibraryKey({ animSets: [] })).toBe('');
      // Reordering the same set yields the same key (no needless rebuild).
      expect(animationLibraryKey({ animSets: ['b', 'a'] })).toBe(animationLibraryKey({ animSets: ['a', 'b'] }));
      // retarget flag changes the key (forces a rebuild).
      expect(animationLibraryKey({ animSets: ['a'], retarget: true }))
        .not.toBe(animationLibraryKey({ animSets: ['a'], retarget: false }));
    });

    it('folds the bone maps into the key (canonical, order-independent)', async () => {
      mockSceneSyncDeps();
      const { animationLibraryKey } = await import('../../src/runtime/rendering/scene3DSync');
      const base = animationLibraryKey({ animSets: ['a'] });
      // Adding a bone map changes the key → rebuild + re-retarget.
      expect(animationLibraryKey({ animSets: ['a'], boneMaps: { a: { hip: 'Hips' } } })).not.toBe(base);
      // Same map, different insertion order → same key (no needless rebuild).
      expect(animationLibraryKey({ animSets: ['a'], boneMaps: { a: { hip: 'Hips', arm: 'Arm' } } }))
        .toBe(animationLibraryKey({ animSets: ['a'], boneMaps: { a: { arm: 'Arm', hip: 'Hips' } } }));
    });
  });

  describe('mergeAnimationLibrary', () => {
    const clip = (name: string) => ({ name, tracks: [] } as any);
    function fakeMixer() {
      return { clipAction: vi.fn((c: any) => ({ __clip: c })) };
    }
    function makeEntry(ownClips: string[]) {
      const actions = new Map<string, any>();
      for (const c of ownClips) actions.set(c, { own: c });
      return {
        modelRef: 'm.glb', root: { traverse: vi.fn() } as any, mixer: fakeMixer(),
        actions, firstClip: ownClips[0] ?? '', bones: new Map(), nodes: new Map(),
      } as any;
    }
    function makeDeps(opts: {
      sets?: Record<string, { source?: string } | null>;
      rigs?: Record<string, { prototype: any; animations: any[] } | undefined>;
    }) {
      const ensureRiggedModelLoaded = vi.fn();
      const retargetClip = vi.fn((_t: any, _s: any, c: any) => ({ ...c, retargeted: true }));
      return {
        ensureRiggedModelLoaded, retargetClip,
        deps: {
          getAnimSet: (ref: string) => (opts.sets?.[ref] ?? null),
          getRiggedModel: (ref: string) => opts.rigs?.[ref],
          ensureRiggedModelLoaded, retargetClip,
        },
      };
    }

    it('merges library clips (own ∪ library; own clip wins on a name conflict)', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = makeEntry(['Idle']); // own clip Idle
      const { deps } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: {}, animations: [clip('Idle'), clip('Dance')] } },
      });
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, deps);
      expect(entry.actions.has('Dance')).toBe(true);              // library-only clip added
      expect(entry.actions.get('Idle')).toEqual({ own: 'Idle' }); // own clip NOT overwritten
      expect(entry.clipParamSource.get('Dance')).toBe('setA');    // param source recorded
      expect(entry.clipParamSource.has('Idle')).toBe(false);      // own clip → no library param source
    });

    it('binds a clip-only model entirely from the library (no own clips)', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = makeEntry([]); // bare rig, zero own clips
      const { deps } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: {}, animations: [clip('Walk'), clip('Run')] } },
      });
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, deps);
      expect([...entry.actions.keys()].sort()).toEqual(['Run', 'Walk']);
    });

    it('is lazy: skips an unloaded animset / GLB and kicks the load, then merges once ready', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = makeEntry([]);
      // Frame 1: animset loaded but GLB not yet → ensureRiggedModelLoaded called, no merge.
      const ld = makeDeps({ sets: { setA: { source: 'lib.glb' } }, rigs: { 'lib.glb': undefined } });
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, ld.deps);
      expect(ld.ensureRiggedModelLoaded).toHaveBeenCalledWith('lib.glb');
      expect(entry.actions.size).toBe(0);
      // Frame 2: GLB now loaded → clips merge.
      const ready = makeDeps({ sets: { setA: { source: 'lib.glb' } }, rigs: { 'lib.glb': { prototype: {}, animations: [clip('Dance')] } } });
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, ready.deps);
      expect(entry.actions.has('Dance')).toBe(true);
    });

    it('is idempotent: a merged source binds its clips exactly once', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const entry = makeEntry([]);
      const { deps } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: {}, animations: [clip('Dance')] } },
      });
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, deps);
      mergeAnimationLibrary(entry, { animSets: ['setA'] }, deps); // second frame
      expect(entry.mixer.clipAction).toHaveBeenCalledTimes(1);   // not re-bound
      expect(entry.libraryMerged.has('lib.glb')).toBe(true);
    });

    it('retargets each library clip when retarget=true', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      // root + prototype each expose a SkinnedMesh so firstSkinnedMesh resolves.
      const skinnedMesh = { isSkinnedMesh: true, skeleton: {} };
      const entry = makeEntry([]);
      entry.root = { traverse: (cb: any) => cb(skinnedMesh) };
      const { deps, retargetClip } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: { traverse: (cb: any) => cb(skinnedMesh) }, animations: [clip('Dance')] } },
      });
      mergeAnimationLibrary(entry, { animSets: ['setA'], retarget: true }, deps);
      expect(retargetClip).toHaveBeenCalledTimes(1);
      // The action was built from the RETARGETED clip (name preserved).
      const action = entry.actions.get('Dance');
      expect(action.__clip.retargeted).toBe(true);
      expect(action.__clip.name).toBe('Dance');
    });

    it('retargets with the per-animSet bone map even when global retarget is false', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const skinnedMesh = { isSkinnedMesh: true, skeleton: {} };
      const entry = makeEntry([]);
      entry.root = { traverse: (cb: any) => cb(skinnedMesh) };
      const { deps, retargetClip } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: { traverse: (cb: any) => cb(skinnedMesh) }, animations: [clip('Dance')] } },
      });
      const boneMap = { tgtBone: 'srcBone' };
      // retarget:false, but a non-empty bone map forces retargeting for this animSet,
      // and the map is passed through as retargetClip's `names` option.
      mergeAnimationLibrary(entry, { animSets: ['setA'], retarget: false, boneMaps: { setA: boneMap } }, deps);
      expect(retargetClip).toHaveBeenCalledTimes(1);
      expect(retargetClip).toHaveBeenCalledWith(skinnedMesh, skinnedMesh, expect.anything(), { names: boneMap });
    });

    it('rewrites retargeted ".bones[Name]" track names to node-name form', async () => {
      // retargetClip emits skeleton-relative track names that only bind to a
      // SkinnedMesh; our mixer drives the clone ROOT (a Group), so they must be
      // rewritten to node-name form or the clip binds nothing (real runtime bug).
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const skinnedMesh = { isSkinnedMesh: true, skeleton: {} };
      const entry = makeEntry([]);
      entry.root = { traverse: (cb: any) => cb(skinnedMesh) };
      const deps = {
        getAnimSet: () => ({ source: 'lib.glb' }),
        getRiggedModel: () => ({ prototype: { traverse: (cb: any) => cb(skinnedMesh) }, animations: [clip('Dance')] }),
        ensureRiggedModelLoaded: vi.fn(),
        retargetClip: vi.fn(() => ({ name: 'x', tracks: [{ name: '.bones[joint1].quaternion' }, { name: '.bones[joint0].scale' }] })),
      } as any;
      mergeAnimationLibrary(entry, { animSets: ['setA'], retarget: true }, deps);
      const action = entry.actions.get('Dance');
      expect(action.__clip.tracks.map((t: any) => t.name)).toEqual(['joint1.quaternion', 'joint0.scale']);
    });

    it('re-attaches dropped scale tracks after retargeting (remapped target←source)', async () => {
      // retargetClip resamples only position(hip)+quaternion — it DROPS scale, so a
      // scale-only clip (shrink/stretch on bone0.scale) would otherwise retarget to a
      // clip that moves nothing. The source scale track is carried over and renamed
      // through the inverted bone map (bone0 → joint0).
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const skinnedMesh = { isSkinnedMesh: true, skeleton: {} };
      const entry = makeEntry([]);
      entry.root = { traverse: (cb: any) => cb(skinnedMesh) };
      const scaleTrack = { name: 'bone0.scale', clone() { return { name: 'bone0.scale' }; } };
      const srcClip = { name: 'shrink', tracks: [scaleTrack] };
      const deps = {
        getAnimSet: () => ({ source: 'lib.glb' }),
        getRiggedModel: () => ({ prototype: { traverse: (cb: any) => cb(skinnedMesh) }, animations: [srcClip] }),
        ensureRiggedModelLoaded: vi.fn(),
        // Mimic retargetClip: emits only a quaternion track; the scale is DROPPED.
        retargetClip: vi.fn(() => ({ name: 'x', tracks: [{ name: '.bones[joint0].quaternion' }], resetDuration: vi.fn() })),
      } as any;
      mergeAnimationLibrary(entry, { animSets: ['setA'], boneMaps: { setA: { joint0: 'bone0' } } }, deps);
      const names = entry.actions.get('shrink').__clip.tracks.map((t: any) => t.name);
      expect(names).toContain('joint0.quaternion');           // retargeted quaternion (renamed)
      expect(names).toContain('joint0.scale');                // dropped scale re-attached + remapped
    });

    it('does NOT retarget when retarget=false and the bone map is absent/empty', async () => {
      mockSceneSyncDeps();
      const { mergeAnimationLibrary } = await import('../../src/runtime/rendering/scene3DSync');
      const skinnedMesh = { isSkinnedMesh: true, skeleton: {} };
      const entry = makeEntry([]);
      entry.root = { traverse: (cb: any) => cb(skinnedMesh) };
      const { deps, retargetClip } = makeDeps({
        sets: { setA: { source: 'lib.glb' } },
        rigs: { 'lib.glb': { prototype: { traverse: (cb: any) => cb(skinnedMesh) }, animations: [clip('Dance')] } },
      });
      mergeAnimationLibrary(entry, { animSets: ['setA'], boneMaps: { setA: {} } }, deps);
      expect(retargetClip).not.toHaveBeenCalled(); // empty map → direct bind by name
    });
  });

  // ── Skeletal: per-node material overrides + visibility (P1) ──────────────
  describe('syncNodeMaterials', () => {
    // A fake submesh holding either a single material or a material array. Slot
    // names come from each material's `.name` (mirrors buildNodes).
    function fakeMesh(uuid: string, mat: any) {
      return { uuid, material: mat, visible: true } as unknown as import('three').Mesh;
    }
    const fakeMat = (name: string) => ({ name, isMaterial: true });

    // Build a NodeRender whose slots/baked are wired by hand (the render path
    // builds these from a real clone; here we mirror one node's structure).
    function nodeWithMeshes(meshes: import('three').Mesh[]) {
      const slots = new Map<string, { mesh: import('three').Mesh; index: number }[]>();
      const baked = new Map<string, any>();
      for (const mesh of meshes) {
        const mat = (mesh as any).material;
        baked.set((mesh as any).uuid, Array.isArray(mat) ? [...mat] : mat);
        const push = (slot: string, index: number) => {
          let arr = slots.get(slot);
          if (!arr) { arr = []; slots.set(slot, arr); }
          arr.push({ mesh, index });
        };
        if (Array.isArray(mat)) mat.forEach((m: any, i: number) => push(m.name, i));
        else push(mat.name, -1);
      }
      return { meshes, slots, baked, appliedOverrides: new Map<string, string>(), visibleApplied: true };
    }

    it('binds an override material to every submesh in the slot', async () => {
      mockSceneSyncDeps();
      const { syncNodeMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      const a = fakeMesh('a', fakeMat('Body'));
      const b = fakeMesh('b', fakeMat('Body')); // two meshes share the 'Body' slot
      const node = nodeWithMeshes([a, b]);
      const override = { name: 'engineMat', isMaterial: true } as any;
      syncNodeMaterials(node, { Body: 'guid-1' }, true, () => override);
      expect((a as any).material).toBe(override);
      expect((b as any).material).toBe(override);
      expect(node.appliedOverrides.get('Body')).toBe('guid-1');
    });

    it('restores the baked material when the override is cleared', async () => {
      mockSceneSyncDeps();
      const { syncNodeMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      const baked = fakeMat('Body');
      const a = fakeMesh('a', baked);
      const node = nodeWithMeshes([a]);
      const override = { name: 'engineMat', isMaterial: true } as any;
      syncNodeMaterials(node, { Body: 'guid-1' }, true, () => override);
      expect((a as any).material).toBe(override);
      syncNodeMaterials(node, {}, true, () => override); // override removed
      expect((a as any).material).toBe(baked); // back to the GLB material
      expect(node.appliedOverrides.has('Body')).toBe(false);
    });

    it('overrides only the matching index of a material-array mesh', async () => {
      mockSceneSyncDeps();
      const { syncNodeMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      const m0 = fakeMat('Skin');
      const m1 = fakeMat('Eyes');
      const mesh = fakeMesh('a', [m0, m1]);
      const node = nodeWithMeshes([mesh]);
      const override = { name: 'engineEyes', isMaterial: true } as any;
      syncNodeMaterials(node, { Eyes: 'guid-eyes' }, true, () => override);
      expect((mesh as any).material[0]).toBe(m0);      // Skin untouched
      expect((mesh as any).material[1]).toBe(override); // Eyes swapped
    });

    it('keeps the baked material and retries when the override has not loaded', async () => {
      mockSceneSyncDeps();
      const { syncNodeMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      const baked = fakeMat('Body');
      const a = fakeMesh('a', baked);
      const node = nodeWithMeshes([a]);
      const override = { name: 'engineMat', isMaterial: true } as any;
      let loaded = false;
      const resolve = () => (loaded ? override : undefined);
      syncNodeMaterials(node, { Body: 'guid-1' }, true, resolve); // not loaded yet
      expect((a as any).material).toBe(baked);
      expect(node.appliedOverrides.has('Body')).toBe(false); // not marked applied
      loaded = true;
      syncNodeMaterials(node, { Body: 'guid-1' }, true, resolve); // now resolves
      expect((a as any).material).toBe(override);
      expect(node.appliedOverrides.get('Body')).toBe('guid-1');
    });

    it('toggles visibility of every submesh in the node', async () => {
      mockSceneSyncDeps();
      const { syncNodeMaterials } = await import('../../src/runtime/rendering/scene3DSync');
      const a = fakeMesh('a', fakeMat('Body'));
      const b = fakeMesh('b', fakeMat('Body'));
      const node = nodeWithMeshes([a, b]);
      syncNodeMaterials(node, {}, false, () => undefined); // hide
      expect((a as any).visible).toBe(false);
      expect((b as any).visible).toBe(false);
      syncNodeMaterials(node, {}, true, () => undefined); // show
      expect((a as any).visible).toBe(true);
      expect((b as any).visible).toBe(true);
    });
  });

  // The skeletal mixer advance: frozen out of Play mode EXCEPT while the Animation
  // editor previews (skeletalPreview). This is the decision that fixes "Animator
  // doesn't play in the scene unless in Play mode".
  describe('mixerAdvanceDelta', () => {
    async function load(playState: string, visual: number) {
      mockSceneSyncDeps();
      vi.doMock('../../src/runtime/systems/playState', () => ({ getPlayState: () => playState }));
      vi.doMock('../../src/runtime/systems/getTime', () => ({ getVisualDelta: () => visual }));
      const sync = await import('../../src/runtime/rendering/scene3DSync');
      const preview = await import('../../src/runtime/systems/skeletalPreview');
      return { ...sync, ...preview };
    }

    it('uses the engine visual delta while playing', async () => {
      const { mixerAdvanceDelta, setSkeletalPreview } = await load('playing', 0.02);
      setSkeletalPreview(false, 0); // even if preview is off, playing wins
      expect(mixerAdvanceDelta({} as any)).toBeCloseTo(0.02);
    });

    it('freezes (0) while stopped and NOT previewing', async () => {
      const { mixerAdvanceDelta, setSkeletalPreview } = await load('stopped', 0.02);
      setSkeletalPreview(false, 0);
      expect(mixerAdvanceDelta({} as any)).toBe(0);
    });

    it('advances by the editor preview delta while stopped + previewing', async () => {
      const { mixerAdvanceDelta, setSkeletalPreview } = await load('stopped', 0.02);
      setSkeletalPreview(true, 0.016);
      expect(mixerAdvanceDelta({} as any)).toBeCloseTo(0.016);
      setSkeletalPreview(false, 0); // don't leak the flag into other tests
    });

    // Missing Test #1 (animation F1): a PAUSED world must freeze the skeletal mixer
    // (dt 0) — Pause is not Stop, but both are "not playing" so the mixer must not
    // advance. Without an active editor preview, advance is 0.
    it('freezes (0) while paused and NOT previewing', async () => {
      const { mixerAdvanceDelta, setSkeletalPreview } = await load('paused', 0.02);
      setSkeletalPreview(false, 0);
      expect(mixerAdvanceDelta({} as any)).toBe(0);
    });

    // Missing Test #2 (animation F2): slow-mo must scale the mixer advance. The
    // skeletal mixer sources `getVisualDelta` (smoothedCadence × timeScale) while
    // playing, NOT a wall clock — so halving/tripling-down timeScale (reflected in
    // the visual delta) scales the per-frame advance proportionally rather than
    // running at real time. timeScale=0 (time-stop) freezes it entirely.
    it('scales the advance with the engine visual delta under slow-mo (not wall-clock)', async () => {
      const full = await load('playing', 0.02); // timeScale 1 → smoothedDelta 0.02
      expect(full.mixerAdvanceDelta({} as any)).toBeCloseTo(0.02);

      vi.resetModules(); // load() memoizes via dynamic import — reset to re-mock
      const slow = await load('playing', 0.006); // timeScale 0.3 → 0.02 × 0.3
      expect(slow.mixerAdvanceDelta({} as any)).toBeCloseTo(0.006);
      // proportional to timeScale, not pinned to a real-time frame delta
      expect(0.006 / 0.02).toBeCloseTo(0.3);

      vi.resetModules();
      const stopped = await load('playing', 0); // timeScale 0 → time-stop
      expect(stopped.mixerAdvanceDelta({} as any)).toBe(0);
    });
  });

  describe('refreshEnvIntensityObserver', () => {
    // Regression: changing scene.environmentIntensity is not monitored by three's
    // NodeMaterialObserver, so on the render-on-demand SceneView some meshes render
    // stale until the camera moves. The helper cycles each material's (monitored)
    // envMapIntensity so needsRefresh re-uploads the env uniform. Two invariants matter:
    // dedupe (a shared material is cycled ONCE, not once per mesh) and change-on-every
    // -call (so the observer always detects it), all within a tiny drift-free band.
    async function loadHelper() {
      mockSceneSyncDeps();
      vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({}));
      vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
      vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
      const THREE = await import('three');
      const { refreshEnvIntensityObserver } = await import('../../src/runtime/rendering/scene3DSync');
      return { THREE, refreshEnvIntensityObserver };
    }

    it('cycles a shared material ONCE per call (deduped) and always changes it', async () => {
      const { THREE, refreshEnvIntensityObserver } = await loadHelper();
      const scene = new THREE.Scene();
      const shared = new THREE.MeshStandardMaterial(); shared.envMapIntensity = 0.35;
      const geo = new THREE.BoxGeometry();
      // Six meshes share ONE material (the bug: per-mesh cycling would advance it 6× →
      // 6 % 3 === 0 → back to base → no net change → observer never refreshes).
      for (let i = 0; i < 6; i++) scene.add(new THREE.Mesh(geo, shared));

      const base = 0.35;
      const seq: number[] = [];
      for (let i = 0; i < 4; i++) { refreshEnvIntensityObserver(scene); seq.push(shared.envMapIntensity); }

      // tick cycles 1,2,0,1 → base + {1,2,0,1}*1e-4 (deduped: one step per call).
      expect(seq[0]).toBeCloseTo(base + 1e-4, 9);
      expect(seq[1]).toBeCloseTo(base + 2e-4, 9);
      expect(seq[2]).toBeCloseTo(base + 0, 9);
      expect(seq[3]).toBeCloseTo(base + 1e-4, 9);
      // Consecutive values always differ (so equals() trips every time)...
      for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
      // ...and never drift outside a tiny band around the authored value.
      for (const v of seq) { expect(v).toBeGreaterThanOrEqual(base); expect(v).toBeLessThanOrEqual(base + 2e-4); }
    });

    it('skips materials without envMapIntensity (e.g. MeshBasicMaterial)', async () => {
      const { THREE, refreshEnvIntensityObserver } = await loadHelper();
      const scene = new THREE.Scene();
      const basic = new THREE.MeshBasicMaterial();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), basic));
      expect(() => refreshEnvIntensityObserver(scene)).not.toThrow();
      expect((basic as unknown as { envMapIntensity?: number }).envMapIntensity).toBeUndefined();
    });
  });
});
