import { trait } from 'koota';

/** Camera — engine-level camera properties. Games add their own
 *  camera behavior traits (orbit, follow, etc.) alongside this.
 *
 *  `projection` picks the lens:
 *   - `'perspective'` (default) — uses `fov` (vertical, degrees) + `aspect`.
 *   - `'orthographic'` — uses `orthoSize` (half the visible world-height, in
 *     world units; top=+orthoSize, bottom=-orthoSize, left/right derived from
 *     the viewport aspect). Unity-style knob. Good for board/top-down games
 *     where perspective foreshortening is unwanted. */
export const Camera = trait({
  projection: 'perspective', // 'perspective' | 'orthographic'
  fov: 30,
  orthoSize: 5,
  near: 0.1,
  far: 500,
  overlayDistance: 3,
  clearColor: 0x000000,
});
