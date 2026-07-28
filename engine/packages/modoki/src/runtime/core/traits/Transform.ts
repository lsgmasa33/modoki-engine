import { trait } from 'koota';

/** Normalize angle (radians) to [-2π, 2π] range (-360° to 360°). */
export function clampAngle(radians: number): number {
  let v = radians % (Math.PI * 4);
  if (v > Math.PI * 2) v -= Math.PI * 4;
  if (v < -Math.PI * 2) v += Math.PI * 4;
  return v;
}

/** Every entity's LOCAL position/rotation/scale — the one trait almost every entity has.
 *  Rotation is Euler angles in radians (order XYZ); position/scale are in scene units.
 *
 *  This is LOCAL space relative to the entity's parent, not world space: rendering
 *  composes the full parent chain (see `worldTransform.ts`'s `getWorldTransform3D`), but
 *  physics/audio/most gameplay code reads `Transform` directly as if it were world space.
 *  If an entity is parented, read world position via `getWorldTransform3D(world, entity)`
 *  instead of this trait's raw fields. */
export const Transform = trait({
  // Position
  x: 0, y: 0, z: 0,
  // Rotation (radians)
  rx: 0, ry: 0, rz: 0,
  // Scale (uniform by default)
  sx: 1, sy: 1, sz: 1,
});
