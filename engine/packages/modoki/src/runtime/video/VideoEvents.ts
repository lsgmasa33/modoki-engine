/** Video lifecycle event bus + journal emits.
 *
 *  Two consumers, deliberately separate:
 *   - a game subscribes to the BUS to react ("cutscene ended → load the level");
 *   - the JOURNAL records the same moments as tick-stamped semantic events, so a
 *     headless assertion can say "the cutscene ended" without a screenshot.
 *
 *  Mirrors TimelineEvents. The journal names are prefixed `@video.` so they group
 *  with the other engine-emitted lifecycle events rather than a game's own. */

import { emit } from '../core/journal';

export interface VideoEventPayload {
  /** Entity guid that owns the VideoPlayer, when known. */
  entity?: string;
  /** Clip GUID. */
  clip: string;
}

type Handler = (p: VideoEventPayload) => void;

const started = new Set<Handler>();
const ended = new Set<Handler>();
const skipped = new Set<Handler>();

function sub(set: Set<Handler>, fn: Handler): () => void {
  set.add(fn);
  return () => { set.delete(fn); };
}

function fire(set: Set<Handler>, p: VideoEventPayload): void {
  // Copy before iterating: a handler that unsubscribes itself (the common
  // "play once then detach" shape) would otherwise mutate the set mid-iteration.
  for (const fn of [...set]) {
    try { fn(p); } catch (e) { console.error('[video] event handler threw:', e); }
  }
}

export const videoEvents = {
  onStart: (fn: Handler) => sub(started, fn),
  onEnd: (fn: Handler) => sub(ended, fn),
  /** Fired when the player skips — distinct from `onEnd`, because "they watched it"
   *  and "they dismissed it" are different facts and a game may care which. */
  onSkip: (fn: Handler) => sub(skipped, fn),
};

export function emitVideoStart(p: VideoEventPayload): void {
  emit('@video.start', p);
  fire(started, p);
}

export function emitVideoEnd(p: VideoEventPayload): void {
  emit('@video.end', p);
  fire(ended, p);
}

/** @param announceEnd - Whether to also emit `@video.end` (default true, preserving every
 *  existing caller's behaviour). `video.skip`'s action handler passes `false` when it has
 *  already claimed the end via `claimVideoEndEmit` — the reconcile announced it first, so
 *  bundling a second `@video.end` here would double-fire. */
export function emitVideoSkip(p: VideoEventPayload, announceEnd = true): void {
  emit('@video.skip', p);
  fire(skipped, p);
  // A skip is also an END for anyone who only cares that the cutscene is over —
  // otherwise every listener would have to subscribe to both to avoid hanging.
  if (announceEnd) emitVideoEnd(p);
}

/** Drop every subscriber (world teardown / tests). */
export function clearVideoEventHandlers(): void {
  started.clear();
  ended.clear();
  skipped.clear();
}
