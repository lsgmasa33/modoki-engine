import { trait } from 'koota';

/** AnimationLibrary — extra skeletal clips a `SkinnedModel` can play that DON'T
 *  live in its own GLB. The shared cross-model story (Unity's "Animation" import
 *  + Animator Override / a shared clip library): one rig animation pack reused by
 *  many models that share a skeleton.
 *
 *  Put this on the SAME entity as the `SkinnedModel` root (next to the
 *  `SkeletalAnimator`). The render sync (`scene3DSync.syncSkinnedModels`) builds
 *  the mixer's actions from the model's OWN clips UNION the library clips:
 *
 *    actions = ownClips ∪ libraryClips      (own clips win on name conflict)
 *
 *  - `animSets` — `.animset.json` GUIDs. Each animset's `source` is the GLB that
 *    holds the actual clips; the render sync loads that GLB (riggedModelCache)
 *    and binds its clips into THIS rig's mixer by track/bone name. The animset's
 *    per-clip params (speed/loop/fade) come along, so a library clip plays with
 *    its authored params (the `SkeletalAnimator`'s fields still override per
 *    entity). The library GLB joins the scene's build deps via the animset.
 *  - `retarget` — run every library clip through `SkeletonUtils.retargetClip`
 *    against this rig before binding (heavier — pre-sampled). Use for a library
 *    whose source rig shares bone NAMES but has a different bind pose/proportions.
 *    Default false: bind directly by name (correct + cheap for a shared rig, the
 *    common case). NOTE: with NO `boneMaps` entry, retarget still matches bones by
 *    identical name — it only re-samples onto this rig's bind pose.
 *  - `boneMaps` — per-animSet bone-name remap for a source rig whose bones are
 *    named DIFFERENTLY from this model's: `boneMaps[animSetRef] = { targetBone:
 *    sourceBone }` (the shape `retargetClip`'s `options.names` wants — keyed by
 *    THIS rig's bone, valued by the source rig's bone). A non-empty map implies
 *    retargeting for that animSet's clips (even if `retarget` is false). This is
 *    what makes a foreign clip pack (e.g. Mixamo) play on your own rig.
 *
 *  Pure DATA — the render sync owns the live mixer/actions. AoS (callback) form
 *  because `animSets`/`boneMaps` are non-scalar (koota's plain/SoA form forbids
 *  them, like `SkinnedMeshRenderer.materials`); each entity gets its own fresh
 *  containers, so treat them as immutable (replace, don't mutate in place).
 *  `.schema` is undefined for AoS traits, so serialize/prefab snapshot fall back
 *  to the live data's own keys. */
export const AnimationLibrary = trait(() => ({
  animSets: [] as string[],
  retarget: false as boolean,
  boneMaps: {} as Record<string, Record<string, string>>,
}));
