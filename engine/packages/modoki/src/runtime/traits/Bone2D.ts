import { trait } from 'koota';

/** Bone2D — marks an ECS entity as a bone of a `SkinnedSprite2D` rig. The bone's
 *  real state is the entity's own `Transform` (posed by the gizmo/Inspector, or
 *  keyframed via `Animator` — a 2D bone is just an entity, so animation is free);
 *  this trait only carries the bone's `name`, which must match a bone in the rig's
 *  `.rig2d.json`. `skin2DSystem` walks the child `Bone2D` entities under a
 *  `SkinnedSprite2D` root (via `EntityAttributes.parentId`) to build the live pose.
 *
 *  Deliberately distinct from the 3D `Bone` trait so `syncBones` never touches it
 *  and the 2D/3D skinning paths stay cleanly separated. Fully SCALAR. */
export const Bone2D = trait({
  name: '' as string, // bone name — must match a bone in the rig's .rig2d.json
});
