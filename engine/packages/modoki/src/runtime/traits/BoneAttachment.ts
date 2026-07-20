import { trait } from 'koota';

/** BoneAttachment — pin this entity to a bone of a `SkinnedModel`'s skeleton
 *  (an Unreal-style socket). Put it on a normal entity that also has a
 *  `Renderable3D`/`Renderable3DPrimitive` + `Transform`: a weapon in the hand,
 *  a VFX on a joint, a hat on the head.
 *
 *  Each frame the render sync finds `bone` in `target`'s animated skeleton and
 *  drives this entity to follow the bone's world POSITION + ROTATION, so it
 *  tracks the animation. The entity's own `Transform` seats the prop: position is
 *  a world-unit offset rotated into the bone's orientation, rotation composes onto
 *  the bone's, and SCALE is the prop's own world scale (NOT inherited from the
 *  rig — so a prop stays its authored size even on a heavily-scaled model).
 *
 *  Cheap by design: O(attachments), not O(bones) — the bones themselves stay
 *  plain Three objects, never ECS entities.
 *
 *  - `target` — GUID of the entity carrying the `SkinnedModel`.
 *  - `bone`   — bone name as authored in the GLB skeleton (see `getBoneNames`). */
export const BoneAttachment = trait({
  target: '' as string,
  bone: '' as string,
});
