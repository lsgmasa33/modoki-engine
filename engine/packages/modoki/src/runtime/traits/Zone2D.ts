import { trait } from 'koota';

/** Zone2D — a 2D spatial zone area for GAME logic (trigger regions, spawn areas, kill zones),
 *  the 2D twin of `Zone3D`. Drawn as an **editor-only** wireframe (in the 2D scene view) so a
 *  human can position + size it with the standard transform gizmo. It is NOT rendered in the
 *  built game. Pure geometric containment — needs NO physics collider.
 *
 *  The area IS the entity's Transform: **position = centre** (x, y); rotation = `rz`; how the
 *  scale maps to the area depends on `shape`:
 *   - `'circle'`  — radius = sx
 *   - `'box'`     — full size = scale (half-extents sx/2, sy/2)
 *   - `'capsule'` — radius = sx, total height = sy (a vertical pill along local Y)
 *  An occupant (tagged `ZoneOccupant`) is tested in the zone's LOCAL frame, so a rotated
 *  box/capsule contains correctly. Pure scalar trait — presentation/kind only. */
export const Zone2D = trait({
  /** Zone area shape (see the scale→area table above). */
  shape: 'circle' as 'circle' | 'box' | 'capsule',
  /** Gizmo wireframe colour (hex). */
  color: 0x38bdf8 as number,
});
