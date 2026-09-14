/** 3D Physics Demo — a showcase project for the Rapier3D physics layer (Phase 1):
 *  gravity, restitution/bounce, rolling, a stacked tower, every primitive collider
 *  (box/sphere/capsule/cylinder/cone), a tilted static ramp (Euler→quaternion), a
 *  sensor trigger zone, and its physics-free twin — a `Zone3D` trigger volume. The only
 *  game code is two pairs of UIActions, wired declaratively to the two trigger stations
 *  via their `OnCollision3D` / `OnZone3D` traits, to demonstrate reacting to detection
 *  without imperative polling. Open via the editor's Open Project
 *  (MODOKI_PROJECT=demos/3d-physics-demo). */

import type { GameDefinition } from '@modoki/engine/runtime';
import type { Entity } from 'koota';
import { registerUIAction, unregisterUIAction, refuseAction, Renderable3DPrimitive, entityRef, onWorldSwap, packedOf, type PackedEntity } from '@modoki/engine/runtime';

// Occupied tints. The IDLE colours are NOT here — they are authored on each station's
// Renderable3DPrimitive in the scene, and `tintOnEnter`/`restoreOnExit` below put back
// exactly what the scene holds. The two constants under them are no-scene fallbacks only.
const HOT_COLOR = 0x2ecc71;        // Sensor Zone occupied: brighter green
const ZONE_HOT_COLOR = 0xd980fa;   // Trigger Zone occupied: brighter violet
const BASE_COLOR_FALLBACK = 0x1abc9c;        // teal — only if the station authored nothing
const ZONE_BASE_COLOR_FALLBACK = 0x9b59b6;   // purple — ditto

// ── Tinting a station while it is occupied ────────────────────────────────────────────
// The authored colour is the source of truth: a hardcoded idle constant would silently
// overwrite an Inspector re-colour on the very next exit. So the FIRST occupant to arrive
// remembers what the scene actually holds, and the LAST one to leave puts it back.
//
// A station can hold SEVERAL occupants at once, so "the last one to leave" needs tracking.
// ⚠️ It tracks WHO is inside, not HOW MANY, and the difference is load-bearing: pressing
// Stop clears the engine's occupancy WITHOUT firing exits (`clearZoneState` —
// "forget occupancy so the NEXT run re-fires enter for everything currently inside"), so a
// station occupied at Stop gets a second enter with no matching exit on the next Play. A
// counter would climb to 2 and never come back down, leaving the station lit forever. A set
// of occupant ids is idempotent under that duplicate enter, so it self-heals.
// ⚠️ Keyed by the PACKED entity (`packedOf`), zone AND occupant, never `entity.id()` (#1198): koota
// recycles an index, so a body destroyed inside the zone and a newcomer spawned onto its index are
// the same `id()`. If the newcomer's enter arrived before the dead body's exit, a bare-id set would
// add a duplicate and then delete it, restoring the idle tint with the newcomer still inside.
const authoredColor = new Map<PackedEntity, number>();
const insiders = new Map<PackedEntity, Set<PackedEntity | typeof NO_OCCUPANT>>();
const NO_OCCUPANT = -1;   // an enter/exit that arrived without an `other` (never seen; be safe)

// ⚠️ This state belongs to ONE play session and must not outlive its world. Stop reverts by
// building a brand-new koota World whose slot indices restart at 0, and koota reuses the destroyed
// World's id — so the next session hands the same PACKED entity to the same entity, generation and
// all, and a packed key does not tell the sessions apart. Left uncleared, session
// 2's first enter would find session 1's entry, skip re-reading the authored colour, and later
// restore a STALE one: the very shadowing bug this code exists to prevent, laundered through a
// cache instead of a constant. `onWorldSwap` fires on exactly that swap.
let unsubWorldSwap: (() => void) | null = null;
function forgetSessionState(): void { authoredColor.clear(); insiders.clear(); }

function tintOnEnter(self: Entity, other: Entity | undefined, hot: number): void {
  const id = packedOf(self);
  let inside = insiders.get(id);
  if (!inside) { inside = new Set(); insiders.set(id, inside); }
  if (inside.size === 0) authoredColor.set(id, (self.get(Renderable3DPrimitive) as { color: number }).color);
  inside.add(other ? packedOf(other) : NO_OCCUPANT);
  self.set(Renderable3DPrimitive, { color: hot });
}

