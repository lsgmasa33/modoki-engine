/** Particle CPU simulator + curve/gradient sampling unit tests (pure, no GPU). */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CpuParticleSim, type ParticleOutputs, type TrailOutputs } from '../../src/runtime/particles/cpuSimulator';
import { sampleCurve, sampleGradientColor, sampleGradientAlpha } from '../../src/runtime/particles/curves';
import { composeParticleMatrices } from '../../src/runtime/particles/meshMatrices';
import { defaultParticleEffect, spriteFrameIndex, clampSimDt, MAX_SIM_DT, seekSteps, SEEK_MAX_STEPS, PREWARM_STEP, MAX_GPU_FORCES, gpuDefSupported, type ParticleEffectDef, type ForceField } from '../../src/runtime/particles/types';
import { resolveCollider, collide, type CollisionHit } from '../../src/runtime/particles/colliders';
import { resolveShape, perpBasis } from '../../src/runtime/particles/emitterShapes';

function makeOutputs(max: number): ParticleOutputs {
  return {
    offsets: new Float32Array(max * 3),
    scales: new Float32Array(max),
    colors: new Float32Array(max * 3),
    opacities: new Float32Array(max),
    rotations: new Float32Array(max),
    frames: new Float32Array(max),
  };
}

function makeSim(overrides: Partial<ParticleEffectDef>): CpuParticleSim {
  const def = { ...defaultParticleEffect(), ...overrides } as ParticleEffectDef;
  return new CpuParticleSim(def, makeOutputs(def.maxParticles), 42);
}

describe('curves', () => {
  it('samples piecewise-linear curve at endpoints and midpoint', () => {
    const c = { points: [{ t: 0, v: 1 }, { t: 1, v: 0 }] };
    expect(sampleCurve(c, 0)).toBeCloseTo(1);
    expect(sampleCurve(c, 1)).toBeCloseTo(0);
    expect(sampleCurve(c, 0.5)).toBeCloseTo(0.5);
  });

  it('returns 1 for empty/undefined curve', () => {
    expect(sampleCurve(undefined, 0.5)).toBe(1);
    expect(sampleCurve({ points: [] }, 0.5)).toBe(1);
  });

  it('applies curve scale', () => {
    expect(sampleCurve({ points: [{ t: 0, v: 1 }, { t: 1, v: 1 }], scale: 3 }, 0.5)).toBeCloseTo(3);
  });

  it('samples gradient color + alpha', () => {
    const grad = {
      colorStops: [{ t: 0, color: { r: 1, g: 0, b: 0 } }, { t: 1, color: { r: 0, g: 0, b: 1 } }],
      alphaStops: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }],
    };
    const out = { r: 0, g: 0, b: 0 };
    sampleGradientColor(grad, 0.5, out);
    expect(out.r).toBeCloseTo(0.5);
    expect(out.b).toBeCloseTo(0.5);
    expect(sampleGradientAlpha(grad, 0.5)).toBeCloseTo(0.5);
  });
});

describe('CpuParticleSim', () => {
  it('emits rateOverTime * dt particles', () => {
    const sim = makeSim({ emission: { rateOverTime: 50 }, startLifetime: { min: 10, max: 10 } });
    const alive = sim.step(0.1); // 50 * 0.1 = 5
    expect(alive).toBe(5);
    expect(sim.aliveCount).toBe(5);
  });

  it('never exceeds maxParticles', () => {
    const sim = makeSim({ maxParticles: 10, emission: { rateOverTime: 1000 }, startLifetime: { min: 10, max: 10 } });
    sim.step(0.1); // wants 100, capped at 10
    expect(sim.aliveCount).toBe(10);
  });

  it('recycles dead particles (steady state, not unbounded growth)', () => {
    const sim = makeSim({
      maxParticles: 1000,
      emission: { rateOverTime: 100 },
      startLifetime: { min: 0.2, max: 0.2 },
      startSpeed: { min: 0, max: 0 },
      gravity: 0,
    });
    for (let i = 0; i < 50; i++) sim.step(0.1); // 5 s total
    // Steady state ≈ rate * life = 100 * 0.2 = 20; far below the 500 it'd reach without recycling.
    expect(sim.aliveCount).toBeGreaterThan(0);
    expect(sim.aliveCount).toBeLessThan(40);
  });

  it('writes finite render outputs for alive particles', () => {
    const out = makeOutputs(100);
    const def = { ...defaultParticleEffect(), maxParticles: 100, emission: { rateOverTime: 100 }, startLifetime: { min: 10, max: 10 } } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, out, 7);
    const alive = sim.step(0.1);
    for (let j = 0; j < alive; j++) {
      expect(Number.isFinite(out.offsets[j * 3 + 1])).toBe(true);
      expect(out.scales[j]).toBeGreaterThan(0);
      expect(out.opacities[j]).toBeGreaterThanOrEqual(0);
    }
  });

  it('reset clears all particles', () => {
    const sim = makeSim({ emission: { rateOverTime: 100 }, startLifetime: { min: 10, max: 10 } });
    sim.step(0.1);
    expect(sim.aliveCount).toBeGreaterThan(0);
    sim.reset();
    expect(sim.aliveCount).toBe(0);
  });

  it('worldSpace bakes the emitter matrix into spawn positions', () => {
    const out = makeOutputs(50);
    const def = {
      ...defaultParticleEffect(), worldSpace: true, maxParticles: 50,
      shape: { type: 'point' as const }, startSpeed: { min: 0, max: 0 },
      emission: { rateOverTime: 50 }, startLifetime: { min: 10, max: 10 }, gravity: 0,
    } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, out, 42);
    sim.setEmitterMatrix(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 5, -3, 1]));
    sim.step(0.1); // point shape, no speed/gravity → particles sit at the emitter world origin
    expect(out.offsets[0]).toBeCloseTo(10);
    expect(out.offsets[1]).toBeCloseTo(5);
    expect(out.offsets[2]).toBeCloseTo(-3);
  });

  it('local mode (worldSpace off) ignores the emitter matrix — spawns stay at local origin', () => {
    const out = makeOutputs(50);
    const def = {
      ...defaultParticleEffect(), worldSpace: false, maxParticles: 50,
      shape: { type: 'point' as const }, startSpeed: { min: 0, max: 0 },
      emission: { rateOverTime: 50 }, startLifetime: { min: 10, max: 10 }, gravity: 0,
    } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, out, 42);
    sim.setEmitterMatrix(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 5, -3, 1]));
    sim.step(0.1);
    expect(out.offsets[0]).toBeCloseTo(0); // not baked — backend applies the matrix to the group instead
    expect(out.offsets[1]).toBeCloseTo(0);
    expect(out.offsets[2]).toBeCloseTo(0);
  });

  it('one-shot (looping=false) stops emitting after duration; particles drain', () => {
    const sim = makeSim({
      looping: false,
      duration: 1,
      emission: { rateOverTime: 100 },
      startLifetime: { min: 0.5, max: 0.5 },
      startSpeed: { min: 0, max: 0 },
      gravity: 0,
    });
    for (let i = 0; i < 10; i++) sim.step(0.1); // 1 s: emitting window
    const atEnd = sim.aliveCount;
    expect(atEnd).toBeGreaterThan(0);
    // past duration: no new emission, existing particles age out within their 0.5 s life
    for (let i = 0; i < 10; i++) sim.step(0.1); // +1 s
    expect(sim.aliveCount).toBe(0);
  });

  it('one-shot fires a burst exactly once (no refire past duration)', () => {
    const sim = makeSim({
      looping: false,
      duration: 1,
      emission: { rateOverTime: 0, bursts: [{ time: 0.5, count: 8 }] },
      startLifetime: { min: 100, max: 100 },
    });
    for (let i = 0; i < 30; i++) sim.step(0.1); // 3 s — well past one duration cycle
    expect(sim.aliveCount).toBe(8); // fired once, never refired
  });

  it('looping refires bursts each duration cycle', () => {
    const sim = makeSim({
      looping: true,
      duration: 1,
      emission: { rateOverTime: 0, bursts: [{ time: 0.5, count: 8 }] },
      startLifetime: { min: 100, max: 100 },
    });
    for (let i = 0; i < 30; i++) sim.step(0.1); // 3 s ≈ 3 cycles → 3 bursts
    expect(sim.aliveCount).toBe(24);
  });

  it('fires emission bursts on time crossing', () => {
    const sim = makeSim({
      emission: { rateOverTime: 0, bursts: [{ time: 0.5, count: 8 }] },
      startLifetime: { min: 10, max: 10 },
      duration: 10,
    });
    sim.step(0.4); // before burst
    expect(sim.aliveCount).toBe(0);
    sim.step(0.2); // crosses t=0.5
    expect(sim.aliveCount).toBe(8);
  });

  it('fires a burst authored at time 0 on the first step (and again after reset/restart)', () => {
    const sim = makeSim({
      emission: { rateOverTime: 0, bursts: [{ time: 0, count: 8 }] },
      startLifetime: { min: 10, max: 10 },
      duration: 10,
    });
    // The half-open (prev, now] interval would skip t=0 (prev===0); the first-step closed lower
    // bound fires it. This is the case a control-track particle RESTART relies on.
    sim.step(0.1);
    expect(sim.aliveCount).toBe(8);
    sim.step(0.1); // does NOT re-fire on the next step
    expect(sim.aliveCount).toBe(8);
    // reset() (what backend.restart does) makes it a fresh first step → the t=0 burst fires again.
    sim.reset();
    expect(sim.aliveCount).toBe(0);
    sim.step(0.1);
    expect(sim.aliveCount).toBe(8);
  });
});

