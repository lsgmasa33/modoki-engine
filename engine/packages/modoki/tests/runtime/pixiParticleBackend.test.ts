/**
 * PixiParticleBackend (2D / PixiJS) — lifecycle unit tests with an INJECTED mock render-object
 * factory, so no real PixiJS objects are constructed. The backend drives a REAL CpuParticleSim
 * over the mock's outputs buffers; the mock only stands in for the ParticleContainer + commit.
 * Mirrors the 3D-backend lifecycle tests (particleBackendPauseResume / TimingRestart) but for the
 * PixiJS twin. Covers: build-once, container access, pause/resume of update, live vs structural
 * setDef, transform extraction (local + worldSpace), restart, and dispose invalidation.
 */

import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { Matrix4 } from 'three';
import { PixiParticleBackend } from '../../src/runtime/particles/pixiParticleBackend';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

// A mock PixiParticleObject factory: builds real typed-array outputs (so the real CpuParticleSim
// can write into them) plus a real (empty) pixi Container as the inner render object — the backend
// adds it to its STABLE wrapper Container, and getContainer() returns that wrapper. `committed`/
// `commitCalls` are recorded on the outer object; `builds` counts factory invocations (rebuilds).
// The backend applies transform/zIndex to the wrapper, so the transform assertions target
// getContainer(h) (the wrapper), not this inner container.
function makeFactory() {
  let builds = 0;
  const make = (max: number, _render: unknown, _opts: unknown) => {
    builds++;
    const outputs = {
      offsets: new Float32Array(max * 3),
      scales: new Float32Array(max),
      colors: new Float32Array(max * 3),
      opacities: new Float32Array(max),
      rotations: new Float32Array(max),
      frames: new Float32Array(max),
    };
    let committed = -1;
    let commitCalls = 0;
    const container = new Container(); // real, so wrapper.addChild(container) works
    return {
      container,
      outputs,
      commit(n: number) { committed = n; commitCalls++; },
      dispose() { container.destroy(); }, // removes the inner container from the wrapper
      get committed() { return committed; },
      get commitCalls() { return commitCalls; },
    };
  };
  return { make, get builds() { return builds; } };
}

const def = (over: Partial<ParticleEffectDef> = {}): ParticleEffectDef =>
  ({ ...defaultParticleEffect(), ...over }) as ParticleEffectDef;

// A non-worldSpace def whose emission fills quickly so update() spawns live particles.
const localDef = (over: Partial<ParticleEffectDef> = {}): ParticleEffectDef =>
  def({ worldSpace: false, emission: { rateOverTime: 500 }, ...over });

describe('PixiParticleBackend lifecycle', () => {
  it('creates exactly one render object and exposes its container', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def());
    expect(f.builds).toBe(1);
    const c = be.getContainer(h) as unknown as { x: number };
    expect(c).toBeDefined();
    expect(c.x).toBe(0);
  });

  it('update steps the sim and commits; pause freezes commit; play resumes', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(localDef());

    be.update(h, 1 / 60);
    expect(getObj(be, h).commitCalls).toBeGreaterThanOrEqual(1); // playing by default → committed
    expect(getObj(be, h).committed).toBeGreaterThanOrEqual(0);

    const before = getObj(be, h).commitCalls;
    be.pause(h);
    be.update(h, 1 / 60);
    be.update(h, 1 / 60);
    expect(getObj(be, h).commitCalls).toBe(before); // paused → no further commits

    be.play(h);
    be.update(h, 1 / 60);
    expect(getObj(be, h).commitCalls).toBe(before + 1); // resumed
  });

  it('setDef: a non-structural change (gravity) does NOT rebuild', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def());
    be.setDef(h, def({ gravity: 99 }));
    expect(f.builds).toBe(1);
  });

  it('setDef: a structural change (blend) rebuilds', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def({ render: { blend: 'additive' } }));
    be.setDef(h, def({ render: { blend: 'normal' } }));
    expect(f.builds).toBe(2);
  });

  it('setDef: a structural change (maxParticles) rebuilds', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def({ maxParticles: 100 }));
    be.setDef(h, def({ maxParticles: 200 }));
    expect(f.builds).toBe(2);
  });

  it('setDef: renderOrder is a live tweak applied to container.zIndex (no rebuild)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def({ render: { blend: 'additive' } }));
    be.setDef(h, def({ render: { blend: 'additive', renderOrder: 7 } }));
    expect(f.builds).toBe(1);
    const c = be.getContainer(h) as unknown as { zIndex: number };
    expect(c.zIndex).toBe(7);
  });

  it('setTransform (local space): extracts translation and z-rotation into the container', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(localDef());
    be.setTransform(h, new Matrix4().makeTranslation(10, 20, 0));
    const c = be.getContainer(h) as unknown as { x: number; y: number; rotation: number };
    expect(c.x).toBe(10);
    expect(c.y).toBe(20);

    const angle = Math.PI / 3;
    be.setTransform(h, new Matrix4().makeRotationZ(angle));
    expect(c.rotation).toBeCloseTo(angle, 6);
  });

  it('setTransform (world space): container stays at the origin (matrix fed to the sim)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def({ worldSpace: true }));
    be.setTransform(h, new Matrix4().makeTranslation(10, 20, 0));
    const c = be.getContainer(h) as unknown as { x: number; y: number };
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it('restart resets the sim (alive count committed as 0)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(localDef());
    // Spawn some particles.
    for (let i = 0; i < 10; i++) be.update(h, 1 / 60);
    expect(getObj(be, h).committed).toBeGreaterThan(0);
    be.restart(h);
    expect(getObj(be, h).committed).toBe(0);
  });

  it('dispose invalidates the handle (getContainer throws afterwards)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def());
    be.dispose(h);
    expect(() => be.getContainer(h)).toThrow();
  });
});

// The mock's committed/commitCalls getters live on the outer PixiParticleObject, not on its
// container (which is what getContainer returns). Reach the object the backend stored for a handle
// via its private entries map.
function getObj(be: PixiParticleBackend, h: { id: number }): { committed: number; commitCalls: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = (be as any).entries.get(h.id);
  return entry.obj;
}
