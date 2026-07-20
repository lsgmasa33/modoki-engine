import { trait } from 'koota';

/** Zone3D — a spatial zone volume for GAME logic (containment areas, spawn regions,
 *  triggers), drawn as an **editor-only** wireframe so a human can position + size it by
 *  dragging/scaling the entity with the standard transform gizmo. It is NOT rendered in
 *  the built game (the wireframe lives in the editor SceneView, like the CameraFrame box).
 *
 *  The volume IS the entity's Transform: **position = centre**; how the scale maps to the
 *  volume depends on `shape` (see below). Game systems read the Transform to keep things
 *  inside (e.g. `fishSystem` steers fish back toward a zone centre when they pass its
 *  radius). Pure scalar trait — presentation/kind only.
 *
 *  Scale → volume by shape:
 *   - `'sphere'`   — radius = uniform scale (sx)
 *   - `'circle'`   — flat ring in the ground (XZ) plane, radius = sx  (best for top-down swim areas)
 *   - `'cylinder'` — radius = sx, height = sy
 *   - `'capsule'`  — radius = sx, height = sy
 *   - `'box'`      — full size = scale (sx, sy, sz)
 *   - `'plane'`    — flat rectangle in the ground plane, size = sx × sz
 *  For containment maths, `'sphere'`/`'circle'`/`'cylinder'`/`'capsule'` are CIRCULAR in
 *  XZ (radius = sx); `'box'`/`'plane'` are RECTANGULAR (half-extents sx/2, sz/2). */
export const Zone3D = trait({
  /** Wireframe volume shape (see the scale→volume table above). */
  shape: 'sphere' as 'sphere' | 'circle' | 'cylinder' | 'capsule' | 'box' | 'plane',
  /** Gizmo wireframe colour (hex). */
  color: 0x38bdf8 as number,
});
