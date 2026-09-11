/**
 * #993 — the GPU compute backend's two remaining vocabulary tables, `SHAPE` and `COLL`.
 *
 * Both are code-declared literals in `gpuComputeBackend.ts` indexed by a string from the
 * `.particle.json`: `def.shape.type` and `def.collision.mode`. `'toString' in SHAPE` is true, so
 * the warning never fired, and `?? 0` cannot catch what came back — a function is not nullish —
 * so an inherited `Object.prototype` method reached a GPU uniform.
 *
 * (The file's third table, `COLLIDER`, now goes through `resolveColliderShape`; it is covered in
 * `vocabWarnings.test.ts` § particle CollisionConfig.shape. The other nine sites in the family
 * are in `vocabTableProtoKeys.test.ts`.)
 *
 * ⚠️ This file exists separately because it has to pay for `three/tsl` + `three/webgpu` fakes, in
 * the same shape as `gpuParticleTextureWait.test.ts` and `gpuParticleBufferLifetime.test.ts`. The
 * `uniform()` fake keeps a real `.value` store, which is the whole observable here. Reaching the
 * uniforms goes through the backend's internal `entries` map — no exported test seam exists, and
 * this follows `gpuParticleBufferLifetime.test.ts` in flagging that rather than adding one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const chainable = vi.hoisted(() => {
  const node: unknown = new Proxy(function stub() {} as unknown as object, {
    get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : node),
    apply: () => node,
    set: () => true,
  });
  return node;
});

// The `.value` store is the observable: a uniform that swallowed its writes would make every
// assertion below vacuous, which is exactly what a shared chainable singleton would do.
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
    Fn: vi.fn(() => chainable), If: n, instanceIndex: chainable,
    instancedArray: vi.fn(() => chainable), uniform: uniformFake, hash: n,
    float: n, int: n, vec2: n, vec3: n, vec4: n, texture: n, uv: n, mix: n, sin: n, cos: n,
    max: n, floor: n, abs: n, sign: n, select: n,
    positionLocal: chainable, normalLocal: chainable,
  };
});
vi.mock('three/webgpu', () => {
  class NodeMaterial { dispose = vi.fn(); constructor(public opts?: unknown) {} }
  return { SpriteNodeMaterial: NodeMaterial, MeshBasicNodeMaterial: NodeMaterial, MeshStandardNodeMaterial: NodeMaterial };
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

const PROTO_KEYS = [
  '__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
] as const;

/** `fillPool` + no texture, mirroring the eligibility fixture the other GPU suites use. */
const gpuDef = (over: Partial<ParticleEffectDef>): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  maxParticles: 100,
  emission: { rateOverTime: 0, fillPool: true },
  render: { blend: 'additive' },
  ...over,
}) as ParticleEffectDef;

interface UniformLike { value: unknown }
interface EntryLike { u: { shapeType: UniformLike; collMode: UniformLike } }

function uniformsOf(be: GpuComputeBackend, def: ParticleEffectDef): EntryLike['u'] {
  const handle = be.create(def) as { id: number };
  const entries = (be as unknown as { entries: Map<number, EntryLike> }).entries;
  const e = entries.get(handle.id);
  if (!e) throw new Error('entry not found');
  return e.u;
}

describe('gpuComputeBackend SHAPE / COLL — a prototype-named vocabulary value (#993)', () => {
  let be: GpuComputeBackend;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    be = new GpuComputeBackend();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  // ⚠️ Restore, or the spies STACK: a second `vi.spyOn` wraps the first, both record, and the
  // per-test counts below read double from the second case onward. Measured — every count was 2.
  afterEach(() => { warn.mockRestore(); });

  it('the harness can OBSERVE a uniform write — without this every case below is vacuous', () => {
    // The fake `uniform()` has to keep a real `.value` store. A shared chainable node would
    // swallow every write and answer itself, and then `expect(...).toBe(0)` could never fail.
    const u = uniformsOf(be, gpuDef({ shape: { type: 'sphere', radius: 1 } } as Partial<ParticleEffectDef>));
    expect(u.shapeType.value).toBe(2);
  });

  it.each(PROTO_KEYS)('shape.type %s falls back to point (0) AND warns', (type) => {
    const u = uniformsOf(be, gpuDef({ shape: { type, radius: 1 } } as unknown as Partial<ParticleEffectDef>));
    // Before the fix this was `Object.prototype.toString` in a GPU uniform, with no warning.
    expect(u.shapeType.value).toBe(0);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('EmitterShape.type')).length).toBe(1);
  });

  it.each(PROTO_KEYS)('collision.mode %s falls back to none (0) AND warns', (mode) => {
    const u = uniformsOf(be, gpuDef({ collision: { mode, bounce: 0.5 } } as unknown as Partial<ParticleEffectDef>));
    expect(u.collMode.value).toBe(0);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('collision.mode')).length).toBe(1);
  });

  // ⚠️ ACCEPT SIDE. A fix that answered 0 for everything passes every case above while breaking
  // every non-point emitter and every collider in the engine.
  it.each([['point', 0], ['cone', 1], ['sphere', 2], ['box', 3], ['circle', 4], ['cylinder', 5]] as const)(
    'ACCEPT: shape.type %s still reaches code %i, with no warning', (type, code) => {
      const u = uniformsOf(be, gpuDef({ shape: { type, radius: 1 } } as unknown as Partial<ParticleEffectDef>));
      expect(u.shapeType.value).toBe(code);
      expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('EmitterShape.type')).length).toBe(0);
    });

  it.each([['none', 0], ['kill', 1], ['bounce', 2]] as const)(
    'ACCEPT: collision.mode %s still reaches code %i, with no warning', (mode, code) => {
      const u = uniformsOf(be, gpuDef({ collision: { mode, bounce: 0.5 } } as unknown as Partial<ParticleEffectDef>));
      expect(u.collMode.value).toBe(code);
      expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('collision.mode')).length).toBe(0);
    });
});