describe('CpuParticleSim — fillPool (continuous full-pool emission)', () => {
  it('fills the whole pool on the first step despite rateOverTime 0', () => {
    // This is exactly the galaxy case: rate 0 emits nothing normally, but fillPool keeps
    // the pool full — so the same asset renders on both the CPU and GPU backends.
    const sim = makeSim({ maxParticles: 64, emission: { rateOverTime: 0, fillPool: true }, startLifetime: { min: 5, max: 9 } });
    expect(sim.step(1 / 60)).toBe(64);
    expect(sim.aliveCount).toBe(64);
  });

  it('stays full as particles die (respawn in place, not swap-remove)', () => {
    const sim = makeSim({
      maxParticles: 50,
      emission: { rateOverTime: 0, fillPool: true },
      startLifetime: { min: 0.2, max: 0.2 }, // short life → many deaths over the run
      startSpeed: { min: 0, max: 0 },
      gravity: 0,
    });
    for (let i = 0; i < 100; i++) expect(sim.step(0.05)).toBe(50); // ~5 s, always full
  });

  it('staggers ages so deaths are spread out (no synchronized first-frame wipe)', () => {
    const sim = makeSim({
      maxParticles: 200,
      emission: { rateOverTime: 0, fillPool: true },
      startLifetime: { min: 1, max: 1 },
      startSpeed: { min: 0, max: 0 },
      gravity: 0,
    });
    sim.step(1 / 60); // prewarm with staggered ages
    // One short step past several would-be lifetimes still leaves the pool full because
    // ages were staggered across [0,1) rather than all starting at 0.
    expect(sim.step(1 / 60)).toBe(200);
  });

  it('reset clears the pool, then it re-fills on the next step', () => {
    const sim = makeSim({ maxParticles: 32, emission: { rateOverTime: 0, fillPool: true }, startLifetime: { min: 5, max: 5 } });
    sim.step(1 / 60);
    expect(sim.aliveCount).toBe(32);
    sim.reset();
    expect(sim.aliveCount).toBe(0);
    expect(sim.step(1 / 60)).toBe(32);
  });

  // The GPU backend (which requires fillPool) recycles collision-killed particles in place
  // to keep the pool full; the CPU sim must match so a fillPool effect looks the same on both.
  it('fillPool + collision kill recycles in place (pool stays full, does not drain)', () => {
    const sim = makeSim({
      maxParticles: 40,
      emission: { rateOverTime: 0, fillPool: true },
      shape: { type: 'point' },
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 }, // deaths come only from collision, not age
      gravity: 20,
      collision: { mode: 'kill', planeY: -0.5, bounce: 0 },
    });
    for (let i = 0; i < 60; i++) expect(sim.step(0.05)).toBe(40); // fall → hit plane → recycle
  });

  it('fillPool + collision bounce keeps the pool full and every particle above the plane', () => {
    const out = makeOutputs(40);
    const def = {
      ...defaultParticleEffect(),
      maxParticles: 40,
      emission: { rateOverTime: 0, fillPool: true },
      shape: { type: 'point' as const },
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      gravity: 20,
      collision: { mode: 'bounce' as const, planeY: 0, bounce: 0.4 },
    } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, out, 42);
    for (let i = 0; i < 80; i++) sim.step(0.05);
    expect(sim.aliveCount).toBe(40);
    for (let j = 0; j < sim.aliveCount; j++) expect(out.offsets[j * 3 + 1]).toBeGreaterThanOrEqual(-0.01);
  });
});

