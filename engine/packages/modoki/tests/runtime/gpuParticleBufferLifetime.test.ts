/** #717 — the GPU compute backend's four per-particle storage buffers (pos/vel/meta/spin) and
 *  its two compute nodes (computeInit/computeUpdate) must be REUSED across a non-count rebuild,
 *  and FREED (not merely dropped) whenever they are actually superseded — on a `maxParticles`
 *  resize, and on `dispose()`.
 *
 *  Before this fix `build()` allocated four fresh `instancedArray` buffers on EVERY structural
 *  rebuild (a blend/aspect/tiles/anchor/sprite-mode/texture change — anything in what's since
 *  split into `renderBuildKey`/`renderQuadKey`, #769 — not just `maxParticles`), and `dispose()`
 *  dropped its references without
 *  ever reaching `renderer._attributes.delete(...)`, three's only route to `GPUBuffer.destroy()`
 *  (see the long comment on `freeStorageBuffer` in the source). Measured on `games/3d-test`: 12
 *  blend toggles at 15k particles allocated 48 storage buffers totalling 9.36 MB, none ever freed.
 *
 *  ⚠️ These drive the REAL `GpuComputeBackend` with `three/tsl` + `three/webgpu` faked, the same
 *  shape as `gpuParticleTextureWait.test.ts`. Two of the fakes deliberately depart from that
 *  file's shared-singleton "chainable" node, because THIS file's assertions are about object
 *  IDENTITY, which a shared singleton would erase:
 *   - `instancedArray(...)` returns a FRESH node per call, carrying its own `.value` sentinel
 *     object (the "GPU attribute" `freeStorageBuffer` passes to `_attributes.delete`).
 *   - `Fn(...)` returns a FRESH node per call, carrying its own `dispose` spy — the source's
 *     compute nodes are entirely closure-only in the real TSL API (never invoked here), so a
 *     spy is the only way to observe a `dispose()` call and its ordering.
 *  Reaching the buffers/compute-nodes themselves goes through the backend's internal `entries`
 *  map (no exported test seam exists — flagged rather than adding one to the source).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

// ── fresh-per-call fakes for the two node kinds whose IDENTITY this file asserts on ──
const h = vi.hoisted(() => {
  let bufSeq = 0;
  function makeBufNode(): unknown {
    const valueObj = { attrId: ++bufSeq };
    const node: unknown = new Proxy(function stub() {} as unknown as object, {
      get: (_t, p) => (p === 'value' ? valueObj : p === 'then' || typeof p === 'symbol' ? undefined : node),
      apply: () => node,
      set: () => true,
    });
    return node;
  }
  function makeComputeNode(): unknown {
    const disposeSpy = vi.fn();
    const node: unknown = new Proxy(function stub() {} as unknown as object, {
      get: (_t, p) => {
        if (p === 'dispose') return disposeSpy;
        if (p === 'then' || typeof p === 'symbol') return undefined;
        return node;
      },
      apply: () => node,
      set: () => true,
    });
    return node;
  }
  return { makeBufNode, makeComputeNode };
});

// A chainable no-op that answers to every property and every call with itself — for every TSL
// node this file does NOT care about the identity of (uniforms, math ops, texture/uv lookups…).
// `then` and symbols answer `undefined` on purpose: a proxy that claims a `then` is THENABLE, and
// awaiting one deadlocks the test instead of failing it. (Same shape as gpuParticleTextureWait.)
const chainable = vi.hoisted(() => {
  const node: unknown = new Proxy(function stub() {} as unknown as object, {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : node),
    apply: () => node,
    set: () => true,
  });
  return node;
});

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
    Fn: vi.fn(() => h.makeComputeNode()),
    If: n, instanceIndex: chainable, instancedArray: vi.fn(() => h.makeBufNode()), uniform: uniformFake, hash: n,
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
  const impl = { loadTexture3D: vi.fn(() => new Promise(() => {})), releaseTexture3D: vi.fn() };
  return { textureProvider: { get: () => impl } };
});

import { GpuComputeBackend } from '../../src/runtime/particles/gpuComputeBackend';

/** The GPU backend only ever routes `fillPool` effects — mirror the eligibility fixture used
 *  in gpuParticleTextureWait.test.ts. No texture, so no wait-for-sprite gating to route around. */
const gpuDef = (overrides?: Partial<ParticleEffectDef['render']> & { maxParticles?: number }): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  maxParticles: overrides?.maxParticles ?? 5000,
  emission: { rateOverTime: 0, fillPool: true },
  render: { blend: 'additive', ...overrides },
}) as ParticleEffectDef;

interface PoolBufsLike { pos: unknown; vel: unknown; meta: unknown; spin: unknown }
interface EntryLike {
  bufs: PoolBufsLike | null;
  computeInit: unknown;
  computeUpdate: unknown;
  renderer: { compute(n: unknown): void; _attributes: { delete: ReturnType<typeof vi.fn> } } | null;
  mesh: THREE.Mesh | null;
}

/** The backend keeps no exported test seam onto its pool state (bufs/computeInit/renderer) — the
 *  brief flags this rather than adding an export to the source. Reach it via the internal
 *  `entries` map instead (TS-private, not JS-private, so this compiles and runs). */
