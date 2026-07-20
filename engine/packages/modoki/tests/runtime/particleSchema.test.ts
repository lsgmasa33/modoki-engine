/** Particle schema/data unit tests (pure, no GPU, no ECS):
 *  - renderStructuralKey: what changes force a backend rebuild vs. a cheap live edit
 *  - normalizeParticleDef: partial/older JSON loads safely with defaults filled
 *  - defaultParticleEffect: a valid, self-consistent starting effect
 *  - createOverLifeLUT: size/opacity/color curves bake correctly into the GPU LUT */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  defaultParticleEffect,
  renderStructuralKey,
  type ParticleEffectDef,
} from '../../src/runtime/particles/types';
import { normalizeParticleDef } from '../../src/runtime/loaders/particleCache';
import { createOverLifeLUT, LUT_WIDTH } from '../../src/runtime/particles/gpuLut';

const base = () => defaultParticleEffect();

describe('renderStructuralKey', () => {
  it('is stable across cosmetic / simulation-only edits (no rebuild)', () => {
    const a = base();
    const b: ParticleEffectDef = {
      ...a,
      startColor: { r: 0, g: 1, b: 0 }, // color
      gravity: 99,                       // physics
      startSpeed: { min: 0, max: 100 },  // spawn
      sizeOverLife: { points: [{ t: 0, v: 0.2 }] }, // over-life curve
      duration: 42,
      looping: !a.looping,
    };
    expect(renderStructuralKey(b)).toBe(renderStructuralKey(a));
  });

  it('treats omitted render fields as their defaults (no spurious rebuild)', () => {
    const explicit: ParticleEffectDef = {
      ...base(),
      render: { blend: 'additive', mode: 'billboard', aspect: 1, anchor: 'center', tilesX: 1, tilesY: 1 },
    };
    const implicit: ParticleEffectDef = { ...base(), render: { blend: 'additive' } };
    expect(renderStructuralKey(explicit)).toBe(renderStructuralKey(implicit));
  });

  it.each([
    ['maxParticles', (d: ParticleEffectDef) => { d.maxParticles = d.maxParticles + 1; }],
    ['blend', (d: ParticleEffectDef) => { d.render.blend = 'normal'; }],
    ['mode', (d: ParticleEffectDef) => { d.render.mode = 'mesh'; }],
    ['aspect', (d: ParticleEffectDef) => { d.render.aspect = 0.5; }],
    ['anchor', (d: ParticleEffectDef) => { d.render.anchor = 'bottom'; }],
    ['offset', (d: ParticleEffectDef) => { d.render.offset = [0, -1]; }],
    ['meshPrimitive', (d: ParticleEffectDef) => { d.render.meshPrimitive = 'sphere'; }],
    ['meshLit', (d: ParticleEffectDef) => { d.render.meshLit = true; }],
    ['tilesX', (d: ParticleEffectDef) => { d.render.tilesX = 4; }],
    ['tilesY', (d: ParticleEffectDef) => { d.render.tilesY = 4; }],
    ['softParticles', (d: ParticleEffectDef) => { d.render.softParticles = true; }],
  ])('changes when the structural field %s changes (forces rebuild)', (_label, mutate) => {
    const a = base();
    const b = base();
    mutate(b);
    expect(renderStructuralKey(b)).not.toBe(renderStructuralKey(a));
  });
});