describe('CpuParticleSim — Phase 3 forces', () => {
  function simWith(overrides: Partial<ParticleEffectDef>) {
    const def = {
      ...defaultParticleEffect(),
      shape: { type: 'point' as const },
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      gravity: 0,
      emission: { rateOverTime: 100 },
      ...overrides,
    } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    return { sim: new CpuParticleSim(def, out, 42), out };
  }

  it('directional force accelerates particles along its vector', () => {
    const { sim, out } = simWith({ forces: [{ type: 'directional', x: 1, y: 0, z: 0, strength: 5 }] });
    sim.step(0.1); // spawn 10 at origin
    for (let i = 0; i < 10; i++) sim.step(0.1);
    expect(out.offsets[0]).toBeGreaterThan(0.5); // moved +x
  });

  it('point force attracts toward its position', () => {
    const { sim, out } = simWith({ forces: [{ type: 'point', x: 10, y: 0, z: 0, strength: 5 }] });
    sim.step(0.1);
    for (let i = 0; i < 10; i++) sim.step(0.1);
    expect(out.offsets[0]).toBeGreaterThan(0); // pulled toward +x target
  });

  it('drag reduces travel distance', () => {
    const force = [{ type: 'directional' as const, x: 1, y: 0, z: 0, strength: 5 }];
    const free = simWith({ forces: force });
    const dragged = simWith({ forces: force, drag: 5 });
    for (let i = 0; i < 12; i++) { free.sim.step(0.1); dragged.sim.step(0.1); }
    expect(dragged.out.offsets[0]).toBeLessThan(free.out.offsets[0]);
  });

  it('collision kill removes particles past the plane', () => {
    const killed = simWith({ gravity: 10, collision: { mode: 'kill', planeY: -0.5, bounce: 0 } });
    const free = simWith({ gravity: 10 });
    for (let i = 0; i < 20; i++) { killed.sim.step(0.1); free.sim.step(0.1); }
    expect(killed.sim.aliveCount).toBeLessThan(free.sim.aliveCount);
  });

  it('collision bounce keeps particles above the plane', () => {
    const { sim, out } = simWith({ gravity: 10, collision: { mode: 'bounce', planeY: 0, bounce: 0.5 } });
    for (let i = 0; i < 40; i++) sim.step(0.1);
    for (let j = 0; j < sim.aliveCount; j++) expect(out.offsets[j * 3 + 1]).toBeGreaterThanOrEqual(-0.01);
  });

  it('sphere collider bounces particles back outside the ball', () => {
    // particles spawn at origin, blown toward a sphere centered at +x so they hit its inside face
    const { sim, out } = simWith({
      forces: [{ type: 'directional', x: 10, y: 0, z: 0, strength: 1 }],
      collision: { mode: 'bounce', bounce: 1, shape: 'sphere', center: [3, 0, 0], radius: 1 },
    });
    for (let i = 0; i < 60; i++) sim.step(0.05);
    // every alive particle must sit on/outside the sphere surface (dist >= radius, small eps)
    for (let j = 0; j < sim.aliveCount; j++) {
      const dx = out.offsets[j * 3] - 3, dy = out.offsets[j * 3 + 1], dz = out.offsets[j * 3 + 2];
      expect(Math.hypot(dx, dy, dz)).toBeGreaterThanOrEqual(1 - 0.05);
    }
  });

  it('box collider kills particles that enter it', () => {
    const inBox = simWith({
      forces: [{ type: 'directional', x: 10, y: 0, z: 0, strength: 1 }],
      collision: { mode: 'kill', bounce: 0, shape: 'box', center: [3, 0, 0], width: 2, height: 2, depth: 2 },
    });
    const free = simWith({ forces: [{ type: 'directional', x: 10, y: 0, z: 0, strength: 1 }] });
    for (let i = 0; i < 20; i++) { inBox.sim.step(0.05); free.sim.step(0.05); }
    expect(inBox.sim.aliveCount).toBeLessThan(free.sim.aliveCount);
  });

  it('container sphere (kill) confines particles within the radius', () => {
    // repel from origin pushes particles outward; a container sphere culls any that escape
    const { sim, out } = simWith({
      forces: [{ type: 'point', x: 0, y: 0, z: 0, strength: -3 }],
      startSpeed: { min: 0.5, max: 0.5 },
      collision: { mode: 'kill', bounce: 0, shape: 'sphere', center: [0, 0, 0], radius: 2, invert: true },
    });
    for (let i = 0; i < 80; i++) sim.step(0.05);
    expect(sim.aliveCount).toBeGreaterThan(0);
    for (let j = 0; j < sim.aliveCount; j++) {
      const d = Math.hypot(out.offsets[j * 3], out.offsets[j * 3 + 1], out.offsets[j * 3 + 2]);
      expect(d).toBeLessThanOrEqual(2 + 0.05); // none survive outside the container
    }
  });

  it('rotation speed advances rotation over time', () => {
    const { sim, out } = simWith({ rotationSpeed: { min: 90, max: 90 } });
    sim.step(0.1);
    for (let i = 0; i < 10; i++) sim.step(0.1);
    expect(out.rotations[0]).toBeGreaterThan(0);
  });

  it('sprite-sheet frame advances over lifetime', () => {
    const { sim, out } = simWith({ startLifetime: { min: 1, max: 1 }, render: { blend: 'additive', tilesX: 2, tilesY: 2 } });
    sim.step(0.05); // ~t=0 → frame 0
    const early = out.frames[0];
    for (let i = 0; i < 8; i++) sim.step(0.1); // ~t=0.85 → frame 3
    expect(early).toBe(0);
    expect(out.frames[0]).toBeGreaterThan(early);
  });
});

describe('collide() geometry', () => {
  const hit: CollisionHit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

  it('normalizes a non-unit plane normal and migrates legacy planeY', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0.5, planeY: -2 });
    expect(rc.shape).toBe('plane');
    expect([rc.nx, rc.ny, rc.nz]).toEqual([0, 1, 0]);
    expect([rc.cx, rc.cy, rc.cz]).toEqual([0, -2, 0]);
    const tilted = resolveCollider({ mode: 'bounce', bounce: 0, planeNormal: [0, 3, 0] });
    expect(tilted.ny).toBeCloseTo(1); // unit length
  });

  it('plane: hit only on the back side, projects to the surface, reflects the normal', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0.5, shape: 'plane', planeNormal: [0, 1, 0], planePoint: [0, 0, 0] });
    expect(collide(rc, 0, 1, 0, 0, -2, 0, 0.5, hit)).toBe(false); // above the plane
    expect(collide(rc, 0, -0.5, 0, 1, -2, 0, 0.5, hit)).toBe(true); // below → hit
    expect(hit.y).toBeCloseTo(0); // projected onto the plane
    expect(hit.vy).toBeCloseTo(1); // -2 → +1 with restitution 0.5
    expect(hit.vx).toBeCloseTo(1); // tangential velocity untouched
  });

  it('sphere: inside is a hit pushed out to radius; outside is free', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'sphere', center: [0, 0, 0], radius: 2 });
    expect(collide(rc, 3, 0, 0, 0, 0, 0, 1, hit)).toBe(false); // outside
    expect(collide(rc, 1, 0, 0, -5, 0, 0, 1, hit)).toBe(true); // inside, moving inward
    expect(Math.hypot(hit.x, hit.y, hit.z)).toBeCloseTo(2); // pushed onto the surface
    expect(hit.vx).toBeCloseTo(5); // -5 reflected to +5 (elastic, normal = +x)
  });

  it('box: exits through the face of least penetration', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0, shape: 'box', center: [0, 0, 0], width: 2, height: 2, depth: 2 });
    expect(collide(rc, 2, 2, 2, 0, 0, 0, 0, hit)).toBe(false); // outside on all axes
    // just inside the +x face (shallowest penetration on x) moving -x
    expect(collide(rc, 0.9, 0.1, 0.1, -3, 0, 0, 0, hit)).toBe(true);
    expect(hit.x).toBeCloseTo(1); // pushed to the +x face (half-extent 1)
    expect(hit.vx).toBeCloseTo(0); // restitution 0 kills the inbound normal component
  });

  it('inverted sphere (container): hit when OUTSIDE, pushed back in and reflected', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'sphere', center: [0, 0, 0], radius: 2, invert: true });
    expect(collide(rc, 1, 0, 0, 0, 0, 0, 1, hit)).toBe(false); // inside the container → free
    expect(collide(rc, 3, 0, 0, 5, 0, 0, 1, hit)).toBe(true); // escaped, moving further out
    expect(Math.hypot(hit.x, hit.y, hit.z)).toBeCloseTo(2); // pulled back onto the surface
    expect(hit.vx).toBeCloseTo(-5); // +5 reflected to -5 (inward normal, elastic)
  });

  it('inverted box (container): clamps an escapee back through the wall', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0.5, shape: 'box', center: [0, 0, 0], width: 2, height: 2, depth: 2, invert: true });
    expect(collide(rc, 0.5, 0.5, 0.5, 0, 0, 0, 0.5, hit)).toBe(false); // inside → free
    expect(collide(rc, 1.5, 0.2, 0, 3, 0, 0, 0.5, hit)).toBe(true); // crossed the +x wall
    expect(hit.x).toBeCloseTo(1); // clamped to the +x face
    expect(hit.vx).toBeCloseTo(-1.5); // 3 → -1.5 (reflected, restitution 0.5)
    expect(hit.y).toBeCloseTo(0.2); // untouched axis stays put
  });

  it('inverted plane: hit on the +normal side instead of behind', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0, shape: 'plane', planeNormal: [0, 1, 0], planePoint: [0, 0, 0], invert: true });
    expect(collide(rc, 0, -1, 0, 0, 0, 0, 0, hit)).toBe(false); // below → free now
    expect(collide(rc, 0, 1, 0, 0, 2, 0, 0, hit)).toBe(true); // above → hit
    expect(hit.y).toBeCloseTo(0); // projected onto the plane
    expect(hit.vy).toBeCloseTo(0); // upward velocity killed (inward normal, restitution 0)
  });

  it('cylinder (Y axis): inside pushed out the curved wall; outside is free', () => {
    // radius 1, length 4 (half-length 2), axis +Y
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'cylinder', center: [0, 0, 0], axis: [0, 1, 0], radius: 1, height: 4 });
    expect(collide(rc, 2, 0, 0, 0, 0, 0, 1, hit)).toBe(false); // outside radius → free
    expect(collide(rc, 0, 3, 0, 0, 0, 0, 1, hit)).toBe(false); // past the end cap → free
    expect(collide(rc, 0.5, 0, 0, -3, 0, 0, 1, hit)).toBe(true); // inside, moving toward -x wall
    expect(Math.hypot(hit.x, hit.z)).toBeCloseTo(1); // pushed onto the curved wall
    expect(hit.y).toBeCloseTo(0); // axial position unchanged
    expect(hit.vx).toBeCloseTo(3); // -3 reflected to +3 (radial normal +x, elastic)
  });

  it('cylinder (Y axis): exits the nearer end cap when closer than the wall', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'cylinder', center: [0, 0, 0], axis: [0, 1, 0], radius: 2, height: 2 });
    // near the +Y cap (axial pen 0.1) vs wall (radial pen 1.5) → exit through the cap. Moving
    // -Y (inbound to the cap normal) so the axial component reflects.
    expect(collide(rc, 0.5, 0.9, 0, 0, -3, 0, 1, hit)).toBe(true);
    expect(hit.y).toBeCloseTo(1); // pushed to the +Y cap (half-length 1)
    expect(hit.vy).toBeCloseTo(3); // -3 reflected to +3 (cap normal +Y, elastic)
  });

  it('cylinder along a non-Y axis (X): radial/axial decompose along the tilted axis', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 1, shape: 'cylinder', center: [0, 0, 0], axis: [1, 0, 0], radius: 1, height: 6 });
    expect(collide(rc, 0, 2, 0, 0, 0, 0, 1, hit)).toBe(false); // outside the radius (perp to X) → free
    expect(collide(rc, 0, 0.5, 0, 0, -3, 0, 1, hit)).toBe(true); // inside, moving toward the -y wall
    expect(Math.hypot(hit.y, hit.z)).toBeCloseTo(1); // on the curved wall (radial is the y/z plane)
    expect(hit.x).toBeCloseTo(0); // axial (X) position unchanged
    expect(hit.vy).toBeCloseTo(3); // reflected radially
  });

  it('inverted cylinder (container): clamps an escapee back inside radius + caps', () => {
    const rc = resolveCollider({ mode: 'bounce', bounce: 0.5, shape: 'cylinder', center: [0, 0, 0], axis: [0, 1, 0], radius: 2, height: 4, invert: true });
    expect(collide(rc, 1, 1, 0, 0, 0, 0, 0.5, hit)).toBe(false); // inside the container → free
    expect(collide(rc, 3, 0, 0, 4, 0, 0, 0.5, hit)).toBe(true); // escaped radially
    expect(Math.hypot(hit.x, hit.z)).toBeCloseTo(2); // clamped to the curved wall
    expect(hit.vx).toBeCloseTo(-2); // 4 → -2 (inward radial reflection, restitution 0.5)
    expect(collide(rc, 0, 3, 0, 0, 2, 0, 0.5, hit)).toBe(true); // escaped past the +Y cap
    expect(hit.y).toBeCloseTo(2); // clamped to the cap (half-length 2)
    expect(hit.vy).toBeCloseTo(-1); // 2 → -1 (inward axial reflection)
  });
});

