/** curveEval unit tests — Hermite/stepped/clamp + tangent presets. */

import { describe, it, expect } from 'vitest';
import {
  evalTrack, evalColorTrack, evalBooleanTrack, evalSteppedTrack, evalTrackValue,
  findKeyIndex, applyTangentMode,
} from '../../src/runtime/animation/curveEval';
import { STEPPED, type Keyframe, type AnimationTrack } from '../../src/runtime/animation/types';

const k = (t: number, v: number, inT = 0, outT = 0): Keyframe => ({ t, v, inTangent: inT, outTangent: outT });

describe('curveEval.findKeyIndex', () => {
  const keys = [k(0, 0), k(1, 1), k(2, 2)];
  it('returns -1 before first key', () => expect(findKeyIndex(keys, -0.5)).toBe(-1));
  it('finds exact and between keys', () => {
    expect(findKeyIndex(keys, 0)).toBe(0);
    expect(findKeyIndex(keys, 1.5)).toBe(1);
    expect(findKeyIndex(keys, 5)).toBe(2);
  });
});

describe('curveEval.evalTrack', () => {
  it('empty → 0, single key → constant', () => {
    expect(evalTrack([], 3)).toBe(0);
    expect(evalTrack([k(0, 7)], 3)).toBe(7);
  });

  it('clamps before first / after last key', () => {
    const keys = [k(1, 10), k(2, 20)];
    expect(evalTrack(keys, 0)).toBe(10);
    expect(evalTrack(keys, 9)).toBe(20);
  });

  it('linear (zero-tangent flat) interpolates… as smoothstep, endpoints exact', () => {
    const keys = [k(0, 0, 0, 0), k(1, 10, 0, 0)];
    expect(evalTrack(keys, 0)).toBeCloseTo(0);
    expect(evalTrack(keys, 1)).toBeCloseTo(10);
    // With flat tangents the Hermite midpoint is the smoothstep value (0.5 → 5).
    expect(evalTrack(keys, 0.5)).toBeCloseTo(5, 5);
  });

  it('true linear with secant tangents is a straight line', () => {
    // out/in tangent = slope (10 over 1s) → exact linear ramp.
    const keys = [k(0, 0, 10, 10), k(1, 10, 10, 10)];
    expect(evalTrack(keys, 0.25)).toBeCloseTo(2.5, 5);
    expect(evalTrack(keys, 0.5)).toBeCloseTo(5, 5);
    expect(evalTrack(keys, 0.75)).toBeCloseTo(7.5, 5);
  });

  it('stepped (Infinity out-tangent) holds the left value', () => {
    const keys = [k(0, 0, 0, STEPPED), k(1, 100)];
    expect(evalTrack(keys, 0.0)).toBe(0);
    expect(evalTrack(keys, 0.99)).toBe(0);
    expect(evalTrack(keys, 1)).toBe(100);
  });

  it('handles a multi-segment curve, monotonic time', () => {
    const keys = [k(0, 0, 0, 0), k(1, 10, 0, 0), k(2, 0, 0, 0)];
    expect(evalTrack(keys, 1)).toBeCloseTo(10);
    expect(evalTrack(keys, 0.5)).toBeGreaterThan(0);
    expect(evalTrack(keys, 1.5)).toBeGreaterThan(0);
  });

  it('weighted tangents: handle length reshapes the curve (heavier out-weight pulls toward start value)', () => {
    const base = [k(0, 0, 0, 0), k(1, 10, 0, 0)];
    // Large outgoing weight on the left key holds the curve near 0 longer.
    const heavy: Keyframe[] = [{ t: 0, v: 0, inTangent: 0, outTangent: 0, outWeight: 0.9 }, k(1, 10, 0, 0)];
    const baseMid = evalTrack(base, 0.5);
    const heavyMid = evalTrack(heavy, 0.5);
    expect(heavyMid).toBeLessThan(baseMid); // held lower at the midpoint
    expect(evalTrack(heavy, 0)).toBeCloseTo(0);
    expect(evalTrack(heavy, 1)).toBeCloseTo(10);
  });

  it('default weights still match the Hermite-equivalent endpoints exactly', () => {
    const keys = [k(0, 0, 5, 5), k(1, 5, 5, 5)]; // slope 5 over 1s = secant → straight line
    expect(evalTrack(keys, 0.5)).toBeCloseTo(2.5, 4);
  });

  it('F3: outWeight + inWeight > 1 stays monotonic (no wrong-root jump)', () => {
    // Two heavy handles (sum 1.8 > 1) make the raw x-map non-monotonic. The sum
    // clamp + bisection fallback must keep the solve on the correct branch:
    // evaluate a rising 0→10 ramp at increasing times and assert it never jumps
    // backwards and stays within the value range, with exact endpoints.
    const keys: Keyframe[] = [
      { t: 0, v: 0, inTangent: 10, outTangent: 10, outWeight: 0.9 },
      { t: 1, v: 10, inTangent: 10, outTangent: 10, inWeight: 0.9 },
    ];
    expect(evalTrack(keys, 0)).toBeCloseTo(0, 5);
    expect(evalTrack(keys, 1)).toBeCloseTo(10, 5);
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = evalTrack(keys, Math.min(t, 1));
      expect(v).toBeGreaterThanOrEqual(-1e-4); // within range, no wild root
      expect(v).toBeLessThanOrEqual(10 + 1e-4);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6); // monotonic non-decreasing
      prev = v;
    }
  });
});

