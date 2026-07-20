/** cameraFraming — pure fit math.
 *
 *  Two layers of coverage:
 *   1. Hand-computed cases with a straight-down-(-Z) camera (tanV known), where
 *      the expected distance/orthoSize is derived on paper.
 *   2. A projection INVARIANT: build a real Three camera from the returned pose +
 *      basis, project all 8 box corners, and assert every corner lands inside the
 *      margined NDC rect AND the binding axis actually touches the edge (a fit
 *      that's merely "far enough" but loose would fail the tightness half). This
 *      covers arbitrary tilt + Y-rotated boxes that hand-math can't easily check. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeFrameFit, boxCornersFromMatrix, ease, type FrameFitInput, type FrameMode } from '../../src/runtime/rendering/cameraFraming';

const R = new THREE.Vector3(1, 0, 0);
const U = new THREE.Vector3(0, 1, 0);
const F = new THREE.Vector3(0, 0, -1); // looking down -Z
const NO_MARGIN = { top: 0, bottom: 0, left: 0, right: 0 };

/** A flat axis-aligned box: half-width hw (x), half-height hh (y), at origin, z=0. */
function flatBox(hw: number, hh: number): { center: THREE.Vector3; corners: THREE.Vector3[] } {
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    corners.push(new THREE.Vector3(i & 1 ? hw : -hw, i & 2 ? hh : -hh, 0));
  }
  // pad to 8 (duplicate) so callers that expect 8 still work; math uses all.
  corners.push(...corners.map((c) => c.clone()));
  return { center: new THREE.Vector3(0, 0, 0), corners };
}

function baseInput(over: Partial<FrameFitInput>): FrameFitInput {
  return {
    corners: [], center: new THREE.Vector3(),
    right: R.clone(), up: U.clone(), forward: F.clone(),
    fovV: Math.PI / 2, // 90° → tanV = 1
    aspect: 1,
    mode: 'contain',
    margins: { ...NO_MARGIN },
    ortho: false,
    autoAim: true,
    authoredPos: new THREE.Vector3(0, 0, 10),
    near: 0.1,
    anchorV: 'off',
    anchorPosV: 0.5,
    anchorH: 'off',
    anchorPosH: 0.5,
    ...over,
  };
}