describe('emitter shapes — resolveShape + sampling', () => {
  it('derives inner/outer radius from legacy radius, fromShell, or explicit start/end', () => {
    expect(resolveShape({ type: 'circle', radius: 3 })).toMatchObject({ innerR: 0, outerR: 3 });
    expect(resolveShape({ type: 'circle', radius: 3, fromShell: true })).toMatchObject({ innerR: 3, outerR: 3 });
    expect(resolveShape({ type: 'cone', radiusStart: 1, radiusEnd: 4 })).toMatchObject({ innerR: 1, outerR: 4 });
  });

  it('flags box shell only when sizeStart is set, defaulting outer half-extents from size', () => {
    expect(resolveShape({ type: 'box', size: [2, 2, 2] })).toMatchObject({ boxShell: false, outHalf: [2, 2, 2] });
    expect(resolveShape({ type: 'box', sizeStart: [1, 1, 1], sizeEnd: [2, 2, 2] }))
      .toMatchObject({ boxShell: true, inHalf: [1, 1, 1], outHalf: [2, 2, 2] });
  });

  it('perpBasis builds an orthonormal basis for a tilted axis', () => {
    for (const axis of [[1, 2, 3], [1, 0, 0], [0, 1, 0]] as [number, number, number][]) {
      const b = perpBasis(axis);
      const dot = (a: number[], c: number[]) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
      const a = [b.ax, b.ay, b.az], u = [b.ux, b.uy, b.uz], v = [b.vx, b.vy, b.vz];
      expect(dot(a, a)).toBeCloseTo(1); // unit axis
      expect(dot(u, u)).toBeCloseTo(1);
      expect(dot(v, v)).toBeCloseTo(1);
      expect(dot(a, u)).toBeCloseTo(0); // mutually perpendicular
      expect(dot(a, v)).toBeCloseTo(0);
      expect(dot(u, v)).toBeCloseTo(0);
    }
  });

  // Spawn a poolful and return each particle's local position (speed 0 + no gravity → it
  // stays where it spawned, so offsets are the raw shape samples).
  function spawnPositions(shape: ParticleEffectDef['shape']): [number, number, number][] {
    const def = {
      ...defaultParticleEffect(),
      shape,
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      gravity: 0,
      maxParticles: 1000,
      worldSpace: false,
      emission: { rateOverTime: 1_000_000 },
    } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    const sim = new CpuParticleSim(def, out, 7);
    sim.step(0.5);
    const pts: [number, number, number][] = [];
    for (let i = 0; i < sim.aliveCount; i++) pts.push([out.offsets[i * 3], out.offsets[i * 3 + 1], out.offsets[i * 3 + 2]]);
    return pts;
  }

  it('circle annulus spawns within the band and never inside the inner radius', () => {
    const pts = spawnPositions({ type: 'circle', radiusStart: 1, radiusEnd: 2 });
    expect(pts.length).toBeGreaterThan(100);
    for (const [x, y, z] of pts) {
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(1 - 0.02); // outside the inner radius
      expect(r).toBeLessThanOrEqual(2 + 0.02); // inside the outer radius
      expect(Math.abs(y)).toBeLessThan(0.01); // flat disc
    }
  });

  it('sphere annulus (cbrt volume formula) spawns in the spherical shell, none inside the inner radius', () => {
    const pts = spawnPositions({ type: 'sphere', radiusStart: 1.5, radiusEnd: 3 });
    expect(pts.length).toBeGreaterThan(100);
    for (const [x, y, z] of pts) {
      const r = Math.hypot(x, y, z); // 3D radius — distinct cbrt path from the disc shapes
      expect(r).toBeGreaterThanOrEqual(1.5 - 0.03); // hollow core
      expect(r).toBeLessThanOrEqual(3 + 0.03);
    }
  });

  it('cone annulus emits in the disc band (shared annulusR path) and excludes the inner radius', () => {
    const pts = spawnPositions({ type: 'cone', radiusStart: 1, radiusEnd: 2, angle: 0 });
    expect(pts.length).toBeGreaterThan(100);
    for (const [x, , z] of pts) {
      const r = Math.hypot(x, z);
      expect(r).toBeGreaterThanOrEqual(1 - 0.02);
      expect(r).toBeLessThanOrEqual(2 + 0.02);
    }
  });

  // Return each particle's unit launch direction. speed 1, no gravity/drag → velocity is constant,
  // so the per-step DISPLACEMENT (pos after step 2 − pos after step 1) is v·dt regardless of where
  // the particle spawned (isolates direction even for off-origin shapes like polyline).
  function spawnDirections(shape: ParticleEffectDef['shape']): [number, number, number][] {
    const def = {
      ...defaultParticleEffect(),
      shape,
      startSpeed: { min: 1, max: 1 },
      startLifetime: { min: 100, max: 100 },
      gravity: [0, 0, 0] as [number, number, number],
      drag: 0,
      maxParticles: 500,
      worldSpace: false,
      emission: { rateOverTime: 1_000_000 }, // fills the pool on step 1; no deaths (long life)
    } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    const sim = new CpuParticleSim(def, out, 9);
    const dt = 1e-3;
    sim.step(dt);
    const p1 = Float32Array.from(out.offsets.subarray(0, sim.aliveCount * 3));
    sim.step(dt);
    const dirs: [number, number, number][] = [];
    for (let i = 0; i < sim.aliveCount; i++) {
      const x = out.offsets[i * 3] - p1[i * 3];
      const y = out.offsets[i * 3 + 1] - p1[i * 3 + 1];
      const z = out.offsets[i * 3 + 2] - p1[i * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      dirs.push([x / len, y / len, z / len]);
    }
    return dirs;
  }

  it('cone (default axis) launches toward +Y; axis (0,-1,0) launches toward -Y (2D up-cone)', () => {
    const up = spawnDirections({ type: 'cone', angle: 10, radius: 0 });
    expect(up.length).toBeGreaterThan(100);
    for (const [, y] of up) expect(y).toBeGreaterThan(0.9); // narrow cone → mostly +Y

    const down = spawnDirections({ type: 'cone', angle: 10, radius: 0, axis: [0, -1, 0] });
    for (const [, y] of down) expect(y).toBeLessThan(-0.9); // flipped to -Y (screen-up in PixiJS)
  });

  it('polyline emits along its axis: default +Y, axis (0,-1,0) → -Y', () => {
    const up = spawnDirections({ type: 'polyline', points: [[-10, 0], [10, 0]], axis: [0, 1, 0] });
    expect(up.length).toBeGreaterThan(50);
    for (const [, y] of up) expect(y).toBeCloseTo(1, 5);
    const down = spawnDirections({ type: 'polyline', points: [[-10, 0], [10, 0]], axis: [0, -1, 0] });
    for (const [, y] of down) expect(y).toBeCloseTo(-1, 5);
  });

  it('gravity vector is applied as-is; scalar migrates to (0,-g,0)', () => {
    // vector [3,0,0] → accelerate +X only (no Y change). speed 0 so gravity is the only motion.
    const vecDef = {
      ...defaultParticleEffect(), shape: { type: 'point' as const }, startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 }, gravity: [3, 0, 0] as [number, number, number], drag: 0,
      emission: { rateOverTime: 0 }, maxParticles: 4,
    } as ParticleEffectDef;
    const vOut = makeOutputs(4);
    const vSim = new CpuParticleSim(vecDef, vOut, 1);
    vSim.injectAt(0, 0, 0);
    vSim.step(0.1); vSim.step(0.1);
    expect(vOut.offsets[0]).toBeGreaterThan(0);      // moved +X
    expect(Math.abs(vOut.offsets[1])).toBeLessThan(1e-6); // Y untouched

    // scalar 10 behaves exactly like vector [0,-10,0] (downward).
    const mk = (g: number | [number, number, number]) => {
      const d = { ...vecDef, gravity: g } as ParticleEffectDef;
      const o = makeOutputs(4); const s = new CpuParticleSim(d, o, 1);
      s.injectAt(0, 0, 0); s.step(0.1); s.step(0.1); return o.offsets[1];
    };
    expect(mk(10)).toBeCloseTo(mk([0, -10, 0]), 6);
    expect(mk(10)).toBeLessThan(0); // scalar pulls -Y
  });

  it('cylinder confines particles to the radius and ±length/2 along a non-Y axis', () => {
    const pts = spawnPositions({ type: 'cylinder', axis: [1, 0, 0], radiusEnd: 2, length: 4 });
    expect(pts.length).toBeGreaterThan(100);
    let maxAxial = 0, maxRadial = 0;
    for (const [x, y, z] of pts) {
      maxAxial = Math.max(maxAxial, Math.abs(x)); // axial = X (the chosen axis)
      maxRadial = Math.max(maxRadial, Math.hypot(y, z)); // radial = perpendicular plane
      expect(Math.abs(x)).toBeLessThanOrEqual(2 + 0.02); // half-length 2
      expect(Math.hypot(y, z)).toBeLessThanOrEqual(2 + 0.02); // radius 2
    }
    expect(maxAxial).toBeGreaterThan(1.5); // actually spans the length
    expect(maxRadial).toBeGreaterThan(1.5); // and the radius
  });

  it('box shell fills the frame between inner and outer (legacy solid box unchanged)', () => {
    const shell = spawnPositions({ type: 'box', sizeStart: [1, 1, 1], sizeEnd: [2, 2, 2] });
    for (const [x, y, z] of shell) {
      expect(Math.max(Math.abs(x), Math.abs(y), Math.abs(z))).toBeGreaterThanOrEqual(1 - 0.02); // outside the inner box
      expect(Math.abs(x)).toBeLessThanOrEqual(2 + 0.02);
      expect(Math.abs(y)).toBeLessThanOrEqual(2 + 0.02);
      expect(Math.abs(z)).toBeLessThanOrEqual(2 + 0.02);
    }
    // legacy solid box (no sizeStart) still fills the whole volume, including near the center
    const solid = spawnPositions({ type: 'box', size: [2, 0.2, 1.2] });
    expect(solid.some(([x, _y, z]) => Math.abs(x) < 0.5 && Math.abs(z) < 0.3)).toBe(true);
    for (const [x, y, z] of solid) {
      expect(Math.abs(x)).toBeLessThanOrEqual(2 + 0.02);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.2 + 0.02);
      expect(Math.abs(z)).toBeLessThanOrEqual(1.2 + 0.02);
    }
  });
});

