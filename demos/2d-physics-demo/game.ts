/** 2D Physics Demo — a showcase project for the Rapier2D physics layer (gravity,
 *  restitution, colliders, revolute + spring joints, sensors). The only game code is
 *  two pairs of UIActions, wired declaratively to the two trigger stations via their
 *  `OnCollision2D` / `OnZone2D` traits, to demonstrate reacting to detection without
 *  imperative polling — one through a Rapier sensor, one through a physics-free
 *  `Zone2D`. Open via the editor's Open Project (MODOKI_PROJECT=demos/2d-physics-demo). */

import type { GameDefinition } from '@modoki/engine/runtime';
import type { Entity } from 'koota';
import { registerUIAction, unregisterUIAction, Renderable2D, entityRef } from '@modoki/engine/runtime';

const BASE_COLOR = 0xf1c40f, BASE_OPACITY = 0.25;   // Sensor Zone idle: translucent yellow
const HOT_COLOR = 0x2ecc71, HOT_OPACITY = 0.5;      // Sensor Zone occupied: brighter green

// The Trigger Zone gets its own palette so the two stations never read as one mechanism.
const ZONE_BASE_COLOR = 0x9b59b6, ZONE_BASE_OPACITY = 0.25;  // idle: translucent purple
const ZONE_HOT_COLOR = 0xd980fa, ZONE_HOT_OPACITY = 0.5;     // occupied: brighter violet

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
    // The Sensor Zone's OnCollision2D dispatches these; ctx.params.self is the zone,
    // ctx.target is the body that entered/left. We tint the zone + log to the journal
    // so the reaction is verifiable by data (modoki_journal), not just by eye.
    registerUIAction('sensorZone/enter', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable2D, { color: HOT_COLOR, opacity: HOT_OPACITY });
      // ctx.emit binds the world; entityRef() converts the body to its stable GUID
      // (id() would churn across hot-reloads). Verifiable via modoki_journal.
      ctx.emit('zone', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('sensorZone/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable2D, { color: BASE_COLOR, opacity: BASE_OPACITY });
      ctx.emit('zone', { phase: 'exit', body: other ? entityRef(other) : undefined });
    });

    // The physics-free twin. The Trigger Zone entity carries NO RigidBody2D and NO
    // Collider2D — only `Zone2D` (the area, sized by its Transform scale) and `OnZone2D`
    // (the reaction). Anything tagged `ZoneOccupant` is tested for containment each
    // frame, so the Zone Probe trips it with nothing on the zone side to collide
    // against. Same declarative shape as the sensor pair above; `zoneTrigger` is a
    // distinct journal type so the two stations stay tellable apart in `modoki_journal`.
    // (The engine also emits its own `@zone` event for every crossing — this one is the
    // game's reaction, not the engine's record.)
    registerUIAction('triggerZone/enter', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable2D, { color: ZONE_HOT_COLOR, opacity: ZONE_HOT_OPACITY });
      ctx.emit('zoneTrigger', { phase: 'enter', body: other ? entityRef(other) : undefined });
    });
    registerUIAction('triggerZone/exit', (ctx) => {
      const { self, other } = (ctx.params ?? {}) as { self?: Entity; other?: Entity };
      self?.set(Renderable2D, { color: ZONE_BASE_COLOR, opacity: ZONE_BASE_OPACITY });
      ctx.emit('zoneTrigger', { phase: 'exit', body: other ? entityRef(other) : undefined });
    });
  },
  unregisterSystems: () => { for (const a of ACTIONS) unregisterUIAction(a); },
};
