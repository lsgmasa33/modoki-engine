/** prewarmShadersForWorld — guarantees a NORMAL material is the renderer's first
 *  compile so the NPR MRT pass is never the first compile (which re-triggers the
 *  WGSL `unresolved type 'OutputType'` bug). The F4 regression: an empty / particle-
 *  only / skinned-only scene used to early-return with `count === 0`, compiling
 *  nothing — so we assert the empty-world path STILL compiles a plain standard mesh.
 *
 *  Heavy GPU siblings scene3DSync imports at module load are mocked; the renderer is
 *  a stub whose `compileAsync` captures the scene it was handed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, unknown>();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
  // Every test builds a fresh world, and koota caps a process at 16. `vi.resetModules()` does
  // NOT reset that counter — koota lives in node_modules and is not re-evaluated — so the ids
  // accumulate across the file and test 17 dies with "Too many worlds created", which reads as
  // a bug in whatever test happened to be added last. Reset the registry instead of budgeting
  // tests around the ceiling. Imported HERE rather than at the top of the file so it is the same
  // cached instance the test's own dynamic import receives.
  const { universe } = await import('koota');
  universe.reset();
});

const RIG_REF = 'rig-guid-0001';

/** A stand-in rigged prototype: one named `THREE.SkinnedMesh` with a bound skeleton, under a
 *  named group so `nodeNameOf` resolves the node the way a real GLB import does. Its material
 *  is NAMED, because `buildNodes` keys a material slot by `material.name` — an unnamed one
 *  would silently key by mesh name and make an override test pass for the wrong reason. */
function makeRigPrototype(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'Ranger';
  const bone = new THREE.Bone();
  const skeleton = new THREE.Skeleton([bone]);
  const material = new THREE.MeshStandardMaterial();
  material.name = 'Ranger_Texture';
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material);
  mesh.name = 'Ranger';
  mesh.add(bone);
  mesh.bind(skeleton);
  group.add(mesh);
  return group;
}

async function setup(opts: { primitives?: boolean; env?: unknown; rig?: THREE.Object3D; overrideMaterial?: THREE.Material } = {}) {
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(() => null), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null),
    // A rig's SkinnedMeshRenderer override resolves through THIS function, so a test that
    // supplies `overrideMaterial` is the only one that can tell "override applied" from
    // "override silently dropped because the guid did not resolve".
    resolveMaterial: vi.fn(() => opts.overrideMaterial ?? null),
    getCachedEnvironment: vi.fn(() => opts.env ?? null), acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn((ref: string) => (opts.rig && ref === RIG_REF ? { prototype: opts.rig, animations: [] } : undefined)),
    ensureRiggedModelLoaded: vi.fn(),
  }));
  // A primitive factory that returns a REAL mesh, so the dedupe test can count the
  // placeholders that actually reached the compile. Each call yields a fresh object,
  // mirroring the real factory (which mints geometry + material per call — the very
  // per-entity cost the dedupe exists to avoid).
  const createPrimitiveMesh = vi.fn(() =>
    opts.primitives ? new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()) : null,
  );
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const { Renderable3DPrimitive, SkinnedModel, SkinnedMeshRenderer, EntityAttributes } = await import('../../src/runtime/traits');
  return { world: createWorld(), sync, Renderable3DPrimitive, SkinnedModel, SkinnedMeshRenderer, EntityAttributes, createPrimitiveMesh };
}

/** A renderer stub that records, AT compile time, a snapshot of the scene it was
 *  handed (prewarm clears the scene afterwards, so post-call inspection is empty). */