describe('spriteFrameIndex — sprite-sheet playback modes', () => {
  it('single tile is always frame 0', () => {
    for (const t of [0, 0.5, 1]) expect(spriteFrameIndex(t, 1, 'loop', 4)).toBe(0);
  });

  it("once: forward pass, clamps to last frame and holds", () => {
    expect(spriteFrameIndex(0, 4, 'once')).toBe(0);
    expect(spriteFrameIndex(0.5, 4, 'once')).toBe(2);
    expect(spriteFrameIndex(0.99, 4, 'once')).toBe(3);
    expect(spriteFrameIndex(1, 4, 'once')).toBe(3); // clamped, not wrapped to 0
  });

  it('loop: wraps and repeats cycles over the lifetime', () => {
    expect(spriteFrameIndex(0, 4, 'loop', 1)).toBe(0);
    expect(spriteFrameIndex(0.5, 4, 'loop', 1)).toBe(2);
    expect(spriteFrameIndex(1, 4, 'loop', 1)).toBe(0); // wraps at the end
    // 2 cycles over the life: halfway through the life is the end of cycle 1 → wraps to 0
    expect(spriteFrameIndex(0.5, 4, 'loop', 2)).toBe(0);
    expect(spriteFrameIndex(0.25, 4, 'loop', 2)).toBe(2);
  });

  it('pingpong: forward then backward (flip-flop), stays in range', () => {
    // one cycle = 2N-2 = 6 virtual frames: 0,1,2,3,2,1
    expect(spriteFrameIndex(0 / 6, 4, 'pingpong', 1)).toBe(0);
    expect(spriteFrameIndex(3 / 6, 4, 'pingpong', 1)).toBe(3); // peak
    expect(spriteFrameIndex(4 / 6, 4, 'pingpong', 1)).toBe(2); // coming back down
    expect(spriteFrameIndex(5 / 6, 4, 'pingpong', 1)).toBe(1);
    // never leaves [0, N-1]
    for (let i = 0; i <= 100; i++) {
      const f = spriteFrameIndex(i / 100, 4, 'pingpong', 3);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(3);
    }
  });

  it('random-start offset shifts the frame modulo tiles', () => {
    expect(spriteFrameIndex(0, 4, 'loop', 1, 2)).toBe(2); // 0 + offset 2
    expect(spriteFrameIndex(0.5, 4, 'loop', 1, 3)).toBe((2 + 3) % 4); // 1
  });
});

