/** particlePartitionIntegration — the exactly-one-path partition, end-to-end.
 *
 *  Phase 2a split particle emitter rendering across two sync passes that MUST never
 *  overlap: `particleSync` (3D / Three.js) owns emitters with NO Canvas2D ancestor;
 *  `particleSync2D` (2D / PixiJS) owns emitters WITH a Canvas2D ancestor. The single
 *  source of truth both agree on is the routing predicate in `particle2DRouting`
 *  (`buildCanvas2DRoute` + `emitterCanvasId`).
 *
 *  This test builds ONE real koota world holding BOTH an emitter parented under a
 *  Canvas2D (→ 2D) and a bare emitter with no Canvas2D ancestor (→ 3D), drives BOTH
 *  real sync passes over it (a faked 3D backend like particleSync.test.ts; an injected
 *  mock 2D backend), and proves each emitter lands in exactly one pass's rec map —
 *  never both, never neither. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { Container } from 'pixi.js';
import type { ParticleEffectDef, ParticleHandle } from '../../src/runtime/particles/types';
import type { IParticle2DBackend } from '../../src/runtime/particles/pixiParticleBackend';

beforeEach(() => {
  vi.resetModules();
});

/** Faked 3D backend — records interactions, hands out real THREE.Object3D roots so
 *  `syncParticles`'s `tagParticleLayer` (obj.traverse) + scene.add work. Mirrors the
 *  fake in particleSync.test.ts. */
function makeFake3DBackend() {
  let nextId = 1;
  const objects = new Map<number, THREE.Object3D>();
  const calls = { create: [] as number[], dispose: [] as number[], update: [] as number[] };
  const backend = {
    create: vi.fn((_def: ParticleEffectDef): ParticleHandle => {
      const id = nextId++;
      objects.set(id, new THREE.Object3D());
      calls.create.push(id);
      return { id };
    }),
    getObject3D: vi.fn((h: ParticleHandle) => objects.get(h.id)!),
    update: vi.fn((h: ParticleHandle) => calls.update.push(h.id)),
    setTransform: vi.fn(),
    setDef: vi.fn(),
    setSpeedScale: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    seek: vi.fn(),
    dispose: vi.fn((h: ParticleHandle) => calls.dispose.push(h.id)),
  };
  return { backend, calls };
}

/** Mock 2D backend — implements IParticle2DBackend with real PixiJS Containers as wrappers
 *  (so removeFromParent/addChild are exercised) and records create/dispose/update. */
function makeMock2DBackend() {
  let nextId = 1;
  const wrappers = new Map<number, Container>();
  const calls = { create: [] as number[], dispose: [] as number[], update: [] as number[] };
  const backend: IParticle2DBackend = {
    create: vi.fn((_def: ParticleEffectDef): ParticleHandle => {
      const id = nextId++;
      wrappers.set(id, new Container());
      calls.create.push(id);
      return { id };
    }),
    getContainer: vi.fn((h: ParticleHandle) => wrappers.get(h.id)!),
    update: vi.fn((h: ParticleHandle) => calls.update.push(h.id)),
    setTransform: vi.fn(),
    setDef: vi.fn(),
    setSpeedScale: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    seek: vi.fn(),
    dispose: vi.fn((h: ParticleHandle) => { wrappers.delete(h.id); calls.dispose.push(h.id); }),
  };
  return { backend, calls, wrappers };
}

const CANVAS_FX = 'fx/canvas.particle.json';
const BARE_FX = 'fx/bare.particle.json';

