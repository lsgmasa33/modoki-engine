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
  MAX_CAPPABLE_LIGHTS, ALL_LIGHTS_MASK, effectiveness, type CapLight, type LightCaps,
} from '../../src/runtime/rendering/autoLightCap';
import {
  resolveTierOverrides, type TierRenderOverrides,
} from '../../src/runtime/rendering/qualityTier';

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

  describe('hysteresis (#353)', () => {
    const WITH_MARGIN: LightCaps = { maxDirectional: 1, maxLocal: 1, hysteresisMargin: 0.2 };

    it('margin 0 (the default) behaves exactly like the memoryless rule', () => {
      // dir(1) is a hair ahead of dir(0) — with no margin the incumbent gets no help.
      expect(bits(globalKeptMask([dir(0, 10), dir(1, 10.01)], LOW, ALL_LIGHTS_MASK, 1 /* dir(0) was kept */)))
        .toEqual([1]);
    });

    it('keeps the incumbent through a near tie that would otherwise flap every frame', () => {
      const incumbent = 1 << 0; // dir(0) was kept last frame
      // dir(1) edges ahead by less than the 20% margin — an index tie-break alone cannot help
      // here because there is no exact tie, just a challenger that is barely, not clearly, better.
      expect(bits(globalKeptMask([dir(0, 10), dir(1, 11)], WITH_MARGIN, ALL_LIGHTS_MASK, incumbent)))
        .toEqual([0]);
    });

    it('still lets a CLEAR winner take over — margin damps flap, it does not freeze the scene', () => {
      const incumbent = 1 << 0;
      expect(bits(globalKeptMask([dir(0, 10), dir(1, 20)], WITH_MARGIN, ALL_LIGHTS_MASK, incumbent)))
        .toEqual([1]);
    });

    it('has no incumbent to protect the first time it runs (previousMask 0)', () => {
      expect(bits(globalKeptMask([dir(0, 10), dir(1, 11)], WITH_MARGIN))).toEqual([1]);
    });
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

  describe('hysteresis (#353)', () => {
    // pt(2,0) at x=0, pt(3,10) at x=10 — an object at x=5.2 is a near tie (d²=27.04 vs 23.04, an
    // 8% gap) that would flap every frame as the object drifts, well inside the 20% margin.
    const WITH_MARGIN: LightCaps = { maxDirectional: 1, maxLocal: 1, hysteresisMargin: 0.2 };

    it('keeps the incumbent local light through a near tie', () => {
      const incumbentIsPt2 = 1 << 2;
      expect(bits(maskForObject(lights, WITH_MARGIN, g, 5.2, 0, 0, ALL_LIGHTS_MASK, incumbentIsPt2)))
        .toEqual([0, 1, 2]); // pt(2) kept despite pt(3) now being nominally nearer
    });

    it('still hands off once the challenger is clearly nearer, not just nominally', () => {
      const incumbentIsPt2 = 1 << 2;
      // At x=9 pt(3) (x=10, d=1) is overwhelmingly closer than pt(2) (x=0, d=9) — far past any
      // reasonable margin, so the incumbent does not get to pin the object dark-side-out forever.
      expect(bits(maskForObject(lights, WITH_MARGIN, g, 9, 0, 0, ALL_LIGHTS_MASK, incumbentIsPt2)))
        .toEqual([0, 1, 3]);
    });

    it('margin 0 (the default) reproduces the plain nearest-N result exactly', () => {
      const incumbentIsPt2 = 1 << 2;
      expect(bits(maskForObject(lights, LOW, g, 5.2, 0, 0, ALL_LIGHTS_MASK, incumbentIsPt2)))
        .toEqual([0, 1, 3]); // no memory effect: pt(3) wins on raw distance as it would today
    });

    it('an out-of-range margin is clamped rather than freezing the selection forever (#353 review)', () => {
      // caps.hysteresisMargin >= 1 makes `d2 * (1 - margin)` <= 0, so a discounted incumbent would
      // win against ANY distance — a typo'd project config (e.g. `1.5`) would pin a light selection
      // permanently with no error anywhere. It must be clamped, not trusted.
      const incumbentIsPt2 = 1 << 2;
      const RUNAWAY: LightCaps = { maxDirectional: 1, maxLocal: 1, hysteresisMargin: 1.5 };
      // pt(4) at x=100 is overwhelmingly farther than pt(3) at x=10, from an object at x=9 — no
      // legitimate margin should let the far incumbent win here.
      expect(bits(maskForObject(lights, RUNAWAY, g, 9, 0, 0, ALL_LIGHTS_MASK, 1 << 4)))
        .toEqual([0, 1, 3]);
    });
  });
});

