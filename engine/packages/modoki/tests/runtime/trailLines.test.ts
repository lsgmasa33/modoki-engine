/**
 * trailLines render object (particles Missing-Test #8, trail slice): commit() draw-range
 * + visibility, the commit(0) hide (WebGPU warns on empty draws), blend mode mapping, and
 * dispose() freeing geometry + material. Pure THREE (no WebGPU), so fully headless.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createTrail } from '../../src/runtime/particles/trailLines';
import type { RenderConfig } from '../../src/runtime/particles/types';

const render = (over: Partial<RenderConfig> = {}): RenderConfig => ({ blend: 'normal', ...over }) as RenderConfig;

describe('createTrail', () => {
  it('starts hidden-ish with a zero draw range and exposes shared output buffers', () => {
    const t = createTrail(10, 4, render());
    expect(t.mesh).toBeInstanceOf(THREE.LineSegments);
    expect(t.mesh.geometry.drawRange.count).toBe(0);
    // vPer = (segments-1)*2 = 6; positions sized maxParticles * vPer * 3.
    expect(t.outputs.positions.length).toBe(10 * 6 * 3);
    expect(t.outputs.colors.length).toBe(10 * 6 * 3);
  });

  it('commit(0) hides the mesh (no empty WebGPU draw); commit(N) sets the draw range visible', () => {
    const t = createTrail(10, 4, render());
    t.commit(0);
    expect(t.mesh.visible).toBe(false);
    expect(t.mesh.geometry.drawRange.count).toBe(0);

    const v0 = t.mesh.geometry.getAttribute('position').version;
    t.commit(3);
    expect(t.mesh.visible).toBe(true);
    expect(t.mesh.geometry.drawRange.count).toBe(3 * 6); // aliveCount * vPer
    // needsUpdate is a write-only setter in THREE (bumps version) — assert the upload was flagged.
    expect(t.mesh.geometry.getAttribute('position').version).toBeGreaterThan(v0);
  });

  it('maps blend mode (additive vs normal)', () => {
    expect((createTrail(4, 4, render({ blend: 'additive' })).mesh.material as THREE.LineBasicMaterial).blending).toBe(THREE.AdditiveBlending);
    expect((createTrail(4, 4, render({ blend: 'normal' })).mesh.material as THREE.LineBasicMaterial).blending).toBe(THREE.NormalBlending);
  });

  it('dispose() frees geometry + material', () => {
    const t = createTrail(4, 4, render());
    const geoSpy = vi.spyOn(t.mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(t.mesh.material as THREE.Material, 'dispose');
    t.dispose();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps segments to a minimum of 2', () => {
    // seg floored to >=2 → vPer = (2-1)*2 = 2.
    const t = createTrail(5, 1, render());
    expect(t.outputs.positions.length).toBe(5 * 2 * 3);
  });
});
