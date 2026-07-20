/**
 * particles F5 — CpuTslBackend live timing edits re-baseline the emission clock.
 *
 * Changing looping/duration/bursts via setDef keeps geometry/buffers (not a full
 * rebuild) but must reset the sim's emission clock — otherwise the burst-crossing
 * window (`time % cycle`) straddles the old/new cycle boundary for one cycle,
 * double-firing or skipping a burst. A non-timing, non-structural edit must NOT
 * reset (live particles are preserved). The real backend builds SpriteNodeMaterial
 * billboards via TSL/WebGPU, so GPU-construction modules + the sim are faked
 * (mirrors particleBackendPauseResume.test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const h = vi.hoisted(() => ({ resetCalls: 0 }));

vi.mock('../../src/runtime/loaders/textureResolver', () => ({ loadTexture3D: vi.fn(() => Promise.resolve({ dispose: vi.fn() })), releaseTexture3D: vi.fn((t?: { dispose?: () => void }) => t?.dispose?.()) }));
vi.mock('../../src/runtime/particles/spriteBillboard', () => ({
  createBillboard: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/meshParticles', () => ({
  createMeshParticles: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/trailLines', () => ({
  createTrail: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/particleCache', () => ({ getParticleEffect: () => null }));
vi.mock('../../src/runtime/particles/cpuSimulator', () => ({
  CpuParticleSim: class {
    step() { return 0; }
    setDef() {} setSpeedScale() {} setEmitterMatrix() {} injectAt() {}
    reset() { h.resetCalls++; }
    get aliveCount() { return 0; }
    get birthEvents() { return [] as number[]; }
    get deathEvents() { return [] as number[]; }
  },
}));

import { CpuTslBackend } from '../../src/runtime/particles/cpuTslBackend';

// A baseline non-looping def (so toggling `looping` is a real change) with a billboard
// render mode (non-structural edits below keep geometry stable).
const baseDef = (): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  looping: false,
  duration: 5,
  emission: { rateOverTime: 50, bursts: [{ time: 0, count: 10 }] },
  render: { blend: 'additive' },
}) as ParticleEffectDef;

beforeEach(() => { h.resetCalls = 0; });

describe('CpuTslBackend live timing edits (F5)', () => {
  it('re-baselines the emission clock when duration changes (non-structural)', () => {
    const be = new CpuTslBackend();
    const handle = be.create(baseDef());
    be.update(handle, 0.1); // advance simTime off zero
    h.resetCalls = 0;       // ignore any reset from build()/create()

    be.setDef(handle, { ...baseDef(), duration: 2 });
    expect(h.resetCalls).toBe(1); // emission clock reset for the new cycle
  });

  it('re-baselines when looping toggles', () => {
    const be = new CpuTslBackend();
    const handle = be.create(baseDef());
    h.resetCalls = 0;

    be.setDef(handle, { ...baseDef(), looping: true });
    expect(h.resetCalls).toBe(1);
  });

  it('re-baselines when the burst list changes', () => {
    const be = new CpuTslBackend();
    const handle = be.create(baseDef());
    h.resetCalls = 0;

    be.setDef(handle, { ...baseDef(), emission: { rateOverTime: 50, bursts: [{ time: 1, count: 10 }] } });
    expect(h.resetCalls).toBe(1);
  });

  it('does NOT reset on a non-timing, non-structural edit (live particles preserved)', () => {
    const be = new CpuTslBackend();
    const handle = be.create(baseDef());
    h.resetCalls = 0;

    // rateOverTime is neither geometry-structural nor a timing field.
    be.setDef(handle, { ...baseDef(), emission: { rateOverTime: 999, bursts: [{ time: 0, count: 10 }] } });
    expect(h.resetCalls).toBe(0);
  });
});
