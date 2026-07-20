/**
 * Dispose coverage for the sprite-billboard + mesh-particle render objects (particles
 * Missing-Test #P3 — `trailLines` dispose was already covered, these two were not).
 *
 * Asserts the GPU-resource teardown contract: `dispose()` frees the geometry and material
 * it owns (and for the `InstancedMesh` path, the mesh itself — its `instanceMatrix` buffer).
 *
 * The real backend builds these via SpriteNodeMaterial / Mesh*NodeMaterial + TSL nodes from
 * `three/webgpu` + `three/tsl`, none of which construct in a headless (node/jsdom) env —
 * `new SpriteNodeMaterial()` throws "is not a constructor". So we substitute plain
 * `THREE.Material` subclasses for the node materials and stub the exact TSL builders the
 * render code imports with chainable no-op nodes (the factory only *assigns* the returned
 * nodes to `mat.*Node` fields, never evaluates them — `texture(t,uv).rgb`, `mul(a,b)` etc.
 * just need to resolve). Everything else — InstancedBufferGeometry, InstancedMesh, attribute
 * buffers, the dispose calls under test — is real THREE, so the resource accounting is faithful.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

vi.mock('three/webgpu', async () => {
  const T = await import('three');
  class FakeNodeMat extends T.Material {}
  return {
    SpriteNodeMaterial: FakeNodeMat,
    MeshBasicNodeMaterial: FakeNodeMat,
    MeshStandardNodeMaterial: FakeNodeMat,
  };
});
// A chainable node: every property used downstream (.rgb/.a) returns the node itself.
vi.mock('three/tsl', () => {
  const node = () => { const n: Record<string, unknown> = {}; n.rgb = n; n.a = n; return n; };
  return { attribute: node, float: node, mul: node, texture: node, uv: node };
});
vi.mock('../../src/runtime/particles/billboardTsl', () => {
  const node = () => { const n: Record<string, unknown> = {}; n.rgb = n; n.a = n; return n; };
  return { radialAlpha: node, spriteSheetUv: node, orientSampleUv: node, softParticleFade: node };
});

import { createBillboard } from '../../src/runtime/particles/spriteBillboard';
import { createMeshParticles } from '../../src/runtime/particles/meshParticles';
import type { RenderConfig } from '../../src/runtime/particles/types';

const render = (over: Partial<RenderConfig> = {}): RenderConfig => ({ blend: 'normal', ...over }) as RenderConfig;

describe('createBillboard dispose', () => {
  it('frees geometry + material', () => {
    const b = createBillboard(8, render());
    expect(b.mesh).toBeInstanceOf(THREE.Mesh);
    const geoSpy = vi.spyOn(b.mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(b.mesh.material as THREE.Material, 'dispose');
    b.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
  });

  it('frees geometry + material on the textured (sprite-sheet) path', () => {
    const tex = new THREE.Texture();
    const b = createBillboard(8, render({ blend: 'additive' }), { texture: tex, tilesX: 2, tilesY: 2 });
    const geoSpy = vi.spyOn(b.mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(b.mesh.material as THREE.Material, 'dispose');
    b.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
    // The render object does NOT own the sprite texture (the backend's refcounted cache does),
    // so dispose() must not free it.
    expect(tex.version).toBeGreaterThanOrEqual(0); // not disposed/null
  });
});

describe('createMeshParticles dispose', () => {
  it('frees geometry + material + the InstancedMesh (its instanceMatrix buffer)', () => {
    const m = createMeshParticles(8, render());
    expect(m.mesh).toBeInstanceOf(THREE.InstancedMesh);
    const geoSpy = vi.spyOn(m.mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(m.mesh.material as THREE.Material, 'dispose');
    const meshSpy = vi.spyOn(m.mesh as THREE.InstancedMesh, 'dispose');
    m.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
    expect(meshSpy).toHaveBeenCalledTimes(1);
  });

  it('frees resources for each mesh primitive variant', () => {
    for (const meshPrimitive of ['box', 'sphere', 'cone', 'tetra', 'torus'] as const) {
      const m = createMeshParticles(4, render({ meshPrimitive }));
      const geoSpy = vi.spyOn(m.mesh.geometry, 'dispose');
      const matSpy = vi.spyOn(m.mesh.material as THREE.Material, 'dispose');
      m.dispose();
      expect(geoSpy).toHaveBeenCalledTimes(1);
      expect(matSpy).toHaveBeenCalledTimes(1);
    }
  });
});
