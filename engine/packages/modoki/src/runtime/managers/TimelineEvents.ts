/** TimelineEvents — the Director sequence enter/marker/exit event bus. The timeline reconciler
 *  (`timelineSystem`) advances every Director playhead each frame and calls `__emitStart` /
 *  `__emitMarker` / `__emitEnd`; game code subscribes via `onSequenceStart(...)` / `onMarker(...)`
 *  / `onSequenceEnd(...)`. Thin wrapper over the `createTimelineEventBus` factory. See
 *  `timelineEventBus.ts`. */

import { createTimelineEventBus } from './timelineEventBus';

export type { SequenceStartHandler, SequenceEndHandler, SequenceMarkerHandler } from './timelineEventBus';

const bus = createTimelineEventBus('TimelineEvents', 'timelineEvents');
export const timelineEvents = bus.events;
export const timelineEventsManager = bus.manager;
