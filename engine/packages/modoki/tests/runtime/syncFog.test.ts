/** syncFog — first-entity-wins fog sync. Mirrors syncLights.test.ts's setup:
 *  drives the live `syncFog` against a real koota world + the real Fog trait + a
 *  REAL THREE.Scene, mocking only the heavy/GPU sibling imports scene3DSync pulls
 *  in at module load (`three/tsl` is aliased package-wide to
 *  `tests/stubs/three-tsl.ts` — see vitest.config.ts).
 *
 *  Hybrid mechanism under test:
 *  - `linear`/`exponential` target the classic `scene.fog` (THREE.Fog/FogExp2)
 *    object, NOT a hand-built `scene.fogNode` — three's WebGPURenderer/NodeManager
 *    auto-converts `scene.fog` into the equivalent TSL node graph each render
 *    (NodeMaterial.fog defaults to true), refreshing color/near/far/density via
 *    `reference()` nodes that re-read the object's properties every frame. So a
 *    value-only change just needs to mutate the SAME Fog/FogExp2 instance; only a
 *    mode switch needs a new object.
 *  - `height` has no classic-object equivalent, so it targets `scene.fogNode`
 *    directly. A STABLE node identity there is a correctness requirement, not an
 *    optimization (see scene3DSync.ts's `HeightFogState` docblock) — the node's
 *    instance id feeds the render-object's shader cache key, so rebuilding it
 *    every frame would recompile every affected shader every frame. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

// koota caps live worlds at 16 (WORLD_ID_BITS) and `createWorld()` throws past
// that. This file's per-test `setup()` creates a fresh world every time (20+
// tests), so each one must be released — otherwise the run fails partway
// through with "Koota: Too many worlds created."
let liveWorld: { destroy(): void } | null = null;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
});

afterEach(() => {
  liveWorld?.destroy();
  liveWorld = null;
});

async function setup() {
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
    getKTX2Loader: vi.fn(), getEnvFormat: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const { Fog } = await import('../../src/three/traits/Fog');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const world = createWorld();
  liveWorld = world;
  return { world, Fog, sync, scene: new THREE.Scene() };
}

describe('syncFog', () => {
  it('leaves scene.fog unset with no Fog entity', async () => {
    const { world, sync, scene } = await setup();
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
  });

  it('leaves scene.fog unset when the only Fog entity is disabled', async () => {
    const { world, Fog, sync, scene } = await setup();
    world.spawn(Fog({ enabled: false }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
  });

  it('creates a THREE.Fog for an enabled linear entity, with near/far/color applied', async () => {
    const { world, Fog, sync, scene } = await setup();
    world.spawn(Fog({ enabled: true, mode: 'linear', near: 5, far: 50, color: 0x112233 }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    const fog = scene.fog as THREE.Fog;
    expect(fog.near).toBe(5);
    expect(fog.far).toBe(50);
    expect(fog.color.getHex()).toBe(0x112233);
  });

  it('creates a THREE.FogExp2 for an enabled exponential entity, with density/color applied', async () => {
    const { world, Fog, sync, scene } = await setup();
    world.spawn(Fog({ enabled: true, mode: 'exponential', density: 0.3, color: 0x445566 }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
    const fog = scene.fog as THREE.FogExp2;
    expect(fog.density).toBe(0.3);
    expect(fog.color.getHex()).toBe(0x445566);
  });

  it('rebuilds a new fog object when mode switches linear -> exponential', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'linear', near: 5, far: 50 }));
    sync.syncFog(world, scene);
    const first = scene.fog;
    expect(first).toBeInstanceOf(THREE.Fog);

    e.set(Fog, { mode: 'exponential' });
    sync.syncFog(world, scene);
    expect(scene.fog).not.toBe(first);
    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
  });

  it('updates near/far/color in place without rebuilding the fog object', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'linear', near: 5, far: 50, color: 0x112233 }));
    sync.syncFog(world, scene);
    const first = scene.fog;
    expect(first).not.toBeNull();

    e.set(Fog, { near: 20, far: 80, color: 0x445566 });
    sync.syncFog(world, scene);
    expect(scene.fog).toBe(first); // same object identity — no rebuild
    const fog = scene.fog as THREE.Fog;
    expect(fog.near).toBe(20);
    expect(fog.far).toBe(80);
    expect(fog.color.getHex()).toBe(0x445566);
  });

  it('updates density in place without rebuilding the fog object (exponential)', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'exponential', density: 0.1 }));
    sync.syncFog(world, scene);
    const first = scene.fog;

    e.set(Fog, { density: 0.4 });
    sync.syncFog(world, scene);
    expect(scene.fog).toBe(first);
    expect((scene.fog as THREE.FogExp2).density).toBe(0.4);
  });

  it('clears scene.fog back to null when the entity is deactivated', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'linear' }));
    sync.syncFog(world, scene);
    expect(scene.fog).not.toBeNull();

    deactivatedEntities.add(e.id());
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
  });

  it('clears scene.fog back to null when no entities remain enabled', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'linear' }));
    sync.syncFog(world, scene);
    expect(scene.fog).not.toBeNull();

    e.set(Fog, { enabled: false });
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
  });

  it('first entity wins when multiple Fog entities are enabled', async () => {
    const { world, Fog, sync, scene } = await setup();
    world.spawn(Fog({ enabled: true, mode: 'linear', near: 1, far: 2 }));
    world.spawn(Fog({ enabled: true, mode: 'exponential', density: 0.5 }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeInstanceOf(THREE.Fog); // the FIRST entity's mode wins
    const first = scene.fog;
    sync.syncFog(world, scene);
    expect(scene.fog).toBe(first); // stable across repeated calls
  });

  it('does not cross-contaminate two independent THREE.Scene instances', async () => {
    const { world, Fog, sync, scene } = await setup();
    const otherScene = new THREE.Scene();
    world.spawn(Fog({ enabled: true, mode: 'linear', near: 1, far: 2 }));
    sync.syncFog(world, scene);
    sync.syncFog(world, otherScene);
    expect(scene.fog).not.toBeNull();
    expect(otherScene.fog).not.toBeNull();
    expect(scene.fog).not.toBe(otherScene.fog); // each scene owns its own Fog object
  });
});

describe('syncFog — height mode', () => {
  it('sets scene.fogNode (not scene.fog) for an enabled height entity, with density/height/color wired through', async () => {
    const { world, Fog, sync, scene } = await setup();
    world.spawn(Fog({ enabled: true, mode: 'height', density: 0.3, height: 4, color: 0x778899 }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeTruthy();
    const node = scene.fogNode as unknown as { __color: { value: THREE.Color }; __factor: { __density: { value: number }; __height: { value: number } } };
    expect(node.__color.value.getHex()).toBe(0x778899);
    expect(node.__factor.__density.value).toBe(0.3);
    expect(node.__factor.__height.value).toBe(4);
  });

  it('updates density/height/color in place without rebuilding the fogNode identity', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'height', density: 0.1, height: 2, color: 0x112233 }));
    sync.syncFog(world, scene);
    const first = scene.fogNode;
    expect(first).toBeTruthy();

    e.set(Fog, { density: 0.5, height: 8, color: 0x445566 });
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBe(first); // same node identity — no shader recompile
    const node = scene.fogNode as unknown as { __color: { value: THREE.Color }; __factor: { __density: { value: number }; __height: { value: number } } };
    expect(node.__color.value.getHex()).toBe(0x445566);
    expect(node.__factor.__density.value).toBe(0.5);
    expect(node.__factor.__height.value).toBe(8);
  });

  it('height -> linear: fogNode nulled, scene.fog is a THREE.Fog', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'height' }));
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeTruthy();

    e.set(Fog, { mode: 'linear', near: 3, far: 30 });
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeNull();
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
  });

  it('linear -> height: scene.fog nulled, fogNode set', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'linear', near: 3, far: 30 }));
    sync.syncFog(world, scene);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);

    e.set(Fog, { mode: 'height' });
    sync.syncFog(world, scene);
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeTruthy();
  });

  it('height -> linear -> height reuses the SAME fogNode instance (no churn)', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'height' }));
    sync.syncFog(world, scene);
    const first = scene.fogNode;

    e.set(Fog, { mode: 'linear' });
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeNull();

    e.set(Fog, { mode: 'height' });
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBe(first); // per-scene WeakMap cache, not rebuilt
  });

  it('disabling while in height mode clears scene.fogNode', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'height' }));
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeTruthy();

    e.set(Fog, { enabled: false });
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeNull();
    expect(scene.fog).toBeNull();
  });

  it('deactivating the entity while in height mode clears scene.fogNode', async () => {
    const { world, Fog, sync, scene } = await setup();
    const e = world.spawn(Fog({ enabled: true, mode: 'height' }));
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeTruthy();

    deactivatedEntities.add(e.id());
    sync.syncFog(world, scene);
    expect(scene.fogNode).toBeNull();
  });

  it('gives two independent THREE.Scene instances distinct fogNode identities', async () => {
    const { world, Fog, sync, scene } = await setup();
    const otherScene = new THREE.Scene();
    world.spawn(Fog({ enabled: true, mode: 'height' }));
    sync.syncFog(world, scene);
    sync.syncFog(world, otherScene);
    expect(scene.fogNode).toBeTruthy();
    expect(otherScene.fogNode).toBeTruthy();
    expect(scene.fogNode).not.toBe(otherScene.fogNode);
  });

  // ROOT-CAUSE REGRESSION (live-reproduced: a fog color edit updated `.value` but
  // never reached the screen on STATIC geometry — the editor grid, unmoving terrain
  // — while animated objects updated fine).
  //
  // A bare `uniform()` defaults to `objectGroup`: a PER-RENDER-OBJECT uniform buffer,
  // only re-uploaded inside `Bindings.updateForRender(renderObject)`, which `Renderer`
  // calls ONLY when `NodeMaterialObserver.needsRefresh(renderObject)` is true. For a
  // static mesh with a plain (non-node) material that is false forever, because the
  // observer only watches MATERIAL properties + world matrix + geometry — and fog is
  // scene-global, so none of those ever change.
  //
  // `renderGroup` is a SHARED group (shared:true, updateType:RENDER): one bind group
  // shared by every material referencing these nodes, re-uploaded once per render
  // call, so it cannot go per-object stale. Three's own `NodeManager.updateFog()`
  // does exactly this for the classic `scene.fog` path — which is why linear/
  // exponential fog never had the bug. Guard it so nobody "simplifies" the
  // `.setGroup(renderGroup)` calls away.
  it('puts every height-fog uniform in renderGroup, NOT the default per-object group', async () => {
    const { world, Fog, sync, scene } = await setup();
    const tsl = await import('three/tsl');
    world.spawn(Fog({ enabled: true, mode: 'height', color: 0x112233, density: 0.1, height: 2 }));
    sync.syncFog(world, scene);

    const node = scene.fogNode as unknown as {
      __color: { __group: unknown };
      __factor: { __density: { __group: unknown }; __height: { __group: unknown } };
    };
    expect(node.__color.__group).toBe(tsl.renderGroup);
    expect(node.__factor.__density.__group).toBe(tsl.renderGroup);
    expect(node.__factor.__height.__group).toBe(tsl.renderGroup);
    expect(node.__color.__group).not.toBe(tsl.objectGroup);
  });
});

describe('syncFog — integration with syncEnvironment + syncLights', () => {
  it('composes with the rest of the per-frame 3D sync without clobbering each other', async () => {
    const { world, Fog, sync, scene } = await setup();
    const { Environment } = await import('../../src/three/traits/Environment');
    const { Light } = await import('../../src/three/traits/Light');

    world.spawn(Fog({ enabled: true, mode: 'linear', near: 5, far: 50 }));
    world.spawn(Environment({ hdrPath: '' })); // no hdrPath: exercises the "active but unloaded" branch
    world.spawn(Light({ lightType: 'ambient', color: 0x223344, intensity: 0.5, isActive: true }));
    const ecsLights = new Map<number, THREE.Light>();

    // Same order Scene3D.tsx/SceneView.tsx call these each frame.
    sync.syncEnvironment(world, scene);
    sync.syncFog(world, scene);
    sync.syncLights(world, scene, ecsLights);

    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    expect((scene.fog as THREE.Fog).near).toBe(5);
    expect(ecsLights.size).toBe(1);
    expect(scene.children).toContain(ecsLights.get([...ecsLights.keys()][0])!);
  });
});
