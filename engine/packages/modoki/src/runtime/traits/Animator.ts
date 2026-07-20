import { trait } from 'koota';

/** Animator — plays keyframe animation clips on this entity and its descendants.
 *
 *  Holds a NAMED LIST of clips (`clips`, a JSON-string bank of `{name, clip(GUID),
 *  speed?, loop?, fadeDuration?}`) and plays ONE at a time, chosen by `clip` (the active
 *  clip NAME; empty → first entry). Switch `clip` to "play a track" — the play loop restarts
 *  the new clip and picks it up next frame (mirrors `SkeletalAnimator` / `SpriteAnimator`).
 *  Each entry's `clip` is a GUID referencing a `.anim.json` asset (resolved via the asset
 *  manifest); the entity carrying the Animator is the clip's binding root, tracks target
 *  descendants by relative name-path.
 *
 *  The `clips` bank is decoded by `animation/animClipBank.ts` (parseAnimClipBank /
 *  resolveActiveClip) — the ONE decoder, shared by the play loop, the resource collector,
 *  and the build tree-shaker (same JSON-string-scalar pattern as `AudioSource.clips`).
 *  `speed`/`loop` here are the fallbacks a per-clip override wins over. */
export const Animator = trait({
  clips: '[]' as string,   // JSON: [{name, clip, speed?, loop?, fadeDuration?}]
  clip: '' as string,      // active clip NAME ('' = first entry)
  time: 0 as number,       // current playhead in seconds
  speed: 1 as number,      // playback rate multiplier (a per-clip `speed` overrides)
  playing: true as boolean,
  loop: true as boolean,   // repeat vs. clamp (a per-clip `loop` overrides)
  // Crossfade seconds when the active `clip` changes (0 = instant cut). A per-clip
  // `fadeDuration` in the bank overrides this; the play loop blends the outgoing pose
  // into the incoming one over this window (see animation/sampleClip.applyClipAtTimeBlended).
  fadeDuration: 0 as number,
  // Runtime read-back (runtimeOnly, not serialized). `activeClip` = resolved name actually
  // playing. The three `fade*` fields are the live crossfade state, advanced each frame:
  // `fadeFrom` is the outgoing clip NAME ('' = no fade in progress), `fadeFromTime` its
  // playhead, `fadeElapsed` seconds into the current fade.
  activeClip: '' as string,
  fadeFrom: '' as string,
  fadeFromTime: 0 as number,
  fadeElapsed: 0 as number,
});
