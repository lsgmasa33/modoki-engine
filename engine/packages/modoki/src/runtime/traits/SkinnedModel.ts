import { trait } from 'koota';

/** SkinnedModel — a rigged GLB rendered as a live SkinnedMesh hierarchy.
 *
 *  Unlike `Renderable3D` (which references a baked `.mesh.json` and renders a
 *  single static `THREE.Mesh` from a shared, flattened geometry template), a
 *  SkinnedModel references the **raw GLB** and keeps the whole scene graph —
 *  bones, `Skeleton`, bind matrices, and the GLB's `AnimationClip`s — intact.
 *  The render sync clones the cached prototype per entity (SkeletonUtils.clone)
 *  so each instance has its own pose. Pair with `SkeletalAnimator` to drive the
 *  clips; without one the model renders in its bind pose.
 *
 *  `model` is a GLB ref (guid or path) resolved via the asset manifest, loaded
 *  + scene-scope-refcounted through `runtime/loaders/riggedModelCache.ts`.
 *
 *  This is the rigged-model ROOT (Unity's model root + Animator): it owns the
 *  clone, skeleton, and AnimationMixer, adds the clone to the scene, and drives
 *  playback via `SkeletalAnimator`. Per-mesh MATERIALS + visibility live on child
 *  `SkinnedMeshRenderer` entities (one per GLB mesh node) — Unity's per-renderer
 *  `materials[]`. A root with no renderer children renders the GLB's baked
 *  materials (back-compat). The import pipeline expands a GLB into root + renderer
 *  entities (a generated prefab). */
export const SkinnedModel = trait({
  model: '' as string,
  /** Per-renderer visibility — hides just THIS renderable. Independent of the entity's
   *  on/off (`EntityAttributes.isActive`, which also cascades to children); both must be
   *  true to draw. */
  isVisible: true as boolean,
});
