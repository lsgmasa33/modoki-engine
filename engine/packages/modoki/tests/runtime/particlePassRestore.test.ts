/** ParticlePassNode.updateBefore restores shared scene/camera/renderer state even
 *  when a render throws (npr-postfx F5). scene + camera are SHARED with the main
 *  forward path and offscreen capture, so a leaked `scene.background = null` /
 *  particles-only `camera.layers.mask` / hijacked render target would corrupt every
 *  subsequent frame. The try/finally must run the restores on the throw path.
 *
 *  Tested by invoking updateBefore on a minimal fake `this` (no real node graph). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('three/webgpu', () => ({
  PassNode: class { setSize() {} },
  QuadMesh: class {},
  MeshBasicNodeMaterial: class {},
}));
vi.mock('three/tsl', () => ({
  texture: () => ({}), screenUV: {}, vec4: () => ({}),
}));

async function getUpdateBefore() {
  const { ParticlePassNode } = await import('../../src/runtime/rendering/npr/ParticlePassNode');
  return (ParticlePassNode as unknown as { prototype: { updateBefore: (f: unknown) => void } }).prototype.updateBefore;
}

function makeFakeThis(scene: THREE.Scene, camera: { layers: { mask: number } }) {
  return {
    scene, camera,
    renderTarget: { /* opaque RT stand-in */ },
    prepQuad: { render: vi.fn() },
    particleMask: 0xdead,
    setSize: vi.fn(),
  };
}

function makeRenderer(render: () => void) {
  return {
    autoClear: true,
    getSize: (v: THREE.Vector2) => v.set(800, 600),
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    getMRT: () => 'PREV_MRT',
    setRenderTarget: vi.fn(),
    setMRT: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(render),
  };
}

describe('ParticlePassNode.updateBefore — shared-state restore (F5)', () => {
  let scene: THREE.Scene;
  let camera: { layers: { mask: number } };
  const ORIGINAL_BG = new THREE.Color(0x223344);
  const ORIGINAL_MASK = 0b1011;

  beforeEach(() => {
    scene = new THREE.Scene();
    scene.background = ORIGINAL_BG;
    camera = { layers: { mask: ORIGINAL_MASK } };
  });

  it('restores background / layer mask / autoClear / render target on the SUCCESS path', async () => {
    const updateBefore = await getUpdateBefore();
    const renderer = makeRenderer(() => {});
    updateBefore.call(makeFakeThis(scene, camera), { renderer });

    expect(scene.background).toBe(ORIGINAL_BG);
    expect(camera.layers.mask).toBe(ORIGINAL_MASK);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null); // prevRT
    expect(renderer.setMRT).toHaveBeenLastCalledWith('PREV_MRT');     // prevMRT
  });

  it('restores all shared state even when renderer.render THROWS', async () => {
    const updateBefore = await getUpdateBefore();
    const renderer = makeRenderer(() => { throw new Error('device lost'); });

    expect(() => updateBefore.call(makeFakeThis(scene, camera), { renderer })).toThrow('device lost');

    // Without the try/finally these would leak: bg=null, mask=particlesOnly, RT=internal.
    expect(scene.background).toBe(ORIGINAL_BG);
    expect(camera.layers.mask).toBe(ORIGINAL_MASK);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
    expect(renderer.setMRT).toHaveBeenLastCalledWith('PREV_MRT');
  });
});
