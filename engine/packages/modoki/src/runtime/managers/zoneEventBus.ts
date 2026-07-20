/** zoneEventBus — the shared factory behind the 2D and 3D Zone trigger EVENT BUSES, the
 *  imperative counterpart to the declarative `OnZone2D`/`OnZone3D` traits. A zone-trigger
 *  system (`zone2DSystem`/`zone3DSystem`) is the single producer: each frame it diffs which
 *  `ZoneOccupant` entities are inside each `Zone2D`/`Zone3D` volume and calls `__emitZone` on
 *  enter/exit. Game code is the consumer: it `onZoneEnter(...)` / `onZoneExit(...)` to react
 *  with arbitrary state — the physics-free analog of the `physicsEventBus` sensor bus.
 *
 *  The bus is dimension-agnostic (only koota `Entity`/`World` + `Set` subscribers, no vec/shape
 *  math), so 2D and 3D share ONE implementation via this factory. Two SEPARATE instances are
 *  still created (Zone2DEvents / Zone3DEvents), because one koota world can carry both 2D and 3D
 *  zones and their subscriber sets must not be conflated.
 *
 *  WORLD-SCOPED subscribers (WeakMap<World>, like the journal + physics bus): the editor's dual
 *  viewports / parallel test worlds keep separate subscriber sets, and a dead world's subscribers
 *  GC on their own. The manager is registered SCENE-SCOPED so its `dispose` also clears the old
 *  world's subscribers deterministically, just before that world dies on a scene swap.
 *
 *  Every callback receives real koota `Entity` handles. Events fire only while the sim is
 *  running (the producer gates its diff on `isSimRunning()`). */

import type { Entity, World } from 'koota';
import { getCurrentWorld } from '../ecs/world';
import type { ManagerDef } from './managerRegistry';

export type ZonePhase = 'enter' | 'exit';
/** `(zone, other, phase)` — `zone` is the `Zone2D`/`Zone3D` entity, `other` the `ZoneOccupant`. */
export type ZoneHandler = (zone: Entity, other: Entity, phase: ZonePhase) => void;

/** The consumer + producer surface of a zone event bus. */
export interface ZoneEventBus {
  onZone(cb: ZoneHandler, world?: World): () => void;
  onZoneEnter(cb: (zone: Entity, other: Entity) => void, world?: World): () => void;
  onZoneExit(cb: (zone: Entity, other: Entity) => void, world?: World): () => void;
  /** Producer-only: called by the zone-trigger system. Not for game code. */
  __emitZone(world: World, zone: Entity, other: Entity, phase: ZonePhase): void;
  /** Drop every subscriber for a world (manager dispose on scene swap; also for tests). */
  __clear(world: World): void;
}

/** Wrap a phase-agnostic handler so it only fires for one phase (enter/exit). */
function phaseFilter(want: ZonePhase, cb: (zone: Entity, other: Entity) => void) {
  return (zone: Entity, other: Entity, phase: ZonePhase) => { if (phase === want) cb(zone, other); };
}

/** Build a zone event bus + its scene-scoped manager. `managerName` is the ManagerDef name
 *  (e.g. 'Zone2DEvents'); `logTag` prefixes handler-threw warnings (e.g. 'zone2DEvents'). */
export function createZoneEventBus(managerName: string, logTag: string): { events: ZoneEventBus; manager: ManagerDef } {
  const subsByWorld = new WeakMap<World, Set<ZoneHandler>>();
  const subsFor = (world: World): Set<ZoneHandler> => {
    let s = subsByWorld.get(world);
    if (!s) { s = new Set(); subsByWorld.set(world, s); }
    return s;
  };

  const events: ZoneEventBus = {
    onZone(cb, world = getCurrentWorld()) {
      const s = subsFor(world); s.add(cb);
      return () => s.delete(cb);
    },
    onZoneEnter(cb, world = getCurrentWorld()) { return events.onZone(phaseFilter('enter', cb), world); },
    onZoneExit(cb, world = getCurrentWorld()) { return events.onZone(phaseFilter('exit', cb), world); },

    __emitZone(world, zone, other, phase) {
      const s = subsByWorld.get(world);
      if (!s || s.size === 0) return;
      for (const cb of s) { try { cb(zone, other, phase); } catch (e) { console.warn(`[${logTag}] zone handler threw`, e); } }
    },
    __clear(world) { subsByWorld.delete(world); },
  };

  const manager: ManagerDef = {
    name: managerName,
    scope: 'scene',
    dispose(ctx) { if (ctx?.world) events.__clear(ctx.world); },
  };

  return { events, manager };
}