describe('CpuParticleSim — sprite playback in render output', () => {
  function simWith(overrides: Partial<ParticleEffectDef>) {
    const def = { ...defaultParticleEffect(), looping: false, startLifetime: { min: 1, max: 1 }, ...overrides } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    return { sim: new CpuParticleSim(def, out, 7), out };
  }

  it('loop mode wraps the frame back to 0 near end of life', () => {
    const { sim, out } = simWith({ render: { blend: 'additive', tilesX: 2, tilesY: 2, spriteMode: 'loop', spriteCycles: 1 } });
    sim.step(0.02); // ~t≈0 → frame 0
    expect(out.frames[0]).toBe(0);
    for (let i = 0; i < 9; i++) sim.step(0.1); // ~t≈0.92 → frame 3
    expect(out.frames[0]).toBe(3);
  });

  it('random-start spreads starting frames across particles', () => {
    const { sim, out } = simWith({ maxParticles: 200, emission: { rateOverTime: 5000 }, render: { blend: 'additive', tilesX: 2, tilesY: 2, spriteMode: 'loop', spriteRandomStart: true } });
    sim.step(0.02); // many fresh particles, all at t≈0
    const distinct = new Set<number>();
    for (let j = 0; j < sim.aliveCount; j++) distinct.add(out.frames[j]);
    expect(distinct.size).toBeGreaterThan(1); // not all locked to frame 0
  });
});

describe('mesh particles — composeParticleMatrices', () => {
  it('writes translation + uniform scale into the column-major instance matrix', () => {
    const offsets = new Float32Array([1, 2, 3]);
    const scales = new Float32Array([2]);
    const rotations = new Float32Array([0]); // no rotation → axes are pure scale
    const out = new Float32Array(16);
    composeParticleMatrices(offsets, scales, rotations, 1, out);
    // column-major: translation is elements 12,13,14; diagonal basis is the scale at 0,5,10
    expect(out[12]).toBeCloseTo(1);
    expect(out[13]).toBeCloseTo(2);
    expect(out[14]).toBeCloseTo(3);
    expect(out[0]).toBeCloseTo(2);
    expect(out[5]).toBeCloseTo(2);
    expect(out[10]).toBeCloseTo(2);
    expect(out[15]).toBeCloseTo(1);
  });

  it('rotation tumbles without distorting scale (basis columns keep length == scale)', () => {
    const out = new Float32Array(16);
    composeParticleMatrices(new Float32Array([0, 0, 0]), new Float32Array([1.5]), new Float32Array([1.2]), 1, out);
    const col0 = Math.hypot(out[0], out[1], out[2]);
    const col1 = Math.hypot(out[4], out[5], out[6]);
    const col2 = Math.hypot(out[8], out[9], out[10]);
    expect(col0).toBeCloseTo(1.5);
    expect(col1).toBeCloseTo(1.5);
    expect(col2).toBeCloseTo(1.5);
  });

  it('only composes the first `count` matrices', () => {
    const out = new Float32Array(32); // room for 2
    composeParticleMatrices(new Float32Array([5, 5, 5, 9, 9, 9]), new Float32Array([1, 1]), new Float32Array([0, 0]), 1, out);
    expect(out[12]).toBeCloseTo(5); // instance 0 written
    expect(out[16 + 12]).toBe(0);   // instance 1 untouched
  });
});

describe('mesh particles — GPU/CPU rotation parity (Missing Test #1)', () => {
  // Plain-JS transcription of the TSL `eulerRotateXYZ` matrix in gpuComputeBackend.ts
  // (m00..m22, verbatim). The GPU mesh tumble rotates vertices with this matrix; the
  // CPU path (composeParticleMatrices) rotates instances via THREE.Euler('XYZ'). Both
  // MUST agree, or a primitive spins differently on WebGPU vs the WebGL/CPU fallback.
  // We anchor BOTH against THREE.makeRotationFromEuler(XYZ) — the independent ground
  // truth the GPU formula's doc-comment claims to mirror — so a typo in either path
  // (this transcription OR composeParticleMatrices) is caught.
  function gpuEulerRotateXYZ(rx: number, ry: number, rz: number): number[] {
    const a = Math.cos(rx), b = Math.sin(rx);
    const c = Math.cos(ry), d = Math.sin(ry);
    const e = Math.cos(rz), f = Math.sin(rz);
    const ae = a * e, af = a * f, be = b * e, bf = b * f;
    const m00 = c * e,        m01 = -(c * f),       m02 = d;
    const m10 = af + be * d,  m11 = ae - bf * d,    m12 = -b * c;
    const m20 = bf - ae * d,  m21 = be + af * d,    m22 = a * c;
    // row-major 3x3 → apply as a left-multiply on a column vector
    return [m00, m01, m02, m10, m11, m12, m20, m21, m22];
  }
  const applyM3 = (m: number[], v: [number, number, number]): [number, number, number] => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  const testVecs: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.4, -0.7, 0.5]];

  it('the GPU eulerRotateXYZ matrix matches THREE.makeRotationFromEuler in XYZ order', () => {
    for (const r of [0, 0.3, 1.2, -0.9, Math.PI / 2]) {
      const rx = r, ry = r * 0.73, rz = r * 0.31; // the per-axis tumble rates
      const three = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
      const gpu = gpuEulerRotateXYZ(rx, ry, rz);
      for (const v of testVecs) {
        const g = applyM3(gpu, v);
        const t = new THREE.Vector3(...v).applyMatrix4(three);
        expect(g[0]).toBeCloseTo(t.x, 5);
        expect(g[1]).toBeCloseTo(t.y, 5);
        expect(g[2]).toBeCloseTo(t.z, 5);
      }
    }
  });

  it('composeParticleMatrices rotation equals the GPU eulerRotateXYZ tumble for the same scalar', () => {
    for (const r of [0.3, 1.2, -0.9]) {
      const out = new Float32Array(16);
      // unit scale, no offset → the basis IS the pure rotation
      composeParticleMatrices(new Float32Array([0, 0, 0]), new Float32Array([1]), new Float32Array([r]), 1, out);
      const cpu = new THREE.Matrix4().fromArray(out);
      const gpu = gpuEulerRotateXYZ(r, r * 0.73, r * 0.31);
      for (const v of testVecs) {
        const c = new THREE.Vector3(...v).applyMatrix4(cpu);
        const g = applyM3(gpu, v);
        expect(c.x).toBeCloseTo(g[0], 5);
        expect(c.y).toBeCloseTo(g[1], 5);
        expect(c.z).toBeCloseTo(g[2], 5);
      }
    }
  });
});

