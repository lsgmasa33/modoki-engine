/** computeActiveFrameFit — the world-aware layer: query the active CameraFrame
 *  box, build its world matrix, and produce a camera fit. Complements the pure
 *  math tests (cameraFraming.test.ts) by covering frame SELECTION + wiring. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { CameraFrame } from '../../src/runtime/traits/CameraFrame';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { computeActiveFrameFit, activeFrameId, setActiveCameraFrame } from '../../src/runtime/rendering/scene3DSync';
import { deactivatedEntities } from '../../src/three/systems/transformPropagationSystem';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch in test'))));
  deactivatedEntities.clear();
});

/** Perspective camera looking straight down -Z from +Z, given aspect. */
function downCamera(aspect: number) {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
  cam.position.set(0, 0, 20);
  cam.quaternion.identity(); // faces -Z
  cam.updateMatrixWorld(true);
  return cam;
}

/** Project all corners of a box (given its Transform) through a camera placed at
 *  `pos` with `cam`'s orientation; return the max |NDC| per axis. */
function frameExtents(cam: THREE.PerspectiveCamera, pos: THREE.Vector3, boxSize: [number, number, number]) {
  const probe = cam.clone();
  probe.position.copy(pos);
  probe.updateMatrixWorld(true);
  let mx = 0, my = 0, inFront = true;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? boxSize[0] / 2 : -boxSize[0] / 2, i & 2 ? boxSize[1] / 2 : -boxSize[1] / 2, i & 4 ? boxSize[2] / 2 : -boxSize[2] / 2).project(probe);
    if (Math.abs(v.z) > 1.0001) inFront = false;
    mx = Math.max(mx, Math.abs(v.x));
    my = Math.max(my, Math.abs(v.y));
  }
  return { mx, my, inFront };
}

