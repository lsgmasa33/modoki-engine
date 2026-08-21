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
import { registerUIAction, unregisterUIAction, Renderable3DPrimitive, entityRef, onWorldSwap } from '@modoki/engine/runtime';

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
const authoredColor = new Map<number, number>();
const insiders = new Map<number, Set<number>>();
const NO_OCCUPANT = -1;   // an enter/exit that arrived without an `other` (never seen; be safe)

// ⚠️ This state belongs to ONE play session and must not outlive its world. Stop reverts by
// building a brand-new koota World, and `entity.id()` is a per-world SLOT INDEX that restarts
// at 0 — so the next session hands the same ids to the same entities. Left uncleared, session
// 2's first enter would find session 1's entry, skip re-reading the authored colour, and later
// restore a STALE one: the very shadowing bug this code exists to prevent, laundered through a
// cache instead of a constant. `onWorldSwap` fires on exactly that swap.
let unsubWorldSwap: (() => void) | null = null;
function forgetSessionState(): void { authoredColor.clear(); insiders.clear(); }

function tintOnEnter(self: Entity | undefined, other: Entity | undefined, hot: number): void {
  if (!self) return;
  const id = self.id();
  let inside = insiders.get(id);
  if (!inside) { inside = new Set(); insiders.set(id, inside); }
  if (inside.size === 0) authoredColor.set(id, (self.get(Renderable3DPrimitive) as { color: number }).color);
  inside.add(other ? other.id() : NO_OCCUPANT);
  self.set(Renderable3DPrimitive, { color: hot });
}

function restoreOnExit(self: Entity | undefined, other: Entity | undefined, fallback: number): void {
  if (!self) return;
  const id = self.id();
  const inside = insiders.get(id);
  inside?.delete(other ? other.id() : NO_OCCUPANT);
  if (inside && inside.size > 0) return;   // someone else is still inside
  insiders.delete(id);
  // A zone removed while occupied fires an exit for each occupant, so `self` can be dead here.
  if (self.isAlive()) self.set(Renderable3DPrimitive, { color: authoredColor.get(id) ?? fallback });
  authoredColor.delete(id);
}

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
      tintOnEnter(self, other, HOT_COLOR);
      // ctx.emit binds the world; entityRef() converts the body to its stable GUID
      // (id() would churn across hot-reloads). Verifiable via modoki_journal.
      ctx.emit('zone', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('sensorZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
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
      tintOnEnter(self, other, ZONE_HOT_COLOR);
      ctx.emit('zoneTrigger', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('triggerZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
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
