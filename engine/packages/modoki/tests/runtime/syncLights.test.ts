/** syncLights lifecycle — create-per-type, type-switch recreate+dispose, reap on
 *  removal, and the F6 orphaned-target regression (runtime-rendering-3d.md Missing
 *  Test #3).
 *
 *  Drives the live `syncLights` against a real koota world + the real Light trait +
 *  a REAL THREE.Scene (needed: `removeLightTarget` gates on `l.target.parent === scene`,
 *  which a mock scene would never set). Only the heavy/GPU sibling imports scene3DSync
 *  pulls at module load are mocked — Light is kept real so `world.query(Light)` and the
 *  trait fields work. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

// koota caps a process at 16 live worlds, and every `setup()` mints one. Releasing them
// per test keeps that a non-issue as the file grows — without this, ADDING a test to the
// end of the file makes unrelated ones fail with "Too many worlds created".
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

async function setup() {
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    // syncEnvironment sweeps retired envs (#315) — a mock without these throws on every call.
    retiredEnvironments: () => new Set(), disposeRetiredEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
  }));

  const { createWorld } = await import('koota');
  const { Light } = await import('../../src/three/traits/Light');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const world = createWorld();
  _worlds.push(world);
  return { world, Light, sync, scene: new THREE.Scene() };
}

/** A full set of world-transform fields for a light at a given position. */
const wt = (x: number, y: number, z: number) => ({ x, y, z, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

describe('syncLights — create per type', () => {
  it('instantiates the matching THREE subclass for each lightType and adds it to the scene', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const a = world.spawn(Light({ lightType: 'ambient', color: 0x111111, intensity: 0.5 })).id();
    const d = world.spawn(Light({ lightType: 'directional', color: 0x222222, intensity: 1 })).id();
    const p = world.spawn(Light({ lightType: 'point', color: 0x333333, intensity: 2, distance: 10 })).id();
    const s = world.spawn(Light({ lightType: 'spot', color: 0x444444, intensity: 3, angle: 0.4, penumbra: 0.2 })).id();

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
    const e = world.spawn(Light({ lightType: 'point', color: 0xff0000, intensity: 1 }));

    sync.syncLights(world, scene, map);
    const first = map.get(e.id());

    e.set(Light, { lightType: 'point', color: 0x00ff00, intensity: 4, distance: 0, angle: 0.5, penumbra: 0, castShadow: false });
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
    const e = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 1 }));

    sync.syncLights(world, scene, map);
    const oldLight = map.get(e.id())!;
    const disposeSpy = vi.spyOn(oldLight, 'dispose');

    e.set(Light, { lightType: 'spot', color: 0xffffff, intensity: 1, distance: 0, angle: 0.5, penumbra: 0, castShadow: false });
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
    const keep = world.spawn(Light({ lightType: 'point' })).id();
    const drop = world.spawn(Light({ lightType: 'point' })).id();

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
    const e = world.spawn(Light({ lightType: 'directional' }));

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
    const e = world.spawn(Light({ lightType: 'spot' }));
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
    const e = world.spawn(Light({ lightType: 'spot' }));
    worldTransforms.set(e.id(), wt(0, 5, 0));

    sync.syncLights(world, scene, map);
    const oldSpot = map.get(e.id())! as THREE.SpotLight;
    expect(scene.children).toContain(oldSpot.target);

    e.set(Light, { lightType: 'ambient', color: 0xffffff, intensity: 1, distance: 0, angle: 0.5, penumbra: 0, castShadow: false });
    sync.syncLights(world, scene, map);

    expect(map.get(e.id())).toBeInstanceOf(THREE.AmbientLight);
    expect(scene.children).not.toContain(oldSpot.target);      // stray target reaped on switch
  });
});

