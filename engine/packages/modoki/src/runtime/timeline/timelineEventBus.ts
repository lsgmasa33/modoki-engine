/** timelineEventBus — the Director sequence EVENT BUS, the imperative counterpart to the
 *  declarative `OnSequence` trait. The `timelineSystem` is the single producer: each frame it
 *  advances every `Director` playhead and calls `__emitStart` / `__emitMarker` / `__emitEnd` as
 *  sequences start, cross a signal marker, and reach their end. Game code is the consumer: it
 *  `onSequenceStart(...)` / `onMarker(...)` / `onSequenceEnd(...)` to react with arbitrary state.
 *
 *  WORLD-SCOPED subscribers (WeakMap<World>, like the journal + zone/physics buses): the editor's
 *  dual viewports / parallel test worlds keep separate subscriber sets, and a dead world's
 *  subscribers GC on their own. The manager is registered SCENE-SCOPED so its `dispose` also
 *  clears the old world's subscribers deterministically, just before that world dies on a scene
 *  swap. Every callback receives a real koota `Entity` handle (the Director). Events fire only
 *  while the sim is running (the producer advances on `getSimDelta`, which is 0 when stopped). */

import type { Entity, World } from 'koota';
import { getCurrentWorld } from '../core/ecs/world';
import type { ManagerDef } from '../core/managerTypes';
import { notifyListeners } from '../core/notifyListeners';

export type SequenceStartHandler = (director: Entity) => void;
export type SequenceEndHandler = (director: Entity) => void;
export type SequenceMarkerHandler = (director: Entity, action: string, t: number) => void;

/** The consumer + producer surface of the timeline event bus. */
export interface TimelineEventBus {
  onSequenceStart(cb: SequenceStartHandler, world?: World): () => void;
  onSequenceEnd(cb: SequenceEndHandler, world?: World): () => void;
  onMarker(cb: SequenceMarkerHandler, world?: World): () => void;
  /** Producer-only: called by the timeline system. Not for game code. */
  __emitStart(world: World, director: Entity): void;
  __emitEnd(world: World, director: Entity): void;
  __emitMarker(world: World, director: Entity, action: string, t: number): void;
  /** Drop every subscriber for a world (manager dispose on scene swap; also for tests). */
  __clear(world: World): void;
}

/** Build the timeline event bus + its scene-scoped manager. `logTag` names the bus in the report
 *  when a handler throws. That report is `notifyListeners`' `console.error`: a game handler that
 *  throws spends the crash budget like any other listener defect (owner ruling on #953). */
export function createTimelineEventBus(managerName: string, logTag: string): { events: TimelineEventBus; manager: ManagerDef } {
  const startLabel = `${logTag}:start`;
  const endLabel = `${logTag}:end`;
  const markerLabel = `${logTag}:marker`;
  const startsByWorld = new WeakMap<World, Set<SequenceStartHandler>>();
  const endsByWorld = new WeakMap<World, Set<SequenceEndHandler>>();
  const markersByWorld = new WeakMap<World, Set<SequenceMarkerHandler>>();

  const setFor = <T>(map: WeakMap<World, Set<T>>, world: World): Set<T> => {
    let s = map.get(world);
    if (!s) { s = new Set(); map.set(world, s); }
    return s;
  };

  const events: TimelineEventBus = {
    onSequenceStart(cb, world = getCurrentWorld()) { const s = setFor(startsByWorld, world); s.add(cb); return () => s.delete(cb); },
    onSequenceEnd(cb, world = getCurrentWorld()) { const s = setFor(endsByWorld, world); s.add(cb); return () => s.delete(cb); },
    onMarker(cb, world = getCurrentWorld()) { const s = setFor(markersByWorld, world); s.add(cb); return () => s.delete(cb); },

    __emitStart(world, director) {
      const s = startsByWorld.get(world);
      if (!s || s.size === 0) return;
      notifyListeners(s, startLabel, [director]);
    },
    __emitEnd(world, director) {
      const s = endsByWorld.get(world);
      if (!s || s.size === 0) return;
      notifyListeners(s, endLabel, [director]);
    },
    __emitMarker(world, director, action, t) {
      const s = markersByWorld.get(world);
      if (!s || s.size === 0) return;
      notifyListeners(s, markerLabel, [director, action, t]);
    },
    __clear(world) { startsByWorld.delete(world); endsByWorld.delete(world); markersByWorld.delete(world); },
  };

  const manager: ManagerDef = {
    name: managerName,
    scope: 'scene',
    dispose(ctx) { if (ctx?.world) events.__clear(ctx.world); },
  };

  return { events, manager };
}