describe('curveEval.evalColorTrack', () => {
  it('lerps per channel', () => {
    const keys = [k(0, 0x000000), k(1, 0xffffff)];
    expect(evalColorTrack(keys, 0)).toBe(0x000000);
    expect(evalColorTrack(keys, 1)).toBe(0xffffff);
    expect(evalColorTrack(keys, 0.5)).toBe(0x808080);
  });
  it('interpolates a single channel', () => {
    const keys = [k(0, 0xff0000), k(1, 0x00ff00)];
    const mid = evalColorTrack(keys, 0.5);
    expect((mid >> 16) & 0xff).toBeCloseTo(0x80, -1);
    expect((mid >> 8) & 0xff).toBeCloseTo(0x80, -1);
  });

  it('F4: STEPPED out-tangent holds the left colour (snap, no fade)', () => {
    // Authored stepped key: must snap, not cross-fade through grey.
    const keys = [k(0, 0x000000, 0, STEPPED), k(1, 0xffffff)];
    expect(evalColorTrack(keys, 0)).toBe(0x000000);
    expect(evalColorTrack(keys, 0.5)).toBe(0x000000); // held, NOT 0x808080
    expect(evalColorTrack(keys, 0.99)).toBe(0x000000);
    expect(evalColorTrack(keys, 1)).toBe(0xffffff);
  });
});

describe('curveEval.evalBooleanTrack', () => {
  it('steps between 0 and 1', () => {
    const keys = [k(0, 0), k(1, 1), k(2, 0)];
    expect(evalBooleanTrack(keys, 0.5)).toBe(0);
    expect(evalBooleanTrack(keys, 1)).toBe(1);
    expect(evalBooleanTrack(keys, 1.9)).toBe(1);
    expect(evalBooleanTrack(keys, 2)).toBe(0);
  });
});

describe('curveEval.evalSteppedTrack (enum)', () => {
  it('holds the most recent key index without squashing to 0/1', () => {
    const keys = [k(0, 0), k(1, 2), k(2, 1)];
    expect(evalSteppedTrack(keys, 0.5)).toBe(0);
    expect(evalSteppedTrack(keys, 1)).toBe(2);   // multi-option index survives
    expect(evalSteppedTrack(keys, 1.9)).toBe(2);
    expect(evalSteppedTrack(keys, 2)).toBe(1);
  });

  it('F4: enum holds the left index regardless of authored tangent (discrete, no ramp)', () => {
    // Even with a non-zero out-tangent authored, enums are discrete → hold the
    // left index until the next key (F4 prescribes only the color-STEPPED fix).
    const keys = [k(0, 0, 0, 3), k(1, 3, 3, 0)];
    expect(evalSteppedTrack(keys, 0.5)).toBe(0);
    expect(evalSteppedTrack(keys, 1)).toBe(3);
  });

  it('F4: a flat (default) enum key still hard-steps', () => {
    const keys = [k(0, 0), k(1, 2)]; // out-tangent 0 → hold left index
    expect(evalSteppedTrack(keys, 0.5)).toBe(0);
    expect(evalSteppedTrack(keys, 1)).toBe(2);
  });
});