describe('syncLights — aim uses the renderer\'s euler order (XYZ)', () => {
  /** A pose where the two candidate orders genuinely DISAGREE. This matters: the old
   *  hand-rolled formula was YXZ (Ry·Rx) while `applyTransform` orients every other object
   *  with three's default XYZ, so the same authored euler meant two different orientations.
   *  The bug hid for a long time because the orders AGREE whenever `ry ≈ 0`, which is true
   *  of most authored spots — so a test at `ry = 0` would have passed either way and proved
   *  nothing. Both angles must be non-zero here. */
  const RX = -0.6;
  const RY = 1.2;

  it('aims a spot light along its XYZ-euler forward, not the legacy YXZ one', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot' }));
    worldTransforms.set(e.id(), { ...wt(0, 5, 0), rx: RX, ry: RY });

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;

    // Expected: three's own transform of -Z by an XYZ euler — the same operation
    // `obj.rotation.set(rx, ry, rz)` performs for meshes and cameras.
    const expected = new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(RX, RY, 0))
      .add(new THREE.Vector3(0, 5, 0));
    expect(spot.target.position.x).toBeCloseTo(expected.x, 6);
    expect(spot.target.position.y).toBeCloseTo(expected.y, 6);
    expect(spot.target.position.z).toBeCloseTo(expected.z, 6);

    // And it must NOT be the legacy YXZ result, or this test is vacuous.
    const legacyY = 5 + Math.sin(RX);
    expect(Math.abs(spot.target.position.y - legacyY)).toBeGreaterThan(0.05);
  });

  it('matches the orientation a mesh with the same euler would take', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'directional' }));
    worldTransforms.set(e.id(), { ...wt(0, 0, 0), rx: RX, ry: RY });

    sync.syncLights(world, scene, map);
    const dir = map.get(e.id())! as THREE.DirectionalLight;

    // A plain Object3D given the SAME euler — the mesh/camera path (applyTransform).
    const proxy = new THREE.Object3D();
    proxy.rotation.set(RX, RY, 0);
    proxy.updateMatrixWorld(true);
    const meshForward = new THREE.Vector3(0, 0, -1).applyQuaternion(proxy.quaternion);

    // One authored euler must mean ONE orientation, light or mesh.
    expect(dir.target.position.x).toBeCloseTo(meshForward.x, 6);
    expect(dir.target.position.y).toBeCloseTo(meshForward.y, 6);
    expect(dir.target.position.z).toBeCloseTo(meshForward.z, 6);
  });

  it('ignores roll — rotating about Z cannot change the -Z forward', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot' }));
    worldTransforms.set(e.id(), { ...wt(0, 0, 0), rx: RX, ry: RY, rz: 0.9 });

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;
    const noRoll = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(RX, RY, 0));
    expect(spot.target.position.x).toBeCloseTo(noRoll.x, 6);
    expect(spot.target.position.y).toBeCloseTo(noRoll.y, 6);
    expect(spot.target.position.z).toBeCloseTo(noRoll.z, 6);
  });
});