describe('computeFrameFit — hand-computed (90° fov, aspect 1, straight-down -Z)', () => {
  it('perspective contain binds on the wider axis (width)', () => {
    const box = flatBox(2, 1); // width 4, height 2
    const r = computeFrameFit(baseInput({ ...box, mode: 'contain' }));
    // width binds: D = hw/(fracH·tanH) = 2/(1·1) = 2
    expect(r.position.z).toBeCloseTo(2, 5); // camera at (0,0,+2) looking -Z
    expect(r.position.x).toBeCloseTo(0, 5);
    expect(r.position.y).toBeCloseTo(0, 5);
  });

  it('perspective fitHeight ignores width → closer', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitHeight' }));
    expect(r.position.z).toBeCloseTo(1, 5); // D = hh/tanV = 1
  });

  it('perspective fitWidth uses width', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitWidth' }));
    expect(r.position.z).toBeCloseTo(2, 5);
  });

  it('symmetric margins push the camera back (smaller usable frustum)', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitWidth', margins: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 } }));
    // fracH = 0.8 → D = 2/(0.8·1) = 2.5
    expect(r.position.z).toBeCloseTo(2.5, 5);
  });

  it('wider aspect frames closer (width fits more easily)', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'contain', aspect: 2 }));
    // tanH = 2 → widthD = 2/(1·2) = 1 ; heightD = 1/(1·1) = 1 → contain = 1
    expect(r.position.z).toBeCloseTo(1, 5);
  });

  // Vertical edge-anchor: box width 4 × height 2 at z=0; fitWidth → D=2, so at the box
  // depth (2) the frustum half-height is D·tanV = 2 → box spans NDC_y −0.5..+0.5.
  it('anchorV bottom pins the bottom edge to anchorPosV (screen bottom)', () => {
    const box = flatBox(2, 1);
    // bottom edge (yv=−1) at anchorPosV 0 (NDC −1): camera rises so the edge drops to the bottom.
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitWidth', anchorV: 'bottom', anchorPosV: 0 }));
    expect(r.position.z).toBeCloseTo(2, 5); // size unchanged (width fit)
    expect(r.position.y).toBeCloseTo(1, 5); // up-offset that puts yv=−1 corner at NDC −1
  });

  it('anchorV bottom at 0.5 puts the bottom edge at screen center', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitWidth', anchorV: 'bottom', anchorPosV: 0.5 }));
    expect(r.position.y).toBeCloseTo(-1, 5); // bottom corner (yv=−1) → NDC 0
  });

  it('anchorV center at 0.75 places the box center 75% up', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitWidth', anchorV: 'center', anchorPosV: 0.75 }));
    // center (yv=0, depth=2) at NDC +0.5 → up-offset −0.5·D·tanV = −1
    expect(r.position.y).toBeCloseTo(-1, 5);
  });

  it('anchorH left pins the left edge to the screen left', () => {
    // box width 2 × height 4; fitHeight → D=2, so horizontally the box spans NDC_x −0.5..+0.5.
    const box = flatBox(1, 2);
    const r = computeFrameFit(baseInput({ ...box, mode: 'fitHeight', anchorH: 'left', anchorPosH: 0 }));
    expect(r.position.z).toBeCloseTo(2, 5); // size unchanged (height fit)
    expect(r.position.x).toBeCloseTo(1, 5); // right-offset that puts xv=−1 corner at NDC −1
  });

  it('orthographic contain sets half-height from the binding axis', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, ortho: true, mode: 'contain' }));
    // width binds: orthoSize = hw/(fracH·aspect) = 2/(1·1) = 2
    expect(r.orthoSize).toBeCloseTo(2, 5);
  });

  it('autoAim recenters for an asymmetric top margin (reserve HUD space)', () => {
    const box = flatBox(2, 1);
    const r = computeFrameFit(baseInput({ ...box, mode: 'contain', margins: { top: 0.2, bottom: 0, left: 0, right: 0 } }));
    // width still binds (fracH=1) → D=2. cy = bottom-top = -0.2, halfH = D·tanV = 2.
    // shiftUp = -cy·halfH = +0.4 → camera up 0.4 so box sits lower (top reserved).
    expect(r.position.z).toBeCloseTo(2, 5);
    expect(r.position.y).toBeCloseTo(0.4, 5);
  });

  it('autoAim=false accounts for the authored lateral offset (no under-fit clip)', () => {
    const box = flatBox(2, 1); // x ∈ [-2,2]
    const r = computeFrameFit(baseInput({
      ...box, mode: 'fitWidth', autoAim: false,
      authoredPos: new THREE.Vector3(3, 0, 10), // camera offset 3 to the right
    }));
    // Camera at x=3, box far edge at x=-2 is 5 units away → fitWidth needs D=5,
    // NOT 2 (the old center-relative bug would clip the far half of the box).
    expect(r.position.z).toBeCloseTo(5, 5);
    expect(r.position.x).toBeCloseTo(3, 5); // authored lateral kept
    // Prove containment: project the box corners through the fitted camera.
    const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
    cam.position.copy(r.position); cam.quaternion.identity(); cam.updateMatrixWorld(true);
    let maxNdcX = 0;
    for (let i = 0; i < 4; i++) {
      const v = new THREE.Vector3(i & 1 ? 2 : -2, i & 2 ? 1 : -1, 0).project(cam);
      maxNdcX = Math.max(maxNdcX, Math.abs(v.x));
    }
    expect(maxNdcX).toBeLessThanOrEqual(1.001); // nothing clipped
    expect(maxNdcX).toBeGreaterThan(0.99);       // and tight (fitWidth)
  });
});