describe('particle trails', () => {
  const SEG = 5;
  function trailSim(overrides: Partial<ParticleEffectDef> = {}) {
    const def = {
      ...defaultParticleEffect(),
      maxParticles: 20,
      shape: { type: 'point' as const },
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      gravity: 0,
      emission: { rateOverTime: 0 },
      startColor: { r: 1, g: 1, b: 1 },
      startOpacity: 1,
      sizeOverLife: undefined,
      opacityOverLife: undefined,
      colorOverLife: undefined,
      trail: { enabled: true, segments: SEG },
      ...overrides,
    } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    const vPer = (SEG - 1) * 2;
    const trail: TrailOutputs = {
      positions: new Float32Array(def.maxParticles * vPer * 3),
      colors: new Float32Array(def.maxParticles * vPer * 3),
    };
    return { sim: new CpuParticleSim(def, out, 42, trail), out, trail, vPer };
  }

  it('records position history so the newest trail vertex tracks the particle', () => {
    const { sim, out, vPer } = trailSim({ emission: { rateOverTime: 50 } });
    sim.step(0.1); // spawn ~5 at origin, history seeded at origin
    // force a known motion by nudging via a directional force
    const moving = trailSim({ emission: { rateOverTime: 50 }, forces: [{ type: 'directional', x: 0, y: 1, z: 0, strength: 10 }] });
    for (let i = 0; i < 4; i++) moving.sim.step(0.1);
    // the head vertex (last segment, second endpoint) of particle 0 should equal its current offset
    const headY = moving.out.offsets[1];
    const lastSeg = (SEG - 1) - 1;
    const o = 0 * vPer * 3 + lastSeg * 6;
    expect(moving.trail.positions[o + 4]).toBeCloseTo(headY, 4); // y of the segment's head endpoint
    expect(headY).toBeGreaterThan(0); // actually moved
    expect(out.opacities[0]).toBeGreaterThan(0);
  });

  it('tapers trail color from faint tail to full head', () => {
    const { sim, trail, vPer } = trailSim({ emission: { rateOverTime: 50 }, forces: [{ type: 'directional', x: 1, y: 0, z: 0, strength: 8 }] });
    for (let i = 0; i < 6; i++) sim.step(0.1);
    // tail segment (s=0) start-vertex red vs head segment (s=SEG-2) end-vertex red
    const tailRed = trail.colors[0 * vPer * 3 + 0 * 6 + 0];
    const headRed = trail.colors[0 * vPer * 3 + (SEG - 2) * 6 + 3];
    expect(headRed).toBeGreaterThan(tailRed);
  });

  it('keeps trail history aligned after swap-remove recycling', () => {
    // short lifetimes → particles die and slots get reused; just assert no NaN/Inf leak
    const { sim, trail } = trailSim({ emission: { rateOverTime: 100 }, startLifetime: { min: 0.2, max: 0.3 }, startSpeed: { min: 1, max: 2 } });
    for (let i = 0; i < 30; i++) sim.step(0.05);
    for (let k = 0; k < sim.aliveCount * (SEG - 1) * 2 * 3; k++) {
      expect(Number.isFinite(trail.positions[k])).toBe(true);
    }
  });
});

describe('sub-emitters — lifecycle events + injection', () => {
  function evSim(overrides: Partial<ParticleEffectDef>) {
    const def = {
      ...defaultParticleEffect(),
      shape: { type: 'point' as const },
      startSpeed: { min: 0, max: 0 },
      startLifetime: { min: 100, max: 100 },
      gravity: 0,
      emission: { rateOverTime: 0 },
      ...overrides,
    } as ParticleEffectDef;
    const out = makeOutputs(def.maxParticles);
    return { sim: new CpuParticleSim(def, out, 42), out };
  }

  it('records a birth event (pos+vel sextet) per spawn when a birth trigger is configured', () => {
    const { sim } = evSim({ emission: { rateOverTime: 50 }, subEmitters: [{ trigger: 'birth', effect: 'x' }] });
    sim.step(0.1); // 50 * 0.1 = 5 spawns
    expect(sim.birthEvents.length).toBe(5 * 6);
    expect(sim.deathEvents.length).toBe(0); // no death trigger → not collected
  });

  it('records death events when a death trigger is configured', () => {
    const { sim } = evSim({ emission: { rateOverTime: 100 }, startLifetime: { min: 0.05, max: 0.05 }, subEmitters: [{ trigger: 'death', effect: 'x' }] });
    sim.step(0.1); // spawn 10, then all age past their 0.05 s life and die this step
    expect(sim.deathEvents.length).toBeGreaterThan(0);
    expect(sim.deathEvents.length % 6).toBe(0);
    expect(sim.birthEvents.length).toBe(0);
  });

  it('collects nothing when no sub-emitters are configured (cheap fast path)', () => {
    const { sim } = evSim({ emission: { rateOverTime: 50 } });
    sim.step(0.1);
    expect(sim.birthEvents.length).toBe(0);
    expect(sim.deathEvents.length).toBe(0);
  });

  it('clears events each step (events are per-step, not cumulative)', () => {
    const { sim } = evSim({ emission: { rateOverTime: 50 }, subEmitters: [{ trigger: 'birth', effect: 'x' }] });
    sim.step(0.1);
    expect(sim.birthEvents.length).toBe(5 * 6);
    sim.step(0); // no new spawns → previous step's events must be cleared
    expect(sim.birthEvents.length).toBe(0);
  });

  it('injectAt spawns a particle at the given position with inherited velocity', () => {
    const { sim, out } = evSim({});
    sim.injectAt(2, 3, 4, 1, 0, 0); // velocity +x
    expect(sim.aliveCount).toBe(1);
    sim.step(0.1); // integrate one frame + write outputs
    expect(out.offsets[0]).toBeGreaterThan(2);          // moved +x from inherited velocity
    expect(out.offsets[1]).toBeCloseTo(3, 1);           // y unchanged (no gravity)
    expect(out.offsets[2]).toBeCloseTo(4, 1);           // z unchanged
  });

  it('injectAt returns true until the pool is full, then false (F6 burst-truncation signal)', () => {
    const { sim } = evSim({ maxParticles: 2 });
    expect(sim.injectAt(0, 0, 0)).toBe(true);  // 1/2
    expect(sim.injectAt(0, 0, 0)).toBe(true);  // 2/2 — full
    expect(sim.injectAt(0, 0, 0)).toBe(false); // dropped
    expect(sim.aliveCount).toBe(2);
  });
});

describe('clampSimDt (shared backend frame-step ceiling)', () => {
  it('caps a long/hitching frame at MAX_SIM_DT', () => {
    expect(clampSimDt(0.1)).toBe(MAX_SIM_DT);
    expect(clampSimDt(1.0)).toBe(MAX_SIM_DT);
    expect(clampSimDt(MAX_SIM_DT)).toBe(MAX_SIM_DT);
  });

  it('clamps negative dt to 0', () => {
    expect(clampSimDt(-1)).toBe(0);
    expect(clampSimDt(-0.001)).toBe(0);
  });

  it('passes a normal frame step through unchanged', () => {
    expect(clampSimDt(1 / 60)).toBeCloseTo(1 / 60, 12);
    expect(clampSimDt(0.02)).toBe(0.02);
    expect(clampSimDt(0)).toBe(0);
  });
});

describe('seekSteps (shared CPU/GPU seek step count, F3)', () => {
  it('forward seek = floor(span / PREWARM_STEP)', () => {
    expect(seekSteps(0, 5)).toBe(Math.floor(5 / PREWARM_STEP)); // 150 @ 1/30
    expect(seekSteps(0, 5)).toBe(150);
  });

  it('steps forward from the current sim time (cheap forward scrub)', () => {
    // Scrubbing 3s → 5s only advances the 2s difference, NOT from zero.
    expect(seekSteps(3, 5)).toBe(Math.floor((5 - 3) / PREWARM_STEP)); // 60
  });

  it('a backward span clamps to 0 (caller rewinds to 0 first)', () => {
    expect(seekSteps(5, 3)).toBe(0);
    expect(seekSteps(5, 5)).toBe(0);
  });

  it('caps far jumps at SEEK_MAX_STEPS so a scrub cannot freeze the UI', () => {
    // 0 → 100s would be 3000 steps; capped at 600 (≈20 s). Past the cap both
    // backends approximate identically.
    expect(seekSteps(0, 100)).toBe(SEEK_MAX_STEPS);
    expect(seekSteps(0, SEEK_MAX_STEPS * PREWARM_STEP)).toBe(SEEK_MAX_STEPS); // exactly the cap
  });
});