function makeRendererStub() {
  const compiledScenes: THREE.Scene[] = [];
  const standardMeshCounts: number[] = [];
  /** Captured AT compile time for the same reason as the counts: prewarm detaches the shared
   *  environment before clearing, so reading `.environment` after the call always sees null. */
  const compiledEnvironments: (THREE.Texture | null)[] = [];
  /** Shadow state AT compile time, for the same reason as everything else here — the prewarm
   *  clears the scene and disposes its lights afterwards, so a post-call read sees nothing. */
  const compiledLightShadows: boolean[][] = [];
  const compiledFog: { fog: boolean; fogNode: boolean }[] = [];
  const compiledMeshShadows: { cast: boolean; receive: boolean }[][] = [];
  /** Rigs AT compile time — and a rig arrives as a GROUP, so unlike the other captures this one
   *  must traverse rather than filter `scene.children`. Same reason as the rest for capturing
   *  here: `prewarmScene.clear()` runs after the compile, so a post-call read finds nothing. */
  const compiledSkinned: { material: THREE.Material | THREE.Material[] }[][] = [];
  const renderer = {
    compileAsync: vi.fn(async (scene: THREE.Scene) => {
      compiledScenes.push(scene);
      compiledEnvironments.push(scene.environment);
      compiledFog.push({ fog: scene.fog !== null && scene.fog !== undefined, fogNode: !!scene.fogNode });
      compiledLightShadows.push(
        scene.children.filter((o) => (o as THREE.Light).isLight).map((o) => o.castShadow),
      );
      compiledMeshShadows.push(
        scene.children
          .filter((o) => (o as THREE.Mesh).isMesh)
          .map((o) => ({ cast: o.castShadow, receive: o.receiveShadow })),
      );
      const rigs: { material: THREE.Material | THREE.Material[] }[] = [];
      scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) rigs.push({ material: (o as THREE.SkinnedMesh).material });
      });
      compiledSkinned.push(rigs);
      standardMeshCounts.push(
        scene.children.filter(
          (o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material instanceof THREE.MeshStandardMaterial,
        ).length,
      );
    }),
  };
  return { renderer, compiledScenes, standardMeshCounts, compiledEnvironments, compiledLightShadows, compiledMeshShadows, compiledFog, compiledSkinned };
}

const camera = new THREE.PerspectiveCamera();

describe('prewarmShadersForWorld — F4 empty-scene first-compile guarantee', () => {
  it('still compiles a plain standard mesh when the world has no Renderable3D/Primitive', async () => {
    const { world, sync } = await setup();
    const { renderer, compiledScenes, standardMeshCounts } = makeRendererStub();

    // Empty world (e.g. a particle-only / skinned-only NPR scene).
    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    expect(renderer.compileAsync).toHaveBeenCalledTimes(1); // did NOT early-return
    expect(compiledScenes).toHaveLength(1);
    expect(standardMeshCounts[0]).toBeGreaterThanOrEqual(1); // placeholder normal material compiled first
  });

  it('leaves the prewarm scene clean afterwards (placeholder disposed + removed)', async () => {
    const { world, sync } = await setup();
    const { renderer, compiledScenes } = makeRendererStub();

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    // The captured scene is cleared after compile — no lingering children.
    expect(compiledScenes[0].children).toHaveLength(0);
  });
});

/** #154 P4a. `compileAsync` walks its render list object-by-object (node build,
 *  bindings, pipeline, `yieldToMain()`), so its cost scales with the OBJECT count
 *  even when every object compiles the identical cached program. 271 placeholders
 *  for ~15 distinct pairs is what produced a 3926 ms boot stall on a Y6 2019. */
describe('prewarmShadersForWorld — one placeholder per distinct (mesh, material) pair', () => {
  it('collapses many entities sharing a mesh+material into a single placeholder', async () => {
    const { world, sync, Renderable3DPrimitive, createPrimitiveMesh } = await setup({ primitives: true });
    // Count AT compile time (`standardMeshCounts`) — prewarm clears the scene afterwards,
    // so inspecting `compiledScenes[0].children` post-call always reads 0.
    const { renderer, standardMeshCounts } = makeRendererStub();

    for (let i = 0; i < 40; i++) {
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: i, color: i, material: '' }));
    }

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    // Size/colour differ across all 40 — they are uniforms and vertex VALUES, so they
    // cannot change the compiled program and must not split the key.
    expect(standardMeshCounts[0]).toBe(1);
    expect(createPrimitiveMesh).toHaveBeenCalledTimes(1); // the per-entity mint is skipped too
  });

  it('keeps one placeholder per distinct pair — a different material still compiles', async () => {
    const { world, sync, Renderable3DPrimitive } = await setup({ primitives: true });
    const { renderer, standardMeshCounts } = makeRendererStub();

    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: 1, color: 0, material: '' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', size: 1, color: 0, material: 'guid-a' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'sphere', size: 1, color: 0, material: '' }));
    world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'sphere', size: 1, color: 0, material: '' })); // dup

    await sync.prewarmShadersForWorld(world, renderer as never, camera);

    expect(standardMeshCounts[0]).toBe(3);
  });
});

