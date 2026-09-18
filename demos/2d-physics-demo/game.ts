/** 2D Physics Demo — a showcase project for the Rapier2D physics layer (gravity,
 *  restitution, colliders, revolute + spring joints, sensors). The only game code is
 *  two pairs of UIActions, wired declaratively to the two trigger stations via their
 *  `OnCollision2D` / `OnZone2D` traits, to demonstrate reacting to detection without
 *  imperative polling — one through a Rapier sensor, one through a physics-free
 *  `Zone2D`. Open via the editor's Open Project (MODOKI_PROJECT=demos/2d-physics-demo). */

import type { GameDefinition } from '@modoki/engine/runtime';
import type { Entity } from 'koota';
import { registerUIAction, unregisterUIAction, refuseAction, Renderable2D, onWorldSwap, packedOf, type PackedEntity } from '@modoki/engine/runtime';

// Occupied tints. The IDLE tints are NOT here — they are authored on each station's
// Renderable2D in the scene, and `tintOnEnter`/`restoreOnExit` below put back exactly what
// the scene holds. The `*_FALLBACK` pairs are no-scene fallbacks only.
const HOT_COLOR = 0x2ecc71, HOT_OPACITY = 0.5;             // Sensor Zone occupied: green
const ZONE_HOT_COLOR = 0xd980fa, ZONE_HOT_OPACITY = 0.5;   // Trigger Zone occupied: violet
const BASE_FALLBACK = { color: 0xf1c40f, opacity: 0.25 };       // translucent yellow
const ZONE_BASE_FALLBACK = { color: 0x9b59b6, opacity: 0.25 };  // translucent purple

// ── Tinting a station while it is occupied ────────────────────────────────────────────
// The authored tint is the source of truth: a hardcoded idle constant would silently
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
interface Tint { color: number; opacity: number }
const authoredTint = new Map<PackedEntity, Tint>();
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
function forgetSessionState(): void { authoredTint.clear(); insiders.clear(); }

function tintOnEnter(self: Entity, other: Entity | undefined, hot: Tint): void {
  const id = packedOf(self);
  let inside = insiders.get(id);
  if (!inside) { inside = new Set(); insiders.set(id, inside); }
  if (inside.size === 0) {
    // COPY the trait's values — retaining the trait object itself would alias live state.
    const r = self.get(Renderable2D) as Tint;
    authoredTint.set(id, { color: r.color, opacity: r.opacity });
  }
  inside.add(other ? packedOf(other) : NO_OCCUPANT);
  self.set(Renderable2D, hot);
}

function restoreOnExit(self: Entity, other: Entity | undefined, fallback: Tint): void {
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
  if (self.isAlive()) self.set(Renderable2D, authoredTint.get(id) ?? fallback);
  authoredTint.delete(id);
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
  'sensorZone/enter', 'sensorZone/exit',
  'triggerZone/enter', 'triggerZone/exit',
] as const;

export const game: GameDefinition = {
  id: '2d-physics-demo',
  name: '2D Physics Demo',
  description: 'Rapier2D showcase: falling bodies, bouncing, a pendulum, a spring, a sensor zone, and a physics-free Zone2D trigger.',
  loadConfig: () => import('./runtime/config').then((m) => m.physicsDemoConfig),
  registerSystems: () => {
    unsubWorldSwap ??= onWorldSwap(forgetSessionState);
    // The Sensor Zone's OnCollision2D dispatches these; ctx.params.self is the zone,
    // ctx.target is the body that entered/left. We tint the zone + log to the journal
    // so the reaction is verifiable by data (modoki_journal), not just by eye.
    registerUIAction('sensorZone/enter', { noControl: true, handler: (ctx) => {
      const { self, other, otherRef } = (ctx.params ?? {}) as { self?: Entity; other?: Entity; otherRef?: string | number };
      if (typeof self !== 'number') return noSelf('sensorZone/enter');
      tintOnEnter(self, other, { color: HOT_COLOR, opacity: HOT_OPACITY });
      // ctx.emit binds the world; `otherRef` is the body's stable GUID, taken by the engine while
      // the body was alive. Never `entityRef(other)` here: on an exit the body may be despawned
      // and its index reused, so its handle can no longer name it (#1227). Verify via modoki_journal.
      ctx.emit('zone', { phase: 'enter', body: otherRef });
    } });
    registerUIAction('sensorZone/exit', { noControl: true, handler: (ctx) => {
      const { self, other, otherRef } = (ctx.params ?? {}) as { self?: Entity; other?: Entity; otherRef?: string | number };
      if (typeof self !== 'number') return noSelf('sensorZone/exit');
      restoreOnExit(self, other, BASE_FALLBACK);
      ctx.emit('zone', { phase: 'exit', body: otherRef });
    } });

    // The physics-free twin. The Trigger Zone entity carries NO RigidBody2D and NO
    // Collider2D — only `Zone2D` (the area, sized by its Transform scale) and `OnZone2D`
    // (the reaction). Anything tagged `ZoneOccupant` is tested for containment each
    // frame, so the Zone Probe trips it with nothing on the zone side to collide
    // against. Same declarative shape as the sensor pair above; `zoneTrigger` is a
    // distinct journal type so the two stations stay tellable apart in `modoki_journal`.
    // (The engine also emits its own `@zone` event for every crossing — this one is the
    // game's reaction, not the engine's record.)
    registerUIAction('triggerZone/enter', { noControl: true, handler: (ctx) => {
      const { self, other, otherRef } = (ctx.params ?? {}) as { self?: Entity; other?: Entity; otherRef?: string | number };
      if (typeof self !== 'number') return noSelf('triggerZone/enter');
      tintOnEnter(self, other, { color: ZONE_HOT_COLOR, opacity: ZONE_HOT_OPACITY });
      ctx.emit('zoneTrigger', { phase: 'enter', body: otherRef });
    } });
    registerUIAction('triggerZone/exit', { noControl: true, handler: (ctx) => {
      const { self, other, otherRef } = (ctx.params ?? {}) as { self?: Entity; other?: Entity; otherRef?: string | number };
      if (typeof self !== 'number') return noSelf('triggerZone/exit');
      restoreOnExit(self, other, ZONE_BASE_FALLBACK);
      ctx.emit('zoneTrigger', { phase: 'exit', body: otherRef });
    } });
  },
  unregisterSystems: () => {
    for (const a of ACTIONS) unregisterUIAction(a);
    unsubWorldSwap?.(); unsubWorldSwap = null;
    forgetSessionState();
  },
};
