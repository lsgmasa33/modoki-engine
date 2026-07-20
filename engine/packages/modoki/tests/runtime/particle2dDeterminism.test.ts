/**
 * 2D particle path determinism (2d-particles-plan Phase 0). Proves the renderer-agnostic CPU sim
 * runs a 2D-flavored effect (polyline emitter, additive blend, alignToVelocity) headlessly and
 * reproducibly: same seed → byte-identical outputs, no wall-clock/Math.random. If this ever drifts,
 * the 2D backend can't be trusted to replay the same frames headlessly.
 */

import { describe, it, expect } from 'vitest';
import { CpuParticleSim, type ParticleOutputs } from '../../src/runtime/particles/cpuSimulator';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

function makeOutputs(max: number): ParticleOutputs {
  return {
    offsets: new Float32Array(max * 3),
    scales: new Float32Array(max),
    colors: new Float32Array(max * 3),
    opacities: new Float32Array(max),
    rotations: new Float32Array(max),
    frames: new Float32Array(max),
  };
}

function make2dDef(): ParticleEffectDef {
  return {
    ...defaultParticleEffect(),
    maxParticles: 500,
    looping: true,
    gravity: 0.5,
    emission: { rateOverTime: 200 },
    shape: { type: 'polyline', points: [[-20, 0], [20, 0], [20, 20]] },
    render: { ...defaultParticleEffect().render, blend: 'additive', alignToVelocity: true },
  } as ParticleEffectDef;
}

function hasNaN(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) return true;
  return false;
}

describe('2D particle path determinism', () => {
  it('is bit-identical across two same-seed runs of the polyline/additive/alignToVelocity effect', () => {
    const SEED = 1234;
    const FRAMES = 90;
    const DT = 1 / 60;

    const outA = makeOutputs(500);
    const outB = makeOutputs(500);
    const simA = new CpuParticleSim(make2dDef(), outA, SEED);
    const simB = new CpuParticleSim(make2dDef(), outB, SEED);

    let aliveA = 0;
    let aliveB = 0;
    for (let f = 0; f < FRAMES; f++) {
      aliveA = simA.step(DT);
      aliveB = simB.step(DT);
    }

    // The 2D path actually produced particles.
    expect(aliveA).toBeGreaterThan(0);
    expect(aliveB).toBe(aliveA);

    // Deep, exact element-wise equality — determinism (no wall-clock / no Math.random).
    expect(Array.from(outA.offsets)).toEqual(Array.from(outB.offsets));
    expect(Array.from(outA.rotations)).toEqual(Array.from(outB.rotations));
    expect(Array.from(outA.opacities)).toEqual(Array.from(outB.opacities));
  });

  it('produces no NaN in any output buffer', () => {
    const out = makeOutputs(500);
    const sim = new CpuParticleSim(make2dDef(), out, 4321);
    let alive = 0;
    for (let f = 0; f < 90; f++) alive = sim.step(1 / 60);

    expect(alive).toBeGreaterThan(0);
    expect(hasNaN(out.offsets)).toBe(false);
    expect(hasNaN(out.scales)).toBe(false);
    expect(hasNaN(out.colors)).toBe(false);
    expect(hasNaN(out.opacities)).toBe(false);
    expect(hasNaN(out.rotations)).toBe(false);
    expect(hasNaN(out.frames)).toBe(false);
  });
});
