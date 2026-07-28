/** Physics3DEvents — the 3D collision/sensor event bus. The physics reconciler
 *  (`physics3DSystem`) drains Rapier's contact/sensor events and calls the `__emit*` methods;
 *  game code subscribes via `onSensorEnter(...)` / `onCollision(...)`. Thin wrapper over the
 *  shared, dimension-agnostic `createPhysicsEventBus` factory (a separate instance from the 2D
 *  bus, so 2D and 3D contacts in the same world never conflate). See `physicsEventBus.ts`. */

import { createPhysicsEventBus } from './physicsEventBus';

export type {
  CollisionPhase as CollisionPhase3D,
  SensorHandler as SensorHandler3D,
  CollisionHandler as CollisionHandler3D,
  ContactDetail as ContactDetail3D,
  ContactHandler as ContactHandler3D,
} from './physicsEventBus';

const bus = createPhysicsEventBus('Physics3DEvents', 'physics3DEvents');
export const physics3DEvents = bus.events;
export const physics3DEventsManager = bus.manager;
