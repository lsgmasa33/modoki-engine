/** Built-in video control layer — engine-wide UI actions so games drive video
 *  DECLARATIVELY (a Skip button bound to `video.skip`) instead of hand-driving the
 *  service from setup.ts. Mirrors `audioControls.ts`.
 *
 *  Registered once app-wide, alongside the audio controls. App-tier, event-driven —
 *  no per-frame tick, no wall-clock/random — so it never enters the deterministic
 *  headless pipeline.
 *
 *  Actions (target a VideoPlayer entity via the binding's `target` GUID):
 *   - `video.play` / `video.pause` / `video.toggle` — flip VideoPlayer.playing.
 *   - `video.stop`   — stop and rewind to the start.
 *   - `video.skip`   — dismiss a cutscene: stop it AND announce it, so a game
 *                      waiting on the end fires exactly once either way.
 *   - `video.seek`   — jump to a time in seconds.
 *   - `video.setClip`— swap the clip by GUID. */

import type { Entity } from 'koota';
import { registerUIAction, refuseAction, type UIActionRefusal } from '../core/actionRegistry';
import { VideoPlayer } from '../traits/VideoPlayer';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { seekEntityVideo, claimVideoEndEmit } from '../video/videoSystem';
import { emitVideoSkip } from '../video/VideoEvents';

/** The refusal for a `video.*` action whose target is missing or carries no VideoPlayer, else
 *  undefined. Unlogged, like the audio twin: silent for a player before #1129, read by the agent op. */
function playerRefusal(action: string, target: Entity | undefined): UIActionRefusal | undefined {
  if (!target) return refuseAction(`[${action}] no target entity — point the binding at a VideoPlayer entity`, { log: false });
  if (!target.has(VideoPlayer)) return refuseAction(`[${action}] target has no VideoPlayer trait`, { log: false });
  return undefined;
}

function patch(action: string, target: Entity | undefined, fields: Partial<{ playing: boolean; clip: string }>): UIActionRefusal | undefined {
  const refused = playerRefusal(action, target);
  if (refused) return refused;
  // Strip undefined-valued keys: koota's setter tests `'key' in value`, not whether it's
  // defined, so an explicit undefined here would overwrite the real value.
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  target!.set(VideoPlayer, defined);
  return undefined;
}

export function registerVideoControls(): void {
  registerUIAction('video.play', ({ target }) => patch('video.play', target, { playing: true }));
  registerUIAction('video.pause', ({ target }) => patch('video.pause', target, { playing: false }));
  registerUIAction('video.toggle', ({ target }) => {
    const v = target?.get(VideoPlayer);
    return patch('video.toggle', target, { playing: !v?.playing });
  });

  registerUIAction('video.stop', ({ target }) => {
    if (!target) return playerRefusal('video.stop', target);
    seekEntityVideo(target.id(), 0);
    return patch('video.stop', target, { playing: false });
  });

  registerUIAction('video.skip', ({ target }) => {
    if (!target) return playerRefusal('video.skip', target);
    const v = target.get(VideoPlayer);
    // Announce BEFORE stopping. `emitVideoSkip` also emits `@video.end`, so a game
    // that only listens for "the cutscene is over" fires exactly once whether the
    // player watched it or dismissed it — otherwise a skip would hang that listener
    // forever, which is the classic way a skippable cutscene softlocks a game.
    //
    // But the reconcile may have already announced the end itself (the clip finished
    // playing before the Skip button was pressed) — `claimVideoEndEmit` consults and
    // latches the SAME guard, so a skip on an already-ended clip fires `@video.skip`
    // without a second, unpaired `@video.end`.
    const announceEnd = claimVideoEndEmit(target.id());
    emitVideoSkip({ entity: target.get(EntityAttributes)?.guid, clip: v?.clip ?? '' }, announceEnd);
    seekEntityVideo(target.id(), 0);
    patch('video.skip', target, { playing: false });
    // NOT the patch's refusal: the skip was already ANNOUNCED above, so a target with no VideoPlayer
    // has had an effect a listener can observe, and reporting "refused" would be the false answer.
    return undefined;
  });

  registerUIAction('video.seek', {
    params: {
      seconds: { type: 'number', min: 0, step: 0.1, tooltip: 'Absolute position in seconds.' },
    },
    handler: ({ target, params }) => {
      const refused = playerRefusal('video.seek', target);   // no target, or no VideoPlayer: seek would do nothing
      if (refused) return refused;
      const seconds = Number(params?.seconds ?? 0);
      if (!Number.isFinite(seconds)) return refuseAction(`[video.seek] seconds must be a finite number, got ${String(params?.seconds)}`, { log: false });
      seekEntityVideo(target!.id(), seconds);
      return undefined;
    },
  });

  registerUIAction('video.setClip', {
    params: {
      clip: {
        type: 'string', accept: ['.mp4', '.mov', '.m4v', '.webm', '.mkv'],
        tooltip: 'Video asset GUID to switch to.',
      },
    },
    handler: ({ target, params }) => {
      const clip = typeof params?.clip === 'string' ? params.clip : '';
      if (!clip) return refuseAction('[video.setClip] no `clip` — set the video asset GUID to switch to', { log: false });
      return patch('video.setClip', target, { clip, playing: true });
    },
  });
}
