/** zoneTriggerCore — the shared enter/exit routing + occupancy bookkeeping for the 2D and 3D
 *  Zone trigger systems. Diffing which `ZoneOccupant` entities are inside each zone frame-to-
 *  frame, and fanning each enter/exit to the three sinks (tick-stamped journal + the code-
 *  subscriber bus + the declarative `OnZone` trait) is byte-identical across dimensions — the
 *  only difference is the containment TEST (a sphere in 3D vs a circle in 2D), which the caller
 *  injects per zone. Keeping the correctness-critical enter/exit balance in ONE place means a
 *  fix can't silently miss the other dimension — the same discipline as `physicsContactEvents`.
 *
 *  Unlike physics (which drains Rapier's event queue), a zone has no engine that reports overlap
 *  begin/end: this module reconstructs it by re-testing every (zone × occupant) pair each frame
 *  and diffing against the previous frame's membership. That diff is what makes despawns correct
 *  for free — a removed zone has no entry in the new membership, so ALL its prior occupants exit;
 *  a removed occupant simply fails every test, so it exits every zone it was in. */

import type { Entity, World } from 'koota';
import { emit, entityRef } from './journal';
import { dispatchGameAction } from '../ui/actionRegistry';
import { Transform } from '../traits/Transform';
import { EntityAttributes } from '../traits/EntityAttributes';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { getWorldTransform3D, type WorldTransform3D } from '../ecs/worldTransform';
import type { ZoneEventBus, ZonePhase } from '../managers/zoneEventBus';

/** Fire the declarative `OnZone` action on the ZONE for one enter/exit. */
export type FireOnZone = (zone: Entity, other: Entity, phase: ZonePhase) => void;

/** A zone resolved for this frame: its entity + a containment predicate over an occupant's
 *  WORLD position, with the zone's own world pose (centre/rotation/scale) already baked in. */
export interface ZoneCandidate { entity: Entity; contains: (x: number, y: number, z: number) => boolean }
/** An occupant sampled for this frame: its entity + copied world position (safe to retain — the
 *  caller copies out of `readWorldTRS`'s shared singleton before the next read). */
export interface OccupantSample { entity: Entity; x: number; y: number; z: number }

/** Build the declarative `OnZone` dispatcher for a given trait (`OnZone2D`/`OnZone3D`). The
 *  action lives on the ZONE ("when something enters THIS zone, do X"): dispatched with the
 *  OTHER (occupant) as `ctx.target` and `{ self: zone, other, phase }` in `ctx.params`.
 *  Pipeline-safe: `dispatchGameAction` never throws on an unwired name; a despawned zone (a
 *  synthesized exit) is guarded by `isAlive()`. */
export function makeFireOnZone(OnZoneTrait: Parameters<Entity['has']>[0]): FireOnZone {
  return (zone, other, phase) => {
    if (!zone.isAlive() || !zone.has(OnZoneTrait)) return;
    const r = zone.get(OnZoneTrait) as { onEnter: string; onExit: string };
    const name = phase === 'enter' ? r.onEnter : r.onExit;
    if (!name) return;
    dispatchGameAction(name, { target: other, params: { self: zone, other, phase } });
  };
}

/** Route ONE zone/occupant transition to all three sinks. The journal payload uses `entityRef`
 *  (stable GUID when the entity has one, else its numeric id) so a trace survives scene hot-
 *  reloads — `entityRef` is despawn-safe (a synthesized exit may hand it a dead handle). */
function routeZone(
  world: World, zone: Entity, other: Entity,
  phase: ZonePhase, bus: ZoneEventBus, fire: FireOnZone, journalType: string,
): void {
  emit(journalType, { zone: entityRef(zone), other: entityRef(other), phase }, world);
  bus.__emitZone(world, zone, other, phase);
  fire(zone, other, phase);
}

/** Per-world occupancy: which occupants were inside each zone last frame, keeping the zone +
 *  occupant `Entity` handles so a transition can still be routed after either despawns. Kept
 *  per CHANNEL ('2d' / '3d') so a scene running both dimensions doesn't have one system's diff
 *  clobber the other's membership (their zone ids share one world but live in separate maps). */
type ZoneState = Map<number, { entity: Entity; occ: Map<number, Entity> }>;
const stateByWorld = new WeakMap<World, Map<string, ZoneState>>();

