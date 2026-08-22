/** The per-frame driver for the automatic light cap (#188 item 7) —
 *  `runtime/rendering/autoLightCapFrame.ts`.
 *
 *  The pure rule (`autoLightCap.ts`) has had its own tests since #121 P3c. What was missing, and
 *  what these cover, is the WIRING: that the cap engages only when it should, that it composes
 *  with an artist's authored masks rather than overriding them, and that it publishes lights in
 *  the identity space the mask variants resolve against. Every one of those was unreachable while
 *  the module was imported by nothing. */

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  armAutoLightCap, autoCapMaskFor, isAutoLightCapEngaged, getAutoLightCapStats,
  resetAutoLightCapFrame,
} from '../../src/runtime/rendering/autoLightCapFrame';
import { DEFAULT_RENDERING_LAYER_MASK, type MaskedLight } from '../../src/runtime/rendering/lightMaskVariants';
import { TIER_SETTINGS } from '../../src/runtime/rendering/qualityTier';

afterEach(() => resetAutoLightCapFrame());

/** A light at a world position. `updateMatrixWorld` is what the cap reads — see the module's note
 *  on why a local position cannot answer "nearest". */
function point(x: number, y: number, z: number, intensity = 1, mask = DEFAULT_RENDERING_LAYER_MASK): MaskedLight {
  const l = new THREE.PointLight(0xffffff, intensity);
  l.position.set(x, y, z);
  l.updateMatrixWorld(true);
  return { light: l, mask };
}
function directional(intensity: number, color = 0xffffff, mask = DEFAULT_RENDERING_LAYER_MASK): MaskedLight {
  const l = new THREE.DirectionalLight(color, intensity);
  l.updateMatrixWorld(true);
  return { light: l, mask };
}
function ambient(intensity = 0.2): MaskedLight {
  const l = new THREE.AmbientLight(0xffffff, intensity);
  l.updateMatrixWorld(true);
  return { light: l, mask: DEFAULT_RENDERING_LAYER_MASK };
}
const bitsOf = (mask: number) => {
  const out: number[] = [];
  for (let i = 0; i < 31; i++) if ((mask >> i) & 1) out.push(i);
  return out;
};

describe('engaging at all', () => {
  it('stays OFF when the scene already fits the tier — the common path is untouched', () => {
    // The census says nearly every scene is like this: one directional, few locals. `low` caps at
    // 1+1, and this scene has 1+1, so nothing is restricted and no synthetic mask is published.
    const lights = [ambient(), directional(1), point(0, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
    expect(isAutoLightCapEngaged()).toBe(false);
    expect(lights.every((l) => l.mask === DEFAULT_RENDERING_LAYER_MASK)).toBe(true);
    // ...and an object's mask is handed back exactly as authored.
    expect(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0)).toBe(DEFAULT_RENDERING_LAYER_MASK);
  });

  it('can NEVER engage on `high` — its caps are 0, meaning unlimited', () => {
    const many = [ambient(), directional(1), directional(2), point(0, 0, 0), point(5, 0, 0), point(9, 0, 0)];
    expect(armAutoLightCap(many, TIER_SETTINGS.high)).toBe(false);
  });

  it('engages on `low` once the scene exceeds the caps', () => {
    const lights = [ambient(), directional(1), point(0, 0, 0), point(5, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(getAutoLightCapStats()).toMatchObject({ engaged: true, lights: 4 });
  });

  it('DISENGAGES past 31 lights rather than capping the wrong ones', () => {
    // A 32-bit mask cannot address more than that individually, and a partial cap would silently
    // drop whichever lights fell off the end — a rendering bug that looks like an art bug.
    const lights = [ambient(), directional(1), ...Array.from({ length: 40 }, (_, i) => point(i, 0, 0))];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
  });

  it('DISENGAGES on a light type the rule cannot classify, leaving it lit', () => {
    // Hemisphere/rect-area are not in the rule's vocabulary. Keeping the scene fully lit is the
    // failure direction that looks like a missed optimisation; guessing is the one that looks
    // like a black object.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
    hemi.updateMatrixWorld(true);
    const lights = [ambient(), directional(1), point(0, 0, 0), point(5, 0, 0), { light: hemi, mask: DEFAULT_RENDERING_LAYER_MASK }];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
  });
});

describe('what it selects', () => {
  it('keeps all ambient, the most EFFECTIVE directional, and the nearest local', () => {
    const lights = [
      ambient(),                    // 0 — never capped
      directional(2, 0x0000ff),     // 1 — brighter, but deep blue: low luminance
      directional(1, 0xffffff),     // 2 — the one a viewer would call the key light
      point(100, 0, 0),             // 3 — far
      point(1, 0, 0),               // 4 — near
    ];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 2, 4]);
  });

  it('picks a DIFFERENT local light for an object at the other end of the scene', () => {
    // The per-object half of the rule. Directionals have no position, so they are chosen once
    // scene-wide; only point/spot vary.
    const lights = [ambient(), directional(1), point(-50, 0, 0), point(50, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, -49, 0, 0))).toEqual([0, 1, 2]);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 49, 0, 0))).toEqual([0, 1, 3]);
  });

  it('reads the light\'s WORLD position, not its local one', () => {
    // A light parented to a moving rig has a local position that says nothing about where it is,
    // and "nearest" is the entire selection rule.
    const rig = new THREE.Group();
    rig.position.set(100, 0, 0);
    const near = new THREE.PointLight(0xffffff, 1);   // local (0,0,0) → world (100,0,0)
    rig.add(near);
    const far = new THREE.PointLight(0xffffff, 1);
    far.position.set(1, 0, 0);                        // world (1,0,0)
    rig.updateMatrixWorld(true);
    far.updateMatrixWorld(true);
    const lights: MaskedLight[] = [
      ambient(), directional(1),
      { light: near, mask: DEFAULT_RENDERING_LAYER_MASK },
      { light: far, mask: DEFAULT_RENDERING_LAYER_MASK },
    ];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // An object at the origin is nearest to `far` (world 1,0,0) — reading local positions would
    // have picked `near`, whose LOCAL position is the origin itself.
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 1, 3]);
  });

  it('`mid` keeps more than `low` — the ladder is visible in the selection, not just the table', () => {
    // Big enough that BOTH tiers engage (3 directional + 4 local exceeds mid's 2+3 as well as
    // low's 1+1) — a scene that already fits mid would simply not engage there, which is a true
    // statement about the tier but says nothing about the selection.
    const build = (): MaskedLight[] => [
      ambient(),                                                     // 0
      directional(3), directional(2), directional(1),                // 1,2,3
      point(0, 0, 0), point(1, 0, 0), point(2, 0, 0), point(50, 0, 0), // 4,5,6,7
    ];
    const low = build();
    expect(armAutoLightCap(low, TIER_SETTINGS.low)).toBe(true);
    const lowBits = bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0));
    resetAutoLightCapFrame();
    const mid = build();
    expect(armAutoLightCap(mid, TIER_SETTINGS.mid)).toBe(true);
    const midBits = bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0));
    expect(lowBits).toEqual([0, 1, 4]);              // ambient + brightest directional + nearest local
    expect(midBits).toEqual([0, 1, 2, 4, 5, 6]);     // 2 directional + 3 nearest locals
    // The far light is dropped by BOTH — the point of the rule.
    expect(lowBits).not.toContain(7);
    expect(midBits).not.toContain(7);
  });
});

