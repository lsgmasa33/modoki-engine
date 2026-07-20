import { trait } from 'koota';

/** Continuous rotation animation. Applies rotation around a given axis per second. */
export const Rotate3D = trait({
  axis: 'y' as 'x' | 'y' | 'z',
  speed: 1, // radians per second
});
