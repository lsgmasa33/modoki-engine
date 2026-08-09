/** Automatic per-object light cap (#121 P3c) — `runtime/rendering/autoLightCap.ts`.
 *
 *  The rule: all ambient + the most EFFECTIVE N directional + the nearest N point/spot.
 *
 *  The assertion that matters most is the BOUNDED-SELECTIONS one. A per-object rule that produced
 *  a distinct light selection per object would multiply compiled pipelines and shadow passes and
 *  could be slower than no cap at all; this rule's global part is identical for every object, so
 *  selections are bounded by the LOCAL light count, never the object count. */

import { describe, it, expect } from 'vitest';
import {
  globalKeptMask, maskForObject, capChangesAnything, canAutoCap,
  MAX_CAPPABLE_LIGHTS, effectiveness, type CapLight, type LightCaps,
} from '../../src/runtime/rendering/autoLightCap';

const LOW: LightCaps = { maxDirectional: 1, maxLocal: 1 };
const UNCAPPED: LightCaps = { maxDirectional: 0, maxLocal: 0 };

const amb = (i: number, intensity = 1): CapLight => ({ index: i, type: 'ambient', intensity, x: 0, y: 0, z: 0 });
const dir = (i: number, intensity: number): CapLight => ({ index: i, type: 'directional', intensity, x: 0, y: 0, z: 0 });
const pt = (i: number, x: number, intensity = 1): CapLight => ({ index: i, type: 'point', intensity, x, y: 0, z: 0 });

const bits = (mask: number) => {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) out.push(i);
  return out;
};

describe('globalKeptMask', () => {
  it('keeps EVERY ambient — they sum into one constant term and cost nothing', () => {
    const lights = [amb(0), amb(1), amb(2), dir(3, 5)];
    expect(bits(globalKeptMask(lights, LOW))).toEqual([0, 1, 2, 3]);
  });

  it('keeps only the MOST EFFECTIVE directional', () => {
    const lights = [dir(0, 1), dir(1, 9), dir(2, 4)];
    expect(bits(globalKeptMask(lights, LOW))).toEqual([1]);
  });

  it('ranks by intensity x colour LUMINANCE, not raw intensity', () => {
    // The case that makes this matter: the cap keeps exactly ONE directional, so picking a bright
    // deep-blue rim over a dimmer white key is the difference between a lit scene and a tinted
    // dark one. Blue's Rec.709 weight is 0.0722, so 2.0 blue loses to 1.0 white.
    const blueRim: CapLight = { index: 0, type: 'directional', intensity: 2, color: 0x0000ff, x: 0, y: 0, z: 0 };
    const whiteKey: CapLight = { index: 1, type: 'directional', intensity: 1, color: 0xffffff, x: 0, y: 0, z: 0 };
    expect(bits(globalKeptMask([blueRim, whiteKey], LOW))).toEqual([1]);
    expect(effectiveness(blueRim)).toBeLessThan(effectiveness(whiteKey));
  });

  it('a black light never wins — the sensible reading of "disabled by zeroing the colour"', () => {
    const black: CapLight = { index: 0, type: 'directional', intensity: 100, color: 0x000000, x: 0, y: 0, z: 0 };
    const dim: CapLight = { index: 1, type: 'directional', intensity: 0.01, color: 0xffffff, x: 0, y: 0, z: 0 };
    expect(bits(globalKeptMask([black, dim], LOW))).toEqual([1]);
  });

  it('defaults a missing colour to white rather than to black', () => {
    expect(effectiveness({ index: 0, type: 'directional', intensity: 1, x: 0, y: 0, z: 0 })).toBeCloseTo(1);
  });

  it('breaks intensity ties deterministically by index', () => {
    // Two equal lights must not swap between frames: a changed selection swaps a material
    // variant, which would strobe the scene.
    const lights = [dir(2, 3), dir(0, 3), dir(1, 3)];
    expect(bits(globalKeptMask(lights, LOW))).toEqual([0]);
    expect(bits(globalKeptMask([...lights].reverse(), LOW))).toEqual([0]); // order-independent
  });

  it('keeps every directional when uncapped (the high tier)', () => {
    const lights = [dir(0, 1), dir(1, 9), dir(2, 4)];
    expect(bits(globalKeptMask(lights, UNCAPPED))).toEqual([0, 1, 2]);
  });

  it('excludes point/spot — those are chosen per object', () => {
    expect(bits(globalKeptMask([amb(0), pt(1, 0), pt(2, 5)], LOW))).toEqual([0]);
  });
});

