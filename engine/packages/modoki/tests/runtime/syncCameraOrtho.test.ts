/** syncCamera / applyOrthoFrustum — orthographic projection support.
 *
 *  Covers the engine side of the ortho-camera feature:
 *   - applyOrthoFrustum: frustum math (orthoSize x aspect) + the change-gate.
 *   - syncCamera: drives BOTH cameras from the ECS Camera entity and returns the
 *     one Camera.projection selects; a live projection toggle flips the return. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { Camera } from '../../src/runtime/traits/Camera';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { syncCamera, applyOrthoFrustum } from '../../src/runtime/rendering/scene3DSync';
import { deactivatedEntities } from '../../src/three/systems/transformPropagationSystem';

beforeEach(() => {
  // scene3DSync's syncCamera doesn't fetch, but sibling helpers in the module may
  // touch it during import-time side effects; fail loudly if anything does.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch in test'))));
});

function makeCameras() {
  const persp = new THREE.PerspectiveCamera(30, 2, 0.1, 500); // aspect 2 (landscape)
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  return { persp, ortho };
}

describe('applyOrthoFrustum', () => {
  it('derives the frustum from orthoSize x aspect (top/bottom = ±size, left/right = ±size·aspect)', () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    applyOrthoFrustum(cam, 5, 2); // half-height 5, landscape 2:1
    expect(cam.top).toBe(5);
    expect(cam.bottom).toBe(-5);
    expect(cam.right).toBe(10);
    expect(cam.left).toBe(-10);
  });

  it('narrows horizontally for a portrait aspect', () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    applyOrthoFrustum(cam, 6, 0.5); // portrait 1:2
    expect(cam.top).toBe(6);
    expect(cam.right).toBe(3); // 6 * 0.5
  });

  it('change-gates: no updateProjectionMatrix when the frustum is unchanged', () => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    applyOrthoFrustum(cam, 5, 2); // establish
    const spy = vi.spyOn(cam, 'updateProjectionMatrix');
    applyOrthoFrustum(cam, 5, 2); // identical → no-op
    expect(spy).not.toHaveBeenCalled();
    applyOrthoFrustum(cam, 7, 2); // changed → recompute
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('syncCamera projection selection', () => {
  it('defaults to perspective and returns the perspective camera', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const { persp, ortho } = makeCameras();
    world.spawn(
      Transform({ x: 1, y: 2, z: 3, rx: 0.5 }),
      Camera({ fov: 45, near: 0.2, far: 400 }),
      EntityAttributes({ name: 'Camera' }),
    );
    const active = syncCamera(world, scene, persp, ortho);
    expect(active).toBe(persp);
    expect(persp.fov).toBe(45);
    expect(persp.position.toArray()).toEqual([1, 2, 3]);
    expect(persp.rotation.x).toBeCloseTo(0.5);
  });

  it('returns the orthographic camera when projection is orthographic, with orthoSize framing', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const { persp, ortho } = makeCameras(); // persp.aspect = 2
    world.spawn(
      Transform({ x: 0, y: 10, z: 0 }),
      Camera({ projection: 'orthographic', orthoSize: 8, near: 0.1, far: 300 }),
      EntityAttributes({ name: 'Camera' }),
    );
    const active = syncCamera(world, scene, persp, ortho);
    expect(active).toBe(ortho);
    // Frustum framed from orthoSize (8) × the live perspective aspect (2).
    expect(ortho.top).toBe(8);
    expect(ortho.right).toBe(16);
    expect(ortho.near).toBe(0.1);
    expect(ortho.far).toBe(300);
  });

  it('writes the transform to BOTH cameras so a toggle is seamless', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const { persp, ortho } = makeCameras();
    world.spawn(
      Transform({ x: 4, y: 5, z: 6 }),
      Camera({ projection: 'perspective' }),
      EntityAttributes({ name: 'Camera' }),
    );
    syncCamera(world, scene, persp, ortho);
    expect(persp.position.toArray()).toEqual([4, 5, 6]);
    expect(ortho.position.toArray()).toEqual([4, 5, 6]); // synced even while inactive
  });

  it('flips the returned camera when projection changes live', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const { persp, ortho } = makeCameras();
    const cam = world.spawn(
      Transform({ x: 0, y: 8, z: 0 }),
      Camera({ projection: 'perspective', orthoSize: 5 }),
      EntityAttributes({ name: 'Camera' }),
    );
    expect(syncCamera(world, scene, persp, ortho)).toBe(persp);
    cam.set(Camera, { projection: 'orthographic', orthoSize: 5 });
    expect(syncCamera(world, scene, persp, ortho)).toBe(ortho);
  });

  it('ignores a DEACTIVATED ortho camera (does not flip the scene to ortho)', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const { persp, ortho } = makeCameras();
    // Intended-active perspective camera.
    world.spawn(
      Transform({ x: 0, y: 8, z: 0 }),
      Camera({ projection: 'perspective' }),
      EntityAttributes({ name: 'Main', isActive: true }),
    );
    // A second, INACTIVE orthographic camera. It must not hijack the projection
    // (the pick is monotone persp->ortho) nor clobber the pose.
    const inactive = world.spawn(
      Transform({ x: 99, y: 99, z: 99 }),
      Camera({ projection: 'orthographic' }),
      EntityAttributes({ name: 'Secondary', isActive: false }),
    );
    deactivatedEntities.add(inactive.id()); // transformPropagationSystem would set this from isActive
    try {
      const active = syncCamera(world, scene, persp, ortho);
      expect(active).toBe(persp); // stays perspective
      expect(persp.position.toArray()).toEqual([0, 8, 0]); // not clobbered by the inactive cam's (99,99,99)
    } finally {
      deactivatedEntities.delete(inactive.id());
    }
  });

  it('falls back to the perspective camera when no ortho camera is passed', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const persp = new THREE.PerspectiveCamera(30, 2, 0.1, 500);
    world.spawn(
      Transform({}),
      Camera({ projection: 'orthographic' }), // requests ortho but none provided
      EntityAttributes({ name: 'Camera' }),
    );
    expect(syncCamera(world, scene, persp)).toBe(persp);
  });
});