describe('composing with an ARTIST\'s authored masks', () => {
  it('never hands back a light the author masked away', () => {
    // The composition rule, and the reason it is an intersection rather than a replacement: the
    // cap is an automatic fallback for scenes that authored nothing, and it must not overrule the
    // one scene that did.
    const LAYER_A = 0b01;
    const LAYER_B = 0b10;
    const lights = [
      ambient(),                                   // 0 — layer A (default)
      directional(1),                              // 1 — layer A
      point(0, 0, 0, 1, LAYER_B),                  // 2 — layer B ONLY: not for a layer-A object
      point(1, 0, 0, 1, LAYER_A),                  // 3 — layer A, slightly farther
      point(9, 0, 0, 1, LAYER_A),                  // 4 — layer A, far. TWO locals on layer A, so a
    ];                                             //     layer-A object does NOT already fit and
                                                   //     must go through the composition.
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // Light 2 is NEAREST of all, so choosing globally and intersecting afterwards would pick it,
    // then delete it — leaving the object with NO local light. Restricting the candidates first
    // gives the nearest one it is ALLOWED to see: light 3.
    expect(bitsOf(autoCapMaskFor(LAYER_A, 0, 0, 0))).toEqual([0, 1, 3]);
    // ...and a layer-B object sees the layer-B light.
    expect(bitsOf(autoCapMaskFor(LAYER_B, 0, 0, 0))).toEqual([2]);
  });

  it('republishes lights under IDENTITY masks so the variant cache resolves the selection', () => {
    // Two mask spaces: authored masks are LAYERS (several lights can share one), the cap names
    // individual lights. Publishing `1 << i` is what makes `lightsForMask` return exactly the
    // cap's choice.
    const lights = [ambient(), directional(1), point(0, 0, 0), point(9, 0, 0)];
    armAutoLightCap(lights, TIER_SETTINGS.low);
    expect(lights.map((l) => l.mask)).toEqual([1, 2, 4, 8]);
  });
});

describe('an object whose authored selection already fits is LEFT ALONE', () => {
  it('hands back the authored bits unchanged rather than re-capping them', () => {
    // MEASURED, not assumed. On a Galaxy A23 with demos/postfx-demo — the one project that authors
    // masks — capping an already-culled object anyway ran the GPU at 6.29ms against 5.18ms
    // uncapped, and cost +1.8ms of CPU: a per-object "nearest local" selection splits objects that
    // shared an authored selection into MORE material variants, and every variant is a pipeline.
    const LAYER_A = 0b01, LAYER_B = 0b10;
    const lights = [
      ambient(),                            // 0 — both layers? no: default layer = A
      directional(1),                       // 1 — layer A
      point(0, 0, 0, 1, LAYER_B),           // 2 — layer B
      point(1, 0, 0, 1, LAYER_B),           // 3 — layer B
      point(2, 0, 0, 1, LAYER_B),           // 4 — layer B
    ];
    // Globally this exceeds low's 1+1 (three locals), so the cap engages...
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // ...but a LAYER_A object only sees ambient + 1 directional + 0 locals, which already fits.
    // It must get exactly its authored selection back — same lights, hence the same variant.
    expect(bitsOf(autoCapMaskFor(LAYER_A, 0, 0, 0))).toEqual([0, 1]);
    // A LAYER_B object sees three locals and no directional, so it IS capped to the nearest one.
    expect(bitsOf(autoCapMaskFor(LAYER_B, 0, 0, 0))).toEqual([2]);
  });

  it('still caps an unauthored object in the same frame — the test is per object, not per scene', () => {
    const lights = [ambient(), directional(1), point(0, 0, 0), point(1, 0, 0), point(2, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 1, 2]);
  });
});
