/**
 * Unit tests for the PURE, renderer-free mapping in pixiParticleMap.ts — the 2D twin of the
 * 3D backend's instance-attribute upload. No `pixi.js` import is needed: the mapping writes
 * onto plain objects implementing MutableParticle, and packColor is byte-exact math. These
 * lock the 0xAABBGGRR color packing and the dense-pool dead-tail hiding across frames.
 */

import { describe, it, expect } from 'vitest';
import { packColor, applyParticleOutputs } from '../../src/runtime/particles/pixiParticleMap';
import type { MutableParticle, ParticleMapOptions } from '../../src/runtime/particles/pixiParticleMap';
import type { ParticleOutputs } from '../../src/runtime/particles/cpuSimulator';

// A plain pool of N MutableParticles, all zeroed (matches Particle at scale 0).
function makePool(n: number): (MutableParticle & { texture?: unknown })[] {
  return Array.from({ length: n }, () => ({
    x: 0,
    y: 0,
    scaleX: 0,
    scaleY: 0,
    rotation: 0,
    color: 0,
    texture: undefined as unknown,
  }));
}

// Build a ParticleOutputs sized for `max` with per-particle values supplied via a builder.
function makeOutputs(
  max: number,
  fill: (i: number) => {
    ox: number;
    oy: number;
    oz?: number;
    scale: number;
    r: number;
    g: number;
    b: number;
    opacity: number;
    rotation: number;
    frame?: number;
  },
): ParticleOutputs {
  const offsets = new Float32Array(max * 3);
  const scales = new Float32Array(max);
  const colors = new Float32Array(max * 3);
  const opacities = new Float32Array(max);
  const rotations = new Float32Array(max);
  const frames = new Float32Array(max);
  for (let i = 0; i < max; i++) {
    const p = fill(i);
    offsets[i * 3] = p.ox;
    offsets[i * 3 + 1] = p.oy;
    offsets[i * 3 + 2] = p.oz ?? 0;
    scales[i] = p.scale;
    colors[i * 3] = p.r;
    colors[i * 3 + 1] = p.g;
    colors[i * 3 + 2] = p.b;
    opacities[i] = p.opacity;
    rotations[i] = p.rotation;
    frames[i] = p.frame ?? 0;
  }
  return { offsets, scales, colors, opacities, rotations, frames };
}

const OPTS: ParticleMapOptions = { aspect: 1, offsetX: 0, offsetY: 0 };

describe('packColor', () => {
  it('packs opaque white to 0xFFFFFFFF', () => {
    expect(packColor(1, 1, 1, 1)).toBe(0xffffffff);
    expect(packColor(1, 1, 1, 1)).toBe(4294967295);
  });

  it('packs fully transparent black to 0', () => {
    expect(packColor(0, 0, 0, 0)).toBe(0);
  });

  it('lays out channels as 0xAABBGGRR (little-endian ABGR)', () => {
    // R=0x30, G=0x20, B=0x10, A=0xFF → 0xFF102030
    expect(packColor(0x30 / 255, 0x20 / 255, 0x10 / 255, 1)).toBe(0xff102030);
    expect(packColor(0x30 / 255, 0x20 / 255, 0x10 / 255, 1)).toBe(4279246896);
  });

  it('clamps channel values below 0 and above 1', () => {
    expect(packColor(-1, -5, -0.001, -1)).toBe(0);
    expect(packColor(2, 5, 1.001, 3)).toBe(0xffffffff);
    // mixed: over-range R, under-range G, in-range B, opaque A
    expect(packColor(2, -1, 0x10 / 255, 1)).toBe(0xff1000ff);
  });

  it('always returns an unsigned 32-bit integer', () => {
    // A high alpha byte would be negative under signed shift; >>>0 keeps it >= 0.
    expect(packColor(0, 0, 0, 1)).toBeGreaterThanOrEqual(0);
    expect(packColor(1, 1, 1, 1)).toBeGreaterThanOrEqual(0);
    expect(packColor(0.5, 0.25, 0.75, 0.9)).toBeGreaterThanOrEqual(0);
  });
});