describe('syncLights — authored Light.target* aim', () => {
  /** The fields were declared, shown in the Inspector, and written into prefab defaults, but
   *  NOTHING read them: a spot authored with correct target coordinates and rotation (0,0,0)
   *  fired horizontally down -Z and appeared to do nothing. These pin BOTH directions of the
   *  fix, because the fallback is what keeps every pre-existing scene (all of which serialize
   *  0,0,0) aiming exactly as before. */
  const target = { targetX: -3, targetY: 1.5, targetZ: -8 };
  // A rotation the fallback cases aim by (same "the two euler orders disagree" pose as above).
  const RX = -0.6;
  const RY = 1.2;

  it('aims a spot at the authored target in WORLD space, ignoring rotation', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot', ...target }));
    // A rotation that would aim somewhere else entirely — the target must win.
    worldTransforms.set(e.id(), { ...wt(2, 4, 1), rx: -0.6, ry: 1.2 });

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;

    // Absolute world coordinates — NOT offset from the light's position.
    expect(spot.target.position.x).toBeCloseTo(target.targetX, 6);
    expect(spot.target.position.y).toBeCloseTo(target.targetY, 6);
    expect(spot.target.position.z).toBeCloseTo(target.targetZ, 6);
    expect(scene.children).toContain(spot.target);
  });

  it('aims a directional light at the authored target too', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'directional', ...target }));
    worldTransforms.set(e.id(), wt(0, 10, 0));

    sync.syncLights(world, scene, map);
    const dir = map.get(e.id())! as THREE.DirectionalLight;

    expect(dir.target.position.x).toBeCloseTo(target.targetX, 6);
    expect(dir.target.position.y).toBeCloseTo(target.targetY, 6);
    expect(dir.target.position.z).toBeCloseTo(target.targetZ, 6);
  });

  it('treats an ALL-ZERO target as unset and falls back to the euler forward', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    // targetX/Y/Z default to 0 — exactly what every scene authored before the fix serializes.
    const e = world.spawn(Light({ lightType: 'spot' }));
    worldTransforms.set(e.id(), { ...wt(0, 5, 0), rx: RX, ry: RY });

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;

    const expected = new THREE.Vector3(0, 0, -1)
      .applyEuler(new THREE.Euler(RX, RY, 0))
      .add(new THREE.Vector3(0, 5, 0));
    expect(spot.target.position.x).toBeCloseTo(expected.x, 6);
    expect(spot.target.position.y).toBeCloseTo(expected.y, 6);
    expect(spot.target.position.z).toBeCloseTo(expected.z, 6);
    // And NOT the origin, which is what "all-zero means aim at (0,0,0)" would have given.
    expect(spot.target.position.length()).toBeGreaterThan(0.1);
  });

  it('a SINGLE non-zero axis is enough to count as set', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot', targetY: 2 }));
    worldTransforms.set(e.id(), { ...wt(0, 5, 0), rx: RX, ry: RY });

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;

    expect(spot.target.position.x).toBeCloseTo(0, 6);
    expect(spot.target.position.y).toBeCloseTo(2, 6);
    expect(spot.target.position.z).toBeCloseTo(0, 6);
  });

  it('follows a live target edit without recreating the light', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const e = world.spawn(Light({ lightType: 'spot', targetX: 1 }));
    worldTransforms.set(e.id(), wt(0, 5, 0));

    sync.syncLights(world, scene, map);
    const spot = map.get(e.id())! as THREE.SpotLight;

    e.set(Light, { lightType: 'spot', color: 0xffffff, intensity: 1, targetX: 1, targetY: 0, targetZ: -9, distance: 0, angle: 0.5, penumbra: 0, castShadow: false });
    sync.syncLights(world, scene, map);

    expect(map.get(e.id())).toBe(spot);                        // same instance
    expect(spot.target.position.z).toBeCloseTo(-9, 6);
  });
});

// ── The IBL-off compensation is gated on ACTUAL suppression, not on the tier (#154) ──
//
// A tier CLAMPS, never RAISES. Suppression is conditional — the tier says no IBL AND the scene
// owns a loaded HDR `Environment` to lose — so the compensation has to carry the same condition.
// Keying it on the tier alone brightened every low-tier scene with an AmbientLight and no
// environment (several shipped demos), and since an unrecognised device resolves `low`, that
// meant every phone. These pin BOTH directions; the boost-applies case is what stops the fix
// from being "delete the compensation".

