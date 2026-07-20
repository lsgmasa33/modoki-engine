/** Coordinate conversion between the ECS/Three.js frame and Rapier's 3D physics frame.
 *
 *  ECS 3D:    right-handed, +Y UP, rotation stored as Euler radians (rx,ry,rz) in
 *             THREE's default 'XYZ' order, positions in WORLD UNITS.
 *  Rapier 3D: right-handed, +Y UP, rotation as a unit quaternion {x,y,z,w},
 *             positions in METERS.
 *
 *  Both frames are right-handed Y-up, so — UNLIKE the 2D integration — there is NO
 *  axis flip and NO handedness reversal. The vector map is a plain uniform scale by
 *  1/unitsPerMeter. The only non-trivial part is rotation: Transform's Euler must
 *  become a quaternion and back.
 *
 *  The Euler↔quaternion functions are the single load-bearing seam: they MUST match
 *  how the renderer builds a body's visual rotation, or physics drifts from what you
 *  see. That reference is `three/systems/transformPropagationSystem.makeMatrix`, which
 *  does `new THREE.Euler().set(rx,ry,rz)` (default order 'XYZ') → `Quaternion.setFromEuler`.
 *  We reproduce it EXACTLY here, hard-coding 'XYZ' (rather than relying on THREE's
 *  ambient default) so a future THREE default change can't silently desync physics.
 *
 *  Kept as pure functions with no Rapier dependency (THREE only, no WASM) so the math
 *  is unit-testable headlessly. Gravity is handled directly in the system because it is
 *  a physical acceleration in m/s² (NOT scaled by unitsPerMeter) and needs no flip. */

import * as THREE from 'three';

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Euler3 { rx: number; ry: number; rz: number }

// Module-scratch THREE objects reused by the rotation converters — physics runs one
// world at a time, synchronously, so a shared scratch is safe (matches the renderer's
// own reuse pattern in transformPropagationSystem / scene3DSync).
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

/** ECS world-space vector (position or velocity) → Rapier meters. Plain scale, no flip. */
export function vecEcsToPhys(x: number, y: number, z: number, upm: number): Vec3 {
  return { x: x / upm, y: y / upm, z: z / upm };
}

/** Rapier-meters vector → ECS world-space (position or velocity). */
export function vecPhysToEcs(x: number, y: number, z: number, upm: number): Vec3 {
  return { x: x * upm, y: y * upm, z: z * upm };
}

/** Allocation-free variants for the physics hot loops — write into a caller-owned/reused
 *  `out`, so the per-body pull/push each tick allocates no Vec3. */
export function vecEcsToPhysInto(x: number, y: number, z: number, upm: number, out: Vec3): Vec3 {
  out.x = x / upm; out.y = y / upm; out.z = z / upm; return out;
}
export function vecPhysToEcsInto(x: number, y: number, z: number, upm: number, out: Vec3): Vec3 {
  out.x = x * upm; out.y = y * upm; out.z = z * upm; return out;
}

/** A length/extent (radius, half-extent) in world units → Rapier meters. */
export function lenToPhys(len: number, upm: number): number {
  return len / upm;
}

/** Transform Euler (rx,ry,rz radians, order 'XYZ') → unit quaternion, written into `out`.
 *  THE reference conversion — matches `transformPropagationSystem.makeMatrix` exactly. */
export function eulerToQuatInto(rx: number, ry: number, rz: number, out: Quat): Quat {
  _euler.set(rx, ry, rz, 'XYZ');
  _quat.setFromEuler(_euler);   // setFromEuler yields a unit quaternion by construction
  out.x = _quat.x; out.y = _quat.y; out.z = _quat.z; out.w = _quat.w;
  return out;
}

/** Convenience object-returning form of {@link eulerToQuatInto}. */
export function eulerToQuat(rx: number, ry: number, rz: number): Quat {
  return eulerToQuatInto(rx, ry, rz, { x: 0, y: 0, z: 0, w: 1 });
}

/** Unit quaternion → Transform Euler (rx,ry,rz radians, order 'XYZ'), written into `out`.
 *  The inverse of {@link eulerToQuatInto}; matches the renderer's reverse path
 *  (`_euler.setFromQuaternion(q)` with default 'XYZ'). */
export function quatToEulerInto(qx: number, qy: number, qz: number, qw: number, out: Euler3): Euler3 {
  _quat.set(qx, qy, qz, qw);
  _euler.setFromQuaternion(_quat, 'XYZ');
  out.rx = _euler.x; out.ry = _euler.y; out.rz = _euler.z;
  return out;
}

/** Convenience object-returning form of {@link quatToEulerInto}. */
export function quatToEuler(qx: number, qy: number, qz: number, qw: number): Euler3 {
  return quatToEulerInto(qx, qy, qz, qw, { rx: 0, ry: 0, rz: 0 });
}

/** Re-exported from the shared physics-layer module (Rapier's interaction-groups format is
 *  dimension-agnostic, so 2D and 3D share one implementation). */
export { packCollisionGroups } from './physicsLayers';