describe('applyParticleOutputs — live prefix mapping', () => {
  it('maps offsets/scale/rotation/color onto the pool and returns aliveCount', () => {
    const pool = makePool(3);
    const outputs = makeOutputs(3, (i) => ({
      ox: 10 + i,
      oy: 20 + i,
      scale: 2 + i,
      r: 1,
      g: 0.5,
      b: 0.25,
      opacity: 1,
      rotation: 0.3 + i,
    }));
    const opts: ParticleMapOptions = { aspect: 3, offsetX: 5, offsetY: 7 };

    const ret = applyParticleOutputs(pool, outputs, 3, 0, opts);
    expect(ret).toBe(3);

    for (let i = 0; i < 3; i++) {
      const s = 2 + i;
      expect(pool[i].x).toBeCloseTo(10 + i + 5 * s, 5); // offsets.x + offsetX*scale
      expect(pool[i].y).toBeCloseTo(20 + i + 7 * s, 5); // offsets.y + offsetY*scale
      expect(pool[i].scaleX).toBeCloseTo(s * 3, 5); // scale*aspect
      expect(pool[i].scaleY).toBeCloseTo(s, 5); // scale
      expect(pool[i].rotation).toBeCloseTo(0.3 + i, 5);
      expect(pool[i].color).toBe(packColor(1, 0.5, 0.25, 1));
    }
  });

  it('maps Y and rotation as an identity (no flip — sim is axis-neutral, +Y-down like PixiJS)', () => {
    const pool = makePool(3);
    const outputs = makeOutputs(3, (i) => ({
      ox: 10 + i, oy: 20 + i, scale: 2 + i, r: 1, g: 0.5, b: 0.25, opacity: 1, rotation: 0.3 + i,
    }));
    const opts: ParticleMapOptions = { aspect: 1, offsetX: 5, offsetY: 7 };
    applyParticleOutputs(pool, outputs, 3, 0, opts);
    for (let i = 0; i < 3; i++) {
      const s = 2 + i;
      expect(pool[i].x).toBeCloseTo(10 + i + 5 * s, 5);
      expect(pool[i].y).toBeCloseTo(20 + i + 7 * s, 5); // Y not negated — screen Y IS sim Y
      expect(pool[i].rotation).toBeCloseTo(0.3 + i, 5); // rotation passed through unchanged
    }
  });

  it('reads opacity as the packed alpha channel', () => {
    const pool = makePool(1);
    const outputs = makeOutputs(1, () => ({
      ox: 0,
      oy: 0,
      scale: 1,
      r: 1,
      g: 1,
      b: 1,
      opacity: 0x10 / 255,
      rotation: 0,
    }));
    applyParticleOutputs(pool, outputs, 1, 0, OPTS);
    expect(pool[0].color).toBe(packColor(1, 1, 1, 0x10 / 255));
    // alpha byte in the high byte: 0x10FFFFFF
    expect(pool[0].color).toBe(0x10ffffff);
  });
});

describe('applyParticleOutputs — dead-tail hiding across frames', () => {
  it('hides only the newly-dead tail as aliveCount shrinks, threading prevAlive', () => {
    const pool = makePool(6);
    const outputs = makeOutputs(6, (i) => ({
      ox: 100 + i,
      oy: 200 + i,
      scale: 5,
      r: 1,
      g: 1,
      b: 1,
      opacity: 1,
      rotation: 0,
    }));

    // Frame 1: 5 alive, prevAlive 0.
    let prev = applyParticleOutputs(pool, outputs, 5, 0, OPTS);
    expect(prev).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(pool[i].scaleX).toBeCloseTo(5, 5);
      expect(pool[i].scaleY).toBeCloseTo(5, 5);
    }

    // Frame 2: 2 alive (prevAlive threaded = 5). Indices 2..4 must be hidden, 0..1 updated.
    prev = applyParticleOutputs(pool, outputs, 2, prev, OPTS);
    expect(prev).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(pool[i].scaleX).toBeCloseTo(5, 5);
      expect(pool[i].scaleY).toBeCloseTo(5, 5);
      expect(pool[i].x).toBeCloseTo(100 + i, 5);
    }
    for (let i = 2; i < 5; i++) {
      expect(pool[i].scaleX).toBe(0);
      expect(pool[i].scaleY).toBe(0);
    }

    // Frame 3: 0 alive (prevAlive threaded = 2). Indices 0..1 must now be hidden.
    prev = applyParticleOutputs(pool, outputs, 0, prev, OPTS);
    expect(prev).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(pool[i].scaleX).toBe(0);
      expect(pool[i].scaleY).toBe(0);
    }
  });
});

describe('applyParticleOutputs — flipbook frames', () => {
  it('picks texture from clamped frame index when frames are provided', () => {
    const pool = makePool(4);
    const frameTex = ['a', 'b', 'c'] as const;
    const outputs = makeOutputs(4, (i) => ({
      ox: 0,
      oy: 0,
      scale: 1,
      r: 1,
      g: 1,
      b: 1,
      opacity: 1,
      rotation: 0,
      frame: [0, 2, 9, -1][i], // in-range, in-range, over (→2), under (→0)
    }));
    const opts: ParticleMapOptions = { aspect: 1, offsetX: 0, offsetY: 0, frames: frameTex };

    applyParticleOutputs(pool, outputs, 4, 0, opts);
    expect(pool[0].texture).toBe('a'); // 0
    expect(pool[1].texture).toBe('c'); // 2
    expect(pool[2].texture).toBe('c'); // 9 clamped → 2 (n-1)
    expect(pool[3].texture).toBe('a'); // -1 clamped → 0
  });

  it('leaves texture untouched when frames option is absent or empty', () => {
    const pool = makePool(2);
    pool[0].texture = 'sentinel0';
    pool[1].texture = 'sentinel1';
    const outputs = makeOutputs(2, () => ({
      ox: 0,
      oy: 0,
      scale: 1,
      r: 1,
      g: 1,
      b: 1,
      opacity: 1,
      rotation: 0,
      frame: 1,
    }));

    // absent
    applyParticleOutputs(pool, outputs, 2, 0, OPTS);
    expect(pool[0].texture).toBe('sentinel0');
    expect(pool[1].texture).toBe('sentinel1');

    // empty array
    applyParticleOutputs(pool, outputs, 2, 0, { ...OPTS, frames: [] });
    expect(pool[0].texture).toBe('sentinel0');
    expect(pool[1].texture).toBe('sentinel1');
  });
});