/** #154. The prewarm mirrors `scene.environment` so `compileAsync` produces the envMap PBR
 *  variant. The low tier SUPPRESSES IBL, so mirroring it there would compile a variant the real
 *  render never uses AND leave the first real frame to compile the non-env one synchronously —
 *  reintroducing the very cold-compile stall the mirror exists to prevent (3926 ms on a Y6).
 *  The prewarm must model the scene the tier will actually DRAW. */
describe('prewarmShadersForWorld — the environment mirror follows the TIER', () => {
  const LOW = { tier: 'low', source: 'test', reason: 'test' } as never;
  const HIGH = { tier: 'high', source: 'test', reason: 'test' } as never;

  async function prewarmWithEnv(tier: unknown) {
    const envTexture = { isTexture: true, name: 'fake-hdr' };
    const { world, sync } = await setup({ env: envTexture });
    const { Environment } = await import('../../src/three/traits/Environment');
    const { setActiveQualityTier, setRenderSettings } = await import('../../src/runtime/rendering/renderSettings');
    const { TIER_SETTINGS } = await import('../../src/runtime/rendering/qualityTier');
    // The DEFAULT is now the ABSENCE of clamping (docs/rendering.md § "Quality tiers") — `low` is a
    // no-op unless the project authored something to clamp with, so author it from the seed table to
    // keep exercising the prewarm/tier mirror this describe block is for.
    setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } });
    setActiveQualityTier(tier as never);
    world.spawn(Environment({ hdrPath: 'hdr-guid', intensity: 0.4 }));
    const { renderer, compiledEnvironments } = makeRendererStub();
    await sync.prewarmShadersForWorld(world, renderer as never, camera);
    setActiveQualityTier(null);
    return { compiledEnv: compiledEnvironments[0], envTexture };
  }

  it('mirrors the environment on HIGH — the variant the render will use', async () => {
    const { compiledEnv, envTexture } = await prewarmWithEnv(HIGH);
    expect(compiledEnv).toBe(envTexture);
  });

  it('does NOT mirror it on LOW, where syncEnvironment suppresses IBL', async () => {
    const { compiledEnv } = await prewarmWithEnv(LOW);
    expect(compiledEnv).toBeNull();
  });
});

/** #238 — the boot stall. A shadow-casting light puts a `ShadowNode` into every lit material's
 *  node graph, so a prewarm scene with no armed caster compiles a DIFFERENT pipeline from the one
 *  the first real frame needs; the first frame then builds the real set SYNCHRONOUSLY and the app
 *  freezes. Measured on a Galaxy A23 with `demos/forest-camp`, three cold boots per arm: the worst
 *  rAF gap fell from 1,516 / 1,466 / 1,466 ms to 533 / 650 / 550 ms, and the count of render
 *  pipelines built after the world swap at ~150 ms each fell from 8 to 3.
 *
 *  These assertions are about the prewarm modelling the scene the tier will actually DRAW —
 *  the same contract the environment mirror above is under, and the reason both exist. */
