/** 3D Physics Demo — a showcase project for the Rapier3D physics layer (Phase 1):
 *  gravity, restitution/bounce, rolling, a stacked tower, every primitive collider
 *  (box/sphere/capsule/cylinder/cone), a tilted static ramp (Euler→quaternion), and a
 *  sensor trigger zone. The only game code is a pair of UIActions wired to the Sensor
 *  Zone via its `OnCollision3D` trait, to demonstrate reacting to sensor detection
 *  (option B — declarative). Open via the editor's Open Project
 *  (MODOKI_PROJECT=games/3d-physics-demo). */

import type { GameDefinition } from '@modoki/engine/runtime';
import type { Entity } from 'koota';
import { registerUIAction, unregisterUIAction, Renderable3DPrimitive, entityRef } from '@modoki/engine/runtime';

const BASE_COLOR = 0x1abc9c;   // idle: teal
const HOT_COLOR = 0x2ecc71;    // occupied: brighter green

const ACTIONS = ['sensorZone3D/enter', 'sensorZone3D/exit'] as const;

export const game: GameDefinition = {
  id: '3d-physics-demo',
  name: '3D Physics Demo',
  description: 'Rapier3D showcase: falling & stacking bodies, a bouncing ball, a rolling ball on a ramp, every primitive collider, and a sensor zone.',
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
  },
  unregisterSystems: () => { for (const a of ACTIONS) unregisterUIAction(a); },
};
