/** physicsEventBus — the shared factory behind the 2D and 3D collision/sensor EVENT BUSES
 *  (option C). A physics reconciler is the single producer: after each fixed step it drains
 *  Rapier's contact/sensor events and calls the `__emit*` methods. Game code is the consumer:
 *  it `onSensorEnter(...)` / `onCollision(...)` to react with arbitrary state — the imperative
 *  counterpart to the declarative `OnCollision2D`/`OnCollision3D` traits (option B).
 *
 *  The bus is entirely dimension-agnostic (it only touches koota `Entity`/`World` + `Set`
 *  subscribers — no Vec/shape/axis math), so 2D and 3D share ONE implementation via this
 *  factory. Two SEPARATE instances are still created (Physics2DEvents / Physics3DEvents),
 *  because a single koota world can carry both 2D and 3D bodies and their subscriber sets
 *  must not be conflated.
 *
 *  WORLD-SCOPED subscribers (WeakMap<World>, like the journal): the editor's dual viewports /
 *  parallel test worlds keep separate subscriber sets, and a dead world's subscribers GC on
 *  their own. The manager is registered SCENE-SCOPED so its `dispose` also clears the old
 *  world's subscribers deterministically, just before that world dies on a scene swap.
 *
 *  Every callback receives real koota `Entity` handles. Events fire only while the sim is
 *  running (the producer gates its drain on `dt > 0`). */

import type { Entity, World } from 'koota';
import { getCurrentWorld } from '../ecs/world';
import type { ManagerDef } from './managerRegistry';

export type CollisionPhase = 'enter' | 'exit';
/** `(sensor, other, phase)` — `sensor` is the entity whose collider `isSensor`. */
export type SensorHandler = (sensor: Entity, other: Entity, phase: CollisionPhase) => void;
/** `(a, b, phase)` — a solid (non-sensor) contact between two colliders. */
export type CollisionHandler = (a: Entity, b: Entity, phase: CollisionPhase) => void;

/** Rich contact info fired ONCE when two solid colliders begin touching (the impact moment).
 *  `point`/`normal` are world-space (arrays: [x,y] in 2D, [x,y,z] in 3D); `speed` is the relative
 *  approach speed along the normal (world units/s) — use it for damage / SFX volume / effects. */
export interface ContactDetail { point: readonly number[]; normal: readonly number[]; speed: number }
/** `(a, b, detail)` — a solid contact beginning, with its point/normal/impact speed. */
export type ContactHandler = (a: Entity, b: Entity, detail: ContactDetail) => void;

interface Subs {
  sensor: Set<SensorHandler>;
  collision: Set<CollisionHandler>;
  contact: Set<ContactHandler>;
}

/** The consumer + producer surface of a physics event bus. */
export interface PhysicsEventBus {
  onSensor(cb: SensorHandler, world?: World): () => void;
  onSensorEnter(cb: (sensor: Entity, other: Entity) => void, world?: World): () => void;
  onSensorExit(cb: (sensor: Entity, other: Entity) => void, world?: World): () => void;
  onCollision(cb: CollisionHandler, world?: World): () => void;
  onCollisionEnter(cb: (a: Entity, b: Entity) => void, world?: World): () => void;
  onCollisionExit(cb: (a: Entity, b: Entity) => void, world?: World): () => void;
  /** Fires ONCE when two solid colliders begin touching, with point/normal/impact speed. */
  onContact(cb: ContactHandler, world?: World): () => void;
  /** Producer-only: called by the physics reconciler. Not for game code. */
  __emitSensor(world: World, sensor: Entity, other: Entity, phase: CollisionPhase): void;
  /** Producer-only: called by the physics reconciler. Not for game code. */
  __emitCollision(world: World, a: Entity, b: Entity, phase: CollisionPhase): void;
  /** Producer-only: called by the physics reconciler on a contact begin. Not for game code. */
  __emitContact(world: World, a: Entity, b: Entity, detail: ContactDetail): void;
  /** Drop every subscriber for a world (manager dispose on scene swap; also for tests). */
  __clear(world: World): void;
}

/** Wrap a phase-agnostic handler so it only fires for one phase (enter/exit). */
function phaseFilter<A, B>(want: CollisionPhase, cb: (a: A, b: B) => void) {
  return (a: A, b: B, phase: CollisionPhase) => { if (phase === want) cb(a, b); };
}

/** Build a physics event bus + its scene-scoped manager. `managerName` is the ManagerDef name
 *  (e.g. 'Physics2DEvents'); `logTag` prefixes handler-threw warnings (e.g. 'physics2DEvents'). */
export function createPhysicsEventBus(managerName: string, logTag: string): { events: PhysicsEventBus; manager: ManagerDef } {
  const subsByWorld = new WeakMap<World, Subs>();
  const subsFor = (world: World): Subs => {
    let s = subsByWorld.get(world);
    if (!s) { s = { sensor: new Set(), collision: new Set(), contact: new Set() }; subsByWorld.set(world, s); }
    return s;
  };

  const events: PhysicsEventBus = {
    onSensor(cb, world = getCurrentWorld()) {
      const s = subsFor(world).sensor; s.add(cb);
      return () => s.delete(cb);
    },
    onSensorEnter(cb, world = getCurrentWorld()) { return events.onSensor(phaseFilter('enter', cb), world); },
    onSensorExit(cb, world = getCurrentWorld()) { return events.onSensor(phaseFilter('exit', cb), world); },
    onCollision(cb, world = getCurrentWorld()) {
      const s = subsFor(world).collision; s.add(cb);
      return () => s.delete(cb);
    },
    onCollisionEnter(cb, world = getCurrentWorld()) { return events.onCollision(phaseFilter('enter', cb), world); },
    onCollisionExit(cb, world = getCurrentWorld()) { return events.onCollision(phaseFilter('exit', cb), world); },
    onContact(cb, world = getCurrentWorld()) {
      const s = subsFor(world).contact; s.add(cb);
      return () => s.delete(cb);
    },

    __emitSensor(world, sensor, other, phase) {
      const s = subsByWorld.get(world);
      if (!s || s.sensor.size === 0) return;
      for (const cb of s.sensor) { try { cb(sensor, other, phase); } catch (e) { console.warn(`[${logTag}] sensor handler threw`, e); } }
    },
    __emitCollision(world, a, b, phase) {
      const s = subsByWorld.get(world);
      if (!s || s.collision.size === 0) return;
      for (const cb of s.collision) { try { cb(a, b, phase); } catch (e) { console.warn(`[${logTag}] collision handler threw`, e); } }
    },
    __emitContact(world, a, b, detail) {
      const s = subsByWorld.get(world);
      if (!s || s.contact.size === 0) return;
      for (const cb of s.contact) { try { cb(a, b, detail); } catch (e) { console.warn(`[${logTag}] contact handler threw`, e); } }
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