async function setup() {
  // Fake the 3D backend so `syncParticles` runs headlessly (no WebGPU/TSL). The 2D
  // backend is injected via createParticleSync2DState, so it needs no module mock.
  const { backend: backend3d, calls: calls3d } = makeFake3DBackend();
  vi.doMock('../../src/runtime/particles/particleBackend', () => ({ particleBackend: backend3d }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync3d = await import('../../src/runtime/rendering/particleSync');
  const sync2d = await import('../../src/runtime/rendering/particleSync2D');
  const routing = await import('../../src/runtime/rendering/particle2DRouting');
  // Use the REAL particle cache (seed via setParticleEffect, per the plan). Both sync
  // modules read getParticleEffect from this same instance.
  const cache = await import('../../src/runtime/loaders/particleCache');
  const { worldTransforms } = await import('../../src/three/systems/transformPropagationSystem');
  worldTransforms.clear();
  cache.clearParticleCache();

  return { backend3d, calls3d, createWorld, traits, sync3d, sync2d, routing, cache, worldTransforms };
}

/** A minimal valid def; setParticleEffect normalizes it (fills render/emission/etc.). */
const seedDef = () => ({ version: 1, maxParticles: 10 } as ParticleEffectDef);

describe('particle 2D/3D partition (exactly-one-path)', () => {
  it('routing predicate partitions the two emitters', async () => {
    const { createWorld, traits, routing } = await setup();
    const { Transform, ParticleEmitter, EntityAttributes, Canvas2D } = traits;

    const world = createWorld();
    const canvasEnt = world.spawn(EntityAttributes({ name: 'Canvas', layer: 'ui' }), Canvas2D());
    const childEnt = world.spawn(
      Transform(),
      ParticleEmitter({ effect: CANVAS_FX }),
      EntityAttributes({ name: 'CanvasFx', parentId: canvasEnt.id() }),
    );
    const bareEnt = world.spawn(
      Transform(),
      ParticleEmitter({ effect: BARE_FX }),
      EntityAttributes({ name: 'BareFx', parentId: 0 }),
    );

    const route = routing.buildCanvas2DRoute(world);
    expect(routing.emitterCanvasId(route, childEnt.id())).toBe(canvasEnt.id());
    expect(routing.emitterCanvasId(route, childEnt.id())).not.toBeNull();
    expect(routing.emitterCanvasId(route, bareEnt.id())).toBeNull();
  });

  it('each emitter lands in exactly one sync pass (2D owns canvas child, 3D owns bare)', async () => {
    const { calls3d, createWorld, traits, sync3d, sync2d, routing, cache } = await setup();
    const { Transform, ParticleEmitter, EntityAttributes, Canvas2D } = traits;

    cache.setParticleEffect(CANVAS_FX, seedDef());
    cache.setParticleEffect(BARE_FX, seedDef());

    const world = createWorld();
    const canvasEnt = world.spawn(EntityAttributes({ name: 'Canvas', layer: 'ui' }), Canvas2D());
    const canvasId = canvasEnt.id();
    const childEnt = world.spawn(
      Transform(),
      ParticleEmitter({ effect: CANVAS_FX }),
      EntityAttributes({ name: 'CanvasFx', parentId: canvasId }),
    );
    const bareEnt = world.spawn(
      Transform(),
      ParticleEmitter({ effect: BARE_FX }),
      EntityAttributes({ name: 'BareFx', parentId: 0 }),
    );

    // ── Drive the 2D pass with a mock ctx routed through the SAME predicate ──
    const { backend: backend2d, calls: calls2d, wrappers } = makeMock2DBackend();
    const route = routing.buildCanvas2DRoute(world);
    const slots = new Map<number, Container>();
    const slotFor = (cid: number) => {
      let c = slots.get(cid);
      if (!c) { c = new Container(); slots.set(cid, c); }
      return c;
    };
    const dirty = new Set<number>();
    const ctx = {
      canvasIdOf: (id: number) => routing.emitterCanvasId(route, id),
      slotContainer: (cid: number) => slotFor(cid),
      markDirty: (cid: number) => { dirty.add(cid); },
      compensate: (_cid: number) => ({ x: 1, y: 1 }),
    };
    const state2d = sync2d.createParticleSync2DState(backend2d);
    sync2d.syncParticles2D(world, ctx, state2d, 0.016);

    // 2D pass handled ONLY the canvas child.
    expect(state2d.recs.has(childEnt.id())).toBe(true);
    expect(state2d.recs.has(bareEnt.id())).toBe(false);
    expect(calls2d.create).toHaveLength(1);
    // Its wrapper was mounted into the canvas slot container.
    const childRec = state2d.recs.get(childEnt.id())!;
    const wrapper = wrappers.get(childRec.handle.id)!;
    expect(wrapper.parent).toBe(slots.get(canvasId));

    // ── Drive the REAL 3D pass over the SAME world (faked backend + fake scene) ──
    const scene = { add: vi.fn(), remove: vi.fn() } as unknown as THREE.Scene;
    const state3d = sync3d.createParticleSyncState();
    sync3d.syncParticles(world, scene, state3d, 0.016);

    // 3D pass handled ONLY the bare emitter (the canvas child is skipped by its own route build).
    expect(state3d.recs.has(bareEnt.id())).toBe(true);
    expect(state3d.recs.has(childEnt.id())).toBe(false);
    expect(calls3d.create).toHaveLength(1);
    expect(calls3d.update).toHaveLength(1);

    // ── The partition invariant: disjoint rec maps whose union is every emitter ──
    const ids2d = new Set(state2d.recs.keys());
    const ids3d = new Set(state3d.recs.keys());
    const overlap = [...ids2d].filter((id) => ids3d.has(id));
    expect(overlap).toEqual([]); // no emitter in BOTH passes

    const union = new Set([...ids2d, ...ids3d]);
    expect(union).toEqual(new Set([childEnt.id(), bareEnt.id()])); // every emitter in exactly one
  });
});