function entryOf(be: GpuComputeBackend, handle: { id: number }): EntryLike {
  const entries = (be as unknown as { entries: Map<number, EntryLike> }).entries;
  const e = entries.get(handle.id);
  if (!e) throw new Error('entry not found');
  return e;
}

function fakeRenderer() {
  return { compute: vi.fn(), _attributes: { delete: vi.fn() } };
}

/** Capture the renderer the way a real draw does (onBeforeRender), without running update(). */
function captureRenderer(entry: EntryLike, r: EntryLike['renderer']): void {
  (entry.mesh!.onBeforeRender as unknown as (renderer: unknown) => void)(r);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('GPU particle pool buffer/compute-node lifetime (#717)', () => {
  it('REUSES the four storage buffers across a non-count structural rebuild', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef());
    const before = entryOf(be, handle).bufs!;

    be.setDef(handle, gpuDef({ blend: 'normal' })); // structural (blend), maxParticles unchanged

    const after = entryOf(be, handle).bufs!;
    expect(after.pos).toBe(before.pos);
    expect(after.vel).toBe(before.vel);
    expect(after.meta).toBe(before.meta);
    expect(after.spin).toBe(before.spin);
  });

  it('never frees and never reallocates across repeated non-count rebuilds', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef());
    const r = fakeRenderer();
    captureRenderer(entryOf(be, handle), r);
    const original = entryOf(be, handle).bufs!;

    const blends: ParticleEffectDef['render']['blend'][] = ['normal', 'additive', 'multiply', 'screen', 'normal'];
    for (const blend of blends) be.setDef(handle, gpuDef({ blend }));

    const bufs = entryOf(be, handle).bufs!;
    expect(bufs.pos).toBe(original.pos);
    expect(bufs.vel).toBe(original.vel);
    expect(bufs.meta).toBe(original.meta);
    expect(bufs.spin).toBe(original.spin);
    expect(r._attributes.delete).not.toHaveBeenCalled();
  });

  it('FREES the old buffers and allocates new ones when maxParticles changes', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ maxParticles: 5000 }));
    const r = fakeRenderer();
    captureRenderer(entryOf(be, handle), r);
    const before = entryOf(be, handle).bufs!;
    const beforeAttrs = [before.pos, before.vel, before.meta, before.spin]
      .map((b) => (b as { value: unknown }).value);

    be.setDef(handle, gpuDef({ maxParticles: 9000 }));

    expect(r._attributes.delete).toHaveBeenCalledTimes(4);
    const deletedAttrs = r._attributes.delete.mock.calls.map((c) => c[0]);
    for (const a of beforeAttrs) expect(deletedAttrs).toContain(a);

    const after = entryOf(be, handle).bufs!;
    expect(after.pos).not.toBe(before.pos);
    expect(after.vel).not.toBe(before.vel);
    expect(after.meta).not.toBe(before.meta);
    expect(after.spin).not.toBe(before.spin);
  });

  it('dispose() frees all four buffers and disposes both compute nodes', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef());
    const r = fakeRenderer();
    const entry = entryOf(be, handle);
    captureRenderer(entry, r);
    const bufs = entry.bufs!;
    const attrs = [bufs.pos, bufs.vel, bufs.meta, bufs.spin].map((b) => (b as { value: unknown }).value);
    const initDispose = (entry.computeInit as { dispose: ReturnType<typeof vi.fn> }).dispose;
    const updateDispose = (entry.computeUpdate as { dispose: ReturnType<typeof vi.fn> }).dispose;

    be.dispose(handle);

    expect(r._attributes.delete).toHaveBeenCalledTimes(4);
    const deletedAttrs = r._attributes.delete.mock.calls.map((c) => c[0]);
    for (const a of attrs) expect(deletedAttrs).toContain(a);
    expect(initDispose).toHaveBeenCalledTimes(1);
    expect(updateDispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() on a pool that was never drawn (no renderer) does not throw and frees nothing', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef());
    const entry = entryOf(be, handle);
    expect(entry.renderer).toBeNull(); // never drawn — onBeforeRender never fired

    expect(() => be.dispose(handle)).not.toThrow();
    // Nothing was ever uploaded, so freeStorageBuffer's renderer-null guard makes this a no-op —
    // there is no fake renderer at all in this test, so "no delete call" is definitionally true;
    // the assertion here is just that dispose completed and released the handle.
    expect(() => be.dispose(handle)).not.toThrow(); // disposing an already-gone handle is also inert
  });

  it('disposes the SUPERSEDED compute nodes only after the replacements are already assigned', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ maxParticles: 5000 }));
    const r = fakeRenderer();
    captureRenderer(entryOf(be, handle), r);
    const prevUpdate = entryOf(be, handle).computeUpdate;
    const prevDispose = (prevUpdate as { dispose: ReturnType<typeof vi.fn> }).dispose;

    let observedDuringDispose: unknown = 'dispose never fired';
    prevDispose.mockImplementationOnce(() => {
      observedDuringDispose = entryOf(be, handle).computeUpdate;
    });

    be.setDef(handle, gpuDef({ maxParticles: 9000 })); // resize -> rebuild -> supersede + free

    expect(prevDispose).toHaveBeenCalledTimes(1);
    expect(observedDuringDispose).not.toBe(prevUpdate);
    expect(observedDuringDispose).toBe(entryOf(be, handle).computeUpdate);
  });
});
