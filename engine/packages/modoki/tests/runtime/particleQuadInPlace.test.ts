/** #769 — `aspect`/`anchor`/`offset` split out of the render-structural gate into their own
 *  `renderQuadKey` (types.ts), applied IN PLACE by each backend instead of forcing a full
 *  rebuild. Before this split, nudging any of these four in the Particle Editor rebuilt the
 *  whole backend (`entry.inited = false` on the GPU backend), restarting the simulation on
 *  every drag of an anchor/offset slider.
 *
 *  Also covers #769's Half B: `GpuComputeBackend.build()` now disposes the mesh (and LUT) it
 *  superseded in the SAME "free what this rebuild superseded" pass as the compute nodes
 *  (`#717`'s block), after the replacement mesh is already built and assigned — not at the top
 *  of `build()`, before the replacement exists.
 *
 *  GPU-backend fixture mirrors `gpuParticleBufferLifetime.test.ts` (real `GpuComputeBackend`
 *  with `three/tsl` + `three/webgpu` faked as chainable no-ops; `makeParticlePrimitiveGeometry`
 *  is left REAL here — mesh mode needs an actual position attribute on the primitive geometry,
 *  which that file's empty-geometry stub doesn't have). The Pixi-backend test mirrors
 *  `pixiParticleBackend.test.ts`'s injected mock render-object factory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';
import { computeQuadCorners } from '../../src/runtime/particles/spriteBillboard';

// ── chainable no-op TSL node, identical shape to gpuParticleBufferLifetime.test.ts ──
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
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, p) => (p === 'value' ? store.value : p === 'then' || typeof p === 'symbol' ? undefined : chainable),
    set: (_t, p, v) => { if (p === 'value') store.value = v; return true; },
    apply: () => chainable,
  });
});
vi.mock('three/tsl', () => {
  const n = chainable as () => unknown;
  return {
    Fn: vi.fn(() => chainable), If: n, instanceIndex: chainable, instancedArray: vi.fn(() => chainable),
    uniform: uniformFake, hash: n, float: n, int: n, vec2: n, vec3: n, vec4: n, texture: n, uv: n,
    mix: n, sin: n, cos: n, max: n, floor: n, abs: n, sign: n, select: n,
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
vi.mock('../../src/runtime/core/textureProvider', () => {
  const impl = { loadTexture3D: vi.fn(() => new Promise(() => {})), releaseTexture3D: vi.fn() };
  return { textureProvider: { get: () => impl } };
});

import { GpuComputeBackend } from '../../src/runtime/particles/gpuComputeBackend';

// ── CpuTslBackend fixture — mirrors particleBackendPauseResume.test.ts's fakes, except
// `spriteBillboard` keeps its REAL `computeQuadCorners`/`applyQuadInPlace`/`resolveQuadShift`
// (only `createBillboard` is swapped for a lighter fake) so the in-place rewrite under test
// runs the actual production code, not a mock recording a call. ──
vi.mock('../../src/runtime/loaders/textureResolver', () => ({ loadTexture3D: vi.fn(() => Promise.resolve({ dispose: vi.fn() })), releaseTexture3D: vi.fn() }));
vi.mock('../../src/runtime/particles/spriteBillboard', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/particles/spriteBillboard')>('../../src/runtime/particles/spriteBillboard');
  return {
    ...actual,
    createBillboard: (_maxParticles: number, render: { aspect?: number; anchor?: string; offset?: [number, number] }) => {
      const { aspect, shiftX, shiftY } = actual.resolveQuadShift(render as never);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(actual.computeQuadCorners(aspect, shiftX, shiftY), 3));
      return { mesh: new THREE.Mesh(geo), outputs: {}, dispose: vi.fn(), commit: vi.fn() };
    },
  };
});
// Partial mock, not a full replacement: the GPU-backend tests above need this module's REAL
// `makeParticlePrimitiveGeometry` (mesh mode needs an actual position attribute).
vi.mock('../../src/runtime/particles/meshParticles', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/particles/meshParticles')>('../../src/runtime/particles/meshParticles');
  return {
    ...actual,
    createMeshParticles: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
  };
});
vi.mock('../../src/runtime/particles/trailLines', () => ({
  createTrail: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/particleCache', () => ({ getParticleEffect: () => null }));
vi.mock('../../src/runtime/particles/cpuSimulator', () => ({
  CpuParticleSim: class {
    setDef() {} reset() {} setSpeedScale() {} setEmitterMatrix() {} injectAt() {}
    step() { return 0; }
    get aliveCount() { return 0; }
    get birthEvents() { return [] as number[]; }
    get deathEvents() { return [] as number[]; }
  },
}));

import { CpuTslBackend } from '../../src/runtime/particles/cpuTslBackend';

const cpuDef = (renderOver?: Partial<ParticleEffectDef['render']>, over?: Partial<ParticleEffectDef>): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  render: { blend: 'additive', ...renderOver },
  ...over,
}) as ParticleEffectDef;

interface CpuEntryLike { billboard: { mesh: THREE.Mesh | THREE.Object3D } }
function cpuEntryOf(be: CpuTslBackend, handle: { id: number }): CpuEntryLike {
  const entries = (be as unknown as { entries: Map<number, CpuEntryLike> }).entries;
  const e = entries.get(handle.id);
  if (!e) throw new Error('entry not found');
  return e;
}

describe('CPU quad-key in-place application (#769)', () => {
  it('rewrites the 12 position floats in place, keeps the same geometry, and does not restart the sim', () => {
    const be = new CpuTslBackend();
    const handle = be.create(cpuDef({ aspect: 1, anchor: 'center', offset: [0, 0] }));
    const entry = cpuEntryOf(be, handle);
    const meshBefore = entry.billboard.mesh as THREE.Mesh;
    const geoBefore = meshBefore.geometry;
    const posBefore = geoBefore.getAttribute('position');

    be.setDef(handle, cpuDef({ aspect: 2, anchor: 'bottom', offset: [0.1, -0.2] }));

    const entryAfter = cpuEntryOf(be, handle);
    const meshAfter = entryAfter.billboard.mesh as THREE.Mesh;
    expect(meshAfter).toBe(meshBefore); // same mesh — no rebuild
    expect(meshAfter.geometry).toBe(geoBefore); // same geometry object
    expect(meshAfter.geometry.getAttribute('position')).toBe(posBefore); // same attribute, rewritten
    const expected = computeQuadCorners(2, 0.1, 0.5 - 0.2); // aspect=2, shiftX=offset[0], shiftY=anchor+offset[1]
    expect(Array.from(posBefore!.array as Float32Array)).toEqual(Array.from(expected));
  });

  it('mesh mode: a quad-key change is a no-op, not a rebuild', () => {
    const be = new CpuTslBackend();
    const handle = be.create(cpuDef({ mode: 'mesh', aspect: 1, anchor: 'center', offset: [0, 0] }));
    const entry = cpuEntryOf(be, handle);
    const meshBefore = entry.billboard.mesh;

    be.setDef(handle, cpuDef({ mode: 'mesh', aspect: 3, anchor: 'bottom', offset: [1, 1] }));

    const entryAfter = cpuEntryOf(be, handle);
    expect(entryAfter.billboard.mesh).toBe(meshBefore); // no rebuild at all
  });
});

const gpuDef = (renderOver?: Partial<ParticleEffectDef['render']>, over?: Partial<ParticleEffectDef>): ParticleEffectDef => ({
  ...defaultParticleEffect(),
  maxParticles: 5000,
  emission: { rateOverTime: 0, fillPool: true },
  render: { blend: 'additive', ...renderOver },
  ...over,
}) as ParticleEffectDef;

interface EntryLike {
  mesh: THREE.Mesh | null;
  inited: boolean;
  renderer: { compute(n: unknown): void; _attributes: { delete: ReturnType<typeof vi.fn> } } | null;
}
function entryOf(be: GpuComputeBackend, handle: { id: number }): EntryLike {
  const entries = (be as unknown as { entries: Map<number, EntryLike> }).entries;
  const e = entries.get(handle.id);
  if (!e) throw new Error('entry not found');
  return e;
}
function captureRenderer(entry: EntryLike, r: EntryLike['renderer']): void {
  (entry.mesh!.onBeforeRender as unknown as (renderer: unknown) => void)(r);
}
function fakeRenderer() {
  return { compute: vi.fn(), _attributes: { delete: vi.fn() } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('GPU quad-key in-place application (#769)', () => {
  it('rewrites the 12 position floats in place, keeps the same geometry, and does not restart the sim', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ aspect: 1, anchor: 'center', offset: [0, 0] }));
    const entry = entryOf(be, handle);
    entry.inited = true; // simulate an already-running pool
    const geoBefore = entry.mesh!.geometry;
    const posBefore = geoBefore.getAttribute('position');

    be.setDef(handle, gpuDef({ aspect: 2, anchor: 'bottom', offset: [0.1, -0.2] }));

    const entryAfter = entryOf(be, handle);
    expect(entryAfter.mesh!.geometry).toBe(geoBefore); // same geometry object — no rebuild
    expect(entryAfter.mesh!.geometry.getAttribute('position')).toBe(posBefore); // same attribute, rewritten
    const expected = computeQuadCorners(2, 0.1, 0.5 - 0.2); // aspect=2, shiftX=offset[0], shiftY=anchor+offset[1]
    expect(Array.from(posBefore!.array as Float32Array)).toEqual(Array.from(expected));
    expect(entryAfter.inited).toBe(true); // simulation NOT restarted
  });

  it('mesh mode: a quad-key change rebuilds nothing and changes nothing', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ mode: 'mesh', meshPrimitive: 'box', aspect: 1, anchor: 'center', offset: [0, 0] }));
    const entry = entryOf(be, handle);
    entry.inited = true;
    const meshBefore = entry.mesh;
    const geoBefore = entry.mesh!.geometry;

    be.setDef(handle, gpuDef({ mode: 'mesh', meshPrimitive: 'box', aspect: 3, anchor: 'bottom', offset: [1, 1] }));

    const entryAfter = entryOf(be, handle);
    expect(entryAfter.mesh).toBe(meshBefore); // no rebuild at all
    expect(entryAfter.mesh!.geometry).toBe(geoBefore);
    expect(entryAfter.inited).toBe(true); // simulation NOT restarted
  });

  it('a genuine build-key field (blend) still forces a full rebuild', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ blend: 'additive' }));
    const entry = entryOf(be, handle);
    const meshBefore = entry.mesh;

    be.setDef(handle, gpuDef({ blend: 'normal' }));

    const entryAfter = entryOf(be, handle);
    expect(entryAfter.mesh).not.toBe(meshBefore); // rebuilt — a new mesh object
    expect(entryAfter.inited).toBe(false); // rebuild resets the pool
  });

  it('frees the SUPERSEDED mesh only after the replacement is already assigned on the entry (#717 block)', () => {
    const be = new GpuComputeBackend();
    const handle = be.create(gpuDef({ blend: 'additive' }));
    const r = fakeRenderer();
    const entry = entryOf(be, handle);
    captureRenderer(entry, r);
    const prevMesh = entry.mesh!;
    const disposeSpy = vi.spyOn(prevMesh.geometry, 'dispose');

    let observedDuringDispose: unknown = 'dispose never fired';
    disposeSpy.mockImplementationOnce(function (this: THREE.BufferGeometry) {
      observedDuringDispose = entryOf(be, handle).mesh;
    });

    be.setDef(handle, gpuDef({ blend: 'normal' })); // structural rebuild -> supersede + free LAST

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(observedDuringDispose).not.toBe(prevMesh);
    expect(observedDuringDispose).toBe(entryOf(be, handle).mesh);
  });
});

describe('Pixi 2D quad-key in-place application (#769)', () => {
  it('applies aspect/offset/anchor without rebuilding the container', async () => {
    const { PixiParticleBackend } = await import('../../src/runtime/particles/pixiParticleBackend');
    const { Container } = await import('pixi.js');
    let builds = 0;
    const setQuadCalls: Array<ParticleEffectDef['render']> = [];
    const make = (max: number) => {
      builds++;
      const outputs = {
        offsets: new Float32Array(max * 3), scales: new Float32Array(max), colors: new Float32Array(max * 3),
        opacities: new Float32Array(max), rotations: new Float32Array(max), frames: new Float32Array(max),
      };
      const container = new Container();
      return {
        container, outputs,
        commit() {}, dispose() { container.destroy(); },
        setQuad(render: ParticleEffectDef['render']) { setQuadCalls.push(render); },
      };
    };
    const def = (renderOver?: Partial<ParticleEffectDef['render']>): ParticleEffectDef =>
      ({ ...defaultParticleEffect(), render: { blend: 'additive', ...renderOver } }) as ParticleEffectDef;

    const be = new PixiParticleBackend(make as never);
    const h = be.create(def({ aspect: 1, anchor: 'center', offset: [0, 0] }));
    expect(builds).toBe(1);

    be.setDef(h, def({ aspect: 2, anchor: 'bottom', offset: [3, 4] }));

    expect(builds).toBe(1); // no rebuild
    expect(setQuadCalls).toHaveLength(1);
    expect(setQuadCalls[0]).toMatchObject({ aspect: 2, anchor: 'bottom', offset: [3, 4] });
  });
});

describe('computeQuadCorners pinned against a real THREE.PlaneGeometry (#769)', () => {
  // `computeQuadCorners` hand-derives the same 4-vertex quad `createBillboard` used to get
  // from `new THREE.PlaneGeometry(aspect, 1).translate(shiftX, shiftY, 0)` before this change,
  // and `applyQuadInPlace` still takes `uv`/`index` from that real geometry (only `position`
  // now comes from `computeQuadCorners`). This pins the two position arrays against each
  // other directly — not against `applyQuadInPlace`, which would just be checking the
  // function against itself — so a future edit to either one that lets them diverge is caught
  // here instead of silently flipping every billboard's UVs.
  const cases: Array<[number, number, number]> = [
    [1, 0, 0],
    [2, 0, 0],
    [0.5, 0.25, -0.75],
    [1.5, -0.3, 0.5],
  ];
  it.each(cases)('aspect=%s shiftX=%s shiftY=%s matches PlaneGeometry(aspect,1).translate(shiftX,shiftY,0)', (aspect, shiftX, shiftY) => {
    const real = new THREE.PlaneGeometry(aspect, 1);
    real.translate(shiftX, shiftY, 0);
    const realPositions = Array.from((real.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);

    const computed = Array.from(computeQuadCorners(aspect, shiftX, shiftY));

    expect(computed).toEqual(realPositions);
  });
});
