/** lightMaskVariants — rendering-layer light masks (#136), against REAL three.js materials
 *  and lights. No renderer/GPU needed: `lightsNode` is an opaque value here, so the lighting
 *  factory is stubbed and we assert on WHICH lights were handed to it.
 *
 *  The load-bearing property is the cache KEY — twice over, and both failures are invisible in a
 *  frame time:
 *   - keyed per ENTITY, the feature trades a fragment-cost problem for a pipeline-count one;
 *   - keyed by MASK alone, two render surfaces (the editor's SceneView + GameView, each owning
 *     its own THREE.Light instances) collide on one entry and rebuild it every frame, and a
 *     material still compiling its pipeline renders UNLIT.
 *  Hence the explicit instance-identity and call-count assertions. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_RENDERING_LAYER_MASK,
  beginLightMaskFrame,
  getMaskedMaterial,
  isLightMaskingActive,
  lightsForMask,
  getLightMaskStats,
  resetLightMaskVariants,
  type LightingFactory,
} from '../../src/runtime/rendering/lightMaskVariants';

/** Records the light list every createNode call received. */
function stubFactory(): LightingFactory & { calls: THREE.Light[][] } {
  const calls: THREE.Light[][] = [];
  return {
    calls,
    lighting: {
      createNode(lights: THREE.Light[]) {
        calls.push([...lights]);
        return { __lightsNode: lights.length };
      },
    },
  };
}

const D = DEFAULT_RENDERING_LAYER_MASK; // 1

beforeEach(() => resetLightMaskVariants());

