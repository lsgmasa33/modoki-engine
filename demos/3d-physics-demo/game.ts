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
import { registerUIAction, unregisterUIAction, Renderable3DPrimitive, entityRef } from '@modoki/engine/runtime';

const BASE_COLOR = 0x1abc9c;   // Sensor Zone idle: teal
const HOT_COLOR = 0x2ecc71;    // Sensor Zone occupied: brighter green

// The Trigger Zone gets its own palette so the two stations never read as one mechanism.
const ZONE_BASE_COLOR = 0x9b59b6;  // Trigger Zone idle: purple
const ZONE_HOT_COLOR = 0xd980fa;   // Trigger Zone occupied: brighter violet

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
    // The Sensor Zone's OnCollision3D dispatches these; ctx.params.self is the zone,
    // ctx.target is the body that entered/left. We tint the zone + log to the journal
    // so the reaction is verifiable by data (modoki_journal), not just by eye.
    registerUIAction('sensorZone3D/enter', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable3DPrimitive, { color: HOT_COLOR });
      // ctx.emit binds the world; entityRef() converts the body to its stable GUID
      // (id() would churn across hot-reloads). Verifiable via modoki_journal.
      ctx.emit('zone', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('sensorZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable3DPrimitive, { color: BASE_COLOR });
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
      self?.set(Renderable3DPrimitive, { color: ZONE_HOT_COLOR });
      ctx.emit('zoneTrigger', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('triggerZone3D/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable3DPrimitive, { color: ZONE_BASE_COLOR });
      ctx.emit('zoneTrigger', { phase: 'exit', body: other ? entityRef(other) : undefined });
    });
  },
  unregisterSystems: () => { for (const a of ACTIONS) unregisterUIAction(a); },
};
