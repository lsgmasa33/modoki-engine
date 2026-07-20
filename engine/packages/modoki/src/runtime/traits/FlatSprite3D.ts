import { trait } from 'koota';

/** FlatSprite3D — promotes a `SkinnedSprite2D` entity out of the flat PixiJS 2D
 *  canvas and INTO the Three.js 3D scene as a mesh **lying flat in the ground (XZ)
 *  plane**, NOT camera-facing. The sibling of `Billboard3D`: same CPU-skinned deform
 *  (`skin2DSystem` → `skin2DBuffers`), same rig / `Bone2D` skeleton / `.anim.json`
 *  clips, same 3D presentation machinery in `scene3DSync` — the only difference is
 *  orientation. A billboard is rotated toward the camera every frame; a flat sprite
 *  keeps the entity's OWN Transform rotation, so its `ry` is a swim/heading yaw within
 *  the plane.
 *
 *  This is the top-down look: fish on the water, a shadow blob, a decal, a splat, a
 *  card lying on a table. The sprite is authored head-up in texture space (+x right,
 *  +y down); flat mode lays that plane down so texture +x → world +x and the sprite's
 *  vertical axis runs along world +z, then the entity Transform yaws it about world Y.
 *  Author the rig with a CENTRED pivot so the sprite rotates about its middle.
 *
 *  Add this trait ALONGSIDE `SkinnedSprite2D` (do not combine with `Billboard3D`).
 *  Scene2D then SKIPS the entity (it renders in 3D instead), and the shared 3D sprite
 *  pass picks it up. Remove it and the entity falls back to the flat 2D layer.
 *
 *  Rendering model matches the billboard path: each rig PART draws as an alpha-tested
 *  mesh, layered by the rig's paint order with depth-WRITE off (coplanar parts never
 *  z-fight) and depth-TEST on (the 3D world still occludes the sprite).
 *
 *  Pure SCALAR trait (see the `traitScalarFields` guard) — presentation knobs only; the
 *  rig lives on the sibling `SkinnedSprite2D`. */
export const FlatSprite3D = trait({
  /** Alpha cutout threshold (0..1). Fragments below this alpha are discarded, giving a
   *  hard silhouette; 0.5 suits hand-drawn sprites. */
  alphaTest: 0.5 as number,
  /** World units per rig-texture pixel — converts the rig's pixel-space deformed
   *  vertices into scene units. 100 px/unit means a 200px sprite spans 2 units. */
  pixelsPerUnit: 100 as number,
});