describe('prewarmShadersForWorld — the shadow mirror follows the TIER (#238)', () => {
  async function withCasterCap(max: number, fn: (ctx: Awaited<ReturnType<typeof setup>>) => void) {
    const ctx = await setup({ primitives: true });
    const { setActiveQualityTier, setRenderSettings } = await import('../../src/runtime/rendering/renderSettings');
    setRenderSettings({ three: { tiers: { low: { maxShadowCasters: max } } } } as never);
    setActiveQualityTier({ tier: 'low', source: 'test', reason: 'test' } as never);
    fn(ctx);
    const stub = makeRendererStub();
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);
    setActiveQualityTier(null);
    return stub;
  }

  it('arms castShadow on a casting light, so the lit variant matches the real frame', async () => {
    const { Light } = await import('../../src/three/traits/Light');
    const { compiledLightShadows } = await withCasterCap(0, ({ world }) => {
      world.spawn(Light({ lightType: 'directional', intensity: 1, castShadow: true }));
    });
    expect(compiledLightShadows[0]).toEqual([true]);
  });

  it('leaves a non-casting light alone — it must not compile a shadow variant either', async () => {
    const { Light } = await import('../../src/three/traits/Light');
    const { compiledLightShadows } = await withCasterCap(0, ({ world }) => {
      world.spawn(Light({ lightType: 'directional', intensity: 1, castShadow: false }));
    });
    expect(compiledLightShadows[0]).toEqual([false]);
  });

  it('applies the tier caster CAP, so a demoted light is unarmed here exactly as in syncLights', async () => {
    const { Light } = await import('../../src/three/traits/Light');
    const { compiledLightShadows } = await withCasterCap(1, ({ world }) => {
      world.spawn(Light({ lightType: 'directional', intensity: 0.2, castShadow: true }));
      world.spawn(Light({ lightType: 'directional', intensity: 5, castShadow: true }));
    });
    // The cap keeps the brighter one. Arming BOTH would compile a two-caster variant the tier
    // never draws — the same class of mismatch as mirroring IBL on a tier that suppresses it.
    expect(compiledLightShadows[0]!.filter(Boolean)).toHaveLength(1);
  });

  it('mirrors the authored mesh shadow flags onto the placeholder', async () => {
    const { compiledMeshShadows } = await withCasterCap(0, ({ world, Renderable3DPrimitive }) => {
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', castShadow: 'on', receiveShadow: false }));
    });
    expect(compiledMeshShadows[0]).toEqual([{ cast: true, receive: false }]);
  });

  it('splits the dedupe key on the shadow flags — they are pipeline key, not uniform', async () => {
    const { standardMeshCounts } = await withCasterCap(0, ({ world, Renderable3DPrimitive }) => {
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', material: '', castShadow: 'on', receiveShadow: true }));
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', material: '', castShadow: 'on', receiveShadow: false }));
      world.spawn(Renderable3DPrimitive({ isVisible: true, mesh: 'box', material: '', castShadow: 'on', receiveShadow: true })); // dup
    });
    // Two variants, not one and not three: same (mesh, material) pair, two distinct flag sets.
    // Collapsing them leaves the second for the first real frame to compile — the stall itself.
    expect(standardMeshCounts[0]).toBe(2);
  });
});

/** #238 close-out. The sweep that looked for SIBLINGS of the shadow defect found one in three's
 *  own source: `NodeManager.getCacheKey()` names exactly three scene-global inputs to a render
 *  object's pipeline key — `lightsNode`, `environmentNode`, `fogNode` — and the prewarm mirrored
 *  two. A fogged scene compiled every lit material without fog, and the first real frame rebuilt
 *  the lot. `games/3d-test` is the only project that authors Fog, and it is one of the four
 *  stallers in the #238 table; the magnitude there is NOT measured, only the mechanism. */
describe('prewarmShadersForWorld — the fog mirror (#238 sibling)', () => {
  async function prewarmWithFog(spawn: (ctx: Awaited<ReturnType<typeof setup>>) => void) {
    const ctx = await setup({ primitives: true });
    spawn(ctx);
    const stub = makeRendererStub();
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);
    return stub;
  }

  it('mirrors linear fog, so the compiled variant carries the fog the render will draw', async () => {
    const { Fog } = await import('../../src/three/traits/Fog');
    const { compiledFog } = await prewarmWithFog(({ world }) => {
      world.spawn(Fog({ enabled: true, mode: 'linear', color: 0x223344, near: 1, far: 90 }));
    });
    expect(compiledFog[0]).toEqual({ fog: true, fogNode: false });
  });

  it('mirrors HEIGHT fog through the node path, not the classic one', async () => {
    const { Fog } = await import('../../src/three/traits/Fog');
    const { compiledFog } = await prewarmWithFog(({ world }) => {
      world.spawn(Fog({ enabled: true, mode: 'height', color: 0x223344, density: 0.02, height: 12 }));
    });
    // The two are mutually exclusive in syncFog — a height fog must NOT also leave scene.fog set,
    // or the prewarm compiles a variant with both and the render draws one.
    expect(compiledFog[0]).toEqual({ fog: false, fogNode: true });
  });

  it('mirrors NOTHING when the scene authors no fog — the common case must not gain a variant', async () => {
    const { compiledFog } = await prewarmWithFog(() => {});
    expect(compiledFog[0]).toEqual({ fog: false, fogNode: false });
  });

  it('respects a DISABLED fog entity, exactly as the real syncFog does', async () => {
    const { Fog } = await import('../../src/three/traits/Fog');
    const { compiledFog } = await prewarmWithFog(({ world }) => {
      world.spawn(Fog({ enabled: false, mode: 'linear', color: 0x223344, near: 1, far: 90 }));
    });
    expect(compiledFog[0]).toEqual({ fog: false, fogNode: false });
  });
});

