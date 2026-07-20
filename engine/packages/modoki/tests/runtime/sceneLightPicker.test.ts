/** sceneLightPicker unit tests — the pure scene-light picker that feeds custom
 *  shaders (key directional + N strongest point lights + summed ambient). */

import { describe, it, expect } from 'vitest';
import {
  pickSceneLights, linearFromHex, keyDirFromEuler, MAX_SHADER_POINT_LIGHTS,
  type LightSample,
} from '../../src/runtime/rendering/sceneLightPicker';

function light(over: Partial<LightSample>): LightSample {
  return {
    lightType: 'point', color: 0xffffff, intensity: 1, distance: 0,
    x: 0, y: 0, z: 0, rx: 0, ry: 0, ...over,
  };
}

describe('sceneLightPicker', () => {
  it('picks the brightest directional as the key light', () => {
    const p = pickSceneLights([
      light({ lightType: 'directional', color: 0xff0000, intensity: 0.5 }),
      light({ lightType: 'directional', color: 0x00ff00, intensity: 2 }),
    ]);
    // green (linear 1) × intensity 2 dominates; red one is ignored.
    expect(p.keyColor[1]).toBeCloseTo(2, 5);
    expect(p.keyColor[0]).toBeCloseTo(0, 5);
  });

  it('sums all ambient lights (linear × intensity)', () => {
    const p = pickSceneLights([
      light({ lightType: 'ambient', color: 0xffffff, intensity: 0.25 }),
      light({ lightType: 'ambient', color: 0xffffff, intensity: 0.75 }),
    ]);
    expect(p.ambient[0]).toBeCloseTo(1, 5);
    expect(p.ambient[1]).toBeCloseTo(1, 5);
    expect(p.ambient[2]).toBeCloseTo(1, 5);
  });

  it('keeps only the strongest MAX point lights, sorted by intensity', () => {
    const lights: LightSample[] = [];
    for (let i = 0; i < MAX_SHADER_POINT_LIGHTS + 3; i++) {
      lights.push(light({ lightType: 'point', intensity: i + 1, x: i }));
    }
    const p = pickSceneLights(lights);
    expect(p.points).toHaveLength(MAX_SHADER_POINT_LIGHTS);
    // Strongest first: intensities N+3, N+2, ... The weakest (i=0..2) are dropped.
    const xs = p.points.map((pt) => pt.pos[0]);
    expect(xs[0]).toBe(MAX_SHADER_POINT_LIGHTS + 2); // highest intensity had the highest x
    expect(Math.min(...xs)).toBe(3); // i=0,1,2 dropped
  });

  it('encodes point range as invRange (0 = infinite)', () => {
    const p = pickSceneLights([
      light({ lightType: 'point', distance: 10 }),
      light({ lightType: 'point', distance: 0, x: 1 }),
    ]);
    const withRange = p.points.find((pt) => pt.pos[0] === 0)!;
    const infinite = p.points.find((pt) => pt.pos[0] === 1)!;
    expect(withRange.invRange).toBeCloseTo(0.1, 6);
    expect(infinite.invRange).toBe(0);
  });

  it('ignores zero/negative-intensity lights', () => {
    const p = pickSceneLights([
      light({ lightType: 'directional', intensity: 0 }),
      light({ lightType: 'point', intensity: 0, x: 5 }),
      light({ lightType: 'ambient', intensity: 0 }),
    ]);
    expect(p.keyColor).toEqual([0, 0, 0]);
    expect(p.ambient).toEqual([0, 0, 0]);
    expect(p.points).toHaveLength(0);
  });

  it('defaults key direction to up when there is no directional light', () => {
    const p = pickSceneLights([light({ lightType: 'point' })]);
    expect(p.keyDir).toEqual([0, 1, 0]);
  });

  it('derives a unit toward-light direction from Euler angles', () => {
    // No rotation: forward is -Z, so toward-light is +Z.
    expect(keyDirFromEuler(0, 0)).toEqual([0, -0, 1]);
    const d = keyDirFromEuler(0.3, 1.1);
    const len = Math.hypot(d[0], d[1], d[2]);
    expect(len).toBeCloseTo(1, 6);
  });

  it('converts sRGB hex to linear (mid-gray is darker in linear)', () => {
    const [r] = linearFromHex(0x808080);
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.3); // ~0.216, well below the sRGB 0.5
  });
});