// ── Projection invariant across tilt / Y-rotation / both projections ──

/** Build a Three camera from the fit result + basis, project all corners, and
 *  return the per-axis max |NDC|. */
function projectExtents(
  r: { position: THREE.Vector3; orthoSize: number },
  input: FrameFitInput,
  corners: THREE.Vector3[],
): { maxNdcX: number; maxNdcY: number; allInFront: boolean } {
  let cam: THREE.Camera;
  if (input.ortho) {
    const s = r.orthoSize;
    cam = new THREE.OrthographicCamera(-s * input.aspect, s * input.aspect, s, -s, input.near, 1000);
  } else {
    cam = new THREE.PerspectiveCamera((input.fovV * 180) / Math.PI, input.aspect, input.near, 1000);
  }
  // Orient: camera local -Z = forward, local X = right, local Y = up.
  const m = new THREE.Matrix4().makeBasis(input.right, input.up, input.forward.clone().negate());
  cam.quaternion.setFromRotationMatrix(m);
  cam.position.copy(r.position);
  cam.updateMatrixWorld(true);
  (cam as THREE.PerspectiveCamera).updateProjectionMatrix?.();

  let maxNdcX = 0, maxNdcY = 0, allInFront = true;
  const v = new THREE.Vector3();
  for (const c of corners) {
    v.copy(c).project(cam);
    if (Math.abs(v.z) > 1.0001) allInFront = false; // outside near..far
    if (Math.abs(v.x) > maxNdcX) maxNdcX = Math.abs(v.x);
    if (Math.abs(v.y) > maxNdcY) maxNdcY = Math.abs(v.y);
  }
  return { maxNdcX, maxNdcY, allInFront };
}

describe('computeFrameFit — projection invariant (arbitrary orientation)', () => {
  // A tilted, yawed camera basis (like sling's fake-iso), orthonormalized.
  function tiltedBasis(pitch: number, yaw: number) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    return {
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      forward: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
    };
  }

  const cases: Array<{ name: string; mode: FrameMode; ortho: boolean; pitch: number; yaw: number; aspect: number; boxYaw: number; margins: typeof NO_MARGIN }> = [
    { name: 'persp contain, tilted', mode: 'contain', ortho: false, pitch: -0.64, yaw: 0, aspect: 0.5625, boxYaw: 0, margins: NO_MARGIN },
    { name: 'persp contain, tilted+yaw, wide', mode: 'contain', ortho: false, pitch: -0.5, yaw: 0.3, aspect: 1.7, boxYaw: 0, margins: NO_MARGIN },
    { name: 'persp fitWidth, tilted, box yawed', mode: 'fitWidth', ortho: false, pitch: -0.7, yaw: 0, aspect: 0.6, boxYaw: 0.5, margins: NO_MARGIN },
    { name: 'persp fitHeight, tilted', mode: 'fitHeight', ortho: false, pitch: -0.4, yaw: 0, aspect: 1.2, boxYaw: 0, margins: NO_MARGIN },
    { name: 'persp contain, margins', mode: 'contain', ortho: false, pitch: -0.6, yaw: 0, aspect: 0.5, boxYaw: 0, margins: { top: 0.1, bottom: 0.1, left: 0.08, right: 0.08 } },
    { name: 'ortho contain, tilted', mode: 'contain', ortho: true, pitch: -0.64, yaw: 0, aspect: 0.5625, boxYaw: 0, margins: NO_MARGIN },
    { name: 'ortho fitWidth, tilted+yaw', mode: 'fitWidth', ortho: true, pitch: -0.5, yaw: 0.2, aspect: 1.4, boxYaw: 0.3, margins: NO_MARGIN },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const basis = tiltedBasis(tc.pitch, tc.yaw);
      // Oriented framing box: size (10, 4, 14), yawed around Y, centered at origin.
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, tc.boxYaw, 0)),
        new THREE.Vector3(10, 4, 14),
      );
      const { center, corners } = boxCornersFromMatrix(m);
      const input: FrameFitInput = {
        corners, center,
        right: basis.right, up: basis.up, forward: basis.forward,
        fovV: Math.PI / 3, aspect: tc.aspect, mode: tc.mode, margins: tc.margins,
        ortho: tc.ortho, autoAim: true, authoredPos: new THREE.Vector3(0, 20, 20), near: 0.1,
        anchorV: 'off', anchorPosV: 0.5, anchorH: 'off', anchorPosH: 0.5,
      };
      const r = computeFrameFit(input);
      const { maxNdcX, maxNdcY, allInFront } = projectExtents(r, input, corners);

      const fracH = 1 - tc.margins.left - tc.margins.right;
      const fracV = 1 - tc.margins.top - tc.margins.bottom;
      const eps = 0.02;

      expect(allInFront).toBe(true);
      // Containment + tightness are per-mode: fitWidth/fitHeight deliberately let
      // the OTHER axis overflow (crop), so only the constrained axis must fit.
      if (tc.mode === 'contain') {
        expect(maxNdcX).toBeLessThanOrEqual(fracH + eps);
        expect(maxNdcY).toBeLessThanOrEqual(fracV + eps);
        expect(Math.max(maxNdcX / fracH, maxNdcY / fracV)).toBeGreaterThan(1 - eps); // binding axis touches
      } else if (tc.mode === 'fitWidth') {
        expect(maxNdcX).toBeLessThanOrEqual(fracH + eps); // width contained
        expect(maxNdcX).toBeGreaterThan(fracH - eps);     // and tight
      } else { // fitHeight
        expect(maxNdcY).toBeLessThanOrEqual(fracV + eps); // height contained
        expect(maxNdcY).toBeGreaterThan(fracV - eps);     // and tight
      }
    });
  }
});

