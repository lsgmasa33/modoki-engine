/** Plays 2D frame-sequence ("flipbook") animations on entities that carry a
 *  SpriteAnimator alongside a Renderable2D.
 *
 *  Runs at SYSTEM_PRIORITY.ANIMATION (same tier as keyframe playback) so the
 *  selected frame is current before the 2D render sync reads Renderable2D. Like
 *  the keyframe Animator it advances on the VISUAL delta (freezes on Stop/Pause,
 *  honors timeScale) and is skipped entirely by the pipeline when the sim isn't
 *  running. Entities tagged `Paused` are skipped individually.
 *
 *  Each tick it computes a frame index from `floor(time·fps)` via the shared
 *  `spriteIndexFromStep` math (the same loop/pingpong logic the GPU particle
 *  sprite-sheets use) and writes `Renderable2D.sprite` to that frame's slice GUID.
 *  Scene2D's per-entity `spriteRef` change-detection rebuilds the framed texture. */

import type { World } from 'koota';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { activeSpriteClip } from '../loaders/spriteAnimCache';
import { Renderable2D } from '../traits/Renderable2D';
import { Paused } from '../traits/Paused';
import { spriteIndexFromStep } from '../particles/types';
import { getVisualDelta } from './getTime';

export function spriteAnimationSystem(world: World) {
  const delta = getVisualDelta(world);

  world.query(SpriteAnimator, Renderable2D).updateEach(([anim, r2d], entity) => {
    if (entity.has(Paused)) return;
    // Play the active track — from the clipSet asset (preferred), else the inline
    // clips map / legacy single-track fallback. undefined while a clipSet asset is
    // still loading → skip this frame (it retries next tick).
    const clip = activeSpriteClip(anim);
    if (!clip) return;
    const frames = clip.frames;
    const n = frames.length;
    if (n === 0) return;
    const fps = clip.fps > 0 ? clip.fps : 0;
    const mode = clip.mode || 'loop';
    const cycles = clip.cycles || 0;

    let step = fps > 0 ? Math.floor(anim.time * fps) : 0;

    // Finite playback: `once` is always a single pass; `loop`/`pingpong` honor
    // `cycles` (0 = infinite). On completion we hold the boundary frame.
    let finished = false;
    if (mode === 'once') {
      if (step >= n - 1) { step = n - 1; finished = true; }
    } else if (cycles > 0) {
      const framesPerCycle = mode === 'pingpong' ? 2 * n - 2 : n;
      const maxStep = cycles * framesPerCycle;
      if (step >= maxStep) { step = maxStep; finished = true; }
    }

    // Apply the current frame BEFORE advancing so frame 0 shows at time 0; the
    // frame is (re)applied every tick so an externally-set `time` (scrubbing)
    // resolves to the right frame even while paused.
    const idx = spriteIndexFromStep(step, n, mode);
    const ref = frames[idx];
    if (ref && r2d.sprite !== ref) r2d.sprite = ref;

    // Advance the playhead for next tick; stop once finished so `time` doesn't grow.
    if (anim.playing) {
      if (finished) anim.playing = false;
      else if (fps > 0) anim.time += delta;
    }
  });
}
