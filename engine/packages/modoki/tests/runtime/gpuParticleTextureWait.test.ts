/** #338 reopen — a GPU pool must not be DRAWN before its declared sprite arrives.
 *
 *  The CPU backends have held a textured emitter hidden since the first #338 pass.
 *  `gpuComputeBackend` had **no such gate at all**: it revealed the pool as soon as `computeInit`
 *  completed, whatever the texture was doing. That is the worst place for the gap, because the
 *  only effects the router sends here are `fillPool` ones — `demos/particle-demo`'s Nebula is
 *  40,000 particles in one frame — and the untextured build multiplies opacity by `radialAlpha()`
 *  alone, i.e. a full-quad soft circle at opacity 1 where the authored sprite is mostly
 *  transparent. Measured on the deployed demo with texture responses held back (CDP screencast,
 *  per-frame mean luma): **241 of 255, a full-screen white wash**, versus ~121 for the same
 *  station textured.
 *
 *  ⚠️ These drive the REAL `GpuComputeBackend` with `three/tsl` + `three/webgpu` faked, the same
 *  shape as the CPU twin in `particleTextureWaitReveal`. The TSL fake is a chainable no-op node,
 *  so nothing here asserts anything about shader graphs — what is asserted is
 *  `geometry.instanceCount` on a REAL `THREE.InstancedBufferGeometry`, which is the backend's own
 *  answer to "may this pool be drawn". That is the one decision this file exists to protect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, TEXTURE_WAIT_BUDGET_MS, type ParticleEffectDef } from '../../src/runtime/particles/types';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

const h = vi.hoisted(() => ({
  resolveTex: null as null | ((t: unknown) => void),
  rejectTex: null as null | ((e: unknown) => void),
}));

// A chainable no-op that answers to every property and every call with itself — enough for the
// node-graph construction in `build()`/`buildMesh()`, which this file deliberately does not test.
// `then` and symbols answer `undefined` on purpose: a proxy that claims a `then` is THENABLE, and
// awaiting one deadlocks the test instead of failing it.
const chainable = vi.hoisted(() => {
  const node: unknown = new Proxy(function stub() {} as unknown as object, {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : node),
    apply: () => node,
    set: () => true,
  });
  return node;
});

// `uniform()` is the one TSL export the backend reads back through: `u.time.value += dt` and
// `(u.gravityVec.value as Vector3).set(...)`. So its fake keeps a REAL `value` slot and stays
// chainable for everything else — a blanket proxy makes `+=` throw on primitive conversion.
const uniformFake = vi.hoisted(() => (initial?: unknown) => {
  const store = { value: initial };
  const node = chainable;
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, p) => (p === 'value' ? store.value : p === 'then' || typeof p === 'symbol' ? undefined : node),
    set: (_t, p, v) => { if (p === 'value') store.value = v; return true; },
    apply: () => node,
  });
});

vi.mock('three/tsl', () => {
  const n = chainable as () => unknown;
  return {
    Fn: n, If: n, instanceIndex: chainable, instancedArray: n, uniform: uniformFake, hash: n,
    float: n, int: n, vec2: n, vec3: n, vec4: n, texture: n, uv: n, mix: n, sin: n, cos: n,
    max: n, floor: n, abs: n, sign: n, select: n,
    positionLocal: chainable, normalLocal: chainable,
  };
});
vi.mock('three/webgpu', () => {
  class NodeMaterial {
    dispose = vi.fn();
    constructor(public opts?: unknown) {}
  }
  return {
    SpriteNodeMaterial: NodeMaterial,
    MeshBasicNodeMaterial: NodeMaterial,
    MeshStandardNodeMaterial: NodeMaterial,
  };
});
vi.mock('../../src/runtime/particles/billboardTsl', () => {
  const n = () => chainable;
  return { orientSampleUv: n, radialAlpha: n, softParticleFade: n, spriteFrameNode: n, spriteSheetUv: n };
});
vi.mock('../../src/runtime/particles/meshParticles', () => ({
  makeParticlePrimitiveGeometry: () => new THREE.BufferGeometry(),
}));
vi.mock('../../src/runtime/core/textureProvider', () => {
  const impl = {
    loadTexture3D: vi.fn(() => new Promise((res, rej) => {
      h.resolveTex = res as (t: unknown) => void; h.rejectTex = rej;
    })),
    releaseTexture3D: vi.fn(),
  };
  return { textureProvider: { get: () => impl } };
});

import { GpuComputeBackend } from '../../src/runtime/particles/gpuComputeBackend';

/** The GPU backend only ever routes `fillPool` effects — mirror that here. */
const gpuDef = (texture?: string): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  maxParticles: 40000,
  emission: { rateOverTime: 0, fillPool: true },
  render: texture ? { blend: 'additive', texture } : { blend: 'additive' },
}) as ParticleEffectDef;

