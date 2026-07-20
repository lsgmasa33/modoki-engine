import { trait } from 'koota';

/** Bone — this entity IS a bone of a `SkinnedModel`'s skeleton (Phase 7b). It's a
 *  node in the bone hierarchy: a child (directly or transitively) of the entity
 *  carrying the `SkinnedModel`, and its `Transform` is the bone's LOCAL transform
 *  (relative to its parent bone), mirroring Unity's expanded-FBX skeleton.
 *
 *  The render sync bridges it two-way against the cloned THREE.Bone the
 *  `AnimationMixer` drives, every frame, post-pose:
 *    mixer poses THREE.Bone → **read-back** into this entity's `Transform` →
 *    **LateUpdate** (game code / a bone-targeted Animator may edit it — overrides
 *    LAYER ON TOP of the clip pose) → **write-back** into the THREE.Bone → skinning.
 *  So you can drive a bone from code (after the animation applies), and any entity
 *  parented UNDER this one rides the bone via normal transform propagation.
 *
 *  Bound by walking up `parentId` to the nearest ancestor with a `SkinnedModel`;
 *  `name` selects the bone in that skeleton (see `getBoneNames`). The bridge is
 *  inactive while the editor is Stopped, so the authored bind pose serializes clean.
 *
 *  - `name` — bone name as authored in the GLB skeleton. */
export const Bone = trait({
  name: '' as string,
});
