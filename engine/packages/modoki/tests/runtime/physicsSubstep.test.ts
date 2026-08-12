/** physicsSubsteps — pure unit tests for the frame-delta → solver-step split.
 *
 *  See `physicsSubstep.ts`'s docblock for the spec: a CEILING on the step (none coarser than
 *  `MAX_PHYSICS_STEP_S`), not a fixed-dt accumulator, with a 5% `SPLIT_TOLERANCE` so a 60 Hz
 *  frame (which can float-round to a hair over 1/60) still resolves to exactly one step. */

import { describe, it, expect } from 'vitest';
import { physicsSubsteps, MAX_PHYSICS_STEP_S } from '../../src/runtime/physics/physicsSubstep';

describe('physicsSubsteps', () => {
  it('an exact 1/60 frame delta is one step', () => {
    const dt = 1 / 60;
    const { count, h } = physicsSubsteps(dt);
    expect(count).toBe(1);
    expect(h).toBe(dt);
  });

  it('a 60 Hz frame delta stays at one step even when float accumulation nudges it a hair over 1/60', () => {
    // A real `getSimDelta` is accumulated from repeated additions, not a clean `1/60` literal, so
    // it can land one ULP above MAX_PHYSICS_STEP_S — `dt / MAX_PHYSICS_STEP_S` evaluates to
    // 1.0000000000000133, not 1. A naive `Math.ceil` (no tolerance) would split this into 2 steps
    // for a frame that is, for every practical purpose, 60 Hz.
    const dt = 1 / 60 + Number.EPSILON;
    expect(dt).toBeGreaterThan(MAX_PHYSICS_STEP_S);
    expect(dt / MAX_PHYSICS_STEP_S).toBeGreaterThan(1); // confirms the float-precision trap is real
    const { count, h } = physicsSubsteps(dt);
    expect(count).toBe(1);
    expect(h).toBe(dt);
  });

  it('a 30 Hz frame delta splits into two ~1/60 steps', () => {
    const dt = 1 / 30;
    const { count, h } = physicsSubsteps(dt);
    expect(count).toBe(2);
    expect(h).toBeCloseTo(1 / 60, 12);
  });

  it('a 20ms (50 Hz) frame delta splits into two 10ms steps', () => {
    const dt = 1 / 50;
    const { count, h } = physicsSubsteps(dt);
    expect(count).toBe(2);
    expect(h).toBeCloseTo(0.01, 12);
  });

  it('zero delta produces no steps', () => {
    expect(physicsSubsteps(0)).toEqual({ count: 0, h: 0 });
  });

  it('a negative delta produces no steps', () => {
    expect(physicsSubsteps(-1 / 60)).toEqual({ count: 0, h: 0 });
  });

  it('NaN produces no steps', () => {
    expect(physicsSubsteps(NaN)).toEqual({ count: 0, h: 0 });
  });

  it('Infinity produces no steps', () => {
    expect(physicsSubsteps(Infinity)).toEqual({ count: 0, h: 0 });
  });

  it('invariant: count * h reconstructs dt, and h never exceeds the tolerant ceiling — across a spread of realistic deltas', () => {
    const deltas = [
      1 / 240, 1 / 144, 1 / 120, 1 / 90, 1 / 60, 1 / 50, 1 / 45, 1 / 40, 1 / 30,
      0.02, 0.0167, 0.0333, 1 / 24, 1 / 15,
    ];
    for (const dt of deltas) {
      const { count, h } = physicsSubsteps(dt);
      expect(count).toBeGreaterThanOrEqual(1);
      // No simulation time created or lost.
      expect(count * h).toBeCloseTo(dt, 12);
      // Never coarser than the ceiling (with the same 5% slack the split itself uses).
      expect(h).toBeLessThanOrEqual(MAX_PHYSICS_STEP_S * 1.05 + 1e-12);
    }
  });
});