describe('normalizeParticleDef', () => {
  it('fills a completely empty object with the full default effect', () => {
    expect(normalizeParticleDef({})).toEqual(defaultParticleEffect());
  });

  it('is idempotent on an already-complete default', () => {
    const d = defaultParticleEffect();
    expect(normalizeParticleDef(d)).toEqual(d);
  });

  it('deep-merges nested emission/shape/render rather than replacing them', () => {
    const out = normalizeParticleDef({
      emission: { rateOverTime: 100 },     // fillPool/bursts come from default (none)
      shape: { type: 'sphere' },           // angle/radius retained from default cone
      render: { blend: 'normal' },         // other render defaults retained
    });
    expect(out.emission.rateOverTime).toBe(100);
    expect(out.shape.type).toBe('sphere');
    expect(out.shape.radius).toBe(defaultParticleEffect().shape.radius);
    expect(out.render.blend).toBe('normal');
  });

  it('preserves provided top-level fields', () => {
    const out = normalizeParticleDef({ maxParticles: 5000, worldSpace: true });
    expect(out.maxParticles).toBe(5000);
    expect(out.worldSpace).toBe(true);
  });

  it('migrates a legacy scalar gravity to the [0,-g,0] acceleration vector', () => {
    expect(normalizeParticleDef({ gravity: -3 }).gravity).toEqual([0, 3, 0]);
    expect(normalizeParticleDef({ gravity: 9.8 }).gravity).toEqual([0, -9.8, 0]);
    // vector form passes through, sanitized to finite numbers
    expect(normalizeParticleDef({ gravity: [0, 450, 0] }).gravity).toEqual([0, 450, 0]);
    expect(normalizeParticleDef({ gravity: [NaN, 1, 2] as unknown as [number, number, number] }).gravity).toEqual([0, 1, 2]);
  });

  it('forces version to 1 regardless of input', () => {
    const out = normalizeParticleDef({ version: 99 } as unknown as Partial<ParticleEffectDef>);
    expect(out.version).toBe(1);
  });

  // F4 — clamp authoring invariants so a hand-edited/corrupt def can't poison the sim.
  it('swaps inverted min/max ranges', () => {
    const out = normalizeParticleDef({ startLifetime: { min: 5, max: 1 }, startSpeed: { min: 10, max: -2 } });
    expect(out.startLifetime).toEqual({ min: 1, max: 5 });
    expect(out.startSpeed).toEqual({ min: -2, max: 10 });
  });

  it('clamps maxParticles to [1, hardCap] and floors it', () => {
    expect(normalizeParticleDef({ maxParticles: -10 }).maxParticles).toBe(1);
    expect(normalizeParticleDef({ maxParticles: 0 }).maxParticles).toBe(1);
    expect(normalizeParticleDef({ maxParticles: 12.7 }).maxParticles).toBe(12);
    expect(normalizeParticleDef({ maxParticles: 5_000_000 }).maxParticles).toBe(1_000_000);
  });

  it('coerces non-finite numbers to defaults (no NaN buffers)', () => {
    const d = defaultParticleEffect();
    const out = normalizeParticleDef({ maxParticles: NaN, startSize: { min: NaN, max: 3 }, duration: NaN });
    expect(out.maxParticles).toBe(d.maxParticles);
    expect(Number.isFinite(out.startSize.min)).toBe(true);
    expect(out.startSize.max).toBe(3);
    expect(out.duration).toBe(d.duration);
  });

  it('replaces a non-positive duration with the default (looping must complete a cycle)', () => {
    const d = defaultParticleEffect();
    expect(normalizeParticleDef({ duration: 0 }).duration).toBe(d.duration);
    expect(normalizeParticleDef({ duration: -2 }).duration).toBe(d.duration);
    expect(normalizeParticleDef({ duration: 2.5 }).duration).toBe(2.5);
  });

  it('floors sprite-sheet tiles to ≥1 only when present', () => {
    expect(normalizeParticleDef({ render: { blend: 'additive', tilesX: 0, tilesY: -3 } }).render.tilesX).toBe(1);
    expect(normalizeParticleDef({ render: { blend: 'additive', tilesX: 0, tilesY: -3 } }).render.tilesY).toBe(1);
    expect(normalizeParticleDef({}).render.tilesX).toBeUndefined(); // not injected when absent
  });
});

describe('defaultParticleEffect', () => {
  it('returns a valid, self-consistent effect', () => {
    const d = defaultParticleEffect();
    expect(d.version).toBe(1);
    expect(d.maxParticles).toBeGreaterThan(0);
    expect(d.startLifetime.min).toBeLessThanOrEqual(d.startLifetime.max);
    expect(d.startSpeed.min).toBeLessThanOrEqual(d.startSpeed.max);
    expect(d.startSize.min).toBeLessThanOrEqual(d.startSize.max);
    expect(['normal', 'additive']).toContain(d.render.blend);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = defaultParticleEffect();
    const b = defaultParticleEffect();
    expect(a).not.toBe(b);
    a.maxParticles = 1;
    expect(b.maxParticles).not.toBe(1);
  });
});

