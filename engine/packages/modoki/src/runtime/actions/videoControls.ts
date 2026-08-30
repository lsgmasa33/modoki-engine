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
import { registerUIAction } from '../core/actionRegistry';
import { VideoPlayer } from '../traits/VideoPlayer';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { seekEntityVideo, claimVideoEndEmit } from '../video/videoSystem';
import { emitVideoSkip } from '../video/VideoEvents';

function patch(target: Entity | undefined, fields: Partial<{ playing: boolean; clip: string }>): void {
  if (!target?.has(VideoPlayer)) return;
  target.set(VideoPlayer, fields);
}

export function registerVideoControls(): void {
  registerUIAction('video.play', ({ target }) => patch(target, { playing: true }));
  registerUIAction('video.pause', ({ target }) => patch(target, { playing: false }));
  registerUIAction('video.toggle', ({ target }) => {
    const v = target?.get(VideoPlayer);
    if (v) patch(target, { playing: !v.playing });
  });

  registerUIAction('video.stop', ({ target }) => {
    if (!target) return;
    seekEntityVideo(target.id(), 0);
    patch(target, { playing: false });
  });

  registerUIAction('video.skip', ({ target }) => {
    if (!target) return;
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
    patch(target, { playing: false });
  });

  registerUIAction('video.seek', {
    params: {
      seconds: { type: 'number', min: 0, step: 0.1, tooltip: 'Absolute position in seconds.' },
    },
    handler: ({ target, params }) => {
      if (!target) return;
      const seconds = Number(params?.seconds ?? 0);
      if (!Number.isFinite(seconds)) return;
      seekEntityVideo(target.id(), seconds);
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
      if (!clip) return;
      patch(target, { clip, playing: true });
    },
  });
}
