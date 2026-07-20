/** Rotates entities that have the Rotate3D trait (unless Paused). */

import type { World } from 'koota';
import { Transform, clampAngle } from '../traits/Transform';
import { Paused } from '../traits/Paused';
import { Rotate3D } from '../traits/Rotate3D';
import { getVisualDelta } from './getTime';

export function rotate3DSystem(world: World) {
  // Visual layer → smoothed cadence × timeScale (freezes on pause/time-stop).
  const delta = getVisualDelta(world);
  if (delta === 0) return;

  world.query(Transform, Rotate3D).updateEach(([tf, rot], entity) => {
    if (entity.has(Paused)) return;
    const angle = rot.speed * delta;
    if (rot.axis === 'x') tf.rx = clampAngle(tf.rx + angle);
    else if (rot.axis === 'y') tf.ry = clampAngle(tf.ry + angle);
    else tf.rz = clampAngle(tf.rz + angle);
  });
}