describe('the AUTHORED hysteresisMargin reaches the selection (#353)', () => {
  /** Every hysteresis test above builds its `LightCaps` BY HAND, so all of them would still pass
   *  if `resolveTierOverrides` dropped `hysteresisMargin` on the way out of a project's
   *  `project.config.json`. Nothing else covers that seam, and it cannot be covered by inspection:
   *  all 24 project configs author `0.15` and the engine's own `TIER_SETTINGS` default is also
   *  `0.15`, so **a value that coincides with the code default cannot tell "read" from "ignored"**
   *  (CLAUDE.md § authoring surfaces — every field you expose must be READ).
   *
   *  So these perturb it in BOTH directions through the real resolution path: one case only passes
   *  with a margin BELOW the default, the other only ABOVE it. No single wrong value — and in
   *  particular not the 0.15 default, and not 0 — satisfies both. */
  const authored = (low: Partial<TierRenderOverrides>) =>
    resolveTierOverrides('low', { low: low as TierRenderOverrides });

  // One incumbent, one challenger, `maxLocal: 1` — so exactly one survives and the assertion is
  // which. Object sits at x=10: the incumbent (x=0) is 10 away, the challenger is nearer.
  const near = [pt(0, 0), pt(1, 19.5)];   // challenger 9.5 away -> it wins only while margin < 0.0975
  const clear = [pt(0, 0), pt(1, 18)];    // challenger 8   away -> it wins only while margin < 0.36
  const INCUMBENT = 1 << 0;
  const pick = (lights: CapLight[], margin: number | undefined) => bits(
    maskForObject(lights, authored({ maxLocal: 1, maxDirectional: 0, hysteresisMargin: margin }),
      0, 10, 0, 0, ALL_LIGHTS_MASK, INCUMBENT));

  it('an authored margin BELOW the default lets a challenger through that the default would hold', () => {
    expect(pick(near, 0.05)).toEqual([1]);   // authored 0.05 < 0.0975 -> challenger takes over
    expect(pick(near, 0.15)).toEqual([0]);   // the default's own behaviour, for contrast
  });

  it('an authored margin ABOVE the default holds an incumbent the default would release', () => {
    expect(pick(clear, 0.6)).toEqual([0]);   // authored 0.6 > 0.36 -> incumbent held
    expect(pick(clear, 0.15)).toEqual([1]);  // the default's own behaviour, for contrast
  });

  it('a tier block that OMITS the field gets hysteresis off, not the engine default', () => {
    // `hysteresisMargin` is not in `UNCLAMPED_OVERRIDES`, so `complete()` injects nothing for it —
    // absent resolves to `undefined`, which `clampMargin` reads as 0. Worth pinning because the
    // seeded fleet all carry the field today, so the omission path is otherwise unexercised.
    //
    // ⚠️ The key must be ABSENT, not present-and-undefined. `complete()` merges with
    // `{ ...UNCLAMPED_OVERRIDES, ...o }` (`qualityTier.ts`), where a present `undefined`
    // OVERWRITES a default and an absent key INHERITS it — so the two differ under exactly the
    // change this guards. Written the other way first, and the close-out review measured it
    // passing: adding `hysteresisMargin: 0.15` to `UNCLAMPED_OVERRIDES` left all 30 tests green.
    const omitted = maskForObject(
      near, authored({ maxLocal: 1, maxDirectional: 0 }), 0, 10, 0, 0, ALL_LIGHTS_MASK, INCUMBENT);
    expect(bits(omitted)).toEqual([1]);
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
