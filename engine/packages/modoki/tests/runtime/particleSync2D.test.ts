/** particleSync2D unit tests — the 2D twin of particleSync, the per-frame bridge between ECS
 *  ParticleEmitter entities and the PixiJS 2D particle backend.
 *
 *  Drives syncParticles2D headlessly with a MOCK IParticle2DBackend (hands out stable handles,
 *  stashes a REAL `new Container()` per handle so parent/child wiring is exercised for real) and a
 *  MOCK ParticleSync2DCtx (a caller-controlled canvasIdOf map, memoized real slot Containers, a
 *  dirty Set, and unit compensation). The particle-effect cache is seeded via the REAL
 *  setParticleEffect so getParticleEffect resolves without a fetch. Verifies the 2D routing gate
 *  (Canvas2D ancestor → 2D, null → 3D owns it), handle create, slot (re)parenting + dirty marking,
 *  per-frame stepping, removal/dispose sweep, per-canvas release, and full teardown. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Container } from 'pixi.js';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { ParticleEmitter } from '../../src/runtime/traits/ParticleEmitter';
import { defaultParticleEffect } from '../../src/runtime/particles/types';
import { setParticleEffect, clearParticleCache } from '../../src/runtime/loaders/particleCache';
import { worldTransforms } from '../../src/three/systems/transformPropagationSystem';
import {
  createParticleSync2DState,
  syncParticles2D,
  releaseCanvas2DEmitters,
  disposeParticleSync2DState,
  type ParticleSync2DCtx,
} from '../../src/runtime/rendering/particleSync2D';
import type { IParticle2DBackend } from '../../src/runtime/particles/pixiParticleBackend';
import type { ParticleEffectDef, ParticleHandle } from '../../src/runtime/particles/types';

const EFFECT = 'fx/a.particle.json';

/** A mock 2D backend: stable ids, a REAL Container per handle, and recorded interactions. */
function makeMockBackend() {
  let nextId = 1;
  const containers = new Map<number, Container>();
  const calls = {
    create: [] as { id: number; def: ParticleEffectDef }[],
    dispose: [] as number[],
    disposed: new Set<number>(),
    pause: [] as number[],
    play: [] as number[],
    setDef: [] as { id: number; def: ParticleEffectDef }[],
    setSpeedScale: [] as { id: number; scale: number }[],
    update: [] as { id: number; dt: number }[],
    setTransform: [] as { id: number }[],
    restart: [] as number[],
    seek: [] as number[],
  };
  const backend: IParticle2DBackend = {
    create: vi.fn((def: ParticleEffectDef): ParticleHandle => {
      const id = nextId++;
      containers.set(id, new Container());
      calls.create.push({ id, def });
      return { id };
    }),
    getContainer: vi.fn((h: ParticleHandle) => containers.get(h.id)!),
    update: vi.fn((h: ParticleHandle, dt: number) => calls.update.push({ id: h.id, dt })),
    setTransform: vi.fn((h: ParticleHandle) => calls.setTransform.push({ id: h.id })),
    setDef: vi.fn((h: ParticleHandle, def: ParticleEffectDef) => calls.setDef.push({ id: h.id, def })),
    setSpeedScale: vi.fn((h: ParticleHandle, scale: number) => calls.setSpeedScale.push({ id: h.id, scale })),
    play: vi.fn((h: ParticleHandle) => calls.play.push(h.id)),
    pause: vi.fn((h: ParticleHandle) => calls.pause.push(h.id)),
    restart: vi.fn((h: ParticleHandle) => calls.restart.push(h.id)),
    seek: vi.fn((h: ParticleHandle) => calls.seek.push(h.id)),
    dispose: vi.fn((h: ParticleHandle) => { calls.dispose.push(h.id); calls.disposed.add(h.id); }),
  } as unknown as IParticle2DBackend;
  return { backend, calls, containers };
}

/** A mock ctx driven by a caller-controlled canvasId map + memoized real slot Containers. */
function makeMockCtx() {
  const canvasOf = new Map<number, number | null>();
  const slots = new Map<number, Container>();
  const dirty = new Set<number>();
  const markDirtyCalls: number[] = [];
  const ctx: ParticleSync2DCtx = {
    canvasIdOf: (id: number) => (canvasOf.has(id) ? canvasOf.get(id)! : null),
    slotContainer: (cid: number) => {
      let c = slots.get(cid);
      if (!c) { c = new Container(); slots.set(cid, c); }
      return c;
    },
    markDirty: (cid: number) => { dirty.add(cid); markDirtyCalls.push(cid); },
    compensate: () => ({ x: 1, y: 1 }),
  };
  return { ctx, canvasOf, slots, dirty, markDirtyCalls };
}