describe('gpuDefSupported (GPU feature eligibility, F11)', () => {
  const base = (): ParticleEffectDef => ({ ...defaultParticleEffect(), emission: { rateOverTime: 0, fillPool: true } });
  const force = (): ForceField => ({ type: 'directional', x: 0, y: 1, z: 0, strength: 1 });

  it('requires fillPool emission', () => {
    expect(gpuDefSupported(base())).toBe(true);
    expect(gpuDefSupported({ ...base(), emission: { rateOverTime: 10 } })).toBe(false);
  });

  it('rejects trails and sub-emitters (no GPU history/atomic plumbing)', () => {
    expect(gpuDefSupported({ ...base(), trail: { enabled: true, segments: 8 } })).toBe(false);
    expect(gpuDefSupported({ ...base(), subEmitters: [{ trigger: 'death', effect: 'x' }] })).toBe(false);
  });

  it('falls back to CPU when forces exceed the GPU kernel cap', () => {
    const atCap = { ...base(), forces: Array.from({ length: MAX_GPU_FORCES }, force) };
    const overCap = { ...base(), forces: Array.from({ length: MAX_GPU_FORCES + 1 }, force) };
    expect(gpuDefSupported(atCap)).toBe(true);     // exactly the cap is fine
    expect(gpuDefSupported(overCap)).toBe(false);  // one over → CPU (no silent drop)
  });

  it('rejects polyline (2D-only shape; GPU maps it to point, ignoring line + axis)', () => {
    // Otherwise a {polyline, simulation:'gpu', fillPool} def would route to GPU and diverge from
    // CPU (positions collapse to the origin; the post-2c emit axis is ignored).
    const poly = { ...base(), shape: { type: 'polyline' as const, points: [[-1, 0], [1, 0]] as [number, number][], axis: [0, -1, 0] as [number, number, number] } };
    expect(gpuDefSupported(poly)).toBe(false);
  });
});

describe('CpuParticleSim — degenerate shapes (F12)', () => {
  // radius/angle/length 0 collapse a shape to a point; spawn dirs/positions must stay
  // finite (no NaN from sqrt of a tiny negative, 0-length normalize, etc.).
  it.each([
    ['sphere radius 0', { type: 'sphere' as const, radius: 0 }],
    ['circle radius 0', { type: 'circle' as const, radius: 0 }],
    ['cone angle 0',    { type: 'cone' as const, angle: 0, radius: 0 }],
    ['cylinder length 0', { type: 'cylinder' as const, length: 0, radius: 0 }],
    ['box size 0',      { type: 'box' as const, size: [0, 0, 0] as [number, number, number] }],
  ])('produces finite outputs for %s', (_label, shape) => {
    const out = makeOutputs(50);
    const def = {
      ...defaultParticleEffect(), maxParticles: 50, shape,
      emission: { rateOverTime: 50 }, startLifetime: { min: 10, max: 10 }, startSpeed: { min: 0, max: 5 },
    } as ParticleEffectDef;
    const sim = new CpuParticleSim(def, out, 42);
    const alive = sim.step(0.1);
    expect(alive).toBeGreaterThan(0);
    for (let j = 0; j < alive; j++) {
      for (let k = 0; k < 3; k++) expect(Number.isFinite(out.offsets[j * 3 + k])).toBe(true);
      expect(Number.isFinite(out.scales[j])).toBe(true);
      expect(Number.isFinite(out.opacities[j])).toBe(true);
      expect(Number.isFinite(out.rotations[j])).toBe(true);
    }
  });
});

describe('curves — edge cases (Missing Test #4)', () => {
  it('single-point curve returns that point everywhere (scaled)', () => {
    const c = { points: [{ t: 0.5, v: 7 }], scale: 2 };
    expect(sampleCurve(c, 0)).toBe(14);
    expect(sampleCurve(c, 0.5)).toBe(14);
    expect(sampleCurve(c, 1)).toBe(14);
  });

  it('samples exactly on an interior stop', () => {
    expect(sampleCurve({ points: [{ t: 0, v: 0 }, { t: 0.5, v: 10 }, { t: 1, v: 0 }] }, 0.5)).toBe(10);
  });

  it('a zero-span (duplicate-t) segment never divides by zero', () => {
    const c = { points: [{ t: 0, v: 0 }, { t: 0.5, v: 3 }, { t: 0.5, v: 9 }, { t: 1, v: 0 }] };
    const v = sampleCurve(c, 0.5);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(3); // hits the first 0.5 stop; the span<=0 guard keeps it NaN-free
  });

  it('negative scale flips the sign', () => {
    expect(sampleCurve({ points: [{ t: 0, v: 1 }, { t: 1, v: 1 }], scale: -2 }, 0.5)).toBe(-2);
  });

  it('NaN t falls through to the last value (no NaN / throw)', () => {
    const v = sampleCurve({ points: [{ t: 0, v: 1 }, { t: 1, v: 5 }] }, NaN);
    expect(v).toBe(5);
  });

  it('gradient: single stop returns it everywhere; zero-span alpha stays finite', () => {
    const out = { r: 0, g: 0, b: 0 };
    sampleGradientColor({ colorStops: [{ t: 0.3, color: { r: 0.2, g: 0.4, b: 0.6 } }], alphaStops: [] }, 0.9, out);
    expect(out).toEqual({ r: 0.2, g: 0.4, b: 0.6 });
    const a = sampleGradientAlpha({ colorStops: [], alphaStops: [{ t: 0.5, alpha: 0.2 }, { t: 0.5, alpha: 0.8 }] }, 0.5);
    expect(Number.isFinite(a)).toBe(true);
  });
});

describe('CpuParticleSim.setSpeedScale (Missing Test #6 — affects only new spawns)', () => {
  // No gravity/drag → velocity is constant, so |Δpos|/dt == launch speed. point shape
  // randomizes direction but keeps the magnitude == startSpeed × speedScale.
  const baseDef = () => ({
    ...defaultParticleEffect(), maxParticles: 50, shape: { type: 'point' as const },
    startSpeed: { min: 10, max: 10 }, startLifetime: { min: 100, max: 100 },
    emission: { rateOverTime: 20 }, gravity: 0, drag: 0,
  }) as ParticleEffectDef;
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const p0 = (o: ParticleOutputs) => [o.offsets[0], o.offsets[1], o.offsets[2]];

  it('a scale set before spawn launches new particles at startSpeed × scale', () => {
    const out = makeOutputs(50);
    const sim = new CpuParticleSim(baseDef(), out, 1);
    sim.setSpeedScale(3);
    sim.step(0.1);
    const a = p0(out);
    sim.step(0.1);
    const b = p0(out);
    expect(dist(a, b) / 0.1).toBeCloseTo(30, 0); // 10 × 3
  });

  it('scaling up later does NOT retroactively speed up already-spawned particles', () => {
    const out = makeOutputs(50);
    const sim = new CpuParticleSim(baseDef(), out, 1);
    sim.step(0.1);
    const a = p0(out);
    sim.step(0.1);
    const b = p0(out);
    expect(dist(a, b) / 0.1).toBeCloseTo(10, 0); // launched at scale 1

    sim.setSpeedScale(5);
    sim.step(0.1);
    const c = p0(out);
    expect(dist(b, c) / 0.1).toBeCloseTo(10, 0); // particle 0 keeps its original velocity
  });
});
