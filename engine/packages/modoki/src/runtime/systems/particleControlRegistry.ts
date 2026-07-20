/** particleControlRegistry — a Timeline **Control track** → particle-system bridge (Phase E).
 *
 *  A control clip's `particle:true` block wants to RESTART (or pause) a `ParticleEmitter` on the
 *  playhead, but the emitter's live state lives in an `IParticleBackend` handle owned by the render
 *  layer (`particleSync`), which the deterministic `timelineSystem` (pipeline) must not touch — same
 *  split as `skeletalSeek`. So the system writes a pending action here, keyed by the target's runtime
 *  entity id, and `syncParticles` drains it: `backend.restart(handle)` / `backend.pause(handle)`.
 *
 *  The particle RESTART is a presentation trigger (the deterministic edge is journaled as `@control`
 *  in `timelineSystem`, which is what headless tests assert on); this registry only carries the
 *  visual effect. Keyed by a world-local entity id, so it is force-cleared on any world swap (like
 *  `controlSpawnRegistry` / `skeletalSeek`) lest an action target a dead/reused id in the next world. */

import { onWorldSwap } from '../ecs/world';

/** What to do to a target emitter on the next render sync. `restart` re-emits from t=0; `pause`
 *  freezes the sim (a clip end with a duration). A later request in the same frame supersedes. */
export type ParticleControlAction = 'restart' | 'pause';

let _pending = new Map<number, ParticleControlAction>();

export function requestParticleControl(entityId: number, action: ParticleControlAction): void {
  _pending.set(entityId, action);
}

/** The pending action for an emitter entity, or undefined. `syncParticles` calls this per emitter. */
export function takeParticleControl(entityId: number): ParticleControlAction | undefined {
  const a = _pending.get(entityId);
  if (a !== undefined) _pending.delete(entityId);
  return a;
}

export function hasParticleControls(): boolean { return _pending.size > 0; }

/** Drop all pending actions (world swap / teardown). No alloc when already empty. */
export function clearParticleControls(): void { if (_pending.size) _pending = new Map(); }

// ── Scrub SPAN reflect (Phase 5) ──────────────────────────────────────────────────────────────
// A particle CONTROL clip with a duration wants its target emitter ON while the scrub playhead is
// inside the span and OFF outside. But `restart` re-emits from t=0, so queuing it every drag frame
// would freeze the burst at its start. So track the last reflected on/off per emitter and queue a
// restart/pause ONLY on a transition (span entry/exit). Forward preview drives the same emitter via
// edge `controlParticle`, so this scrub state is reset whenever the forward step runs (below).
let _scrubReflect = new Map<number, boolean>();

/** Reflect a scrub span-containment for `entityId`: ON=inside the span, OFF=outside. Idempotent —
 *  only queues a `restart`/`pause` on the on↔off transition. */
export function reflectParticleScrub(entityId: number, on: boolean): void {
  const was = _scrubReflect.get(entityId) ?? false;
  if (on === was) return;
  _scrubReflect.set(entityId, on);
  requestParticleControl(entityId, on ? 'restart' : 'pause');
}

/** Record an emitter's on/off in the scrub-reflect memory WITHOUT queuing a request — used by the
 *  forward-preview edge path (`controlParticle`) to keep the scrub memory in sync with the emitter's
 *  actual state. So when a scrub takes over after a (possibly paused) forward preview, the first
 *  out-of-span scrub correctly sees a still-running emitter as ON and pauses it, instead of reading a
 *  wiped 'off' and leaving it running (review C8). */
export function noteScrubParticleState(entityId: number, on: boolean): void { _scrubReflect.set(entityId, on); }

/** Reset the scrub-reflect transition memory (teardown / world swap), so the next scrub re-establishes
 *  each emitter's on/off from scratch. */
export function resetScrubParticleReflect(): void { if (_scrubReflect.size) _scrubReflect = new Map(); }

// A world-local registry MUST NOT survive a world swap.
onWorldSwap(() => { clearParticleControls(); resetScrubParticleReflect(); });