describe('syncParticles2D', () => {
  beforeEach(() => {
    clearParticleCache();
    worldTransforms.clear();
    setParticleEffect(EFFECT, defaultParticleEffect());
  });

  it('creates a handle, parents its wrapper under the Canvas2D slot, marks dirty, and steps', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf, slots, markDirtyCalls } = makeMockCtx();
    const e = world.spawn(Transform({ x: 1, y: 2 }), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(e.id(), 7);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);

    expect(calls.create).toHaveLength(1);
    expect(state.recs.size).toBe(1);
    const wrapper = backend.getContainer({ id: calls.create[0].id });
    expect(wrapper.parent).toBe(slots.get(7));
    expect(markDirtyCalls).toContain(7);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].dt).toBeGreaterThan(0);
    expect(calls.update[0].dt).toBeCloseTo(1 / 60);

    // Idempotent: a second frame reuses the handle (no rebuild, no re-add).
    syncParticles2D(world, ctx, state, 1 / 60);
    expect(calls.create).toHaveLength(1);
    expect(calls.update).toHaveLength(2);
  });

  it('skips an emitter with no Canvas2D ancestor (canvasIdOf → null; 3D owns it)', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx } = makeMockCtx(); // canvasOf empty → canvasIdOf returns null
    world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);

    expect(calls.create).toHaveLength(0);
    expect(state.recs.size).toBe(0);
  });

  it('reparents the wrapper to the new slot and marks BOTH canvases dirty on a canvas change', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf, slots, markDirtyCalls } = makeMockCtx();
    const e = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(e.id(), 1);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    const wrapper = backend.getContainer({ id: calls.create[0].id });
    expect(wrapper.parent).toBe(slots.get(1));

    // Reparent under a different Canvas2D.
    canvasOf.set(e.id(), 2);
    markDirtyCalls.length = 0;
    syncParticles2D(world, ctx, state, 1 / 60);

    expect(calls.create).toHaveLength(1); // reparent, not rebuild
    expect(wrapper.parent).toBe(slots.get(2));
    expect(markDirtyCalls).toContain(1); // old canvas redraws without the emitter
    expect(markDirtyCalls).toContain(2); // new canvas draws it
  });

  it('disposes the handle and detaches its wrapper when the emitter goes invisible', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf } = makeMockCtx();
    const e = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(e.id(), 3);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    const createdId = calls.create[0].id;
    const wrapper = backend.getContainer({ id: createdId });

    e.set(ParticleEmitter, { ...e.get(ParticleEmitter)!, isVisible: false });
    syncParticles2D(world, ctx, state, 1 / 60);

    expect(calls.disposed.has(createdId)).toBe(true);
    expect(wrapper.parent).toBeNull();
    expect(state.recs.size).toBe(0);
  });

  it('disposes the handle when the emitter entity is destroyed', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf } = makeMockCtx();
    const e = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(e.id(), 4);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    const createdId = calls.create[0].id;

    e.destroy();
    syncParticles2D(world, ctx, state, 1 / 60);

    expect(calls.disposed.has(createdId)).toBe(true);
    expect(state.recs.size).toBe(0);
  });

  it('creates the handle paused when playOnStart is false', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf } = makeMockCtx();
    const e = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT, playOnStart: false }));
    canvasOf.set(e.id(), 5);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    expect(calls.pause).toEqual([calls.create[0].id]);
  });

  it('releaseCanvas2DEmitters disposes only the recs on the released canvas', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf } = makeMockCtx();
    const a = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    const b = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(a.id(), 10);
    canvasOf.set(b.id(), 20);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    expect(state.recs.size).toBe(2);
    const idA = calls.create[0].id;
    const idB = calls.create[1].id;
    const wrapperA = backend.getContainer({ id: idA });

    releaseCanvas2DEmitters(state, 10);

    expect(calls.disposed.has(idA)).toBe(true);
    expect(calls.disposed.has(idB)).toBe(false);
    expect(wrapperA.parent).toBeNull();
    expect(state.recs.size).toBe(1);
    expect(state.recs.has(b.id())).toBe(true);
  });

  it('disposeParticleSync2DState disposes all handles and clears the map', () => {
    const world = createWorld();
    const { backend, calls } = makeMockBackend();
    const { ctx, canvasOf } = makeMockCtx();
    const a = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    const b = world.spawn(Transform(), ParticleEmitter({ effect: EFFECT }));
    canvasOf.set(a.id(), 1);
    canvasOf.set(b.id(), 2);

    const state = createParticleSync2DState(backend);
    syncParticles2D(world, ctx, state, 1 / 60);
    expect(state.recs.size).toBe(2);

    disposeParticleSync2DState(state);

    expect(calls.dispose).toHaveLength(2);
    expect(calls.disposed.size).toBe(2);
    expect(state.recs.size).toBe(0);
  });
});
