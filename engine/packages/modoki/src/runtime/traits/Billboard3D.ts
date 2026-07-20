import { trait } from 'koota';

/** Billboard3D — promotes a `SkinnedSprite2D` entity out of the flat PixiJS 2D
 *  canvas and INTO the Three.js 3D scene as a camera-facing (billboarded) mesh.
 *  This is the 2.5D bridge: the CPU-skinned deform (`skin2DSystem` → `skin2DBuffers`)
 *  is reused verbatim — the same rig, the same `Bone2D` skeleton, the same
 *  `.anim.json` clips — but instead of `Scene2D` drawing a PixiJS `Mesh`, the 3D
 *  renderer (`scene3DSync`) builds a `THREE.BufferGeometry` from the deformed
 *  positions and orients it toward the camera each frame.
 *
 *  Add this trait ALONGSIDE `SkinnedSprite2D`. Scene2D then SKIPS the entity (it
 *  renders in 3D instead), and the 3D billboard pass picks it up. Remove it and the
 *  entity falls back to the flat 2D layer — nothing else about the rig changes.
 *
 *  Rendering model (2.5D): each rig PART draws as an alpha-tested, camera-facing mesh.
 *  Parts are layered by the rig's own paint order (like the 2D canvas) with depth-WRITE
 *  off so the ~coplanar parts never z-fight, and depth-TEST on so the 3D world still
 *  occludes the sprite. The whole sprite composites after opaque geometry, so it reads
 *  as a solid character sitting IN the scene — occluded by terrain in front of it and
 *  drawn over terrain behind it — rather than a floating overlay.
 *
 *  This is a pure SCALAR trait (see the `traitScalarFields` guard); it carries only
 *  presentation knobs — the rig lives on the sibling `SkinnedSprite2D`. */
export const Billboard3D = trait({
  /** Camera-facing mode:
   *   - `'cylindrical'` (Y-locked): the sprite yaws to face the camera but stays
   *     upright on the ground plane — the classic 2.5D character look (Octopath,
   *     Don't Starve, Paper Mario). Correct for anything that stands on the floor.
   *   - `'spherical'` (full-face): the sprite always faces the camera on every axis,
   *     like a particle — good for pickups/orbs/floating markers, wrong for a
   *     grounded character when the camera tilts. */
  mode: 'cylindrical' as 'cylindrical' | 'spherical',
  /** Alpha cutout threshold (0..1). Fragments below this alpha are discarded, giving a
   *  hard silhouette; above it they blend in paint order. Lower ⇒ keep more soft edge;
   *  0.5 is a good default for hand-drawn sprites. */
  alphaTest: 0.5 as number,
  /** World units per rig-texture pixel — converts the rig's pixel-space deformed
   *  vertices into scene units. 100 px/unit means a 200px-tall sprite is 2 units
   *  tall. Match your scene's scale (a 1-unit-per-meter world wants this ≈ the
   *  sprite's pixel height / its intended metre height). */
  pixelsPerUnit: 100 as number,
  /** Vertical pivot — which point of the sprite sits at the entity's Transform
   *  position (and is the point the billboard rotates about):
   *   - `'bottom'` (feet): the sprite's lowest bind-pose vertex sits at the entity
   *     origin, so an entity at `y = 0` stands ON the ground and the billboard
   *     yaws about its feet. Correct for grounded characters — the default.
   *   - `'center'`: the sprite's vertical mid-point sits at the entity origin and it
   *     pivots about its centre. Correct for floating pickups/orbs/markers.
   *  The anchor is measured ONCE from the bind pose, so a lifted foot in a walk clip
   *  still rises off the ground (the anchor doesn't chase the animated pose). */
  anchor: 'bottom' as 'bottom' | 'center',
});