describe('syncLights — IBL-off ambient compensation', () => {
  /** Same as setup(), but with a loaded HDR in the environment cache so an `Environment`
   *  entity actually reaches syncEnvironment's suppression branch. */
  async function setupWithEnvCache() {
    vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
      worldTransforms, deactivatedEntities, transformPropagationSystem: {},
    }));
    vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
      resolveMeshTemplate: vi.fn(), resolveMeshLodInfo: vi.fn(() => null),
      resolveMaterialForMesh: vi.fn(() => null), resolveMaterial: vi.fn(),
      getCachedEnvironment: vi.fn(() => ({ isTexture: true })), acquireEnvironment: vi.fn(),
      // syncEnvironment sweeps retired envs (#315) — a mock without these throws on every call.
      retiredEnvironments: () => new Set(), disposeRetiredEnvironment: vi.fn(),
    }));
    vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
    vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: vi.fn(() => false) }));
    vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
      loadTexture3D: vi.fn(async () => ({})), releaseTexture3D: vi.fn(), setActiveRenderer: vi.fn(),
      getEnvFormat: vi.fn(() => undefined),   // unregistered path → no UltraHDR boost
    }));

    const { createWorld } = await import('koota');
    const { Light } = await import('../../src/three/traits/Light');
    const { Environment } = await import('../../src/three/traits/Environment');
    const settings = await import('../../src/runtime/rendering/renderSettings');
    const { TIER_SETTINGS } = await import('../../src/runtime/rendering/qualityTier');
    const sync = await import('../../src/runtime/rendering/scene3DSync');
    // The DEFAULT is now the ABSENCE of clamping (docs/rendering.md § "Quality tiers") — `low` is a
    // no-op (IBL stays ON) unless the project authored something to clamp with, so author it from the
    // seed table to keep exercising the IBL-off compensation this describe block is for.
    settings.setRenderSettings({ three: { tiers: { low: TIER_SETTINGS.low } } });
    settings.setActiveQualityTier({ tier: 'low', source: 'measured', reason: 'test' });
    return { world: createWorld(), Light, Environment, sync, settings, TIER_SETTINGS, scene: new THREE.Scene() };
  }

  it('leaves ambient UNTOUCHED on the low tier when the scene has no Environment to lose', async () => {
    const { world, Light, sync, settings, scene } = await setupWithEnvCache();
    try {
      const map = new Map<number, THREE.Light>();
      const e = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 0.5 }));

      sync.syncEnvironment(world, scene);   // no Environment entity → nothing suppressed
      expect(sync.isIblSuppressed()).toBe(false);
      sync.syncLights(world, scene, map);

      // The authored value, NOT authored × iblOffAmbientBoost.
      expect((map.get(e.id()) as THREE.AmbientLight).intensity).toBeCloseTo(0.5, 6);
    } finally {
      settings.setActiveQualityTier(null);
      world.destroy();  // koota caps at 16 live worlds; this describe adds four more
    }
  });

  it('boosts ambient on the low tier when an Environment WAS suppressed', async () => {
    const { world, Light, Environment, sync, settings, TIER_SETTINGS, scene } = await setupWithEnvCache();
    try {
      const map = new Map<number, THREE.Light>();
      const e = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 0.5 }));
      world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 1 }));

      sync.syncEnvironment(world, scene);
      expect(sync.isIblSuppressed()).toBe(true);
      expect(scene.environment).toBe(null);  // the thing being compensated for
      sync.syncLights(world, scene, map);

      expect((map.get(e.id()) as THREE.AmbientLight).intensity)
        .toBeCloseTo(0.5 * TIER_SETTINGS.low.iblOffAmbientBoost, 6);
    } finally {
      settings.setActiveQualityTier(null);
      world.destroy();  // koota caps at 16 live worlds; this describe adds four more
    }
  });

  it('drops the boost again on the frame the Environment goes away', async () => {
    const { world, Light, Environment, sync, settings, scene } = await setupWithEnvCache();
    try {
      const map = new Map<number, THREE.Light>();
      const e = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 0.5 }));
      const env = world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 1 }));
      sync.syncEnvironment(world, scene);
      sync.syncLights(world, scene, map);

      env.destroy();                        // scene swap into a scene with no environment
      sync.syncEnvironment(world, scene);
      expect(sync.isIblSuppressed()).toBe(false);
      sync.syncLights(world, scene, map);

      expect((map.get(e.id()) as THREE.AmbientLight).intensity).toBeCloseTo(0.5, 6);
    } finally {
      settings.setActiveQualityTier(null);
      world.destroy();  // koota caps at 16 live worlds; this describe adds four more
    }
  });

  it('applyRendererColorConfig leaves the AUTHORED exposure — the compensation is not baked in', async () => {
    // It also serves the asset-preview renderers (ModelPreview, previewScene), which never sync
    // an Environment and so can never reconcile the flag back. Baking the boost in at renderer
    // construction meant a material thumbnail rendered 1.25x brighter because a game panel
    // elsewhere had set the module flag — a surface inheriting a compensation it cannot own.
    const { world, Environment, sync, settings, scene } = await setupWithEnvCache();
    try {
      const base = settings.getRenderSettings().three.exposure;
      world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 1 }));
      sync.syncEnvironment(world, scene);
      expect(sync.isIblSuppressed()).toBe(true);           // flag is set…

      const preview = { toneMapping: 0 as never, toneMappingExposure: 0, outputColorSpace: '' };
      sync.applyRendererColorConfig(preview);
      expect(preview.toneMappingExposure).toBeCloseTo(base, 6);   // …and this surface ignores it
    } finally {
      settings.setActiveQualityTier(null);
      world.destroy();
    }
  });

  it('reconcileToneExposure carries the SAME predicate as the ambient boost', async () => {
    const { world, Environment, sync, settings, TIER_SETTINGS, scene } = await setupWithEnvCache();
    try {
      const base = settings.getRenderSettings().three.exposure;
      const r = { toneMappingExposure: 0 };

      sync.syncEnvironment(world, scene);   // no Environment
      sync.reconcileToneExposure(r);
      expect(r.toneMappingExposure).toBeCloseTo(base, 6);

      world.spawn(Environment({ hdrPath: '/sky.hdr', intensity: 1 }));
      sync.syncEnvironment(world, scene);
      sync.reconcileToneExposure(r);
      expect(r.toneMappingExposure).toBeCloseTo(base * TIER_SETTINGS.low.iblOffExposure, 6);
    } finally {
      settings.setActiveQualityTier(null);
      world.destroy();  // koota caps at 16 live worlds; this describe adds four more
    }
  });
});