/** Fake renderer: enough for the dispatch + the `onSubmittedWorkDone` readiness signal. */
function fakeRenderer() {
  const pending: Array<() => void> = [];
  return {
    r: {
      compute: vi.fn(),
      initTexture: vi.fn(),
      backend: { device: { queue: { onSubmittedWorkDone: () => new Promise<void>((res) => { pending.push(res); }) } } },
    },
    /** Let every armed readiness promise resolve, then drain microtasks. */
    async finishGpuWork() {
      const all = pending.splice(0);
      for (const res of all) res();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    },
  };
}

function poolMesh(be: GpuComputeBackend, handle: { id: number }): THREE.Mesh {
  const group = be.getObject3D(handle) as THREE.Group;
  const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
  expect(mesh, 'the pool mesh should exist').toBeTruthy();
  return mesh;
}
const drawn = (m: THREE.Mesh) => (m.geometry as THREE.InstancedBufferGeometry).instanceCount;

/** Capture the renderer the way a real draw does, then pump one frame. */
function pump(be: GpuComputeBackend, handle: { id: number }, r: unknown, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    const mesh = poolMesh(be, handle);
    (mesh.onBeforeRender as unknown as (renderer: unknown) => void)(r);
    be.update(handle, 1 / 60);
  }
}

beforeEach(() => { h.resolveTex = null; h.rejectTex = null; setManualNow(0); });
afterEach(() => { restoreRealClock(); });

describe('a GPU pool waits for its declared sprite before drawing (#338 reopen)', () => {
  it('stays at 0 instances after the GPU readiness signal, while the texture is still in flight', async () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();

    pump(be, handle, r);            // dispatches computeInit and arms the readiness signal
    await finishGpuWork();          // the buffers ARE filled — the old gate would reveal here
    expect(drawn(poolMesh(be, handle)), 'buffers ready but no sprite: drawing this is the white wash').toBe(0);

    // …and it stays hidden however many frames pass, since the frame counter is only a backstop.
    pump(be, handle, r, 10);
    expect(drawn(poolMesh(be, handle)), '10 frames in ~0 ms must not spend a 1.5 s network wait').toBe(0);
  });

  it('draws the full pool once the sprite lands', async () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);
    await finishGpuWork();

    h.resolveTex?.({ dispose: vi.fn() });          // the sprite arrives -> build() with the texture
    await Promise.resolve(); await Promise.resolve();
    expect(drawn(poolMesh(be, handle)), 'the rebuild re-hides until ITS dispatch lands').toBe(0);

    pump(be, handle, r);                            // re-dispatch against the rebuilt buffers
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle)), 'ready AND textured — draw it').toBe(40000);
  });

  it('reveals untextured once the time budget is spent — silence must not be permanent', async () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle))).toBe(0);

    advanceManual(TEXTURE_WAIT_BUDGET_MS);          // the texture never arrives at all
    pump(be, handle, r, 8);                         // the frame backstop retries every update()
    expect(drawn(poolMesh(be, handle)), 'a dead sprite must not hide the pool forever').toBe(40000);
  });

  it('a failed sprite load reveals rather than hiding the pool forever', async () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);
    await finishGpuWork();

    h.rejectTex?.(new Error('404'));                // the way a missing/undecodable sprite fails
    await Promise.resolve(); await Promise.resolve();
    pump(be, handle, r, 8);
    expect(drawn(poolMesh(be, handle)), 'a 404 sprite must not strand the pool at 0 instances').toBe(40000);
  });

  it('is not stranded when setDef swaps the ref away mid-load and starts no new one', async () => {
    // The CPU twin's #338 close-out F1, one backend over: a swap to an empty/mesh ref starts no
    // replacement load, so the stale branch of the ORIGINAL load is the last thing that runs.
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);

    be.setDef(handle, gpuDef());                    // no texture -> no replacement load
    h.resolveTex?.({ dispose: vi.fn() });           // the original lands, and takes the stale branch
    await Promise.resolve(); await Promise.resolve();

    pump(be, handle, r);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle)), 'a swapped-away ref must not leave the pool hidden').toBe(40000);
  });

  it('a structural edit made mid-wait must NOT clear the wait', async () => {
    // The close-out's own finding, on the sweep that added the setDef re-arm: `structural` is true
    // for a dozen non-texture reasons, so clearing `awaitingTexture` in a bare `else` revealed the
    // untextured pool on any structural edit made while the ORIGINAL sprite was in flight — the
    // white wash, reintroduced by the fix for it.
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef('some-guid'));
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle))).toBe(0);

    // maxParticles changes -> structural, texture ref UNCHANGED, sprite still in flight.
    be.setDef(handle, { ...gpuDef('some-guid'), maxParticles: 20000 } as ParticleEffectDef);
    pump(be, handle, r, 10);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle)), 'the sprite is still owed — the rebuild is untextured').toBe(0);

    h.resolveTex?.({ dispose: vi.fn() });
    await Promise.resolve(); await Promise.resolve();
    pump(be, handle, r);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle)), 'and it draws once the sprite finally lands').toBe(20000);
  });

  it('an effect with NO sprite is never held back — there is nothing to wait for', async () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef());
    const { r, finishGpuWork } = fakeRenderer();
    pump(be, handle, r);
    await finishGpuWork();
    expect(drawn(poolMesh(be, handle))).toBe(40000);
  });
});
