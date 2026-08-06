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

describe('ONE lights node per selection — the shadow bug that shipped', () => {
  // A LightsNode builds a ShadowNode per shadow-casting light, and that ShadowNode owns the
  // shadow-map render target its material samples. Two nodes over the same light means two
  // ShadowNodes fighting over one LightShadow, and the loser samples a map nothing rendered
  // into — it reads as fully in shadow, i.e. a PITCH-BLACK object with perfectly correct data.
  // Live repro: the horse plinth (shared plinth .mat.json) and the horse statue (its own GLB
  // material) both select only SpotHorse. Statue lit, plinth black.
  it('shares one node across DIFFERENT base materials selecting the same lights', () => {
    const f = stubFactory();
    const key = new THREE.SpotLight();
    const other = new THREE.SpotLight();
    beginLightMaskFrame([{ light: key, mask: 0b01 }, { light: other, mask: 0b10 }], true);

    const plinth = getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f) as THREE.Material & { lightsNode?: unknown };
    const statue = getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f) as THREE.Material & { lightsNode?: unknown };

    expect(plinth).not.toBe(statue);                  // distinct materials — they carry different props
    expect(plinth.lightsNode).toBe(statue.lightsNode); // ...over ONE lights node
    expect(f.calls).toHaveLength(1);                   // built once, so ONE ShadowNode per light
    expect(getLightMaskStats().variants).toBe(2);
  });

  it('still builds a distinct node per distinct selection', () => {
    const f = stubFactory();
    const a = new THREE.SpotLight();
    const b = new THREE.SpotLight();
    const held = new THREE.PointLight();
    beginLightMaskFrame(
      [{ light: a, mask: 0b01 }, { light: b, mask: 0b10 }, { light: held, mask: 0b100 }],
      true,
    );
    const base = new THREE.MeshStandardMaterial();

    const onA = getMaskedMaterial(base, 0b01, f) as THREE.Material & { lightsNode?: unknown };
    const onB = getMaskedMaterial(base, 0b10, f) as THREE.Material & { lightsNode?: unknown };

    expect(onA.lightsNode).not.toBe(onB.lightsNode);
    expect(f.calls).toEqual([[a], [b]]);
  });

  it('gives each render SURFACE its own node — they hold different THREE.Light instances', () => {
    // Sharing must key off light IDENTITY, not the mask: SceneView and GameView own separate
    // THREE.Light objects, and a node holding the other surface's lights lights nothing.
    const f = stubFactory();
    const base = new THREE.MeshStandardMaterial();
    const surfaceA = [{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }];
    const surfaceB = [{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }];

    beginLightMaskFrame(surfaceA, true);
    const a = getMaskedMaterial(base, 0b01, f) as THREE.Material & { lightsNode?: unknown };
    beginLightMaskFrame(surfaceB, true);
    const b = getMaskedMaterial(base, 0b01, f) as THREE.Material & { lightsNode?: unknown };

    expect(a.lightsNode).not.toBe(b.lightsNode);
    expect(f.calls).toEqual([[surfaceA[0].light], [surfaceB[0].light]]);
  });
});

