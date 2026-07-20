/**
 * particles Missing-Test #2 — RouterParticleBackend.pick() routing matrix + one-time
 * fallback warn. The two real backends import three/webgpu, so they're replaced with
 * tagged fakes; getActiveRenderer is mocked to toggle WebGPU availability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const h = vi.hoisted(() => ({ created: [] as string[], renderer: null as unknown }));

const fake = (tag: string) => class {
  create() { h.created.push(tag); return { id: 1 }; }
  getObject3D() { return new THREE.Object3D(); }
  update() {} setTransform() {} setDef() {} play() {} pause() {} setSpeedScale() {}
  restart() {} seek() {} dispose() {}
};
vi.mock('../../src/runtime/particles/cpuTslBackend', () => ({ CpuTslBackend: fake('cpu') }));
vi.mock('../../src/runtime/particles/gpuComputeBackend', () => ({ GpuComputeBackend: fake('gpu') }));
vi.mock('../../src/runtime/loaders/textureResolver', () => ({ getActiveRenderer: () => h.renderer }));

const { particleBackend } = await import('../../src/runtime/particles/particleBackend');

const WEBGPU = { backend: { isWebGPUBackend: true } };
const def = (over: Partial<ParticleEffectDef>): ParticleEffectDef => ({
  ...defaultParticleEffect(), emission: { rateOverTime: 0, fillPool: true }, ...over,
}) as ParticleEffectDef;

beforeEach(() => { h.created = []; h.renderer = null; });

describe('RouterParticleBackend routing (Missing Test #2)', () => {
  it('routes simulation:cpu to the CPU backend', () => {
    h.renderer = WEBGPU;
    particleBackend.create(def({ simulation: 'cpu' }));
    expect(h.created).toEqual(['cpu']);
  });

  it('gpu request falls back to CPU when there is no WebGPU compute backend', () => {
    h.renderer = null;
    particleBackend.create(def({ simulation: 'gpu' }));
    expect(h.created).toEqual(['cpu']);
  });

  it('gpu request falls back to CPU without fillPool, with trails, or with sub-emitters', () => {
    h.renderer = WEBGPU;
    particleBackend.create(def({ simulation: 'gpu', emission: { rateOverTime: 10 } })); // no fillPool
    particleBackend.create(def({ simulation: 'gpu', trail: { enabled: true, segments: 8 } }));
    particleBackend.create(def({ simulation: 'gpu', subEmitters: [{ trigger: 'death', effect: 'x' }] }));
    expect(h.created).toEqual(['cpu', 'cpu', 'cpu']);
  });

  it('routes a fully-eligible gpu effect to the GPU backend', () => {
    h.renderer = WEBGPU;
    particleBackend.create(def({ simulation: 'gpu' }));
    expect(h.created).toEqual(['gpu']);
  });

  it('warns at most once per effect id on fallback', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    h.renderer = null;
    particleBackend.create(def({ simulation: 'gpu', id: 'fx-a' }));
    particleBackend.create(def({ simulation: 'gpu', id: 'fx-a' })); // same id → no second warn
    particleBackend.create(def({ simulation: 'gpu', id: 'fx-b' })); // different id → warns
    const fallbackWarns = info.mock.calls.filter((c) => String(c[0]).includes('fell back to CPU'));
    expect(fallbackWarns).toHaveLength(2);
    info.mockRestore();
  });
});