function restoreOnExit(self: Entity, other: Entity | undefined, fallback: number): void {
  const id = packedOf(self);
  const inside = insiders.get(id);
  inside?.delete(other ? packedOf(other) : NO_OCCUPANT);
  if (inside && inside.size > 0) return;   // someone else is still inside
  insiders.delete(id);
  // `self` is normally alive: the engine's zone and contact dispatch drop an event whose self is dead
  // (runtime/zones/zoneTriggerCore.ts, runtime/physics/physicsContactEvents.ts). So a zone despawned while
  // occupied never gets these exits and its `insiders` entry is stranded until the world swap. That is
  // why the zone is keyed by packed entity too: a new zone on the same index must not inherit the
  // stranded set and skip reading its own authored colour.
  if (self.isAlive()) self.set(Renderable3DPrimitive, { color: authoredColor.get(id) ?? fallback });
  authoredColor.delete(id);
}

// Only the engine's collision/zone dispatch can supply `params.self` (an Entity) — an agent's JSON
// params never can (a GUID string is not one; koota entities are numbers). Without it nothing is tinted, so a zone event must not be journalled either:
// RETURN the refusal so dispatch-action reads ok:false instead of dispatched:true (#1185). Silent,
// because the engine always passes `self` and a shipped warn becomes a crash report.
const noSelf = (action: string) => refuseAction(
  `${action}: params.self must be the zone Entity, and it is missing or not an entity — only the zone's own collision dispatch supplies it. Move a body into the zone to fire this.`,
  { log: false },
);

const ACTIONS = [
  'sensorZone3D/enter', 'sensorZone3D/exit',
  'triggerZone3D/enter', 'triggerZone3D/exit',
] as const;

export const game: GameDefinition = {
  id: '3d-physics-demo',
  name: '3D Physics Demo',
  description: 'Rapier3D showcase: falling & stacking bodies, a bouncing ball, a rolling ball on a ramp, every primitive collider, a sensor zone, and a physics-free Zone3D trigger.',
  loadConfig: () => import('./runtime/config').then((m) => m.physics3DDemoConfig),
  registerSystems: () => {
    unsubWorldSwap ??= onWorldSwap(forgetSessionState);
    // The Sensor Zone's OnCollision3D dispatches these; ctx.params.self is the zone,
    // ctx.target is the body that entered/left. We tint the zone + log to the journal
    // so the reaction is verifiable by data (modoki_journal), not just by eye.
    registerUIAction('sensorZone3D/enter', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      if (typeof self !== 'number') return noSelf('sensorZone3D/enter');
      tintOnEnter(self, other, HOT_COLOR);
      // ctx.emit binds the world; entityRef() converts the body to its stable GUID
      // (id() would churn across hot-reloads). Verifiable via modoki_journal.
      ctx.emit('zone', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('sensorZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      if (typeof self !== 'number') return noSelf('sensorZone3D/exit');
      restoreOnExit(self, other, BASE_COLOR_FALLBACK);
      ctx.emit('zone', { phase: 'exit', body: other ? entityRef(other) : undefined });
    });

    // The physics-free twin. The Trigger Zone entity carries NO RigidBody3D and NO
    // Collider3D — only `Zone3D` (the volume, sized by its Transform scale) and
    // `OnZone3D` (the reaction). Anything tagged `ZoneOccupant` is tested for
    // containment each frame, so the Zone Probe and the character-controller Player
    // both trip it with nothing on the zone side to collide against. Same declarative
    // shape as the sensor pair above; `zoneTrigger` is a distinct journal type so the
    // two stations stay tellable apart in `modoki_journal`. (The engine also emits its
    // own `@zone` event for every crossing — this one is the game's reaction, not the
    // engine's record.)
    registerUIAction('triggerZone3D/enter', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      if (typeof self !== 'number') return noSelf('triggerZone3D/enter');
      tintOnEnter(self, other, ZONE_HOT_COLOR);
      ctx.emit('zoneTrigger', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('triggerZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      if (typeof self !== 'number') return noSelf('triggerZone3D/exit');
      restoreOnExit(self, other, ZONE_BASE_COLOR_FALLBACK);
      ctx.emit('zoneTrigger', { phase: 'exit', body: other ? entityRef(other) : undefined });
    });
  },
  unregisterSystems: () => {
    for (const a of ACTIONS) unregisterUIAction(a);
    unsubWorldSwap?.(); unsubWorldSwap = null;
    forgetSessionState();
  },
};
