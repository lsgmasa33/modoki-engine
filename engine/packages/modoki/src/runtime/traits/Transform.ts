import { trait } from 'koota';

/** Normalize angle (radians) to [-2π, 2π] range (-360° to 360°). */
export function clampAngle(radians: number): number {
  let v = radians % (Math.PI * 4);
  if (v > Math.PI * 2) v -= Math.PI * 4;
  if (v < -Math.PI * 2) v += Math.PI * 4;
  return v;
}

export const Transform = trait({
  // Position
  x: 0, y: 0, z: 0,
  // Rotation (radians)
  rx: 0, ry: 0, rz: 0,
  // Scale (uniform by default)
  sx: 1, sy: 1, sz: 1,
});
