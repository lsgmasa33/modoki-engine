/** 2D Physics Demo — a showcase project for the Rapier2D physics layer (gravity,
 *  restitution, colliders, revolute + spring joints, sensors). The only game code is
 *  a pair of UIActions wired to the Sensor Zone via its `OnCollision2D` trait, to
 *  demonstrate reacting to sensor detection (option B — declarative). Open via the
 *  editor's Open Project (MODOKI_PROJECT=demos/2d-physics-demo). */

import type { GameDefinition } from '@modoki/engine/runtime';
import type { Entity } from 'koota';
import { registerUIAction, unregisterUIAction, Renderable2D, entityRef } from '@modoki/engine/runtime';

const BASE_COLOR = 0xf1c40f, BASE_OPACITY = 0.25;   // idle: translucent yellow
const HOT_COLOR = 0x2ecc71, HOT_OPACITY = 0.5;      // occupied: brighter green

const ACTIONS = ['sensorZone/enter', 'sensorZone/exit'] as const;

export const game: GameDefinition = {
  id: '2d-physics-demo',
  name: '2D Physics Demo',
  description: 'Rapier2D showcase: falling bodies, bouncing, a pendulum, a spring, and a sensor zone.',
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
  },
  unregisterSystems: () => { for (const a of ACTIONS) unregisterUIAction(a); },
};
