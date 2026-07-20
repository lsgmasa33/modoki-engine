/**
 * Regression test for runtime-particles F2 / runtime-texture-shader-font F4 + F3:
 * loaded sprite textures must be freed — on handle teardown, on a texture-ref swap,
 * and when a load resolves stale. Textures now come from the refcounted shared cache
 * (F3), so the backend calls `releaseTexture3D` rather than `tex.dispose()`; the mock
 * maps release → the fake's dispose() spy (mirroring the real resolver, which disposes
 * a texture when its last ref drops), so these ownership assertions hold unchanged.
 *
 * The real backend builds SpriteNodeMaterial billboards via TSL/WebGPU, which can't
 * run headless, so the GPU-construction modules + loadTexture3D are faked. We only
 * exercise the texture-ownership bookkeeping, asserting on the fake texture's
 * dispose() spy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

// A registry of fake textures handed out by the mocked loadTexture3D, each with a
// dispose() spy. Hoisted so the vi.mock factory below can close over it.
const h = vi.hoisted(() => {
  const created: { id: number; dispose: ReturnType<typeof vi.fn> }[] = [];
  let seq = 0;
  return {
    created,
    makeTex: () => {
      const t = { id: seq++, dispose: vi.fn() };
      created.push(t);
      return t as unknown as THREE.Texture;
    },
  };
});

vi.mock('../../src/runtime/loaders/textureResolver', () => ({
  loadTexture3D: vi.fn(() => Promise.resolve(h.makeTex())),
  // Fake textures carry no shared-cache key; the real releaseTexture3D disposes a
  // non-cache texture directly, so model that here to keep the dispose-spy assertions.
  releaseTexture3D: vi.fn((t?: { dispose?: () => void }) => t?.dispose?.()),
}));
vi.mock('../../src/runtime/particles/spriteBillboard', () => ({
  createBillboard: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/meshParticles', () => ({
  createMeshParticles: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/trailLines', () => ({
  createTrail: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/particleCache', () => ({
  getParticleEffect: () => null,
}));
vi.mock('../../src/runtime/particles/cpuSimulator', () => ({
  CpuParticleSim: class {
    step() { return 0; }
    setDef() {}
    reset() {}
    setSpeedScale() {}
    setEmitterMatrix() {}
    injectAt() {}
    get aliveCount() { return 0; }
    get birthEvents() { return [] as number[]; }
    get deathEvents() { return [] as number[]; }
  },
}));

// Imported after the mocks are registered.
import { CpuTslBackend } from '../../src/runtime/particles/cpuTslBackend';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDef(texture: string): ParticleEffectDef {
  return { ...defaultParticleEffect(), render: { blend: 'additive', texture } } as ParticleEffectDef;
}

beforeEach(() => {
  h.created.length = 0;
});

describe('CpuTslBackend texture disposal (F2)', () => {
  it('disposes the loaded texture on handle teardown', async () => {
    const be = new CpuTslBackend();
    const handle = be.create(makeDef('guid-a'));
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].dispose).not.toHaveBeenCalled();

    be.dispose(handle);
    expect(h.created[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the prior texture when the ref changes (setDef)', async () => {
    const be = new CpuTslBackend();
    const handle = be.create(makeDef('guid-a'));
    await flush();
    expect(h.created).toHaveLength(1);

    be.setDef(handle, makeDef('guid-b')); // texChanged → old texture freed
    expect(h.created[0].dispose).toHaveBeenCalledTimes(1);

    await flush(); // new ref's texture loads
    expect(h.created).toHaveLength(2);

    be.dispose(handle);
    expect(h.created[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a texture that resolves after the handle was already disposed (stale)', async () => {
    const be = new CpuTslBackend();
    const handle = be.create(makeDef('guid-a'));
    be.dispose(handle); // tear down before the async load resolves
    await flush();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].dispose).toHaveBeenCalledTimes(1); // stale branch freed it
  });
});
