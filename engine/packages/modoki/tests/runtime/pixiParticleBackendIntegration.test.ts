/**
 * End-to-end integration test for the PixiJS 2D particle backend using the REAL default
 * render-object factory (real pixi.js objects) in the plain node vitest env — pixi.js is
 * headless-safe (constructs ParticleContainer / Particle / Texture.EMPTY with no GL context).
 */

import { describe, it, expect } from 'vitest';
import { Container, ParticleContainer } from 'pixi.js';
import { PixiParticleBackend } from '../../src/runtime/particles/pixiParticleBackend';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

function pointEffect(): ParticleEffectDef {
  return {
    ...defaultParticleEffect(),
    shape: { type: 'point' },
    maxParticles: 100,
    emission: { rateOverTime: 300 },
    gravity: 0,
    render: { blend: 'additive' },
  } as ParticleEffectDef;
}

// getContainer() returns the STABLE wrapper Container; the ParticleContainer of pooled particles
// is its single child (this indirection is what keeps the mounted object's identity across rebuilds).
function innerParticleContainer(wrapper: Container): ParticleContainer {
  const inner = wrapper.children[0];
  expect(inner).toBeInstanceOf(ParticleContainer);
  return inner as ParticleContainer;
}

describe('PixiParticleBackend — real-pixi integration', () => {
  it('creates a stable wrapper whose child is a full pool of pooled particles', () => {
    const be = new PixiParticleBackend();
    const h = be.create(pointEffect());
    const wrapper = be.getContainer(h);
    expect(wrapper).toBeInstanceOf(Container);
    const container = innerParticleContainer(wrapper);
    expect(container.particleChildren.length).toBe(100);
    expect(container.blendMode).toBe('add');
    be.dispose(h);
  });

  it('keeps the wrapper identity stable across a structural rebuild', () => {
    const be = new PixiParticleBackend();
    const h = be.create(pointEffect());
    const wrapper = be.getContainer(h);
    const firstInner = wrapper.children[0];
    // A structural setDef (blend change) rebuilds the INNER container...
    be.setDef(h, { ...pointEffect(), render: { blend: 'normal' } });
    // ...but the wrapper the sync layer mounted is unchanged, and now holds the new inner container.
    expect(be.getContainer(h)).toBe(wrapper);
    expect(wrapper.children.length).toBe(1);
    expect(wrapper.children[0]).not.toBe(firstInner);
    expect((wrapper.children[0] as ParticleContainer).blendMode).toBe('normal');
    be.dispose(h);
  });

  it('steps the sim and writes finite, alive particle data onto the pool', () => {
    const be = new PixiParticleBackend();
    const h = be.create(pointEffect());
    const container = innerParticleContainer(be.getContainer(h));

    for (let i = 0; i < 30; i++) be.update(h, 1 / 60);

    const children = container.particleChildren;
    // At 300/s over ~0.5s some particles must be alive → non-zero scaleX.
    const anyAlive = children.some((p) => p.scaleX > 0);
    expect(anyAlive).toBe(true);
    // Every particle's position stays finite (no NaN leaking from the mapping/sim).
    for (const p of children) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    be.dispose(h);
  });

  it('disposes the handle so the container is no longer retrievable', () => {
    const be = new PixiParticleBackend();
    const h = be.create(pointEffect());
    expect(be.getContainer(h)).toBeInstanceOf(Container);
    be.dispose(h);
    expect(() => be.getContainer(h)).toThrow();
  });
});
