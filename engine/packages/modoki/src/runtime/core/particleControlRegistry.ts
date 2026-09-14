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
 *  visual effect. Force-cleared on any world swap (like `controlSpawnRegistry` / `skeletalSeek`).
 *
 *  KEYED BY THE PACKED ENTITY (#868), not `entity.id()`. A request outlives its target whenever the
 *  target is destroyed before it renders (or, for the scrub memory, for the rest of the scrub
 *  session), and koota hands a destroyed index to the next spawn — so an id key delivered the dead
 *  emitter's restart to the newcomer, or told a new emitter it was already ON. A dead target's
 *  entry is not matched by the next entity on its index and goes at the next swap/teardown.
 *  ⚠️ Not swept before then: koota's 8-bit generation repeats a packed value after 256 reuses of an
 *  index, so an undrained request could in principle reach an entity that many spawns later. Accepted
 *  — a request is drained on its target's next render, and the map is emptied on every world swap. */

import type { Entity } from 'koota';
import { onWorldSwap } from './ecs/world';
import { packedOf, type PackedEntity } from './ecs/entityTable';

/** What to do to a target emitter on the next render sync. `restart` re-emits from t=0; `pause`
 *  freezes the sim (a clip end with a duration). A later request in the same frame supersedes. */
export type ParticleControlAction = 'restart' | 'pause';

let _pending = new Map<PackedEntity, ParticleControlAction>();

export function requestParticleControl(target: Entity, action: ParticleControlAction): void {
  _pending.set(packedOf(target), action);
}

/** The pending action for an emitter entity, or undefined. `syncParticles` calls this per emitter. */
export function takeParticleControl(emitter: Entity): ParticleControlAction | undefined {
  const key = packedOf(emitter);
  const a = _pending.get(key);
  if (a !== undefined) _pending.delete(key);
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
let _scrubReflect = new Map<PackedEntity, boolean>();

/** Reflect a scrub span-containment for `target`: ON=inside the span, OFF=outside. Idempotent —
 *  only queues a `restart`/`pause` on the on↔off transition. */
export function reflectParticleScrub(target: Entity, on: boolean): void {
  const key = packedOf(target);
  const was = _scrubReflect.get(key) ?? false;
  if (on === was) return;
  _scrubReflect.set(key, on);
  requestParticleControl(target, on ? 'restart' : 'pause');
}

/** Record an emitter's on/off in the scrub-reflect memory WITHOUT queuing a request — used by the
 *  forward-preview edge path (`controlParticle`) to keep the scrub memory in sync with the emitter's
 *  actual state. So when a scrub takes over after a (possibly paused) forward preview, the first
 *  out-of-span scrub correctly sees a still-running emitter as ON and pauses it, instead of reading a
 *  wiped 'off' and leaving it running (review C8). */
export function noteScrubParticleState(target: Entity, on: boolean): void { _scrubReflect.set(packedOf(target), on); }

/** Reset the scrub-reflect transition memory (teardown / world swap), so the next scrub re-establishes
 *  each emitter's on/off from scratch. */
export function resetScrubParticleReflect(): void { if (_scrubReflect.size) _scrubReflect = new Map(); }

// A world-local registry MUST NOT survive a world swap.
onWorldSwap(() => { clearParticleControls(); resetScrubParticleReflect(); });
