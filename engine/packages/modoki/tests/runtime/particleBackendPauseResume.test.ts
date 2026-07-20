/**
 * particles Missing-Test #7 — CpuTslBackend pause/resume: while paused, update() is a
 * no-op (the sim doesn't advance); play() resumes advancing. The real backend builds
 * SpriteNodeMaterial billboards via TSL/WebGPU, so the GPU-construction modules + the
 * sim are faked (mirrors particleBackendTextureDispose.test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const h = vi.hoisted(() => ({ stepCalls: 0 }));

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
    step() { h.stepCalls++; return 0; }
    setDef() {} reset() {} setSpeedScale() {} setEmitterMatrix() {} injectAt() {}
    get aliveCount() { return 0; }
    get birthEvents() { return [] as number[]; }
    get deathEvents() { return [] as number[]; }
  },
}));

import { CpuTslBackend } from '../../src/runtime/particles/cpuTslBackend';

const def = (): ParticleEffectDef => ({ ...defaultParticleEffect(), render: { blend: 'additive' } }) as ParticleEffectDef;

beforeEach(() => { h.stepCalls = 0; });

describe('CpuTslBackend pause/resume (Missing Test #7)', () => {
  it('advances while playing, freezes while paused, and resumes on play', () => {
    const be = new CpuTslBackend();
    const handle = be.create(def());

    be.update(handle, 0.1);
    expect(h.stepCalls).toBe(1); // playing by default → advanced

    be.pause(handle);
    be.update(handle, 0.1);
    be.update(handle, 0.1);
    expect(h.stepCalls).toBe(1); // paused → no further advance

    be.play(handle);
    be.update(handle, 0.1);
    expect(h.stepCalls).toBe(2); // resumed
  });
});
