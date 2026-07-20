import { trait } from 'koota';

/** One named 2D frame-sequence ("track" / clip). The frames are an ordered list of
 *  `'sprite'` slice GUIDs (carved sub-rects of a sheet; see `loaders/spriteSheet.ts`). */
export interface SpriteClip {
  frames: string[];                      // ordered 'sprite' slice GUIDs
  fps: number;                           // frames per second
  mode: 'once' | 'loop' | 'pingpong';    // pingpong = flip-flop
  cycles: number;                        // # passes for once/pingpong; 0 = infinite
}

export function defaultSpriteClip(): SpriteClip {
  return { frames: [], fps: 12, mode: 'loop', cycles: 0 };
}

/** SpriteAnimator — plays 2D frame-sequence ("flipbook") animations by driving the
 *  sibling `Renderable2D.sprite` ref through an ordered list of frames. Put it on the
 *  SAME entity as the `Renderable2D`.
 *
 *  The clips live in a REUSABLE `.spriteanim.json` asset referenced by `clipSet`
 *  (GUID), holding MULTIPLE named clips ("tracks") — e.g. `idle`, `walk`, `attack`.
 *  The trait plays ONE at a time, chosen by `clip` (the active track name; empty →
 *  first). Switch `clip` (+ reset `time`) to "play a track". Each clip carries its own
 *  frames/fps/mode/cycles (resolved via `spriteAnimCache.activeSpriteClip`).
 *
 *  Playback is presentation-time: `spriteAnimationSystem` advances `time` by the
 *  visual delta (freezes on Stop/Pause, honors `timeScale`) and computes the frame
 *  index via the shared `spriteIndexFromStep` math (the same one the GPU particle
 *  sprite-sheets use). The three play modes match the particle convention:
 *    - `once`     — clamp to the last frame after one pass
 *    - `loop`     — wrap forever
 *    - `pingpong` — forward then backward, repeating (the flip-flop)
 *
 *  This is a plain SCALAR trait — the clip DATA is the asset's concern, not the
 *  entity's (was an inline `clips` map until the asset migration; see git history). */
export const SpriteAnimator = trait({
  clipSet: '' as string,   // GUID of a .spriteanim.json asset (the named clip set)
  clip: '' as string,      // active track name ('' = first)
  time: 0 as number,       // current playhead in seconds (driven)
  playing: true as boolean,
});
