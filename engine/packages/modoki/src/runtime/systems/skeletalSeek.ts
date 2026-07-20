/** skeletalSeek — editor-only "pose a skeletal rig at an EXACT clip time" signal.
 *
 *  A keyframe `Animator` scrubs frame-accurately by writing `Animator.{clip,time}` — the
 *  pipeline `animationSystem` then SAMPLES that exact pose. A `SkeletalAnimator` has no such
 *  trait-driven sampler: its pose lives in a `THREE.AnimationMixer` owned by the render layer
 *  (`scene3DSync.syncSkinnedModels`), which normally only ADVANCES by a frame delta. So a
 *  timeline scrub can't pose it through a trait — the runtime scrub entry point
 *  (`timelineSystem.previewTimelineAt`) can't touch THREE.
 *
 *  This module is the bridge, mirroring `skeletalPreview`. The EDITOR scrub path registers an
 *  absolute clip time per skeletal animation-track target via `requestSkeletalSeek`; the
 *  render sync consumes it with `getSkeletalSeek`, seeking that rig's mixer action to the exact
 *  time (`action.time = t; mixer.update(0)`) instead of advancing it. `previewTimelineAt`
 *  clears + rebuilds the whole set each scrub, so it always reflects the current playhead; the
 *  render layer clears everything when real Play resumes. In a shipped game nothing ever calls
 *  `requestSkeletalSeek`, so `hasSkeletalSeeks()` is false and behaviour is unchanged
 *  (frozen-at-bind while stopped, mixer-advanced while playing).
 *
 *  Why a module-level singleton (mirrors `playState` / `skeletalPreview`): both 3D viewports
 *  (editor SceneView + GameView Scene3D) run on the one frame driver and each owns an
 *  independent mixer clone — reading the same seek request poses each clone to the same time.
 *  It's keyed by runtime entity id, which is stable within a scene load (the scrub session) but is
 *  reassigned on the next load — so the map is force-cleared on any world swap (below), mirroring
 *  `controlSpawnRegistry`, lest a seek target a dead/reused id in the freshly-loaded world. */

import { onWorldSwap } from '../ecs/world';

/** One clip in a seek pose: absolute local `time` at blend `weight` (0..1). A single-element
 *  array is a plain seek (weight 1); two elements are a crossfade (weights sum to ~1). */
export interface SeekClip { clip: string; time: number; weight: number; }

let _seeks = new Map<number, SeekClip[]>();

/** Register the desired pose for a skeletal rig (editor scrub-preview): 1 clip = seek, 2 = a
 *  crossfade blend (Phase B — replicates the fadeDuration crossfade Play shows). */
export function requestSkeletalSeek(entityId: number, clips: SeekClip[]): void {
  _seeks.set(entityId, clips);
}

/** The pending seek/blend for a rig, or undefined when none (advance normally). */
export function getSkeletalSeek(entityId: number): SeekClip[] | undefined {
  return _seeks.get(entityId);
}

/** Drop all pending seeks (call when the scrub set is rebuilt, Play resumes, or the editor
 *  surface unmounts). No-op — and no allocation — when already empty. */
export function clearSkeletalSeeks(): void {
  if (_seeks.size) _seeks = new Map();
}

/** True while any skeletal seek is pending — i.e. a timeline scrub is posing a rig. Used by
 *  `syncBones` to read the seeked mixer pose back into bone Transforms instead of clobbering it. */
export function hasSkeletalSeeks(): boolean {
  return _seeks.size > 0;
}

// Seeks are keyed by world-local entity ids — never let them survive into a new world.
onWorldSwap(() => clearSkeletalSeeks());
