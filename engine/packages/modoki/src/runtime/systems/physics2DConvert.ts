/** Coordinate conversion between the ECS/screen frame and Rapier's physics frame.
 *
 *  ECS 2D:    +X right, +Y DOWN, angle `rz` in radians (clockwise-visual, as PixiJS
 *             applies it), positions in WORLD UNITS.
 *  Rapier 2D: +X right, +Y UP, angle CCW-positive, positions in METERS.
 *
 *  So the map is a uniform scale by 1/pixelsPerMeter PLUS a reflection across the
 *  X-axis (Y negate). A reflection reverses handedness, so every angle (and angular
 *  velocity) negates too — this is the single most bug-prone part of the integration,
 *  hence it lives here as pure, unit-tested functions with no Rapier dependency.
 *
 *  Vectors (position AND velocity) transform identically; angles (rotation AND
 *  angular velocity) transform identically. Gravity is handled separately in the
 *  system because it is a physical acceleration in m/s² (NOT scaled by ppm). */

import { parseColliderPoints } from '../scene/colliderPoints';

export interface Vec2 { x: number; y: number }

/** ECS world-space vector (position or velocity) → Rapier meters. */
export function vecEcsToPhys(x: number, y: number, ppm: number): Vec2 {
  return { x: x / ppm, y: -y / ppm };
}

/** Rapier-meters vector → ECS world-space (position or velocity). */
export function vecPhysToEcs(x: number, y: number, ppm: number): Vec2 {
  return { x: x * ppm, y: -y * ppm };
}

/** Allocation-free variants for the physics hot loops — write into a caller-owned/reused
 *  `out`, so the per-body pull/push each tick allocates no Vec2. Keep the Y-flip in this one
 *  module (the object-returning fns above still serve query/raycast callers). */
export function vecEcsToPhysInto(x: number, y: number, ppm: number, out: Vec2): Vec2 {
  out.x = x / ppm; out.y = -y / ppm; return out;
}
export function vecPhysToEcsInto(x: number, y: number, ppm: number, out: Vec2): Vec2 {
  out.x = x * ppm; out.y = -y * ppm; return out;
}

/** ECS angle (rotation or angular velocity, radians) → Rapier angle. */
export function angEcsToPhys(a: number): number {
  return -a;
}

/** Rapier angle → ECS angle (rotation or angular velocity, radians). */
export function angPhysToEcs(a: number): number {
  return -a;
}

/** A length/extent (radius, half-width) in world units → Rapier meters. */
export function lenToPhys(len: number, ppm: number): number {
  return len / ppm;
}

/** Re-exported from the shared physics-layer module (Rapier's interaction-groups format is
 *  dimension-agnostic, so 2D and 3D share one implementation). */
export { packCollisionGroups } from './physicsLayers';

/** Pack local-space points (world units, Y-down) into a flat physics-space `Float32Array`
 *  [x0,y0,x1,y1,…] — ÷ppm + Y-flip. THE single home for that mapping; callers that already
 *  have parsed points (concaveDecomp pieces, parsePointsToPhys) route through it. */
export function ptsToPhysFloat32(pts: readonly { x: number; y: number }[], ppm: number): Float32Array {
  const out = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[i * 2] = pts[i].x / ppm;         // x scales
    out[i * 2 + 1] = -pts[i].y / ppm;    // y flips + scales
  }
  return out;
}

/** Parse an inline point list (polygon/mesh collider `points`) into a flat physics-space
 *  `Float32Array`. Accepts nested `[[x,y],…]` or flat `[x,y,x,y,…]` JSON (shared parser).
 *  Returns null on invalid JSON / a non-array / an odd flat length / < `minPoints` points. */
export function parsePointsToPhys(src: string, ppm: number, minPoints = 2): Float32Array | null {
  const pts = parseColliderPoints(src);   // shared: [] on invalid
  if (pts.length < minPoints) return null;
  return ptsToPhysFloat32(pts, ppm);
}
