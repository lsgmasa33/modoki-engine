/** Zone3DEvents — the 3D `Zone3D` enter/exit event bus. The zone-trigger reconciler
 *  (`zone3DSystem`) diffs `ZoneOccupant` containment each frame and calls `__emitZone`; game
 *  code subscribes via `onZoneEnter(...)` / `onZoneExit(...)`. Thin wrapper over the shared,
 *  dimension-agnostic `createZoneEventBus` factory (a separate instance from the 2D bus, so 2D
 *  and 3D zones in the same world never conflate). See `zoneEventBus.ts`. */

import { createZoneEventBus } from './zoneEventBus';

export type { ZonePhase, ZoneHandler } from './zoneEventBus';

const bus = createZoneEventBus('Zone3DEvents', 'zone3DEvents');
export const zone3DEvents = bus.events;
export const zone3DEventsManager = bus.manager;
