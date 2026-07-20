/** Audio cue bus — the "emit an event, audio reacts" channel, DELIBERATELY
 *  separate from the verification journal.
 *
 *  The journal is a capped, ring-dropping, build-toggleable trace for assertions
 *  and debugging; routing playback through it would make audio lossy and let
 *  `setJournalEnabled(false)` (a legit shipped-build optimization) silently mute
 *  the game. So game code raises cues here instead:
 *   - `cueSound(name)` → `audioSystem` plays every `AudioSource` whose
 *     `playOnCue === name` (state-driven, entity-owned SFX).
 *   - `cueClip(guid, opts)` → a fire-and-forget one-shot with no entity.
 *
 *  World-scoped (WeakMap<World>) like the journal, so coexisting worlds (editor
 *  dual-viewport, tests) keep separate queues. `audioSystem` drains once per frame.
 *  Headless: cues still queue + drain deterministically; the service just no-ops
 *  the actual playback. */

import { type World } from 'koota';
import { getCurrentWorld } from '../ecs/worldRegistry';

export interface AudioCue {
  /** Named cue → plays any AudioSource whose `playOnCue` matches. */
  name?: string;
  /** Direct one-shot: play this clip guid now (no entity/AudioSource needed). */
  clip?: string;
  bus?: 'master' | 'music' | 'sfx' | 'ui';
  volume?: number;
  pitch?: number;
}

const queues = new WeakMap<World, AudioCue[]>();

function queueFor(world: World): AudioCue[] {
  let q = queues.get(world);
  if (!q) { q = []; queues.set(world, q); }
  return q;
}

/** Raise a named cue — every `AudioSource` with a matching `playOnCue` fires a
 *  one-shot this frame. */
export function cueSound(name: string, world: World = getCurrentWorld()): void {
  queueFor(world).push({ name });
}

/** Play a clip directly as a one-shot, with no entity. */
export function cueClip(
  clip: string,
  opts?: Omit<AudioCue, 'name' | 'clip'>,
  world: World = getCurrentWorld(),
): void {
  queueFor(world).push({ clip, ...opts });
}

/** Drain + clear this frame's cues (called by `audioSystem`). */
export function drainAudioCues(world: World = getCurrentWorld()): AudioCue[] {
  const q = queues.get(world);
  if (!q || q.length === 0) return [];
  const out = q.slice();
  q.length = 0;
  return out;
}

/** Drop any pending cues without playing them (teardown / stop). */
export function clearAudioCues(world: World = getCurrentWorld()): void {
  queues.get(world)?.splice(0);
}
