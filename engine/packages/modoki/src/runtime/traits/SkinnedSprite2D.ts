import { trait } from 'koota';

/** SkinnedSprite2D — a 2D sprite deformed by a weighted mesh + bone hierarchy (the
 *  2D analogue of the 3D `SkinnedModel`). It references a reusable `.rig2d.json`
 *  asset by GUID (`rig`) that holds the deformable mesh (verts/uvs/tris), the
 *  bind-pose bone hierarchy, and per-vertex bone weights.
 *
 *  Unlike 3D — where the ECS `Bone` entities merely bridge into the GLB's own
 *  skeleton — 2D has no imported skeleton, so **the child `Bone2D` entities ARE
 *  the skeleton.** `skin2DSystem` reads their Transforms each frame, computes each
 *  bone's skinning matrix against the rig's inverse-bind, linear-blend-skins the
 *  mesh on the CPU, and hands the deformed vertex buffer to `Scene2D` to upload to
 *  a PixiJS `Mesh`. Author the child `Bone2D` entities (parented via
 *  `EntityAttributes.parentId`) with names matching the rig's bones.
 *
 *  This is its OWN renderable — it does NOT carry `Renderable2D`. It is a fully
 *  SCALAR trait; all structured rig data lives in the `.rig2d.json` asset (see the
 *  `traitScalarFields` guard). */
export const SkinnedSprite2D = trait({
  rig: '' as string,           // GUID of a .rig2d.json asset
  color: 0xffffff as number,   // tint multiplied over the sprite texture
  opacity: 1 as number,        // alpha 0..1
  flipX: false as boolean,     // mirror horizontally about the rig origin (render-only)
  flipY: false as boolean,     // mirror vertically about the rig origin (render-only)
  isVisible: true as boolean,
});