describe('inert until authored', () => {
  it('allocates nothing when every light and renderable uses the default mask', () => {
    const f = stubFactory();
    const lights = [
      { light: new THREE.AmbientLight(), mask: D },
      { light: new THREE.PointLight(), mask: D },
    ];
    beginLightMaskFrame(lights, false);

    expect(isLightMaskingActive()).toBe(false);
    const base = new THREE.MeshStandardMaterial();
    expect(getMaskedMaterial(base, D, f)).toBeNull();
    expect(getLightMaskStats().variants).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it('activates when a LIGHT is masked, even with no renderable masked', () => {
    beginLightMaskFrame([{ light: new THREE.PointLight(), mask: 0b10 }], false);
    expect(isLightMaskingActive()).toBe(true);
  });

  it('activates when a RENDERABLE is masked, even with every light on the default layer', () => {
    // A renderable whose mask excludes layer 0 must stop being lit by default-layer lights,
    // so the renderable side has to arm the path on its own.
    beginLightMaskFrame([{ light: new THREE.PointLight(), mask: D }], true);
    expect(isLightMaskingActive()).toBe(true);
  });
});

describe('mask intersection', () => {
  it('selects lights whose mask shares a bit with the renderer', () => {
    const a = new THREE.PointLight();
    const b = new THREE.PointLight();
    const c = new THREE.PointLight();
    beginLightMaskFrame(
      [{ light: a, mask: 0b001 }, { light: b, mask: 0b010 }, { light: c, mask: 0b110 }],
      true,
    );

    expect(lightsForMask(0b001)).toEqual([a]);
    expect(lightsForMask(0b010)).toEqual([b, c]);
    expect(lightsForMask(0b100)).toEqual([c]);
    expect(lightsForMask(0b111)).toEqual([a, b, c]);
    expect(lightsForMask(0b1000)).toEqual([]);
  });

  it('returns null when the mask already sees every light — the global lights node is correct', () => {
    const f = stubFactory();
    const a = new THREE.PointLight();
    beginLightMaskFrame([{ light: a, mask: 0b11 }], true);

    expect(getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f)).toBeNull();
    expect(getLightMaskStats().variants).toBe(0);
  });

  it('builds a variant carrying only the intersecting lights', () => {
    const f = stubFactory();
    const key = new THREE.SpotLight();
    const other = new THREE.SpotLight();
    beginLightMaskFrame([{ light: key, mask: 0b01 }, { light: other, mask: 0b10 }], true);

    const base = new THREE.MeshStandardMaterial();
    const variant = getMaskedMaterial(base, 0b01, f);

    expect(variant).not.toBeNull();
    expect(variant).not.toBe(base);
    expect(f.calls).toEqual([[key]]);
    // The shared base must never be given a lightsNode — it is the cache-owned material.
    expect((base as THREE.Material & { lightsNode?: unknown }).lightsNode).toBeUndefined();
  });
});

describe('cache keying — one variant per (material, mask), NOT per entity', () => {
  it('returns the SAME instance for repeated lookups of the same pair', () => {
    const f = stubFactory();
    beginLightMaskFrame([{ light: new THREE.PointLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);
    const base = new THREE.MeshStandardMaterial();

    const first = getMaskedMaterial(base, 0b01, f);
    const second = getMaskedMaterial(base, 0b01, f);

    expect(second).toBe(first);
    expect(f.calls).toHaveLength(1);
    expect(getLightMaskStats().variants).toBe(1);
  });

  it('does not grow with the number of meshes — 50 meshes on 2 masks yield 2 variants', () => {
    const f = stubFactory();
    beginLightMaskFrame(
      [{ light: new THREE.PointLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }, { light: new THREE.PointLight(), mask: 0b100 }],
      true,
    );
    const base = new THREE.MeshStandardMaterial();

    for (let i = 0; i < 50; i++) getMaskedMaterial(base, i % 2 === 0 ? 0b01 : 0b10, f);

    expect(getLightMaskStats().variants).toBe(2);
    expect(f.calls).toHaveLength(2);
  });

  it('separates variants per base material', () => {
    const f = stubFactory();
    beginLightMaskFrame([{ light: new THREE.PointLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);

    getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f);
    getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f);

    expect(getLightMaskStats().variants).toBe(2);
  });
});

describe('a changed light set lands on a different variant', () => {
  it('rebuilds when a light joins the mask', () => {
    const f = stubFactory();
    const a = new THREE.PointLight();
    beginLightMaskFrame([{ light: a, mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);
    const base = new THREE.MeshStandardMaterial();
    const first = getMaskedMaterial(base, 0b01, f)!;

    const b = new THREE.PointLight();
    beginLightMaskFrame(
      [{ light: a, mask: 0b01 }, { light: b, mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }],
      true,
    );
    const second = getMaskedMaterial(base, 0b01, f)!;

    expect(second).not.toBe(first);
    expect(f.calls[1]).toEqual([a, b]);
  });

  it('rebuilds when only a MASK changed, with the same light objects', () => {
    const f = stubFactory();
    const a = new THREE.PointLight();
    const b = new THREE.PointLight();
    // `held` never intersects 0b01, so the mask stays narrower than the full set across both
    // frames — otherwise this would exercise the sees-everything shortcut, not the rebuild.
    const held = new THREE.PointLight();
    beginLightMaskFrame([{ light: a, mask: 0b01 }, { light: b, mask: 0b10 }, { light: held, mask: 0b100 }], true);
    const base = new THREE.MeshStandardMaterial();
    getMaskedMaterial(base, 0b01, f);
    expect(f.calls[0]).toEqual([a]);

    beginLightMaskFrame([{ light: a, mask: 0b01 }, { light: b, mask: 0b01 }, { light: held, mask: 0b100 }], true);
    getMaskedMaterial(base, 0b01, f);

    expect(f.calls[1]).toEqual([a, b]);
  });

  it('reuses the variant when the light set is unchanged', () => {
    const f = stubFactory();
    const lights = [{ light: new THREE.PointLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }];
    const base = new THREE.MeshStandardMaterial();
    beginLightMaskFrame(lights, true);
    const first = getMaskedMaterial(base, 0b01, f);
    beginLightMaskFrame(lights.map((l) => ({ ...l })), true);
    expect(getMaskedMaterial(base, 0b01, f)).toBe(first);
    expect(f.calls).toHaveLength(1);
  });
});

describe('TWO SURFACES — the editor bug that shipped', () => {
  // The editor mounts SceneView AND GameView. Each owns its own ecsLights map, so each builds
  // its OWN THREE.Light instances for the same ECS entities, and they alternate frame by frame
  // through one module-global light list. Keyed by mask alone they collided on a single cache
  // entry and rebuilt it every frame; a material whose pipeline is still compiling renders
  // UNLIT, which looked like the object lighting and unlighting as the camera orbited.
  it('gives each surface its own variant and never rebuilds when they alternate', () => {
    const f = stubFactory();
    const base = new THREE.MeshStandardMaterial();
    // Same ECS entities, different THREE.Light instances per surface.
    const surfaceA = [{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }];
    const surfaceB = [{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }];

    beginLightMaskFrame(surfaceA, true);
    const a1 = getMaskedMaterial(base, 0b01, f);
    beginLightMaskFrame(surfaceB, true);
    const b1 = getMaskedMaterial(base, 0b01, f);

    // Ten alternating frames, as the two panels render.
    for (let i = 0; i < 10; i++) {
      beginLightMaskFrame(surfaceA, true);
      expect(getMaskedMaterial(base, 0b01, f)).toBe(a1);
      beginLightMaskFrame(surfaceB, true);
      expect(getMaskedMaterial(base, 0b01, f)).toBe(b1);
    }

    expect(a1).not.toBe(b1);                     // one variant per surface
    expect(f.calls).toHaveLength(2);             // built twice, TOTAL — not per frame
    expect(getLightMaskStats().variants).toBe(2);
  });
});

describe('teardown', () => {
  it('disposes every variant and clears state', () => {
    const f = stubFactory();
    beginLightMaskFrame([{ light: new THREE.PointLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);
    const v = getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f)!;
    const disposed = vi.spyOn(v, 'dispose');

    resetLightMaskVariants();

    expect(disposed).toHaveBeenCalled();
    expect(getLightMaskStats()).toEqual({ variants: 0, lights: 0, active: false });
  });
});