/** #238 — a `THREE.SkinnedMesh` puts a skinning node into the vertex graph, so its pipeline
 *  differs from the plain Mesh the prewarm builds for the same material. The prewarm placed
 *  ZERO rigs, so every rigged character's material was left for the first real frame to build
 *  synchronously — the shadow/fog defect a third time, and the one measured residual on
 *  demos/forest-camp after those two landed. */
describe('prewarmShadersForWorld — the skinned mirror (#238)', () => {
  async function prewarmRig(
    opts: { overrideMaterial?: THREE.Material },
    spawn: (ctx: Awaited<ReturnType<typeof setup>>) => void,
  ) {
    const ctx = await setup({ rig: makeRigPrototype(), ...opts });
    const stub = makeRendererStub();
    spawn(ctx);
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);
    return { ...stub, ...ctx };
  }

  it('places the rig in the compiled scene, so the skinned variant is compiled before the swap', async () => {
    const { compiledSkinned } = await prewarmRig({}, ({ world, SkinnedModel }) => {
      world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
    });
    // The assertion that fails on the old code: it compiled a scene with no SkinnedMesh at all.
    expect(compiledSkinned[0]).toHaveLength(1);
  });

  it('compiles the OVERRIDE material a SkinnedMeshRenderer rebinds, not the baked one', async () => {
    const override = new THREE.MeshStandardMaterial();
    override.name = 'override';
    const { compiledSkinned } = await prewarmRig({ overrideMaterial: override },
      ({ world, SkinnedModel, SkinnedMeshRenderer, EntityAttributes }) => {
        const rig = world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
        world.spawn(
          SkinnedMeshRenderer({ node: 'Ranger', materials: { Ranger_Texture: 'mat-guid' }, visible: true }),
          EntityAttributes({ parentId: rig.id() }),
        );
      });
    // Mirroring the rig WITHOUT its overrides compiles the baked GLB material the render is
    // about to replace — a variant nobody draws, which is the exact failure the mirror exists
    // to prevent rather than a cosmetic difference.
    expect(compiledSkinned[0][0].material).toBe(override);
  });

  it('dedupes two entities sharing a rig, but NOT when their overrides differ', async () => {
    const override = new THREE.MeshStandardMaterial();
    const same = await prewarmRig({}, ({ world, SkinnedModel }) => {
      world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
      world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
    });
    expect(same.compiledSkinned[0]).toHaveLength(1);

    const differing = await prewarmRig({ overrideMaterial: override },
      ({ world, SkinnedModel, SkinnedMeshRenderer, EntityAttributes }) => {
        const a = world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
        const b = world.spawn(SkinnedModel({ model: RIG_REF, isVisible: true }));
        world.spawn(SkinnedMeshRenderer({ node: 'Ranger', materials: { Ranger_Texture: 'mat-a' }, visible: true }),
          EntityAttributes({ parentId: a.id() }));
        world.spawn(SkinnedMeshRenderer({ node: 'Ranger', materials: { Ranger_Texture: 'mat-b' }, visible: true }),
          EntityAttributes({ parentId: b.id() }));
      });
    // Two rigs sharing a model but rebinding different materials are two pipelines, so keying
    // without the overrides would compile whichever entity came first and leave the other for
    // the first real frame — the stall, reintroduced through the dedupe.
    expect(differing.compiledSkinned[0]).toHaveLength(2);
  });

  it('skips a rig whose prototype is not cached rather than throwing', async () => {
    const ctx = await setup({ rig: makeRigPrototype() });
    const stub = makeRendererStub();
    ctx.world.spawn(ctx.SkinnedModel({ model: 'not-the-cached-rig', isVisible: true }));
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);
    expect(stub.compiledSkinned[0]).toHaveLength(0);
    expect(stub.renderer.compileAsync).toHaveBeenCalledTimes(1); // still compiled the F4 placeholder
  });

  it('disposes the clone\'s skeleton but NOT the prototype\'s shared geometry/material', async () => {
    const proto = makeRigPrototype();
    const protoMesh = proto.children[0] as THREE.SkinnedMesh;
    const geoSpy = vi.spyOn(protoMesh.geometry, 'dispose');
    const matSpy = vi.spyOn(protoMesh.material as THREE.Material, 'dispose');
    const ctx = await setup({ rig: proto });
    const stub = makeRendererStub();
    ctx.world.spawn(ctx.SkinnedModel({ model: RIG_REF, isVisible: true }));
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);
    // SkeletonUtils.clone SHARES geometry + material with the prototype, so disposing them
    // here would tear the model out from under every other scene holding it — the whole point
    // of the scene-scoped refcount. Only the Skeleton the clone minted is ours to dispose.
    expect(geoSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
  });
});

