/** #338 part 2 — a fresh emitter that declares a sprite texture starts HIDDEN.
 *
 *  The defect: `build()` constructs the render objects AND a new `CpuParticleSim` together, and
 *  `loadTextureFor` calls it a SECOND time when the texture arrives (a sprite texture changes the
 *  material, so the billboard cannot just be re-pointed). That second build discards every live
 *  particle and resets the sim clock — observed by the owner as particles "spawning for 1-2
 *  frames, resetting, and continuing". Now the throwaway build happens off-screen.
 *
 *  ⚠️ These drive the REAL `CpuTslBackend` with the GPU construction path faked — the same shape
 *  as `particleBackendPauseResume` / `particleBackendTextureDispose`. What is asserted is the
 *  backend's own visibility decisions, never the mocks: a fake billboard cannot tell you whether
 *  a group was drawn, but `group.visible` is the backend's answer to exactly that question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { defaultParticleEffect, type ParticleEffectDef } from '../../src/runtime/particles/types';

const h = vi.hoisted(() => ({
  /** Resolve the pending texture load by hand, so the test owns the timing. */
  resolveTex: null as null | ((t: unknown) => void),
  rejectTex: null as null | ((e: unknown) => void),
  simsBuilt: 0,
  /** What the sub-emitter child's effect ref resolves to. */
  childDef: null as unknown,
}));

// ⚠️ `cpuTslBackend` does NOT import the resolver directly — it goes through `textureProvider`
// (see its local loadTexture3D wrapper). Mocking the resolver instead looks right and silently
// does nothing: the load then rejects with "textureProvider not wired" and the test measures the
// FAILURE path while appearing to measure the success one.
vi.mock('../../src/runtime/core/textureProvider', () => {
  const impl = {
    loadTexture3D: vi.fn(() => new Promise((res, rej) => { h.resolveTex = res as (t: unknown) => void; h.rejectTex = rej; })),
    releaseTexture3D: vi.fn(),
  };
  return { textureProvider: { get: () => impl } };
});
vi.mock('../../src/runtime/particles/spriteBillboard', () => ({
  createBillboard: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/meshParticles', () => ({
  createMeshParticles: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
  makeParticlePrimitiveGeometry: () => new THREE.BufferGeometry(),
}));
vi.mock('../../src/runtime/particles/trailLines', () => ({
  createTrail: () => ({ mesh: new THREE.Object3D(), outputs: {}, dispose: vi.fn(), commit: vi.fn() }),
}));
vi.mock('../../src/runtime/particles/particleCache', () => ({ getParticleEffect: () => null }));
// Sub-emitter children resolve their effect through this slot, not through particleCache.
vi.mock('../../src/runtime/particles/particleDefProvider', () => ({
  particleDefProvider: { get: () => ({ getParticleEffect: () => h.childDef }) },
}));
vi.mock('../../src/runtime/particles/cpuSimulator', () => ({
  CpuParticleSim: class {
    constructor() { h.simsBuilt++; }
    step() { return 0; }
    setDef() {} reset() {} setSpeedScale() {} setEmitterMatrix() {} injectAt() {}
    get aliveCount() { return 0; }
    get birthEvents() { return [] as number[]; }
    get deathEvents() { return [] as number[]; }
  },
}));

import { CpuTslBackend } from '../../src/runtime/particles/cpuTslBackend';

const textured = (): ParticleEffectDef => ({
  ...defaultParticleEffect(), render: { blend: 'additive', texture: 'some-guid' },
}) as ParticleEffectDef;
const plain = (): ParticleEffectDef => ({
  ...defaultParticleEffect(), render: { blend: 'additive' },
}) as ParticleEffectDef;

beforeEach(() => { h.resolveTex = null; h.rejectTex = null; h.simsBuilt = 0; h.childDef = null; });

describe('a fresh emitter waits HIDDEN for its declared texture (#338)', () => {
  it('starts hidden, and is revealed by the texture arriving', async () => {
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    expect(group.visible, 'must not be drawn before its texture lands').toBe(false);

    h.resolveTex?.({ dispose: vi.fn() });
    await Promise.resolve(); await Promise.resolve();

    expect(group.visible, 'the texture arrived — draw it now').toBe(true);
    // The reveal follows the REBUILD, so what is first drawn is the textured sim at its own t=0.
    expect(h.simsBuilt, 'create() + the texture rebuild').toBe(2);
  });

  it('an effect with NO texture is never hidden — there is nothing to wait for', () => {
    const be = new CpuTslBackend();
    expect(be.getObject3D(be.create(plain())).visible).toBe(true);
  });

  it('the throwaway build happens entirely off-screen — the reset is never drawn', async () => {
    // The point of the whole change: two sims ARE built (that is inherent to the material swap),
    // but the emitter is invisible across the discard.
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    const seenVisible: boolean[] = [];
    for (let i = 0; i < 3; i++) { be.update(handle, 1 / 60); seenVisible.push(group.visible); }
    expect(seenVisible, 'hidden for every frame before the texture lands').toEqual([false, false, false]);
    expect(h.simsBuilt).toBe(1); // still the throwaway one
  });
});