describe('computeActiveFrameFit', () => {
  it('returns null when there is no CameraFrame', () => {
    const world = createWorld();
    expect(computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)).toBeNull();
  });

  it('fits the active box so all corners land inside the viewport (perspective, contain)', () => {
    const world = createWorld();
    world.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 4, sz: 14 }), // box size 10×4×14
      CameraFrame({ active: true, mode: 'contain', marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }),
      EntityAttributes({ name: 'Frame' }),
    );
    const cam = downCamera(0.5625);
    const fit = computeActiveFrameFit(world, cam, 0.5625, false);
    expect(fit).not.toBeNull();
    const { mx, my, inFront } = frameExtents(cam, fit!.position, [10, 4, 14]);
    expect(inFront).toBe(true);
    expect(mx).toBeLessThanOrEqual(1.02);
    expect(my).toBeLessThanOrEqual(1.02);
    expect(Math.max(mx, my)).toBeGreaterThan(0.98); // binding axis touches
  });

  it('prefers the frame flagged active over an inactive one', () => {
    const world = createWorld();
    // Inactive frame far away (would fit very differently) + the real active one.
    world.spawn(
      Transform({ x: 100, y: 0, z: 0, sx: 2, sy: 2, sz: 2 }),
      CameraFrame({ active: false, mode: 'contain' }),
      EntityAttributes({ name: 'Other' }),
    );
    world.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: true, mode: 'fitWidth', marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }),
      EntityAttributes({ name: 'Active' }),
    );
    const cam = downCamera(0.5625);
    const fit = computeActiveFrameFit(world, cam, 0.5625, false);
    // The active box is centered at origin → framed camera stays near x≈0, not near x≈100.
    expect(Math.abs(fit!.position.x)).toBeLessThan(1);
  });

  it('skips a deactivated frame entity', () => {
    const world = createWorld();
    const e = world.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: true, mode: 'contain' }),
      EntityAttributes({ name: 'Frame', isActive: false }),
    );
    deactivatedEntities.add(e.id());
    expect(computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)).toBeNull();
  });

  it('passes the continuous flag through', () => {
    const world = createWorld();
    world.spawn(
      Transform({ sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: true, continuous: true }),
      EntityAttributes({ name: 'Frame' }),
    );
    expect(computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)!.continuous).toBe(true);
  });

  it('treats active=false as an OFF switch — a lone inactive frame is not used', () => {
    const world = createWorld();
    world.spawn(
      Transform({ sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: false, mode: 'contain' }), // the only frame, inactive
      EntityAttributes({ name: 'Frame' }),
    );
    // Must NOT fall back to this inactive frame (regression: it used to hijack).
    expect(computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)).toBeNull();
    expect(activeFrameId(world)).toBeNull();
  });

  it('activeFrameId reports the active frame id (for switch/removal detection)', () => {
    const world = createWorld();
    world.spawn(Transform({ sx: 2, sy: 2, sz: 2 }), CameraFrame({ active: false }), EntityAttributes({ name: 'A' }));
    const b = world.spawn(Transform({ sx: 10, sy: 4, sz: 14 }), CameraFrame({ active: true }), EntityAttributes({ name: 'B' }));
    expect(activeFrameId(world)).toBe(b.id());
    // Deactivating the flag releases it (→ null → camera returns to authored).
    b.set(CameraFrame, { active: false });
    expect(activeFrameId(world)).toBeNull();
  });

  it('returns the frameId with the fit', () => {
    const world = createWorld();
    const e = world.spawn(Transform({ sx: 10, sy: 4, sz: 14 }), CameraFrame({ active: true }), EntityAttributes({ name: 'F' }));
    expect(computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)!.frameId).toBe(e.id());
  });

  it('does not NaN on a flat (zero-scale-axis) framing box', () => {
    const world = createWorld();
    world.spawn(
      Transform({ sx: 10, sy: 0, sz: 14 }), // flat on Y (a 2D-plane frame)
      CameraFrame({ active: true, mode: 'contain', marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }),
      EntityAttributes({ name: 'Flat' }),
    );
    const fit = computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false);
    expect(fit).not.toBeNull();
    expect(Number.isFinite(fit!.position.x)).toBe(true);
    expect(Number.isFinite(fit!.position.y)).toBe(true);
    expect(Number.isFinite(fit!.position.z)).toBe(true);
  });

  it('carries the target frame blendTime/blendEase in the fit (for the switch blend)', () => {
    const world = createWorld();
    world.spawn(
      Transform({ sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: true, blendTime: 0.8, blendEase: 'cubicInOut' }),
      EntityAttributes({ name: 'F' }),
    );
    const fit = computeActiveFrameFit(world, downCamera(0.5625), 0.5625, false)!;
    expect(fit.blendTime).toBe(0.8);
    expect(fit.blendEase).toBe('cubicInOut');
  });

  describe('setActiveCameraFrame', () => {
    function threeFrames() {
      const world = createWorld();
      const a = world.spawn(Transform({ sx: 6, sy: 3, sz: 6 }), CameraFrame({ active: true }), EntityAttributes({ name: 'Shot A', guid: 'guid-a' }));
      const b = world.spawn(Transform({ sx: 10, sy: 4, sz: 14 }), CameraFrame({ active: false }), EntityAttributes({ name: 'Shot B', guid: 'guid-b' }));
      const c = world.spawn(Transform({ sx: 8, sy: 8, sz: 8 }), CameraFrame({ active: false }), EntityAttributes({ name: 'Shot C', guid: 'guid-c' }));
      return { world, a, b, c };
    }

    it('by name: activates the target and deactivates every other frame', () => {
      const { world, b } = threeFrames();
      expect(setActiveCameraFrame(world, { name: 'Shot B' })).toBe(true);
      expect(activeFrameId(world)).toBe(b.id());
    });

    it('by guid and by id also work', () => {
      const { world, c } = threeFrames();
      expect(setActiveCameraFrame(world, { guid: 'guid-c' })).toBe(true);
      expect(activeFrameId(world)).toBe(c.id());
      const { world: w2, a } = threeFrames();
      expect(setActiveCameraFrame(w2, { id: a.id() })).toBe(true);
      expect(activeFrameId(w2)).toBe(a.id());
    });

    it('returns false and is a NO-OP on no match (leaves the current active frame)', () => {
      const { world, a } = threeFrames();
      expect(setActiveCameraFrame(world, { name: 'nope' })).toBe(false);
      expect(activeFrameId(world)).toBe(a.id()); // Shot A still active — framing not killed
    });

    it('returns false for a DEACTIVATED target (it could never become active) and is a no-op', () => {
      const { world, a, b } = threeFrames();
      deactivatedEntities.add(b.id());
      expect(setActiveCameraFrame(world, { id: b.id() })).toBe(false); // honest: b can't activate
      expect(activeFrameId(world)).toBe(a.id()); // Shot A untouched
    });
  });

  it('produces an orthoSize for the ortho path', () => {
    const world = createWorld();
    world.spawn(
      Transform({ sx: 10, sy: 4, sz: 14 }),
      CameraFrame({ active: true, mode: 'contain', marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }),
      EntityAttributes({ name: 'Frame' }),
    );
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    ortho.position.set(0, 0, 20);
    ortho.quaternion.identity();
    const fit = computeActiveFrameFit(world, ortho, 0.5625, true);
    expect(fit!.orthoSize).toBeGreaterThan(0);
  });
});