/** The F4 guarantee survives the skinned mirror (#238). Mirroring rigs added placeholders to a
 *  scene that previously had none, and F4's condition is "nothing was placed" — so a skinned-only
 *  scene came within one `count++` of losing the plain-material-first guarantee that exists to
 *  stop the NPR MRT pass being the renderer's first compile. */
describe('prewarmShadersForWorld — F4 still holds for a skinned-only scene', () => {
  it('compiles a PLAIN standard mesh even when the only renderable is a rig', async () => {
    const ctx = await setup({ rig: makeRigPrototype() });
    const stub = makeRendererStub();
    ctx.world.spawn(ctx.SkinnedModel({ model: RIG_REF, isVisible: true }));
    await ctx.sync.prewarmShadersForWorld(ctx.world, stub.renderer as never, camera);

    expect(stub.compiledSkinned[0]).toHaveLength(1); // the rig IS mirrored…
    // …and the throwaway plain mesh is STILL there. A rig's material is a MeshStandardMaterial but
    // its program is the skinned variant, and F4 exists because of a lazy init in three's node
    // builder that a NORMAL compile has to prime — so "the rig's material is standard enough"
    // is not a substitution this may quietly make.
    // `standardMeshCounts` is captured AT compile time and filters `scene.children` — a rig hangs
    // its SkinnedMesh under a Group, so this counts exactly the top-level plain meshes, i.e. the
    // F4 placeholder. (Reading `compiledScenes[0].children` here instead would find nothing: the
    // prewarm clears the scene after compiling, which is why every capture in this stub is taken
    // inside `compileAsync`.)
    expect(stub.standardMeshCounts[0]).toBe(1);
  });
});

/** The unresolved-ref tally (#238). The prewarm can only compile what it can resolve, and every
 *  resolution failure here degrades into a plausible-looking object rather than an error — so the
 *  tally is the only thing that can tell "the prewarm modelled the scene" from "the prewarm
 *  compiled defaults the render will never use". It has to survive its own failure path. */
describe('prewarmShadersForWorld — the unresolved-ref tally (#238)', () => {
  it('warns with a count when an authored material ref does not resolve, and does not throw', async () => {
    // `overrideMaterial` unset → the harness's resolveMaterial returns null, which is exactly the
    // silent-degradation path: the primitive keeps the default material createPrimitiveMesh minted.
    const { world, sync, Renderable3DPrimitive } = await setup({ primitives: true });
    const { renderer } = makeRendererStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      world.spawn(Renderable3DPrimitive({ mesh: 'cube', material: 'mat-guid-that-never-resolves', isVisible: true }));
      await sync.prewarmShadersForWorld(world, renderer as never, camera);

      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[prewarm]'));
      expect(line).toBeDefined();
      expect(line).toContain('1 material');
    } finally { warn.mockRestore(); }
  });

  it('stays silent when everything resolves — the warn must mean something', async () => {
    const mat = new THREE.MeshStandardMaterial();
    const { world, sync, Renderable3DPrimitive } = await setup({ primitives: true, overrideMaterial: mat });
    const { renderer } = makeRendererStub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      world.spawn(Renderable3DPrimitive({ mesh: 'cube', material: 'mat-guid', isVisible: true }));
      await sync.prewarmShadersForWorld(world, renderer as never, camera);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[prewarm]'))).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
