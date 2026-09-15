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
import { emit, entityRef } from '../core/journal';
import { dispatchGameAction } from '../core/actionRegistry';
import { Transform } from '../core/traits/Transform';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { worldTransforms } from '../core/ecs/transformPropagationSystem';
import { getWorldTransform3D, type WorldTransform3D } from '../core/ecs/worldTransform';
import { packedOf, type PackedEntity } from '../core/ecs/entityTable';
import type { ZoneEventBus, ZonePhase, ZoneRefs } from './zoneEventBus';

/** Fire the declarative `OnZone` action on the ZONE for one enter/exit. `refs` are both entities'
 *  journal refs as last seen ALIVE — the only identity a despawn-synthesized exit still has (#1227). */
export type FireOnZone = (zone: Entity, other: Entity, phase: ZonePhase, refs: ZoneRefs) => void;

/** A zone resolved for this frame: its entity + a containment predicate over an occupant's
 *  WORLD position, with the zone's own world pose (centre/rotation/scale) already baked in. */
export interface ZoneCandidate { entity: Entity; contains: (x: number, y: number, z: number) => boolean }
/** An occupant sampled for this frame: its entity + copied world position (safe to retain — the
 *  caller copies out of `readWorldTRS`'s shared singleton before the next read). */
export interface OccupantSample { entity: Entity; x: number; y: number; z: number }

/** Build the declarative `OnZone` dispatcher for a given trait (`OnZone2D`/`OnZone3D`). The
 *  action lives on the ZONE ("when something enters THIS zone, do X"): dispatched with the
 *  OTHER (occupant) as `ctx.target` and `{ self: zone, other, phase, selfRef, otherRef }` in
 *  `ctx.params`. On an exit `other` may be DEAD, and its index already reclaimed: `otherRef` is the
 *  ref it had while alive, and `entityRef(other)` answers `null` rather than name the newcomer (#1227).
 *  Pipeline-safe: `dispatchGameAction` never throws on an unwired name; a despawned zone (a
 *  synthesized exit) is guarded by `isAlive()`. */
export function makeFireOnZone(OnZoneTrait: Parameters<Entity['has']>[0]): FireOnZone {
  return (zone, other, phase, refs) => {
    if (!zone.isAlive() || !zone.has(OnZoneTrait)) return;
    const r = zone.get(OnZoneTrait) as { onEnter: string; onExit: string };
    const name = phase === 'enter' ? r.onEnter : r.onExit;
    if (!name) return;
    dispatchGameAction(name, { target: other, params: { self: zone, other, phase, selfRef: refs.zone, otherRef: refs.other } });
  };
}

/** One member of `ZoneState` — the live handle PLUS its journal ref, cached at the moment this
 *  entry was first recorded (when the entity was known alive, sampled fresh from this frame's
 *  query) and refreshed by every live `refOf`. The cache is what `refOf` returns once the handle
 *  may have gone dead AND had its index reclaimed by an unrelated entity — see `refOf`. */
interface ZoneMember { entity: Entity; ref: string | number }

/** Stable Percept/journal reference for a zone-state member: its GUID when the handle is STILL
 *  alive (`entityRef` does its own live-handle probe — `has()`/`get()`), else the ref CACHED on
 *  the member. Mirrors `physicsContactEvents.refOf` exactly, and for the same reason
 *  (QA-ZONE-0003, review follow-up): koota's `has()`/`get()` do not check generation, only
 *  `isAlive()` does — so calling `entityRef(deadHandle)` on a handle whose index has been
 *  RECLAIMED by a new entity silently resolves to the NEW entity's guid/name, misattributing the
 *  exit. Reproduced live: a same-tick despawn+respawn produced a `@zone` journal entry with the
 *  zone/other roles inverted, both naming entities that were still alive — the exit belonged to
 *  the DEAD pair, not to them. The cached ref avoids re-deriving anything from the handle.
 *
 *  The cache used to be the numeric id, which split enter (guid) from despawn-exit (number) — for
 *  every code-spawned occupant once #1210 gave each one a runtime guid (#1225). */
function refOf(m: ZoneMember): string | number {
  if (m.entity.isAlive()) m.ref = entityRef(m.entity) ?? m.ref;
  return m.ref;
}

