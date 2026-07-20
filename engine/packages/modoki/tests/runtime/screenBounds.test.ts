/** projectAABBToScreen — the world-AABB → viewport CSS-rect projection behind the
 *  layout-bounds agent op (3D layer). Pure math, tested with a real THREE camera. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { projectAABBToScreen, registerBoundsProvider, collectScreenBounds } from '../../src/runtime/rendering/screenBounds';

const vp = { left: 0, top: 0, width: 100, height: 100 };

function cameraAt(z: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('projectAABBToScreen', () => {
  it('null screen for an empty box', () => {
    const r = projectAABBToScreen(new THREE.Box3(), cameraAt(5), vp);
    expect(r.screen).toBeNull();
    expect(r.onScreen).toBe(false);
  });

  it('a box at the origin projects to a centered, on-screen rect', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const r = projectAABBToScreen(box, cameraAt(6), vp);
    expect(r.onScreen).toBe(true);
    expect(r.screen).not.toBeNull();
    const cx = r.screen!.x + r.screen!.w / 2;
    const cy = r.screen!.y + r.screen!.h / 2;
    expect(cx).toBeGreaterThan(40); expect(cx).toBeLessThan(60); // ~centered horizontally
    expect(cy).toBeGreaterThan(40); expect(cy).toBeLessThan(60);
    expect(r.screen!.w).toBeGreaterThan(0);
    expect(r.screen!.h).toBeGreaterThan(0);
  });

  it('a box behind the camera is not on-screen', () => {
    // Camera at z=5 looking toward -z; a box at z=+20 is behind it.
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, 19), new THREE.Vector3(1, 1, 21));
    const r = projectAABBToScreen(box, cameraAt(5), vp);
    expect(r.onScreen).toBe(false);
  });

  it('a box off to the far side is off-screen even if in front', () => {
    const box = new THREE.Box3(new THREE.Vector3(999, 999, -1), new THREE.Vector3(1001, 1001, 1));
    const r = projectAABBToScreen(box, cameraAt(6), vp);
    expect(r.onScreen).toBe(false);
  });
});

describe('collectScreenBounds — worldAABB passthrough (V5)', () => {
  it('surfaces a provider\'s world-space AABB size/center', () => {
    const unreg = registerBoundsProvider(() => [
      { id: 7, layer: '3d', screen: null, onScreen: false, worldAABB: { size: [2, 1, 0.5], center: [0, 0.5, 0] } },
    ]);
    try {
      const e = collectScreenBounds([7]).find((b) => b.id === 7);
      expect(e?.worldAABB).toEqual({ size: [2, 1, 0.5], center: [0, 0.5, 0] });
    } finally { unreg(); }
  });

  it('worldAABB is optional — a provider may omit it (2D/UI)', () => {
    const unreg = registerBoundsProvider(() => [{ id: 8, layer: '2d', screen: { x: 0, y: 0, w: 10, h: 10 }, onScreen: true }]);
    try {
      const e = collectScreenBounds([8]).find((b) => b.id === 8);
      expect(e?.worldAABB).toBeUndefined();
    } finally { unreg(); }
  });
});
