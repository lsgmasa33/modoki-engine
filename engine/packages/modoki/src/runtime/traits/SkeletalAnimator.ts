import { trait } from 'koota';

/** SkeletalAnimator — desired playback state for a `SkinnedModel`'s GLB clips.
 *
 *  Pure DATA. The render sync (`scene3DSync.syncSkinnedModels`) owns the actual
 *  `THREE.AnimationMixer` / `AnimationAction`s and reads this trait each frame to
 *  drive them — the same split used for `Renderable3D` material binding. Put this
 *  on the SAME entity as the `SkinnedModel`.
 *
 *  - `animSet` — ref (GUID) to a `.animset.json` providing per-CLIP default
 *    params (speed/loop/fadeDuration). Empty → no animset (legacy: the fields
 *    below are used directly). When set, `speed`/`loop`/`fadeDuration` act as
 *    per-entity OVERRIDES: a field left at its trait default below inherits the
 *    animset's per-clip value; a non-default value wins. (The defaults here MUST
 *    match `ANIMSET_DEFAULTS` in animSetCache — that equality IS the sentinel.)
 *  - `clip` — active clip NAME (as authored in the GLB). Empty → first clip.
 *  - `playing` — false pauses the mixer (pose holds).
 *  - `speed` — playback rate (mixer timeScale); 1 = authored, negative = reverse.
 *  - `loop` — repeat vs. play-once-and-clamp.
 *  - `fadeDuration` — crossfade seconds when `clip` changes (0 = instant switch). */
export const SkeletalAnimator = trait({
  animSet: '' as string,
  clip: '' as string,
  playing: true as boolean,
  speed: 1 as number,
  loop: true as boolean,
  fadeDuration: 0 as number,
  // ── Runtime read-back (Percept, S4) — live mixer state mirrored each frame by
  //    scene3DSync so scene-state can report what's ACTUALLY playing (not just the
  //    desired state above). runtimeOnly → not serialized.
  /** Resolved clip actually playing (clip || firstClip); '' when none. */
  activeClip: '' as string,
  /** Playhead in seconds. */
  time: 0 as number,
  /** Playhead as 0..1 of the active clip's duration (0 when no clip/duration). */
  normalizedTime: 0 as number,
  /** Effective blend weight of the active clip (0..1). */
  weight: 0 as number,
  /** Whether the action is effectively paused — includes global stop/pause, not
   *  just the authored `playing` flag. */
  effectivePaused: false as boolean,
});