describe('PIPELINE CACHE KEY — the black-object bug', () => {
  // three's RenderObject.getMaterialCacheKey() decides which compiled pipeline to reuse by
  // walking the material's properties, and a lightsNode is invisible to it: a non-texture object
  // contributes the literal "{}", and uuid/name/userData are skipped. So clones of ONE base that
  // differ only in their light set hash identically and share whichever pipeline compiled first.
  // postfx-demo's six plinths share one .mat.json; several selections were empty, the empty
  // pipeline won, and every plinth rendered BLACK while its data was perfect.
  const keyOf = (m: THREE.Material | null) =>
    (m as (THREE.Material & { customProgramCacheKey?: () => string }) | null)?.customProgramCacheKey?.();

  it('gives variants of the SAME base different keys when their light sets differ', () => {
    const f = stubFactory();
    const a = new THREE.SpotLight();
    const b = new THREE.SpotLight();
    const held = new THREE.PointLight();
    beginLightMaskFrame(
      [{ light: a, mask: 0b01 }, { light: b, mask: 0b10 }, { light: held, mask: 0b100 }],
      true,
    );
    const base = new THREE.MeshStandardMaterial();

    const onA = getMaskedMaterial(base, 0b01, f);
    const onB = getMaskedMaterial(base, 0b10, f);

    expect(keyOf(onA)).toBeTruthy();
    expect(keyOf(onA)).not.toBe(keyOf(onB));
  });

  it('distinguishes an EMPTY selection from a non-empty one — the exact plinth collision', () => {
    const f = stubFactory();
    const lit = new THREE.SpotLight();
    const other = new THREE.PointLight();
    beginLightMaskFrame([{ light: lit, mask: 0b01 }, { light: other, mask: 0b10 }], true);
    const plinthMat = new THREE.MeshStandardMaterial(); // ONE .mat.json, six plinths

    const litPlinth = getMaskedMaterial(plinthMat, 0b01, f);   // sees the spot
    const darkPlinth = getMaskedMaterial(plinthMat, 0b100, f); // sees nothing

    expect(lightsForMask(0b100)).toEqual([]);
    expect(keyOf(litPlinth)).not.toBe(keyOf(darkPlinth));
  });

  it('separates a variant from its own unmasked base material', () => {
    const f = stubFactory();
    beginLightMaskFrame([{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);
    const base = new THREE.MeshStandardMaterial();
    const variant = getMaskedMaterial(base, 0b01, f);

    expect(keyOf(variant)).not.toBe(base.customProgramCacheKey());
  });

  it('leaves a NodeMaterial ALONE — three already hashes its node graph', () => {
    // NodeMaterial.customProgramCacheKey() hashes _getNodeChildren(), which picks up every own
    // property whose value isNode — including an assigned lightsNode. Overriding it there would
    // REPLACE that graph hash with just the light selection, so two different node graphs (two
    // file shaders) would share one pipeline. That is this same defect one layer up.
    //
    // A REAL node material cannot be built here: `three/webgpu` resolves to an EMPTY module under
    // vitest (0 exports — verified). So this is a genuine THREE.Material subclass carrying the one
    // property the branch actually reads, which survives clone() (`new this.constructor().copy()`)
    // exactly as a real NodeMaterial's would.
    class FakeNodeMaterial extends THREE.MeshStandardMaterial {
      isNodeMaterial = true;
      override customProgramCacheKey(): string { return 'node-graph-hash'; }
    }
    const f = stubFactory();
    const key = new THREE.SpotLight();
    const other = new THREE.PointLight();
    beginLightMaskFrame([{ light: key, mask: 0b01 }, { light: other, mask: 0b10 }], true);

    const variant = getMaskedMaterial(new FakeNodeMaterial(), 0b01, f) as THREE.Material & {
      isNodeMaterial?: boolean;
      customProgramCacheKey: () => string;
    };

    expect(variant.isNodeMaterial).toBe(true);
    // We must not have shadowed it: three's own graph-derived key still answers.
    expect(Object.prototype.hasOwnProperty.call(variant, 'customProgramCacheKey')).toBe(false);
    expect(variant.customProgramCacheKey()).toBe('node-graph-hash');
  });

  it('COMPOSES with a classic base that customises its own key, rather than replacing it', () => {
    class KeyedMaterial extends THREE.MeshStandardMaterial {
      override customProgramCacheKey(): string { return 'base-own-key'; }
    }
    const f = stubFactory();
    beginLightMaskFrame([{ light: new THREE.SpotLight(), mask: 0b01 }, { light: new THREE.PointLight(), mask: 0b10 }], true);

    const variant = getMaskedMaterial(new KeyedMaterial(), 0b01, f) as THREE.Material & {
      customProgramCacheKey: () => string;
    };

    expect(variant.customProgramCacheKey()).toContain('base-own-key');
    expect(variant.customProgramCacheKey()).toContain('lightmask:');
  });

  it('lets variants sharing a light set share a key — the cache must not fragment needlessly', () => {
    const f = stubFactory();
    const key = new THREE.SpotLight();
    const other = new THREE.PointLight();
    beginLightMaskFrame([{ light: key, mask: 0b01 }, { light: other, mask: 0b10 }], true);

    const plinth = getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f);
    const statue = getMaskedMaterial(new THREE.MeshStandardMaterial(), 0b01, f);

    expect(keyOf(plinth)).toBe(keyOf(statue));
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