function stateFor(world: World, channel: string): { all: Map<string, ZoneState>; state: ZoneState } {
  let all = stateByWorld.get(world);
  if (!all) { all = new Map(); stateByWorld.set(world, all); }
  let state = all.get(channel);
  if (!state) { state = new Map(); all.set(channel, state); }
  return { all, state };
}

/** Forget occupancy so the NEXT run re-fires `enter` for everything currently inside. Called by
 *  the trigger systems when the sim is not running (a fresh start-of-play baseline), and safe on
 *  teardown. Omit `channel` to clear ALL channels for the world. (A scene swap replaces the world,
 *  so its state GCs on its own.) */
export function clearZoneState(world: World, channel?: string): void {
  if (channel === undefined) { stateByWorld.delete(world); return; }
  stateByWorld.get(world)?.delete(channel);
}

/** Diff this frame's containment against last frame's and fan every transition to the sinks.
 *  `channel` namespaces the occupancy state ('2d' / '3d'); `journalType` is the semantic event
 *  type (e.g. `@zone`). Occupants equal to the zone entity are skipped (a zone tagged
 *  `ZoneOccupant` never triggers on itself). */
export function runZoneTriggers(
  world: World, channel: string, zones: readonly ZoneCandidate[], occupants: readonly OccupantSample[],
  bus: ZoneEventBus, fire: FireOnZone, journalType: string,
): void {
  const { all, state: prev } = stateFor(world, channel);

  const next: ZoneState = new Map();
  for (const z of zones) {
    const zid = z.entity.id();
    const occ = new Map<number, Entity>();
    for (const o of occupants) {
      const oid = o.entity.id();
      if (oid === zid) continue;
      if (z.contains(o.x, o.y, o.z)) occ.set(oid, o.entity);
    }
    next.set(zid, { entity: z.entity, occ });
  }

  // Enters — in `next` but not `prev`.
  for (const [zid, cur] of next) {
    const before = prev.get(zid);
    for (const [oid, oEnt] of cur.occ) {
      if (before && before.occ.has(oid)) continue;
      routeZone(world, cur.entity, oEnt, 'enter', bus, fire, journalType);
    }
  }
  // Exits — in `prev` but not `next`. Covers occupant-left, occupant-despawn, AND zone-despawn
  // (a removed zone is absent from `next`, so every prior occupant of it exits).
  for (const [zid, before] of prev) {
    const cur = next.get(zid);
    for (const [oid, oEnt] of before.occ) {
      if (cur && cur.occ.has(oid)) continue;
      routeZone(world, before.entity, oEnt, 'exit', bus, fire, journalType);
    }
  }

  all.set(channel, next);
}

/** Read an entity's WORLD transform, cache-first (the pre-computed `worldTransforms` map, O(1)),
 *  falling back to the entity's LOCAL Transform for a root on a cache miss, then to an on-demand
 *  compose for a PARENTED entity (headless / no pre-pass). Symmetric with physics' `worldPoseOf`.
 *  Returns a SHARED singleton — read/copy its fields immediately, before the next call. */
const _pose: WorldTransform3D = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
export function readWorldTRS(entity: Entity): WorldTransform3D {
  const id = entity.id();
  const w = worldTransforms.get(id);
  if (w) {
    _pose.x = w.x; _pose.y = w.y; _pose.z = w.z;
    _pose.rx = w.rx; _pose.ry = w.ry; _pose.rz = w.rz;
    _pose.sx = w.sx; _pose.sy = w.sy; _pose.sz = w.sz;
    return _pose;
  }
  const parentId = entity.has(EntityAttributes) ? ((entity.get(EntityAttributes) as { parentId?: number } | undefined)?.parentId ?? 0) : 0;
  if (!parentId) {
    const tf = entity.get(Transform) as WorldTransform3D | undefined;
    if (tf) {
      _pose.x = tf.x; _pose.y = tf.y; _pose.z = tf.z;
      _pose.rx = tf.rx; _pose.ry = tf.ry; _pose.rz = tf.rz;
      _pose.sx = tf.sx; _pose.sy = tf.sy; _pose.sz = tf.sz;
      return _pose;
    }
  }
  return getWorldTransform3D(id);
}