describe('maskForObject', () => {
  const lights = [amb(0), dir(1, 5), pt(2, 0), pt(3, 10), pt(4, 100)];
  const g = globalKeptMask(lights, LOW);

  it('adds the NEAREST local light to the global set', () => {
    expect(bits(maskForObject(lights, LOW, g, 0, 0, 0))).toEqual([0, 1, 2]);   // nearest = pt@0
    expect(bits(maskForObject(lights, LOW, g, 11, 0, 0))).toEqual([0, 1, 3]);  // nearest = pt@10
    expect(bits(maskForObject(lights, LOW, g, 90, 0, 0))).toEqual([0, 1, 4]);  // nearest = pt@100
  });

  it('THE BOUNDING PROPERTY: distinct selections are limited by LOCAL light count, not objects', () => {
    // 200 objects scattered across the scene, 3 local lights -> at most 3 distinct masks.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(maskForObject(lights, LOW, g, i * 0.7 - 20, 0, 0));
    expect(seen.size).toBeLessThanOrEqual(3);
  });

  it('breaks distance ties deterministically by index', () => {
    const tied = [pt(1, -5), pt(0, 5)]; // both 5 away from the origin
    expect(bits(maskForObject(tied, LOW, 0, 0, 0, 0))).toEqual([0]);
  });

  it('keeps every local light when uncapped', () => {
    expect(bits(maskForObject(lights, UNCAPPED, g, 0, 0, 0))).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles a scene with no local lights at all — the common case here', () => {
    // Every project except postfx-demo is pure ambient + directional.
    const noLocal = [amb(0), dir(1, 5), dir(2, 1)];
    const gm = globalKeptMask(noLocal, LOW);
    expect(bits(maskForObject(noLocal, LOW, gm, 3, 4, 5))).toEqual([0, 1]);
  });
});

describe('capChangesAnything', () => {
  it('is false when the scene is already under the cap — skip the whole path', () => {
    expect(capChangesAnything([amb(0), dir(1, 1), pt(2, 0)], LOW)).toBe(false);
  });

  it('is true when directionals exceed the cap', () => {
    expect(capChangesAnything([dir(0, 1), dir(1, 1)], LOW)).toBe(true);
  });

  it('is true when local lights exceed the cap', () => {
    expect(capChangesAnything([pt(0, 0), pt(1, 1)], LOW)).toBe(true);
  });

  it('is false for an uncapped tier no matter how many lights', () => {
    const many = Array.from({ length: 20 }, (_, i) => dir(i, 1));
    expect(capChangesAnything(many, UNCAPPED)).toBe(false);
  });

  it('ambient alone never trips it, however many there are', () => {
    const many = Array.from({ length: 10 }, (_, i) => amb(i));
    expect(capChangesAnything(many, LOW)).toBe(false);
  });
});

describe('canAutoCap', () => {
  it('disengages past the addressable-bit limit rather than capping the wrong set', () => {
    // A partial cap would silently drop whichever lights fell off the end of a 32-bit mask —
    // a rendering bug that looks like an art bug.
    expect(canAutoCap(MAX_CAPPABLE_LIGHTS)).toBe(true);
    expect(canAutoCap(MAX_CAPPABLE_LIGHTS + 1)).toBe(false);
  });
});
