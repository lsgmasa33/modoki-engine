/** syncLights lifecycle — create-per-type, type-switch recreate+dispose, reap on
 *  removal, and the F6 orphaned-target regression (runtime-rendering-3d.md Missing
 *  Test #3).
 *
 *  Drives the live `syncLights` against a real koota world + the real Light trait +
 *  a REAL THREE.Scene (needed: `removeLightTarget` gates on `l.target.parent === scene`,
 *  which a mock scene would never set). Only the heavy/GPU sibling imports scene3DSync
 *  pulls at module load are mocked — Light is kept real so `world.query(Light)` and the
 *  trait fields work. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
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
  }));

  const { createWorld } = await import('koota');
  const { Light } = await import('../../src/three/traits/Light');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { world: createWorld(), Light, sync, scene: new THREE.Scene() };
}

/** A full set of world-transform fields for a light at a given position. */
const wt = (x: number, y: number, z: number) => ({ x, y, z, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

describe('syncLights — create per type', () => {
  it('instantiates the matching THREE subclass for each lightType and adds it to the scene', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const a = world.spawn(Light({ lightType: 'ambient', color: 0x111111, intensity: 0.5, isActive: true })).id();
    const d = world.spawn(Light({ lightType: 'directional', color: 0x222222, intensity: 1, isActive: true })).id();
    const p = world.spawn(Light({ lightType: 'point', color: 0x333333, intensity: 2, distance: 10, isActive: true })).id();
    const s = world.spawn(Light({ lightType: 'spot', color: 0x444444, intensity: 3, angle: 0.4, penumbra: 0.2, isActive: true })).id();

    sync.syncLights(world, scene, map);

    expect(map.get(a)).toBeInstanceOf(THREE.AmbientLight);
    expect(map.get(d)).toBeInstanceOf(THREE.DirectionalLight);
    expect(map.get(p)).toBeInstanceOf(THREE.PointLight);
    expect(map.get(s)).toBeInstanceOf(THREE.SpotLight);
    expect((map.get(p) as THREE.PointLight).distance).toBe(10);
    expect((map.get(s) as THREE.SpotLight).angle).toBeCloseTo(0.4);
    // Each light is parented to the scene.
    for (const id of [a, d, p, s]) expect((map.get(id) as THREE.Light).parent).toBe(scene);
  });

  it('re-applies per-frame fields without recreating (idempotent)', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'point', color: 0xff0000, intensity: 1, isActive: true }));

    sync.syncLights(world, scene, map);
    const first = map.get(e.id());

    e.set(Light, { lightType: 'point', color: 0x00ff00, intensity: 4, distance: 0, angle: 0.5, penumbra: 0, castShadow: false, isActive: true });
    sync.syncLights(world, scene, map);

    expect(map.get(e.id())).toBe(first);                       // same instance, not recreated
    expect((first as THREE.PointLight).color.getHex()).toBe(0x00ff00);
    expect((first as THREE.PointLight).intensity).toBe(4);
  });
});

describe('syncLights — type-switch recreate + dispose', () => {
  it('disposes the old light and builds the new subclass when lightType changes', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 1, isActive: true }));

    sync.syncLights(world, scene, map);
    const oldLight = map.get(e.id())!;
    const disposeSpy = vi.spyOn(oldLight, 'dispose');

    e.set(Light, { lightType: 'spot', color: 0xffffff, intensity: 1, distance: 0, angle: 0.5, penumbra: 0, castShadow: false, isActive: true });
    sync.syncLights(world, scene, map);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    const newLight = map.get(e.id())!;
    expect(newLight).not.toBe(oldLight);
    expect(newLight).toBeInstanceOf(THREE.SpotLight);
    expect(oldLight.parent).toBeNull();                        // old removed from scene
    expect(newLight.parent).toBe(scene);
  });
});

describe('syncLights — reap on removal', () => {
  it('removes + disposes the light and clears the map when the entity is deactivated', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const keep = world.spawn(Light({ lightType: 'point', isActive: true })).id();
    const drop = world.spawn(Light({ lightType: 'point', isActive: true })).id();

    sync.syncLights(world, scene, map);
    const dropLight = map.get(drop)!;
    const disposeSpy = vi.spyOn(dropLight, 'dispose');

    deactivatedEntities.add(drop);
    sync.syncLights(world, scene, map);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(dropLight.parent).toBeNull();
    expect(map.has(drop)).toBe(false);
    expect(map.has(keep)).toBe(true);                          // survivor untouched
  });

  it('reaps a light whose entity was destroyed', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'directional', isActive: true }));

    sync.syncLights(world, scene, map);
    const light = map.get(e.id())!;

    e.destroy();
    sync.syncLights(world, scene, map);

    expect(light.parent).toBeNull();
    expect(map.size).toBe(0);
  });
});

describe('syncLights — F6 orphaned-target regression', () => {
  it('removes a spot light\'s target from the scene when the light is reaped (no orphan)', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot', isActive: true }));
    // A world transform makes syncLights add the spot's target to the scene graph.
    worldTransforms.set(e.id(), wt(1, 2, 3));

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;
    expect(spot.target.parent).toBe(scene);                    // target was added to the scene
    expect(scene.children).toContain(spot.target);

    deactivatedEntities.add(e.id());
    sync.syncLights(world, scene, map);

    // The whole point of F6: the target must NOT survive its light.
    expect(spot.target.parent).toBeNull();
    expect(scene.children).not.toContain(spot.target);
  });

  it('removes the old spot target on a spot→ambient type switch', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot', isActive: true }));
    worldTransforms.set(e.id(), wt(0, 5, 0));

    sync.syncLights(world, scene, map);
    const oldSpot = map.get(e.id())! as THREE.SpotLight;
    expect(scene.children).toContain(oldSpot.target);

    e.set(Light, { lightType: 'ambient', color: 0xffffff, intensity: 1, distance: 0, angle: 0.5, penumbra: 0, castShadow: false, isActive: true });
    sync.syncLights(world, scene, map);

    expect(map.get(e.id())).toBeInstanceOf(THREE.AmbientLight);
    expect(scene.children).not.toContain(oldSpot.target);      // stray target reaped on switch
  });
});