// ── Shadow follow (#183) ──────────────────────────────────────────────────────
//
// A directional shadow box anchored at the light's authored position covers a fixed
// patch of ground, so a subject that walks off it loses its shadow (measured in
// demos/forest-camp: gone after 9 m). The box now recentres — on an authored follow
// TARGET when there is one, else on the view focus the caller supplies.
//
// The cases worth pinning are the FALLBACKS, because each one fails silently: a stale
// guid that centred the box at the world origin would put every shadow in the scene in
// the wrong place, and nothing would throw.
describe('syncLights — shadow follow target', () => {
  const dirLight = (over: Record<string, unknown> = {}) => ({
    lightType: 'directional' as const, color: 0xffffff, intensity: 1, castShadow: true,
    targetX: 0, targetY: -1, targetZ: 0, shadowFollowCamera: true, ...over,
  });

  it('centres the shadow box on the authored follow target, not the view focus', async () => {
    const { world, Light, sync, scene } = await setup();
    const { EntityAttributes } = await import('../../src/runtime/traits');
    const map = new Map<number, THREE.Light>();
    const subject = world.spawn(EntityAttributes({ guid: 'subject-guid' }));
    worldTransforms.set(subject.id(), wt(20, 0, -12));
    const lid = world.spawn(Light(dirLight({ shadowFollowTarget: 'subject-guid' }))).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map, { x: -100, y: 0, z: -100 }); // view focus far away

    const l = map.get(lid) as THREE.DirectionalLight;
    // Snapped to a shadow texel, so assert with a tolerance, never ===.
    expect(l.target.position.x).toBeCloseTo(20, 0);
    expect(l.target.position.z).toBeCloseTo(-12, 0);
  });

  it('falls back to the view focus when the target guid no longer resolves', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const lid = world.spawn(Light(dirLight({ shadowFollowTarget: 'deleted-entity' }))).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map, { x: 7, y: 0, z: -3 });

    const l = map.get(lid) as THREE.DirectionalLight;
    // The failure this guards: a stale guid resolving to nothing and centring on (0,0,0),
    // which silently relocates every shadow in the scene.
    expect(l.target.position.x).toBeCloseTo(7, 0);
    expect(l.target.position.z).toBeCloseTo(-3, 0);
  });

  it('leaves the box at the authored position when shadowFollowCamera is off', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const lid = world.spawn(Light(dirLight({ shadowFollowCamera: false }))).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map, { x: 40, y: 0, z: 40 });

    const l = map.get(lid) as THREE.DirectionalLight;
    expect(l.position.x).toBeCloseTo(5, 5);   // untouched by the follow logic
    expect(l.position.y).toBeCloseTo(10, 5);
    expect(l.position.z).toBeCloseTo(4, 5);
  });

  it('keeps the focus inside the shadow camera depth range for a scene-scale box', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    // An outdoor level legitimately authors a big ortho box. The follow pulls the camera back by
    // shadowCameraSize*2+10, so at 100 the focus sits 210 away while `far` was a flat 200 — the
    // whole scene falls outside the depth range and every shadow from this light vanishes, with
    // nothing thrown. `shadowFollowCamera` defaults ON, so this would hit such a scene unasked.
    const lid = world.spawn(Light(dirLight({ shadowCameraSize: 100 }))).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map, { x: 0, y: 0, z: 0 });

    const l = map.get(lid) as THREE.DirectionalLight;
    const depth = l.position.distanceTo(l.target.position);
    expect(depth).toBeGreaterThan(l.shadow.camera.near);
    expect(depth).toBeLessThan(l.shadow.camera.far);
  });

  it('leaves the authored far plane alone for an ordinary box size', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const lid = world.spawn(Light(dirLight({ shadowCameraSize: 16 }))).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map, { x: 0, y: 0, z: 0 });

    // Widened only when the pull-back needs it — the common case keeps its authored depth,
    // so the fix can't quietly cost precision everywhere by inflating the range.
    expect((map.get(lid) as THREE.DirectionalLight).shadow.camera.far).toBe(200);
  });

  it('preserves the authored light DIRECTION while moving the box', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const lid = world.spawn(Light(dirLight())).id();
    worldTransforms.set(lid, wt(5, 10, 4));

    sync.syncLights(world, scene, map);                       // no focus → authored placement
    const l = map.get(lid) as THREE.DirectionalLight;
    const authored = new THREE.Vector3().subVectors(l.target.position, l.position).normalize();

    sync.syncLights(world, scene, map, { x: 30, y: 0, z: -25 }); // now follow, far from authored
    const followed = new THREE.Vector3().subVectors(l.target.position, l.position).normalize();

    // Only the shadow camera may move. A directional light's shading depends solely on
    // direction, so this is what makes moving its position safe.
    expect(followed.x).toBeCloseTo(authored.x, 5);
    expect(followed.y).toBeCloseTo(authored.y, 5);
    expect(followed.z).toBeCloseTo(authored.z, 5);
  });
});

