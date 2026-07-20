/** Plays keyframe animation clips on entities that have the Animator trait.
 *
 *  Runs before transform propagation (SYSTEM_PRIORITY.ANIMATION) so animated
 *  local transforms propagate and the render sync picks them up the same frame.
 *  Clips are lazy-loaded via the clip cache — until a clip resolves, the entity
 *  simply isn't posed (retried next frame). */

import type { World } from 'koota';
import { Animator } from '../traits/Animator';
import { Paused } from '../traits/Paused';
import { getAnimationClip } from '../loaders/animationClipCache';
import { resolveActiveClip, resolveClipByName } from '../animation/animClipBank';
import { applyClipAtTime, applyClipAtTimeBlended, advanceClipTime, buildEntityIndex } from '../animation/sampleClip';
import type { AnimationClipDef } from '../animation/types';
import { applyClipDeform } from './deform2DSystem';
import { beginDeform2DFrame } from './deform2DBuffers';
import { getTime, getVisualDelta } from './getTime';

export function animationSystem(world: World) {
  const time = getTime(world);
  if (!time) return;
  // Start a fresh deform epoch — a part not re-written this pass reads back as
  // "no deform" (auto-expiry on clip switch / animator removal).
  beginDeform2DFrame();
  // Visual layer → smoothed cadence × timeScale (freezes on pause/time-stop).
  const delta = getVisualDelta(world);

  // Collect first (advancing Animator.time mutates the trait; applyClipAtTime
  // also runs its own queries, so we don't write inside the query callback).
  // Resolve the clip once here and carry it into the apply pass (no double fetch).
  const pending: {
    rootId: number; clip: AnimationClipDef; t: number;
    from?: { clip: AnimationClipDef; time: number }; w: number;
  }[] = [];
  world.query(Animator).updateEach(([anim], entity) => {
    if (entity.has(Paused)) return;
    const resolved = resolveActiveClip(anim);
    if (!resolved) { if (anim.activeClip) anim.activeClip = ''; if (anim.fadeFrom) anim.fadeFrom = ''; return; }
    const fadeDuration = resolved.fadeDuration ?? anim.fadeDuration;
    // Active-name change → restart the incoming clip. Only between two KNOWN names, so the
    // initial bind (activeClip still '' — runtimeOnly, never serialized) adopts the clip
    // WITHOUT clobbering an authored/scrubbed `time`. With a fade window, capture the
    // outgoing clip's name+playhead as the fade-FROM source (Unity's Animator.CrossFade);
    // fadeDuration 0 = instant cut (Phase-1 behavior).
    if (anim.activeClip && anim.activeClip !== resolved.name) {
      if (fadeDuration > 0) { anim.fadeFrom = anim.activeClip; anim.fadeFromTime = anim.time; anim.fadeElapsed = 0; }
      else anim.fadeFrom = '';
      anim.time = 0;
    }
    anim.activeClip = resolved.name;

    const clip = getAnimationClip(resolved.ref);
    if (anim.playing) {
      const duration = clip?.duration ?? 0;
      anim.time = advanceClipTime(anim.time, delta * (resolved.speed ?? anim.speed), duration, resolved.loop ?? anim.loop);
    }

    // Advance an in-progress crossfade: the outgoing playhead keeps moving (so it fades out
    // MID-motion, not frozen), and the blend weight ramps 0→1 over fadeDuration. Both only
    // progress while this animator is playing — a pause freezes the blend in place.
    let from: { clip: AnimationClipDef; time: number } | undefined;
    let w = 1;
    if (anim.fadeFrom && fadeDuration > 0) {
      const fromEntry = resolveClipByName(anim, anim.fadeFrom);
      const fromClip = fromEntry ? getAnimationClip(fromEntry.ref) : null;
      if (anim.playing) {
        if (fromClip) anim.fadeFromTime = advanceClipTime(anim.fadeFromTime, delta * (fromEntry!.speed ?? anim.speed), fromClip.duration, fromEntry!.loop ?? anim.loop);
        anim.fadeElapsed += delta;
      }
      if (anim.fadeElapsed >= fadeDuration) {
        anim.fadeFrom = ''; // fade complete → pure incoming clip
      } else if (fromClip) {
        from = { clip: fromClip, time: anim.fadeFromTime };
        w = anim.fadeElapsed / fadeDuration;
      }
    }

    if (clip) pending.push({ rootId: entity.id(), clip, t: anim.time, from, w }); // else not loaded — retry next frame
  });

  if (pending.length === 0) return;
  // Build the entity index once for the whole frame and share it across animators.
  const index = buildEntityIndex(world);
  for (const p of pending) {
    if (p.from) applyClipAtTimeBlended(world, p.rootId, p.from, { clip: p.clip, time: p.t }, p.w, index);
    else applyClipAtTime(world, p.rootId, p.clip, p.t, index);
    // Deform channels don't crossfade — the incoming clip drives them at full (a documented
    // limitation; deform is a niche 2D-mesh channel and blending vertex offsets mid-fade is
    // rarely wanted). No-op for scalar-only clips.
    applyClipDeform(world, p.rootId, p.clip, p.t, index);
  }
}
