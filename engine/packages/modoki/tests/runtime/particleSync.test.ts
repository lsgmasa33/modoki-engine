/** particleSync integration tests — the per-frame bridge between ECS ParticleEmitter
 *  entities and the particle backend (the particle analogue of syncRenderables).
 *
 *  Uses a real koota world + real traits (Transform / ParticleEmitter / Time) so the
 *  ECS query matches, with a fake IParticleBackend + a fake getParticleEffect so no
 *  WebGPU/TSL renderer is required. Verifies handle create/dispose lifecycle, transform
 *  composition, dt sourcing (Time trait vs override) + playbackSpeed scaling, effect
 *  hot-swap rebuild, isActive/loading gating, and playOnStart=false pausing. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { ParticleEffectDef, ParticleHandle } from '../../src/runtime/particles/types';
import { PARTICLE_LAYER } from '../../src/runtime/rendering/layers';

beforeEach(() => {
  vi.resetModules();
});

/** A fake backend that records every interaction and hands out stable handles. */
function makeFakeBackend() {
  let nextId = 1;
  const objects = new Map<number, THREE.Object3D>();
  const calls = {
    create: [] as { id: number; def: ParticleEffectDef }[],
    dispose: [] as number[],
    pause: [] as number[],
    update: [] as { id: number; dt: number }[],
    setTransform: [] as { id: number; m: THREE.Matrix4 }[],
  };
  const backend = {
    create: vi.fn((def: ParticleEffectDef): ParticleHandle => {
      const id = nextId++;
      const obj = new THREE.Object3D();
      obj.name = `obj${id}`;
      objects.set(id, obj);
      calls.create.push({ id, def });
      return { id };
    }),
    getObject3D: vi.fn((h: ParticleHandle) => objects.get(h.id)),
    update: vi.fn((h: ParticleHandle, dt: number) => calls.update.push({ id: h.id, dt })),
    setTransform: vi.fn((h: ParticleHandle, m: THREE.Matrix4) => calls.setTransform.push({ id: h.id, m: m.clone() })),
    setDef: vi.fn(),
    setSpeedScale: vi.fn(),
    play: vi.fn(),
    pause: vi.fn((h: ParticleHandle) => calls.pause.push(h.id)),
    restart: vi.fn(),
    seek: vi.fn(),
    dispose: vi.fn((h: ParticleHandle) => calls.dispose.push(h.id)),
  };
  return { backend, calls };
}