/** The member for `entity` in the next diff: last frame's member when the same (packed) entity
 *  was already tracked, so its cached ref carries over; otherwise a new one, its ref taken now
 *  while the entity is known alive. Only a first appearance pays for an `entityRef`. */
function memberFor(entity: Entity, prior: ZoneMember | undefined): ZoneMember {
  return prior ?? { entity, ref: entityRef(entity) ?? entity.id() }; // sampled this tick, so alive
}

/** Route ONE zone/occupant transition to all three sinks. Every sink gets the SAME refs, taken
 *  once through `refOf` (despawn-safe — see its own comment): the journal payload, and the `refs`
 *  handed to `bus`/`fire` beside the raw `Entity` handles. The handles may be dead on a synthesized
 *  exit (`makeFireOnZone` guards `zone.isAlive()` before dispatching); the refs never are (#1227). */
function routeZone(
  world: World, zone: ZoneMember, other: ZoneMember,
  phase: ZonePhase, bus: ZoneEventBus, fire: FireOnZone, journalType: string,
): void {
  const refs: ZoneRefs = { zone: refOf(zone), other: refOf(other) };
  emit(journalType, { zone: refs.zone, other: refs.other, phase }, world);
  bus.__emitZone(world, zone.entity, other.entity, phase, refs);
  fire(zone.entity, other.entity, phase, refs);
}

/** Per-world occupancy: which occupants were inside each zone last frame, keeping the zone +
 *  occupant `Entity` handles so a transition can still be routed after either despawns. Kept
 *  per CHANNEL ('2d' / '3d') so a scene running both dimensions doesn't have one system's diff
 *  clobber the other's membership (their zone ids share one world but live in separate maps).
 *
 *  KEYED BY THE PACKED ENTITY (`packedOf(entity)`, NOT `entity.id()`) —
 *  QA-ZONE-0003: this state persists ACROSS frames, and koota's `entity.id()` strips the
 *  generation (`Number.prototype.id` masks to `ENTITY_ID_MASK`), while `has()`/`get()` do the
 *  same — only `isAlive()` checks generation. A despawn immediately followed by a respawn that
 *  reclaims the same index (a scene hot-reload, or Play→Stop→Play) then collides in an
 *  `.id()`-keyed map: `prev`/`next` share the stripped key, so the diff goes BLIND (no exit for
 *  the dead pair, no enter for the new one) — measured live, reproducibly, with a same-frame
 *  teardown+rebuild. The packed entity number carries the generation, so a reclaimed index is a
 *  genuinely different key and the diff sees a real exit + a real enter. The `PackedEntity` brand
 *  makes an `.id()` key a type error here; the shared rule is in `core/ecs/entityTable.ts` (#868). */
type ZoneState = Map<PackedEntity, { member: ZoneMember; occ: Map<PackedEntity, ZoneMember> }>;
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
    const zid = packedOf(z.entity); // generation-carrying — see ZoneState's doc comment
    const before = prev.get(zid);
    const occ = new Map<PackedEntity, ZoneMember>();
    for (const o of occupants) {
      const oid = packedOf(o.entity);
      if (oid === zid) continue;
      // The ref is cached HERE, while `o.entity` is known alive (freshly sampled this tick) — see
      // `refOf`'s comment for why it must never be re-derived from the handle later.
      if (z.contains(o.x, o.y, o.z)) occ.set(oid, memberFor(o.entity, before?.occ.get(oid)));
    }
    next.set(zid, { member: memberFor(z.entity, before?.member), occ });
  }

  // Enters — in `next` but not `prev`.
  for (const [zid, cur] of next) {
    const before = prev.get(zid);
    for (const [oid, oMember] of cur.occ) {
      if (before && before.occ.has(oid)) continue;
      routeZone(world, cur.member, oMember, 'enter', bus, fire, journalType);
    }
  }
  // Exits — in `prev` but not `next`. Covers occupant-left, occupant-despawn, AND zone-despawn
  // (a removed zone is absent from `next`, so every prior occupant of it exits).
  for (const [zid, before] of prev) {
    const cur = next.get(zid);
    for (const [oid, oMember] of before.occ) {
      if (cur && cur.occ.has(oid)) continue;
      routeZone(world, before.member, oMember, 'exit', bus, fire, journalType);
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
