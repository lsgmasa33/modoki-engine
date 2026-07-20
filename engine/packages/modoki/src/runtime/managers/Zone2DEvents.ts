/** Zone2DEvents — the 2D `Zone2D` enter/exit event bus. The zone-trigger reconciler
 *  (`zone2DSystem`) diffs `ZoneOccupant` containment each frame and calls `__emitZone`; game
 *  code subscribes via `onZoneEnter(...)` / `onZoneExit(...)`. Thin wrapper over the shared,
 *  dimension-agnostic `createZoneEventBus` factory (a separate instance from the 3D bus, so 2D
 *  and 3D zones in the same world never conflate). See `zoneEventBus.ts`. */

import { createZoneEventBus } from './zoneEventBus';

const bus = createZoneEventBus('Zone2DEvents', 'zone2DEvents');
export const zone2DEvents = bus.events;
export const zone2DEventsManager = bus.manager;
