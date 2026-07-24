/** sceneLightUniforms integration test — the ECS→uniform seam that feeds custom
 *  shaders. Exercises the REAL path: spawn `Light` entities in a koota world +
 *  seed their world transforms, run `updateSceneLightUniforms`, and assert the
 *  shared uniform `.value`s reflect the picked lights. `three/tsl` is the shared
 *  test stub (its `uniform()` carries a real `.value`), so this runs headless.
 *  The pure ranking math itself is covered by sceneLightPicker.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

// Controllable stand-ins for the transform-propagation globals the module reads.
const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();
const deactivatedEntities = new Set<number>();

async function setup() {
  worldTransforms.clear();
  deactivatedEntities.clear();
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities,
  }));
  const { createWorld } = await import('koota');
  const { Light } = await import('../../src/three/traits/Light');
  const uniforms = await import('../../src/runtime/rendering/sceneLightUniforms');
  // A shader binding the uniforms is what lazily creates the singleton; without
  // it updateSceneLightUniforms is a no-op.
  uniforms.getSceneLightUniforms();
  return { world: createWorld(), Light, uniforms };
}

function setWT(id: number, over: Partial<{ x: number; y: number; z: number; rx: number; ry: number }>) {
  worldTransforms.set(id, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, ...over });
}

describe('updateSceneLightUniforms — world → uniforms', () => {
  it('writes key / ambient / point values from the scene lights', async () => {
    const { world, Light, uniforms } = await setup();

    const amb = world.spawn(Light({ lightType: 'ambient', color: 0xffffff, intensity: 0.5 }));
    const dir = world.spawn(Light({ lightType: 'directional', color: 0xffffff, intensity: 3 }));
    const pt = world.spawn(Light({ lightType: 'point', color: 0xff0000, intensity: 2, distance: 10 }));
    setWT(amb.id(), {});
    setWT(dir.id(), { rx: 0, ry: 0 }); // forward -Z → toward-light +Z
    setWT(pt.id(), { x: 4, y: 5, z: 6 });

    uniforms.updateSceneLightUniforms(world);
    const u = uniforms.getSceneLightUniforms();

    // Ambient: white linear (1) × 0.5.
    expect(u.ambientColor.value.x).toBeCloseTo(0.5, 5);
    // Key directional: white × 3, aimed straight down -Z so toward-light is +Z.
    expect(u.keyLightColor.value.x).toBeCloseTo(3, 5);
    expect([u.keyLightDir.value.x, u.keyLightDir.value.y, u.keyLightDir.value.z].map((n: number) => Math.round(n) + 0))
      .toEqual([0, 0, 1]);
    // Point: red × 2 at its world position, invRange = 1/10.
    expect(u.pointColor[0].value.x).toBeCloseTo(2, 5);
    expect(u.pointColor[0].value.y).toBeCloseTo(0, 5);
    expect([u.pointPos[0].value.x, u.pointPos[0].value.y, u.pointPos[0].value.z]).toEqual([4, 5, 6]);
    expect(u.pointInvRange[0].value).toBeCloseTo(0.1, 6);
  });

  it('zeroes unused point slots', async () => {
    const { world, Light, uniforms } = await setup();
    const pt = world.spawn(Light({ lightType: 'point', color: 0xffffff, intensity: 1, distance: 0 }));
    setWT(pt.id(), { x: 1 });

    uniforms.updateSceneLightUniforms(world);
    const u = uniforms.getSceneLightUniforms();

    expect(u.pointInvRange[0].value).toBe(0); // distance 0 → infinite range
    // Slot 1 (no light) is zeroed.
    expect(u.pointColor[1].value.x).toBe(0);
    expect(u.pointInvRange[1].value).toBe(0);
  });

  it('ignores deactivated light entities', async () => {
    const { world, Light, uniforms } = await setup();
    const dir = world.spawn(Light({ lightType: 'directional', color: 0xffffff, intensity: 4 }));
    setWT(dir.id(), {});

    uniforms.updateSceneLightUniforms(world);
    expect(uniforms.getSceneLightUniforms().keyLightColor.value.x).toBeCloseTo(4, 5);

    deactivatedEntities.add(dir.id());
    uniforms.updateSceneLightUniforms(world);
    expect(uniforms.getSceneLightUniforms().keyLightColor.value.x).toBe(0);
  });

  it('tracks a moved key light (direction follows the transform)', async () => {
    const { world, Light, uniforms } = await setup();
    const dir = world.spawn(Light({ lightType: 'directional', color: 0xffffff, intensity: 1 }));
    setWT(dir.id(), { rx: 0, ry: 0 });
    uniforms.updateSceneLightUniforms(world);
    const before = uniforms.getSceneLightUniforms().keyLightDir.value.z;

    setWT(dir.id(), { rx: 0, ry: Math.PI / 2 }); // rotate 90° → toward-light swings to +X
    uniforms.updateSceneLightUniforms(world);
    const u = uniforms.getSceneLightUniforms();
    expect(before).toBeCloseTo(1, 5);
    expect(u.keyLightDir.value.x).toBeCloseTo(1, 5);
    expect(u.keyLightDir.value.z).toBeCloseTo(0, 5);
  });
});

describe('sceneLightUniforms — uniform grouping', () => {
  // These are SCENE-GLOBAL values shared by every custom-shader material, so they
  // must live in `renderGroup` (a shared buffer re-uploaded once per render call).
  // A bare `uniform()` defaults to `objectGroup` — a PER-RENDER-OBJECT buffer only
  // re-uploaded when `NodeMaterialObserver.needsRefresh(renderObject)` is true,
  // which is false forever for a static mesh with a plain material. That would make
  // a light change silently never reach a NON-ANIMATING custom-shader object. Same
  // root cause as the height-fog staleness bug; see docs/rendering.md "Fog".
  it('puts every scene-light uniform in renderGroup, NOT the default per-object group', async () => {
    const { uniforms } = await setup();
    const tsl = await import('three/tsl');
    const u = uniforms.getSceneLightUniforms();

    const all = [u.keyLightDir, u.keyLightColor, u.ambientColor, ...u.pointPos, ...u.pointColor, ...u.pointInvRange];
    for (const node of all) {
      expect((node as unknown as { __group: unknown }).__group).toBe(tsl.renderGroup);
      expect((node as unknown as { __group: unknown }).__group).not.toBe(tsl.objectGroup);
    }
  });
});
