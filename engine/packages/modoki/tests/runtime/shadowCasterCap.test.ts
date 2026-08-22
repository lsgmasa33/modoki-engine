/** The shadow-caster cap's pure rule (#229).
 *
 *  What is worth pinning here is not "it keeps N" — it is the two decisions that are easy to
 *  regress into something that still looks correct: that ranking never compares a spot's
 *  intensity against a directional's (they are different units), and that the cap DISENGAGES
 *  rather than doing something arbitrary when it has nothing to do. */

import { describe, it, expect } from 'vitest';
import { keptShadowCasters, effectiveness, type ShadowCaster } from '../../src/runtime/rendering/shadowCasterCap';
import { effectiveness as capEffectiveness } from '../../src/runtime/rendering/autoLightCap';

const spot = (id: number, intensity: number, color?: number): ShadowCaster =>
  ({ id, type: 'spot', intensity, ...(color === undefined ? {} : { color }) });
const dir = (id: number, intensity: number): ShadowCaster => ({ id, type: 'directional', intensity });

describe('when the cap disengages', () => {
  it('returns null for an unlimited cap, however many casters there are', () => {
    expect(keptShadowCasters([spot(1, 10), spot(2, 10), spot(3, 10)], 0)).toBeNull();
  });

  it('returns null when the scene is already under the cap — the caller skips the whole path', () => {
    // The fleet case: 52 of 53 committed scenes have at most one caster, and they must not pay a
    // Set allocation or a per-light lookup for a cap that can never bite.
    expect(keptShadowCasters([spot(1, 10)], 2)).toBeNull();
    expect(keptShadowCasters([spot(1, 10), spot(2, 10)], 2)).toBeNull();
    expect(keptShadowCasters([], 1)).toBeNull();
  });

  it('treats a negative cap as unlimited, NOT as "no shadows"', () => {
    // A tier that wants no shadows says `shadows: false`. Reading a typo'd negative as a global
    // shadow kill would be a far worse failure than ignoring it.
    expect(keptShadowCasters([spot(1, 10), spot(2, 10)], -1)).toBeNull();
  });
});

describe('which casters survive', () => {
  it('keeps the most effective, and exactly as many as the cap allows', () => {
    const kept = keptShadowCasters([spot(1, 70), spot(2, 120), spot(3, 90)], 2);
    expect(kept).not.toBeNull();
    expect([...kept!].sort()).toEqual([2, 3]);
  });

  it('ranks a DIRECTIONAL ahead of every local, whatever the raw intensities say', () => {
    // The load-bearing case. three's spot/point intensity is in candela and a directional's is
    // not: postfx-demo authors spots at 70-120 where a typical sun is 1-5. One shared ranking
    // would hand every slot to the spots and drop the scene-wide shadow every time.
    const kept = keptShadowCasters([spot(1, 120), spot(2, 90), dir(3, 2)], 1);
    expect([...kept!]).toEqual([3]);
  });

  it('spends the slots on EVERY directional before any local', () => {
    // Both directionals fill a cap of 2 and the 500-candela spot gets nothing — the point of the
    // rule, not a rounding artefact of it.
    const kept = keptShadowCasters([spot(1, 500), dir(2, 1), dir(3, 4)], 2);
    expect([...kept!].sort()).toEqual([2, 3]);
  });

  it('fills the remaining slots with the most effective locals', () => {
    const kept = keptShadowCasters([spot(1, 70), dir(2, 3), spot(3, 90)], 2);
    expect([...kept!].sort()).toEqual([2, 3]);          // the directional, then the brighter spot
  });

  it('orders directionals among themselves by effectiveness', () => {
    const kept = keptShadowCasters([dir(1, 1), dir(2, 4), dir(3, 2)], 1);
    expect([...kept!]).toEqual([2]);
  });

  it('breaks ties in SCENE ORDER — an equal pair must not swap between frames', () => {
    // Changing which lights cast rebuilds the material's ShadowNode set, i.e. a runtime shader
    // recompile. A tiebreak that could go either way would make that a per-frame risk.
    const casters = [spot(7, 50), spot(3, 50), spot(9, 50)];
    for (let i = 0; i < 5; i++) expect([...keptShadowCasters(casters, 2)!]).toEqual([7, 3]);
  });

  it('never lets a black light take a slot from one that emits', () => {
    // Zeroing the colour is how a light gets disabled without deleting it; scoring 0 is what
    // stops it from silently consuming the scene's only shadow slot.
    const kept = keptShadowCasters([spot(1, 999, 0x000000), spot(2, 10)], 1);
    expect([...kept!]).toEqual([2]);
  });

  it('prefers a white key over a brighter deep-blue rim', () => {
    const kept = keptShadowCasters([spot(1, 2, 0x0000ff), spot(2, 1, 0xffffff)], 1);
    expect([...kept!]).toEqual([2]);
  });
});

describe('a cap that is not a whole number', () => {
  it('keeps FLOOR(max), not one more — 2.5 means two', () => {
    // `kept.size >= 2.5` first holds at 3, and the editor's number input has no `step`, so a
    // fractional cap is reachable by typing rather than hypothetical.
    expect(keptShadowCasters([spot(1, 40), spot(2, 30), spot(3, 20), spot(4, 10)], 2.5)!.size).toBe(2);
  });

  it('never floors down to the UNLIMITED sentinel — 0.5 keeps one, not everything', () => {
    // 0 means unlimited everywhere in the tier table, so a bare floor would turn the tightest
    // possible cap into no cap at all.
    const kept = keptShadowCasters([spot(1, 40), spot(2, 30)], 0.5);
    expect(kept).not.toBeNull();
    expect([...kept!]).toEqual([1]);
  });
});

describe('effectiveness', () => {
  it('is intensity scaled by Rec. 709 luminance, and defaults to white', () => {
    expect(effectiveness(spot(1, 3))).toBeCloseTo(3, 9);
    expect(effectiveness(spot(1, 1, 0x00ff00))).toBeCloseTo(0.7152, 6);
    expect(effectiveness(spot(1, 1, 0x000000))).toBe(0);
  });
});

describe('the deliberate copy of `effectiveness` must not DRIFT from its original', () => {
  it('agrees with autoLightCap\'s copy on every input shape either one ranks', () => {
    // `autoLightCap.effectiveness` is duplicated here rather than imported, because that one takes
    // a `CapLight` carrying a bitmask index and a world position this rule has no use for (see the
    // module header). The DUPLICATION is deliberate; DIVERGENCE would not be. If the two ever
    // disagree, the light chosen to SHADE an object stops being the one chosen to CAST its shadow
    // — for the same scene, silently. Nothing else pins them together.
    for (const [intensity, color] of [[1, 0xffffff], [2, 0x0000ff], [999, 0x000000], [0, 0xff0000], [0.5, 0x00ff00]] as const) {
      expect(effectiveness({ id: 1, type: 'spot', intensity, color }))
        .toBeCloseTo(capEffectiveness({ index: 0, type: 'spot', intensity, color, x: 0, y: 0, z: 0 }), 12);
    }
    // ...and on the default-white path, which each reaches through its own `?? 0xffffff`.
    expect(effectiveness({ id: 1, type: 'spot', intensity: 3 }))
      .toBeCloseTo(capEffectiveness({ index: 0, type: 'spot', intensity: 3, x: 0, y: 0, z: 0 }), 12);
  });
});