describe('curveEval.evalTrackValue dispatch', () => {
  it('routes by track type', () => {
    const color: AnimationTrack = { path: '', trait: 'Tint', field: 'color', type: 'color', keys: [k(0, 0x000000), k(1, 0xffffff)] };
    const bool: AnimationTrack = { path: '', trait: 'X', field: 'on', type: 'boolean', keys: [k(0, 0), k(1, 1)] };
    const enm: AnimationTrack = { path: '', trait: 'Canvas2D', field: 'scaleMode', type: 'enum', keys: [k(0, 0), k(1, 2)] };
    expect(evalTrackValue(color, 0.5)).toBe(0x808080);
    expect(evalTrackValue(bool, 1)).toBe(1);
    expect(evalTrackValue(enm, 1)).toBe(2);   // stepped, raw index
  });
});

describe('curveEval.applyTangentMode', () => {
  it('constant sets stepped out-tangent', () => {
    const keys = [k(0, 0), k(1, 10)];
    applyTangentMode(keys, 0, 'constant');
    expect(keys[0].outTangent).toBe(STEPPED);
    expect(evalTrack(keys, 0.5)).toBe(0);
  });
  it('linear sets secant slopes to neighbors', () => {
    const keys = [k(0, 0), k(1, 10), k(2, 30)];
    applyTangentMode(keys, 1, 'linear');
    expect(keys[1].inTangent).toBeCloseTo(10); // (10-0)/(1-0)
    expect(keys[1].outTangent).toBeCloseTo(20); // (30-10)/(2-1)
  });
  it('auto sets a smooth slope through surrounding keys', () => {
    const keys = [k(0, 0), k(1, 10), k(2, 0)];
    applyTangentMode(keys, 1, 'auto');
    expect(keys[1].inTangent).toBeCloseTo(0); // (0-0)/(2-0)
    expect(keys[1].outTangent).toBeCloseTo(0);
    expect(keys[1].broken).toBe(false);
  });
});

describe('normalizeAnimationClip — tangent defaulting (F8)', () => {
  it('defaults missing in/out tangents to 0 so legacy keys interpolate smoothly, not stepped', async () => {
    const { normalizeAnimationClip } = await import('../../src/runtime/animation/types');
    // A hand-authored/legacy clip whose keys omit inTangent/outTangent entirely.
    const partial = {
      tracks: [{
        path: '', trait: 'Transform', field: 'x', type: 'number' as const,
        keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] as any,
      }],
    };
    const clip = normalizeAnimationClip(partial);
    const keys = clip.tracks[0].keys;
    expect(keys[0].inTangent).toBe(0);
    expect(keys[0].outTangent).toBe(0);
    // Midpoint must interpolate (≈5), NOT hold the left value (0) as a stepped key would.
    const mid = evalTrack(keys, 0.5);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(8);
  });

  it('preserves STEPPED (+Infinity) tangents', async () => {
    const { normalizeAnimationClip } = await import('../../src/runtime/animation/types');
    const clip = normalizeAnimationClip({
      tracks: [{
        path: '', trait: 'Transform', field: 'x', type: 'number' as const,
        keys: [{ t: 0, v: 0, inTangent: 0, outTangent: STEPPED }, { t: 1, v: 10, inTangent: 0, outTangent: 0 }],
      }],
    });
    expect(clip.tracks[0].keys[0].outTangent).toBe(STEPPED);
    expect(evalTrack(clip.tracks[0].keys, 0.5)).toBe(0); // held (stepped)
  });

  it('reconstructs STEPPED from tangentMode:constant across a JSON round-trip', async () => {
    const { normalizeAnimationClip } = await import('../../src/runtime/animation/types');
    // JSON.stringify(Infinity) === "null" — so a saved stepped key loses its out-tangent.
    // The persistent marker is tangentMode:'constant' (applyTangentMode sets both). Simulate
    // the round-trip and confirm the hold is reconstructed instead of degrading to linear.
    const authored = normalizeAnimationClip({
      tracks: [{
        path: '', trait: 'Transform', field: 'x', type: 'number' as const,
        keys: [
          { t: 0, v: 0, inTangent: 0, outTangent: STEPPED, tangentMode: 'constant' as const },
          { t: 1, v: 10, inTangent: 0, outTangent: 0 },
        ],
      }],
    });
    const roundTripped = normalizeAnimationClip(JSON.parse(JSON.stringify(authored)));
    // After JSON the raw outTangent is null; normalize must restore +Infinity from the mode.
    expect(roundTripped.tracks[0].keys[0].outTangent).toBe(STEPPED);
    expect(evalTrack(roundTripped.tracks[0].keys, 0.5)).toBe(0); // still held, not ≈5
  });
});