describe('ease (camera-blend easing)', () => {
  const names = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'cubicInOut', 'unknown'];
  it('pins endpoints and clamps out-of-range t', () => {
    for (const n of names) {
      expect(ease(n, 0)).toBe(0);
      expect(ease(n, 1)).toBe(1);
      expect(ease(n, -5)).toBe(0);
      expect(ease(n, 5)).toBe(1);
    }
  });
  it('is monotonic non-decreasing on [0,1]', () => {
    for (const n of names) {
      let prev = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const v = ease(n, t);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });
  it('linear is identity; quadIn lags, quadOut leads at the midpoint', () => {
    expect(ease('linear', 0.5)).toBeCloseTo(0.5, 6);
    expect(ease('unknown', 0.3)).toBeCloseTo(0.3, 6); // falls back to linear
    expect(ease('quadIn', 0.5)).toBeCloseTo(0.25, 6);
    expect(ease('quadOut', 0.5)).toBeCloseTo(0.75, 6);
    expect(ease('quadInOut', 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('boxCornersFromMatrix', () => {
  it('unrotated: corners at ±half-size', () => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), new THREE.Vector3(4, 2, 6),
    );
    const { corners, center } = boxCornersFromMatrix(m);
    expect(center.toArray()).toEqual([0, 0, 0]);
    const xs = corners.map((c) => c.x);
    expect(Math.max(...xs)).toBeCloseTo(2, 5);
    expect(Math.min(...xs)).toBeCloseTo(-2, 5);
    const zs = corners.map((c) => c.z);
    expect(Math.max(...zs)).toBeCloseTo(3, 5);
  });

  it('90° Y-rotation swaps the X and Z extents', () => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
      new THREE.Vector3(4, 2, 6), // width 4, depth 6
    );
    const { corners } = boxCornersFromMatrix(m);
    const xs = corners.map((c) => c.x);
    const zs = corners.map((c) => c.z);
    // After 90° yaw the world-X extent comes from the box depth (±3), Z from width (±2).
    expect(Math.max(...xs)).toBeCloseTo(3, 5);
    expect(Math.max(...zs)).toBeCloseTo(2, 5);
  });
});
