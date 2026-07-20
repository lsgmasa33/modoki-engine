/**
 * Phase 0 (2D particles) — align-to-velocity rotation output of the CPU sim.
 *
 * When `render.alignToVelocity` is set, the CPU simulator writes each particle's
 * output rotation as `atan2(vy, vx) + startRotationOffset` (radians) instead of the
 * raw spin. We drive this deterministically with `injectAt`: a `'point'` shape with
 * `startSpeed {0,0}` (and gravity/drag/forces/rotationSpeed all zero) means the
 * particle's velocity equals exactly the injected vector, so the expected angle is
 * a closed form.
 */

import { describe, it, expect } from 'vitest';
import { CpuParticleSim, type ParticleOutputs } from '../../src/runtime/particles/cpuSimulator';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const MAX = 8;

function makeOutputs(): ParticleOutputs {
  return {
    offsets: new Float32Array(MAX * 3),
    scales: new Float32Array(MAX),
    colors: new Float32Array(MAX * 3),
    opacities: new Float32Array(MAX),
    rotations: new Float32Array(MAX),
    frames: new Float32Array(MAX),
  };
}

/** A def with all motion/rotation sources zeroed so injected velocity is the ONLY input. */
function makeDef(overrides: Partial<ParticleEffectDef> = {}): ParticleEffectDef {
  return {
    ...defaultParticleEffect(),
    maxParticles: MAX,
    shape: { type: 'point' },
    emission: { rateOverTime: 0 },
    startLifetime: { min: 100, max: 100 },
    startSpeed: { min: 0, max: 0 },
    startSize: { min: 1, max: 1 },
    startRotation: { min: 0, max: 0 },
    rotationSpeed: { min: 0, max: 0 },
    gravity: 0,
    drag: 0,
    forces: [],
    sizeOverLife: undefined,
    opacityOverLife: undefined,
    rotationOverLife: undefined,
    render: { blend: 'normal' },
    ...overrides,
  };
}

const DT = 1e-4; // tiny so gravity/drag (0 here anyway) can't perturb velocity

describe('CpuParticleSim align-to-velocity rotation output', () => {
  it('aligns to atan2(vy, vx) for velocity (3,4,0)', () => {
    const out = makeOutputs();
    const sim = new CpuParticleSim(makeDef({ render: { blend: 'normal', alignToVelocity: true } }), out);
    expect(sim.injectAt(0, 0, 0, 3, 4, 0)).toBe(true);
    sim.step(DT);
    expect(out.rotations[0]).toBeCloseTo(Math.atan2(4, 3), 5);
  });

  it('aligns to +PI/2 for straight-up velocity (0,5,0)', () => {
    const out = makeOutputs();
    const sim = new CpuParticleSim(makeDef({ render: { blend: 'normal', alignToVelocity: true } }), out);
    expect(sim.injectAt(0, 0, 0, 0, 5, 0)).toBe(true);
    sim.step(DT);
    expect(out.rotations[0]).toBeCloseTo(Math.PI / 2, 5);
  });

  it('does NOT align when alignToVelocity is false (rotation stays 0)', () => {
    const out = makeOutputs();
    const sim = new CpuParticleSim(makeDef({ render: { blend: 'normal' } }), out);
    expect(sim.injectAt(0, 0, 0, 3, 4, 0)).toBe(true);
    sim.step(DT);
    expect(out.rotations[0]).toBeCloseTo(0, 5);
  });

  it('adds startRotation as an additive offset on top of the aligned angle', () => {
    // NOTE: `startRotation` is authored in DEGREES (types.ts: `startRotation?: MinMax; // degrees`)
    // and the sim converts to radians (rot = deg * DEG2RAD) before the align-to-velocity add. So a
    // startRotation of 0.1 (degrees) contributes an offset of 0.1 * PI/180 radians, not a raw 0.1.
    const DEG2RAD = Math.PI / 180;
    const out = makeOutputs();
    const sim = new CpuParticleSim(
      makeDef({ startRotation: { min: 0.1, max: 0.1 }, render: { blend: 'normal', alignToVelocity: true } }),
      out,
    );
    expect(sim.injectAt(0, 0, 0, 3, 4, 0)).toBe(true);
    sim.step(DT);
    expect(out.rotations[0]).toBeCloseTo(Math.atan2(4, 3) + 0.1 * DEG2RAD, 5);
  });
});
