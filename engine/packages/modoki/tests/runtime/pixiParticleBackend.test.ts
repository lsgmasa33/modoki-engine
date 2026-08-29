/**
 * PixiParticleBackend (2D / PixiJS) — lifecycle unit tests with an INJECTED mock render-object
 * factory, so no real PixiJS objects are constructed. The backend drives a REAL CpuParticleSim
 * over the mock's outputs buffers; the mock only stands in for the ParticleContainer + commit.
 * Mirrors the 3D-backend lifecycle tests (particleBackendPauseResume / TimingRestart) but for the
 * PixiJS twin. Covers: build-once, container access, pause/resume of update, live vs structural
 * setDef, transform extraction (local + worldSpace), restart, and dispose invalidation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('PixiParticleBackend sub-pixel 2D warning', () => {
  // A failed expect() inside a test throws, skipping any cleanup written later in that test's
  // body — this restores unconditionally so one test's failure can't leak its console.warn spy
  // into the next.
  afterEach(() => { vi.restoreAllMocks(); });

  it('warns once for a metre-scale (3D-authored) effect with an id', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Same shape as a real 3D effect (e.g. confetti.particle.json): small size/speed, short life.
    const metreScale = def({ id: 'metre-scale-1', startSize: { min: 0.1, max: 0.2 }, startSpeed: { min: 3.5, max: 6 } });
    be.create(metreScale);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('metre-scale-1');
    expect(warn.mock.calls[0][0]).toContain('renders sub-pixel in 2D');

    // A second effect instance with the SAME id doesn't warn again.
    be.create(metreScale);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a design-px-scaled (2D-authored) effect', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const designPxScale = def({ id: 'design-px-1', startSize: { min: 0.5, max: 1 }, startSpeed: { min: 60, max: 120 } });
    be.create(designPxScale);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn on sprite size alone for a TEXTURED effect (real size unknown until async load)', () => {
    // games/court's shipped win-sequence confetti: startSize reads as sub-pixel ONLY under the
    // 64px default-texture assumption, but it sets a custom render.texture, so that assumption
    // does not apply. Reach is comfortably large (fast + long-lived), so this must stay quiet.
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const texturedSmallSprite = def({
      id: 'textured-small-sprite-1',
      startSize: { min: 0.15, max: 0.24 },
      startSpeed: { min: 200, max: 380 },
      startLifetime: { min: 3.8, max: 5.2 },
      render: { blend: 'normal', texture: 'some-texture-guid' },
    });
    be.create(texturedSmallSprite);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a TEXTURED effect can still warn via reach alone when genuinely sub-pixel', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const texturedTinyReach = def({
      id: 'textured-tiny-reach-1',
      startSize: { min: 0.15, max: 0.24 },
      startSpeed: { min: 1, max: 2 },
      startLifetime: { min: 1, max: 1.5 },
      render: { blend: 'normal', texture: 'some-texture-guid' },
    });
    be.create(texturedTinyReach);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('sprite ≈'); // sprite half skipped for textured effects
    expect(warn.mock.calls[0][0]).toContain('plume reach ≈');
  });

  it('does not warn for an effect with no id (nothing stable to dedupe against)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    be.create(def({ id: undefined, startSize: { min: 0.1, max: 0.2 }, startSpeed: { min: 3.5, max: 6 } }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a zero-speed, gravity-driven effect (a waterfall) does not read as sub-pixel', () => {
    // startSpeed alone says "reach 0" — but a strong gravity pull still carries the plume a real
    // distance even at zero launch speed. Big untextured sprite too, so this exercises both halves.
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waterfall = def({
      id: 'waterfall-1',
      startSize: { min: 0.5, max: 1 }, // × 64 default texture = 64px — plainly visible
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 2, max: 2.5 },
      gravity: [0, 150, 0], // 2D: +Y falls
    });
    be.create(waterfall);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an id is un-warned once fixed, and re-warns if edited back into sub-pixel territory', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = def({ id: 'iterate-1', startSize: { min: 0.1, max: 0.2 }, startSpeed: { min: 3.5, max: 6 } });
    const fixed = def({ id: 'iterate-1', startSize: { min: 0.5, max: 1 }, startSpeed: { min: 60, max: 120 } });

    const h = be.create(bad);
    expect(warn).toHaveBeenCalledTimes(1);

    be.setDef(h, fixed); // live edit in the Particle Editor makes it visible again
    expect(warn).toHaveBeenCalledTimes(1); // setDef on a now-clean def doesn't itself warn

    be.setDef(h, bad); // edited back into sub-pixel territory
    expect(warn).toHaveBeenCalledTimes(2); // re-armed, not silently suppressed forever
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

describe('a textured 2D emitter waits HIDDEN, bounded (#338 close-out F4)', () => {
  // The 2D backend has the SAME defect the 3D one was fixed for: build() constructs the render
  // object AND a CpuParticleSim together, and the texture `.then` calls build() again — so a cold
  // sprite discards every live particle and resets the clock, on screen. Fixing the 3D path and
  // the sub-emitter path while leaving this one is how the second instance survives a sweep.
  //
  // ⚠️ These run headless (`typeof window === 'undefined'` in the node env), which is exactly the
  // "nothing will ever arrive" case — so they pin that the emitter is NOT left hidden there, which
  // is the failure mode that would break every 2D particle in a headless/test render.
  it('is not left hidden when no texture load can run (headless)', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def({ render: { blend: 'additive', texture: 'some-guid' } } as Partial<ParticleEffectDef>));
    expect(be.getContainer(h).visible, 'headless has no loader — reveal rather than hide forever').toBe(true);
  });

  it('an untextured 2D emitter is never hidden', () => {
    const f = makeFactory();
    const be = new PixiParticleBackend(f.make as never);
    const h = be.create(def());
    expect(be.getContainer(h).visible).toBe(true);
  });
});