describe('createOverLifeLUT', () => {
  const decode = THREE.DataUtils.fromHalfFloat;

  it('builds two HalfFloat 1-D textures of LUT_WIDTH', () => {
    const lut = createOverLifeLUT(defaultParticleEffect());
    for (const tex of [lut.scalarTex, lut.colorTex]) {
      expect(tex.image.width).toBe(LUT_WIDTH);
      expect(tex.image.height).toBe(1);
      expect(tex.type).toBe(THREE.HalfFloatType);
      expect((tex.image.data as Uint16Array).length).toBe(LUT_WIDTH * 4);
    }
    lut.dispose();
  });

  it('bakes size (R) and opacity (G) curves at the endpoints', () => {
    // default sizeOverLife: 1 -> 0 ; opacityOverLife: 1 (held) -> 0
    const lut = createOverLifeLUT(defaultParticleEffect());
    const s = lut.scalarTex.image.data as Uint16Array;
    const last = LUT_WIDTH - 1;
    expect(decode(s[0])).toBeCloseTo(1, 2);          // size at t=0
    expect(decode(s[last * 4])).toBeCloseTo(0, 2);   // size at t=1
    expect(decode(s[1])).toBeCloseTo(1, 2);          // opacity at t=0
    expect(decode(s[last * 4 + 1])).toBeCloseTo(0, 2); // opacity at t=1
    lut.dispose();
  });

  it('bakes the color gradient into the color texture', () => {
    const def: ParticleEffectDef = {
      ...defaultParticleEffect(),
      colorOverLife: {
        colorStops: [
          { t: 0, color: { r: 1, g: 0, b: 0 } },
          { t: 1, color: { r: 0, g: 0, b: 1 } },
        ],
        alphaStops: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }],
      },
    };
    const lut = createOverLifeLUT(def);
    const c = lut.colorTex.image.data as Uint16Array;
    const last = LUT_WIDTH - 1;
    expect(decode(c[0])).toBeCloseTo(1, 1);          // red at t=0
    expect(decode(c[last * 4 + 2])).toBeCloseTo(1, 1); // blue at t=1
    // alpha is baked into scalar.B
    const s = lut.scalarTex.image.data as Uint16Array;
    expect(decode(s[2])).toBeCloseTo(1, 1);          // alpha at t=0
    expect(decode(s[last * 4 + 2])).toBeCloseTo(0, 1); // alpha at t=1
    lut.dispose();
  });

  it('re-bakes existing texture data on update() without reallocating', () => {
    const lut = createOverLifeLUT(defaultParticleEffect());
    const before = lut.scalarTex.image.data as Uint16Array;
    lut.update({ ...defaultParticleEffect(), sizeOverLife: { points: [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }] } });
    const after = lut.scalarTex.image.data as Uint16Array;
    expect(after).toBe(before); // same backing buffer (in-place)
    expect(decode(after[0])).toBeCloseTo(0.5, 2);
    lut.dispose();
  });
});

describe('normalizeParticleDef — legacy collision migration (migrateCollision)', () => {
  it('migrates a legacy collision (planeY, no shape) to an explicit plane collider', () => {
    const out = normalizeParticleDef({ collision: { mode: 'kill', bounce: 0, planeY: 3 } } as Partial<ParticleEffectDef>);
    expect(out.collision).toMatchObject({ mode: 'kill', shape: 'plane', planeNormal: [0, 1, 0], planePoint: [0, 3, 0] });
    expect((out.collision as { planeY?: number }).planeY).toBeUndefined(); // legacy field stripped
  });

  it('defaults the plane height to 0 when a legacy collision omits planeY', () => {
    const out = normalizeParticleDef({ collision: { mode: 'kill', bounce: 0 } } as Partial<ParticleEffectDef>);
    expect(out.collision).toMatchObject({ shape: 'plane', planePoint: [0, 0, 0] });
  });

  it('leaves a modern shape-tagged collision unchanged', () => {
    const coll = { mode: 'bounce', bounce: 0.5, shape: 'sphere', center: [0, 0, 0], radius: 2 };
    const out = normalizeParticleDef({ collision: coll } as Partial<ParticleEffectDef>);
    expect(out.collision).toEqual(coll);
  });

  it('leaves an absent collision undefined', () => {
    expect(normalizeParticleDef({}).collision).toBeUndefined();
  });
});