async function setup() {
  const { backend, calls } = makeFakeBackend();
  vi.doMock('../../src/runtime/particles/particleBackend', () => ({ particleBackend: backend }));

  const effects = new Map<string, ParticleEffectDef>();
  vi.doMock('../../src/runtime/loaders/particleCache', () => ({
    getParticleEffect: vi.fn((ref: string) => effects.get(ref) ?? null),
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/particleSync');
  // Same reset module graph as `sync`, so the registry singleton is shared with syncParticles.
  const particleControl = await import('../../src/runtime/systems/particleControlRegistry');
  const { worldTransforms } = await import('../../src/three/systems/transformPropagationSystem');
  worldTransforms.clear();
  return { backend, calls, effects, world: createWorld(), traits, sync, particleControl, worldTransforms };
}

const fakeDef = (over: Partial<ParticleEffectDef> = {}): ParticleEffectDef =>
  ({ version: 1, maxParticles: 10, ...over } as ParticleEffectDef);

function makeScene() {
  return { add: vi.fn(), remove: vi.fn() } as unknown as THREE.Scene;
}

describe('syncParticles', () => {
  it('creates a backend handle and adds its Object3D when an emitter appears', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform({ x: 1, y: 2, z: 3 }), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);

    expect(calls.create).toHaveLength(1);
    expect(scene.add).toHaveBeenCalledTimes(1);
    expect(state.recs.size).toBe(1);
    expect(calls.update[0].dt).toBeCloseTo(0.016);

    // Idempotent: a second frame reuses the handle (no rebuild, no extra scene.add).
    sync.syncParticles(world, scene, state, 0.016);
    expect(calls.create).toHaveLength(1);
    expect(scene.add).toHaveBeenCalledTimes(1);
    expect(calls.update).toHaveLength(2);
  });

  it('tags the emitter object subtree onto PARTICLE_LAYER', async () => {
    const { backend, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);

    // A child added by the backend AFTER creation (sub-emitter) must also inherit
    // the layer — the per-frame re-tag covers it.
    const root = backend.getObject3D({ id: 1 });
    const child = new THREE.Object3D();
    root.add(child);
    sync.syncParticles(world, makeScene(), state, 0.016);

    expect(root.layers.mask).toBe(1 << PARTICLE_LAYER);
    expect(child.layers.mask).toBe(1 << PARTICLE_LAYER);
  });

  it('pushes a reseeded def to the existing handle (editor live-edit, no rebuild)', async () => {
    const { backend, calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);
    expect(backend.setDef).not.toHaveBeenCalled(); // no edit yet

    // Editor reseeds the cache with a NEW def object for the SAME path (a live edit).
    const edited = fakeDef({ duration: 5 });
    effects.set('fx/a.particle.json', edited);
    sync.syncParticles(world, scene, state, 0.016);

    expect(backend.setDef).toHaveBeenCalledWith({ id: 1 }, edited); // pushed to live handle
    expect(calls.create).toHaveLength(1); // same path → no rebuild

    // Idempotent: unchanged def reference does NOT re-push.
    sync.syncParticles(world, scene, state, 0.016);
    expect(backend.setDef).toHaveBeenCalledTimes(1);
  });

  it('composes the emitter matrix from the entity Transform', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform({ x: 1, y: 2, z: 3 }), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);

    const pos = new THREE.Vector3().setFromMatrixPosition(calls.setTransform[0].m);
    expect(pos.x).toBeCloseTo(1);
    expect(pos.y).toBeCloseTo(2);
    expect(pos.z).toBeCloseTo(3);
  });

  it('composes from the propagated WORLD transform when present (v2 — parented emitter)', async () => {
    const { calls, effects, world, traits, sync, worldTransforms } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    // Local Transform is (1,2,3); the propagation system computed a world position of
    // (11,12,13) because the emitter sits under a moving parent. The emitter must follow
    // the WORLD transform, not its local one.
    const e = world.spawn(Transform({ x: 1, y: 2, z: 3 }), ParticleEmitter({ effect: 'fx/a.particle.json' }));
    worldTransforms.set(e.id(), { x: 11, y: 12, z: 13, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);

    const pos = new THREE.Vector3().setFromMatrixPosition(calls.setTransform[0].m);
    expect(pos.x).toBeCloseTo(11);
    expect(pos.y).toBeCloseTo(12);
    expect(pos.z).toBeCloseTo(13);
  });

  it('scales the step dt by playbackSpeed', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json', playbackSpeed: 2 }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);
    expect(calls.update[0].dt).toBeCloseTo(0.032);
  });

  it('reads the visual delta from the Time trait when no override is given', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter, Time } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    // Particles advance on the VISUAL delta (smoothedDelta = smoothed × timeScale) via getVisualDelta.
    world.spawn(Time({ delta: 0.05, smoothedDelta: 0.05, timeScale: 1 }));
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state); // no dtOverride
    expect(calls.update[0].dt).toBeCloseTo(0.05);
  });

  it('skips creation while the effect asset is still loading, then creates once ready', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    const e = world.spawn(Transform(), ParticleEmitter({ effect: 'fx/late.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016); // asset not cached yet
    expect(calls.create).toHaveLength(0);
    expect(state.recs.size).toBe(0);

    effects.set('fx/late.particle.json', fakeDef()); // asset finishes loading
    sync.syncParticles(world, scene, state, 0.016);
    expect(calls.create).toHaveLength(1);
    expect(state.recs.size).toBe(1);
    expect(e.isAlive()).toBe(true);
  });

  it('does not create a handle for an empty effect ref', async () => {
    const { calls, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    world.spawn(Transform(), ParticleEmitter({ effect: '' }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);
    expect(calls.create).toHaveLength(0);
  });

  it('disposes the handle when isActive flips to false', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    const e = world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);
    expect(state.recs.size).toBe(1);
    const createdId = calls.create[0].id;

    e.set(ParticleEmitter, { ...e.get(ParticleEmitter)!, isVisible: false });
    sync.syncParticles(world, scene, state, 0.016);
    expect(calls.dispose).toContain(createdId);
    expect(scene.remove).toHaveBeenCalledTimes(1);
    expect(state.recs.size).toBe(0);
  });

  it('disposes the handle when the emitter entity is destroyed', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    const e = world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);
    const createdId = calls.create[0].id;

    e.destroy();
    sync.syncParticles(world, scene, state, 0.016);
    expect(calls.dispose).toContain(createdId);
    expect(state.recs.size).toBe(0);
  });

  it('rebuilds (dispose + create) when the effect ref changes', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef({ maxParticles: 10 }));
    effects.set('fx/b.particle.json', fakeDef({ maxParticles: 20 }));
    const e = world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);
    const firstId = calls.create[0].id;

    e.set(ParticleEmitter, { ...e.get(ParticleEmitter)!, effect: 'fx/b.particle.json' });
    sync.syncParticles(world, scene, state, 0.016);

    expect(calls.dispose).toContain(firstId);
    expect(calls.create).toHaveLength(2);
    expect(calls.create[1].def.maxParticles).toBe(20);
    expect(state.recs.size).toBe(1);
  });

  it('creates the handle paused when playOnStart is false', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json', playOnStart: false }));

    const state = sync.createParticleSyncState();
    sync.syncParticles(world, makeScene(), state, 0.016);
    expect(calls.pause).toEqual([calls.create[0].id]);
  });

  it('forcePlay (FX preview) does NOT pause a playOnStart:false emitter, and loops a one-shot burst', async () => {
    const { backend, calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef({ looping: false, duration: 1 }));
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json', playOnStart: false }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.4, { forcePlay: true }); // created + advanced 0.4s
    expect(calls.pause).toHaveLength(0);      // NOT paused despite playOnStart:false
    expect(backend.restart).not.toHaveBeenCalled();

    sync.syncParticles(world, scene, state, 0.4, { forcePlay: true }); // 0.8s
    expect(backend.restart).not.toHaveBeenCalled();
    sync.syncParticles(world, scene, state, 0.4, { forcePlay: true }); // 1.2s ≥ duration → loop-restart
    expect(backend.restart).toHaveBeenCalledTimes(1);
  });

  it('applies a queued Timeline restart / pause to the live handle (Phase E control track)', async () => {
    const { backend, calls, effects, world, traits, sync, particleControl } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    const e = world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016); // create handle (id 1)
    const id = calls.create[0].id;
    expect(backend.restart).not.toHaveBeenCalled();

    // A control clip crossed its start → restart request drained + applied this frame.
    particleControl.requestParticleControl(e.id(), 'restart');
    sync.syncParticles(world, scene, state, 0.016);
    expect(backend.restart).toHaveBeenCalledWith({ id });

    // One-shot: a later frame with no new request does NOT restart again.
    sync.syncParticles(world, scene, state, 0.016);
    expect(backend.restart).toHaveBeenCalledTimes(1);

    // Clip end → pause request.
    particleControl.requestParticleControl(e.id(), 'pause');
    sync.syncParticles(world, scene, state, 0.016);
    expect(calls.pause).toContain(id);
  });

  it('disposeParticleSyncState releases all handles and clears the map', async () => {
    const { calls, effects, world, traits, sync } = await setup();
    const { Transform, ParticleEmitter } = traits;
    effects.set('fx/a.particle.json', fakeDef());
    effects.set('fx/b.particle.json', fakeDef());
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/a.particle.json' }));
    world.spawn(Transform(), ParticleEmitter({ effect: 'fx/b.particle.json' }));

    const scene = makeScene();
    const state = sync.createParticleSyncState();
    sync.syncParticles(world, scene, state, 0.016);
    expect(state.recs.size).toBe(2);

    sync.disposeParticleSyncState(state, scene);
    expect(calls.dispose).toHaveLength(2);
    expect(scene.remove).toHaveBeenCalledTimes(2);
    expect(state.recs.size).toBe(0);
  });
});