describe('the wait is BOUNDED — silence is worse than an untextured frame (#338)', () => {
  it('reveals untextured once the frame budget is spent', () => {
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    // Never resolve the texture — the pathological slow/cold case.
    for (let i = 0; i < 20; i++) be.update(handle, 1 / 60);
    expect(group.visible, 'must not stay invisible forever waiting on a texture').toBe(true);
  });

  it('a PAUSED emitter still spends its budget — being paused must not strand it hidden', () => {
    // ⚠️ THIS ASSERTION USED TO BE THE OPPOSITE, and the old expectation was wrong. It read "a
    // paused emitter does not burn its budget while frozen", which sounds obviously right and
    // pinned a stranding bug in place: reveal has only two sources — this counter and the texture
    // promise — and `loadTextureFor`'s stale branch returns without revealing whenever `setDef`
    // swaps the ref, while a swap to an empty/mesh ref starts no replacement load at all. Paused
    // plus stale meant hidden FOREVER (reproduced: create → pause → setDef(no texture) → resolve
    // the original load → 200 updates → still invisible). Readiness is a RENDER concern, not a
    // simulation one, which is why the GPU backend runs it before its own play gate too.
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    be.pause(handle);
    for (let i = 0; i < 20; i++) be.update(handle, 1 / 60);
    expect(group.visible, 'the wait is bounded even while paused').toBe(true);
  });

  it('is not stranded when setDef swaps the texture ref mid-load and starts no new one', async () => {
    // The exact reproduction from the finding above, in a form that fails if the stale branch
    // stops revealing.
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    be.pause(handle);
    be.setDef(handle, plain());          // no texture -> no replacement load is started
    h.resolveTex?.({ dispose: vi.fn() }); // the ORIGINAL load lands, and takes the stale branch
    await Promise.resolve(); await Promise.resolve();
    expect(group.visible, 'a swapped-away ref must not leave the emitter hidden').toBe(true);
  });

  it('a failed texture load reveals rather than leaving the emitter invisible forever', async () => {
    const be = new CpuTslBackend();
    const handle = be.create(textured());
    const group = be.getObject3D(handle);
    expect(group.visible).toBe(false);
    h.rejectTex?.(new Error('404'));           // the way a missing/undecodable sprite fails
    await Promise.resolve(); await Promise.resolve();
    expect(group.visible, 'a dead texture must not hide the emitter forever').toBe(true);
  });
});

describe('a SUB-EMITTER child waits hidden too — the same defect one level down (#338 close-out)', () => {
  const withChild = (): ParticleEffectDef => ({
    ...defaultParticleEffect(),
    render: { blend: 'additive' },                       // parent itself has no texture
    subEmitters: [{ trigger: 'birth', effect: 'child-guid', count: 4, probability: 1, inheritVelocity: 0 }],
  }) as ParticleEffectDef;

  it('hides the child group until ITS texture lands', async () => {
    // `buildChildRender()` rebuilds `c.sim` as well as the render, despite its name — so a late
    // child texture wipes every particle the parent has injected. Found by the close-out sweep:
    // the parent's own defect, unfixed one level down. Latent in the repo today because the only
    // sub-emitter child (`sparks.particle.json`) declares no sprite.
    h.childDef = { ...defaultParticleEffect(), render: { blend: 'additive', texture: 'child-tex' } };
    const be = new CpuTslBackend();
    const handle = be.create(withChild());
    be.update(handle, 1 / 60);                            // advance() builds the child lazily

    const group = be.getObject3D(handle);
    const childGroups = group.children.filter((o) => typeof o.name === 'string' && o.name.startsWith('subfx:'));
    expect(childGroups.length, 'the child group should exist by now').toBe(1);
    expect(childGroups[0].visible, 'child must not draw before its own texture lands').toBe(false);

    h.resolveTex?.({ dispose: vi.fn() });
    await Promise.resolve(); await Promise.resolve();
    expect(childGroups[0].visible, 'child texture arrived — draw it').toBe(true);
  });

  it('a child with NO texture is never hidden', () => {
    h.childDef = { ...defaultParticleEffect(), render: { blend: 'additive' } };
    const be = new CpuTslBackend();
    const handle = be.create(withChild());
    be.update(handle, 1 / 60);
    const child = be.getObject3D(handle).children.find((o) => typeof o.name === 'string' && o.name.startsWith('subfx:'));
    expect(child?.visible).toBe(true);
  });

  it("a seek's advance() LOOP must not spend the child's budget", () => {
    // #338 close-out F3: the counter used to live in advance(), which seek()/prewarm() call in a
    // loop — a scrub to 2s runs ~120 iterations in ONE tick, revealing the child untextured six
    // steps in, long before any load could land. Frames, not sim steps.
    h.childDef = { ...defaultParticleEffect(), render: { blend: 'additive', texture: 'child-tex' } };
    const be = new CpuTslBackend();
    const handle = be.create(withChild());
    be.update(handle, 1 / 60);                    // build the child (1 frame of budget)
    const child = be.getObject3D(handle).children.find((o) => typeof o.name === 'string' && o.name.startsWith('subfx:'));
    expect(child?.visible).toBe(false);
    be.seek(handle, 2);                           // many advance() iterations, ZERO frames
    expect(child?.visible, 'a synchronous seek must not spend a frame-denominated budget').toBe(false);
  });

  it("the child's wait is bounded too", () => {
    h.childDef = { ...defaultParticleEffect(), render: { blend: 'additive', texture: 'child-tex' } };
    const be = new CpuTslBackend();
    const handle = be.create(withChild());
    for (let i = 0; i < 20; i++) be.update(handle, 1 / 60);   // never resolve the texture
    const child = be.getObject3D(handle).children.find((o) => typeof o.name === 'string' && o.name.startsWith('subfx:'));
    expect(child?.visible, 'a child must not stay invisible forever either').toBe(true);
  });
});
