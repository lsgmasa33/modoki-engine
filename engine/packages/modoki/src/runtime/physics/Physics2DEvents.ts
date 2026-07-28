/** Physics2DEvents — the 2D collision/sensor event bus. The physics reconciler
 *  (`physics2DSystem`) drains Rapier's contact/sensor events and calls the `__emit*` methods;
 *  game code subscribes via `onSensorEnter(...)` / `onCollision(...)`. Thin wrapper over the
 *  shared, dimension-agnostic `createPhysicsEventBus` factory (a separate instance from the 3D
 *  bus, so 2D and 3D contacts in the same world never conflate). See `physicsEventBus.ts`. */

import { createPhysicsEventBus } from './physicsEventBus';

export type { CollisionPhase, SensorHandler, CollisionHandler } from './physicsEventBus';

const bus = createPhysicsEventBus('Physics2DEvents', 'physics2DEvents');
export const physics2DEvents = bus.events;
export const physics2DEventsManager = bus.manager;