describe('syncLights — the tier shadow-caster cap (#229)', () => {
  /** Author a `mid` tier whose ONLY departure from unclamped is the caster cap, and make it
   *  active. Isolating the one field matters: `TIER_SETTINGS.mid` also switches AA and DPR, and a
   *  test that swallowed the whole row could not say which knob produced the result. */
  async function capAt(max: number) {
    const rs = await import('../../src/runtime/rendering/renderSettings');
    const { UNCLAMPED_OVERRIDES } = await import('../../src/runtime/rendering/qualityTier');
    rs.resetRenderSettings();
    rs.setRenderSettings({ three: { tiers: { mid: { ...UNCLAMPED_OVERRIDES, maxShadowCasters: max } } } });
    rs.setActiveQualityTier({ tier: 'mid', source: 'project', reason: 'test' });
    return rs;
  }

  /** A casting spot by default; `over` can switch the type or the intensity. `as const` on the
   *  literal keeps `lightType` a union rather than widening to `string`, which the Light trait's
   *  schema rejects. */
  const casting = (over: { intensity: number; lightType?: 'spot' | 'directional' | 'point' }) => ({
    lightType: 'spot' as const, color: 0xffffff, angle: 0.5, penumbra: 0.1, castShadow: true, ...over,
  });

  it('lets every caster render its map when no tier clamps — the unchanged default', async () => {
    const { world, Light, sync, scene } = await setup();
    const map = new Map<number, THREE.Light>();
    const ids = [120, 90, 70].map((i) => world.spawn(Light(casting({ intensity: i }))).id());
    ids.forEach((id) => worldTransforms.set(id, wt(0, 3, 0)));

    sync.syncLights(world, scene, map);

    expect(ids.map((id) => map.get(id)!.castShadow)).toEqual([true, true, true]);
  });

  it('keeps only the most effective casters, and leaves the AUTHORED intent alone', async () => {
    const { world, Light, sync, scene } = await setup();
    await capAt(1);
    const map = new Map<number, THREE.Light>();
    const [dim, bright, mid] = [70, 120, 90].map((i) => world.spawn(Light(casting({ intensity: i }))).id());
    [dim, bright, mid].forEach((id) => worldTransforms.set(id, wt(0, 3, 0)));

    sync.syncLights(world, scene, map);

    expect(map.get(bright)!.castShadow).toBe(true);
    expect(map.get(mid)!.castShadow).toBe(false);
    expect(map.get(dim)!.castShadow).toBe(false);
    // The trait still says what the author asked for — the cap is a frame decision, not an edit.
    // Anything else would let a device's tier write itself back into the scene file.
    for (const id of [dim, bright, mid]) {
      expect(world.query(Light).find((e) => e.id() === id)!.get(Light)!.castShadow).toBe(true);
    }
  });

  it('gives the slot to a DIRECTIONAL over brighter spots — the units are not comparable', async () => {
    const { world, Light, sync, scene } = await setup();
    await capAt(1);
    const map = new Map<number, THREE.Light>();
    const spot = world.spawn(Light(casting({ intensity: 120 }))).id();
    const sun = world.spawn(Light(casting({ lightType: 'directional', intensity: 2 }))).id();
    [spot, sun].forEach((id) => worldTransforms.set(id, wt(0, 5, 0)));

    sync.syncLights(world, scene, map);

    expect(map.get(sun)!.castShadow).toBe(true);
    expect(map.get(spot)!.castShadow).toBe(false);
  });

  it('does not let a DEACTIVATED light consume a slot', async () => {
    const { world, Light, sync, scene } = await setup();
    await capAt(1);
    const map = new Map<number, THREE.Light>();
    const off = world.spawn(Light(casting({ intensity: 500 }))).id();
    const on = world.spawn(Light(casting({ intensity: 10 }))).id();
    [off, on].forEach((id) => worldTransforms.set(id, wt(0, 3, 0)));
    deactivatedEntities.add(off);      // brightest, but not in the scene this frame

    sync.syncLights(world, scene, map);

    expect(map.get(on)!.castShadow).toBe(true);
    expect(map.get(off)).toBeUndefined();   // deactivated lights are skipped entirely
  });

  it('reports what it dropped, because a missing shadow has no other symptom', async () => {
    const { world, Light, sync, scene } = await setup();
    await capAt(2);
    const { getShadowCasterCapStats } = await import('../../src/runtime/rendering/shadowCasterCapFrame');
    const map = new Map<number, THREE.Light>();
    for (const i of [120, 90, 70, 60]) worldTransforms.set(world.spawn(Light(casting({ intensity: i }))).id(), wt(0, 3, 0));

    sync.syncLights(world, scene, map);

    expect(getShadowCasterCapStats()).toEqual({ engaged: true, casters: 4, kept: 2 });
  });

  it('RE-ARMS every sync: turning the winner off promotes the next light', async () => {
    // The path a game actually takes — the authored flag changes at runtime and the cap has to
    // re-decide. Verified on a Galaxy A23 before it was written down: flipping the 120-intensity
    // spot off moved the shadow to the 90 (see the swap measurement in shadowCasterCap.ts's
    // header). Nothing covered it, because every other test here arms once and asserts once.
    const { world, Light, sync, scene } = await setup();
    await capAt(1);
    const map = new Map<number, THREE.Light>();
    const bright = world.spawn(Light(casting({ intensity: 120 })));
    const next = world.spawn(Light(casting({ intensity: 90 })));
    [bright.id(), next.id()].forEach((id) => worldTransforms.set(id, wt(0, 3, 0)));

    sync.syncLights(world, scene, map);
    expect([map.get(bright.id())!.castShadow, map.get(next.id())!.castShadow]).toEqual([true, false]);

    bright.set(Light, { castShadow: false });
    sync.syncLights(world, scene, map);

    // The demoted-by-the-author light casts nothing, and the slot it freed goes to the 90 —
    // not to nobody, which is what a cap that armed only once would have left.
    expect([map.get(bright.id())!.castShadow, map.get(next.id())!.castShadow]).toEqual([false, true]);
  });

  it('stays disengaged when the scene is already under the cap', async () => {
    const { world, Light, sync, scene } = await setup();
    await capAt(2);
    const { getShadowCasterCapStats } = await import('../../src/runtime/rendering/shadowCasterCapFrame');
    const map = new Map<number, THREE.Light>();
    const id = world.spawn(Light(casting({ intensity: 90 }))).id();
    worldTransforms.set(id, wt(0, 3, 0));

    sync.syncLights(world, scene, map);

    expect(getShadowCasterCapStats()).toEqual({ engaged: false, casters: 1, kept: 1 });
    expect(map.get(id)!.castShadow).toBe(true);
  });

  it('reports NO counts on the unlimited path, because it never counted', async () => {
    // An unlimited cap skips the collection walk, so the counter holds 0 — and reporting that as
    // "0 casters" from the one function exported to answer "where did my shadow go?" would be a
    // confident lie on the most common path of all (`high`, every untiered project). Absent, not 0.
    const { world, Light, sync, scene } = await setup();
    await capAt(0);
    const { getShadowCasterCapStats } = await import('../../src/runtime/rendering/shadowCasterCapFrame');
    const map = new Map<number, THREE.Light>();
    for (const i of [120, 90, 70]) worldTransforms.set(world.spawn(Light(casting({ intensity: i }))).id(), wt(0, 3, 0));

    sync.syncLights(world, scene, map);

    expect(getShadowCasterCapStats()).toEqual({ engaged: false });
  });
});
