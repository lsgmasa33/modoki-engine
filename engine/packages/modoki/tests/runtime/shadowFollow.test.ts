/** shadowFollow — pure math for recentring a directional light's shadow ortho box on the view
 *  each frame (see runtime/rendering/shadowFollow.ts for the why). Covers the anti-shimmer texel
 *  snap and the degenerate-input guards in `snapShadowCenter`, and the ground-plane intersection
 *  + fallback in `viewGroundFocus`. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { snapShadowCenter, viewGroundFocus } from '../../src/runtime/rendering/shadowFollow';

describe('snapShadowCenter', () => {
  const size = 16;
  const mapSize = 2048;
  const texel = (2 * size) / mapSize; // 0.015625

  it('leaves the centre unchanged for a sub-texel move', () => {
    const base = snapShadowCenter({ focus: { x: 5, y: 0, z: 3 }, lightDir: { x: 0, y: -1, z: -0.3 }, size, mapSize });
    const moved = snapShadowCenter({
      focus: { x: 5 + texel * 0.3, y: 0, z: 3 },
      lightDir: { x: 0, y: -1, z: -0.3 },
      size,
      mapSize,
    });
    expect(moved.x).toBeCloseTo(base.x, 9);
    expect(moved.y).toBeCloseTo(base.y, 9);
    expect(moved.z).toBeCloseTo(base.z, 9);
  });

  it('moves by a whole number of texels for a multi-texel move (light straight down)', () => {
    // Straight-down light: right = (1,0,0), trueUp = (0,0,-1) or similar — snap axes align
    // with world X/Z, so a world-space shift of exactly N texels along X is exactly N texels
    // in the snapped output.
    const lightDir = { x: 0, y: -1, z: 0 };
    const a = snapShadowCenter({ focus: { x: 0, y: 0, z: 0 }, lightDir, size, mapSize });
    const shiftTexels = 5;
    const b = snapShadowCenter({ focus: { x: texel * shiftTexels, y: 0, z: 0 }, lightDir, size, mapSize });
    const deltaX = b.x - a.x;
    const texelsMoved = deltaX / texel;
    expect(texelsMoved).toBeCloseTo(Math.round(texelsMoved), 6);
    expect(Math.round(texelsMoved)).not.toBe(0);
  });

  it('returns a finite, non-NaN centre for a straight-down light (degenerate-basis guard)', () => {
    const c = snapShadowCenter({ focus: { x: 12.34, y: 5, z: -7.8 }, lightDir: { x: 0, y: -1, z: 0 }, size, mapSize });
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(Number.isFinite(c.z)).toBe(true);
  });

  it('returns a finite, non-NaN centre for a straight-up light too', () => {
    const c = snapShadowCenter({ focus: { x: 1, y: 2, z: 3 }, lightDir: { x: 0, y: 1, z: 0 }, size, mapSize });
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(Number.isFinite(c.z)).toBe(true);
  });

  it('returns the raw focus unsnapped when size is 0', () => {
    const focus = { x: 3.14159, y: 1, z: -2.71828 };
    const c = snapShadowCenter({ focus, lightDir: { x: 1, y: -1, z: 0 }, size: 0, mapSize });
    expect(c).toEqual(focus);
  });

  it('returns the raw focus unsnapped when mapSize is 0', () => {
    const focus = { x: 3.14159, y: 1, z: -2.71828 };
    const c = snapShadowCenter({ focus, lightDir: { x: 1, y: -1, z: 0 }, size, mapSize: 0 });
    expect(c).toEqual(focus);
  });
});

describe('viewGroundFocus', () => {
  it('hits the ground plane at the expected point for a camera pitched down', () => {
    // Camera at (0, 10, 0) looking down and slightly forward (-Y, +Z-ish forward tilted).
    const camPos = { x: 0, y: 10, z: 0 };
    const camForward = { x: 0, y: -1, z: 1 }; // 45 degrees down, normalized internally
    const groundY = 0;
    const maxDistance = 100;
    const focus = viewGroundFocus({ camPos, camForward, groundY, maxDistance });
    // t solves camPos.y + t*fwd.y = 0 with normalized fwd = (0, -1/sqrt2, 1/sqrt2)
    const fwdLen = Math.hypot(0, -1, 1);
    const fwdY = -1 / fwdLen;
    const fwdZ = 1 / fwdLen;
    const t = (groundY - camPos.y) / fwdY;
    expect(focus.y).toBeCloseTo(0, 6);
    expect(focus.x).toBeCloseTo(camPos.x, 6);
    expect(focus.z).toBeCloseTo(camPos.z + fwdZ * t, 6);
  });

  it('clamps the hit distance at maxDistance for a shallow angle', () => {
    // A very shallow downward angle puts the ground intersection far beyond maxDistance.
    const camPos = { x: 0, y: 10, z: 0 };
    const camForward = { x: 0, y: -0.01, z: 1 };
    const maxDistance = 20;
    const focus = viewGroundFocus({ camPos, camForward, groundY: 0, maxDistance });
    const fwdLen = Math.hypot(0, -0.01, 1);
    const fwd = { x: 0, y: -0.01 / fwdLen, z: 1 / fwdLen };
    expect(focus.x).toBeCloseTo(camPos.x + fwd.x * maxDistance, 6);
    expect(focus.y).toBeCloseTo(camPos.y + fwd.y * maxDistance, 6);
    expect(focus.z).toBeCloseTo(camPos.z + fwd.z * maxDistance, 6);
  });

  it('falls back to the bounded forward point for a level camera (no ground hit)', () => {
    const camPos = { x: 5, y: 2, z: 5 };
    const camForward = { x: 0, y: 0, z: -1 }; // dead level — never crosses y=0
    const maxDistance = 30;
    const focus = viewGroundFocus({ camPos, camForward, groundY: 0, maxDistance });
    expect(Number.isFinite(focus.x)).toBe(true);
    expect(Number.isFinite(focus.y)).toBe(true);
    expect(Number.isFinite(focus.z)).toBe(true);
    expect(focus.x).toBeCloseTo(camPos.x, 6);
    expect(focus.y).toBeCloseTo(camPos.y, 6);
    expect(focus.z).toBeCloseTo(camPos.z - maxDistance, 6);
  });

  it('falls back to the bounded forward point for a camera looking up (away from the ground)', () => {
    const camPos = { x: 0, y: 1, z: 0 };
    const camForward = { x: 0, y: 1, z: 0 }; // straight up — ground is behind it
    const maxDistance = 15;
    const focus = viewGroundFocus({ camPos, camForward, groundY: 0, maxDistance });
    expect(Number.isFinite(focus.y)).toBe(true);
    expect(focus.y).toBeCloseTo(camPos.y + maxDistance, 6);
  });
});

// ── The snap basis must match THREE's, not merely be *a* valid basis (#183 close-out) ────────
//
// `snapShadowCenter` only prevents shimmer if it snaps on the same texel grid THREE rasterizes
// the depth map in. THREE builds that grid in `Matrix4.lookAt` as `x = normalize(up × z)` with
// `z = -forward`, and it swaps its reference axis ONLY when that cross product is EXACTLY zero.
// An earlier version here swapped whenever `|forward.y| > 0.99` — an ~8° band around the zenith
// where THREE has not swapped, leaving the two bases in different planes.
describe('snapShadowCenter — basis agreement with THREE', () => {
  /** The right/x axis THREE will actually use for a light aimed along `dir`. */
  const threeRightAxis = (dir: { x: number; y: number; z: number }) => {
    const m = new THREE.Matrix4();
    const forward = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    // eye - target = -forward, i.e. aim a camera at the origin from along -forward.
    m.lookAt(forward.clone().multiplyScalar(-1), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    return new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
  };

  /** Recover the basis snapShadowCenter used, by snapping two known points and differencing. */
  const snappedDeltaAxis = (dir: { x: number; y: number; z: number }) => {
    const size = 16, mapSize = 2048, texel = (2 * size) / mapSize;
    const a = snapShadowCenter({ focus: { x: 0, y: 0, z: 0 }, lightDir: dir, size, mapSize });
    const three = threeRightAxis(dir);
    // Step exactly 100 texels along THREE's right axis: a matching basis snaps it back to a
    // whole-texel offset along that same axis.
    const focus = { x: three.x * texel * 100, y: three.y * texel * 100, z: three.z * texel * 100 };
    const b = snapShadowCenter({ focus, lightDir: dir, size, mapSize });
    return new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  };

  it('agrees with THREE for an ordinary sun angle', () => {
    const dir = { x: 0.207, y: -0.745, z: 0.634 };
    const moved = snappedDeltaAxis(dir);
    const expected = threeRightAxis(dir).multiplyScalar(moved.length());
    expect(moved.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('agrees with THREE INSIDE the near-vertical band the old 0.99 threshold mis-handled', () => {
    // |y| = 0.998 > 0.99: the old code swapped its reference axis here, THREE does not.
    const dir = { x: 0.05, y: 0.998, z: 0.03 };
    const moved = snappedDeltaAxis(dir);
    const expected = threeRightAxis(dir).multiplyScalar(moved.length());
    expect(moved.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('still returns a finite centre exactly at the pole, where THREE itself is degenerate', () => {
    const c = snapShadowCenter({ focus: { x: 3, y: 2, z: -4 }, lightDir: { x: 0, y: -1, z: 0 }, size: 16, mapSize: 2048 });
    expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)).toBe(true);
  });
});
