/** physicsContactEvents — the shared collision/sensor event routing for the 2D and 3D physics
 *  systems. Draining Rapier's event queue, synthesizing exits on collider removal, and fanning
 *  each pair to the three sinks (tick-stamped journal + the code-subscriber bus + the declarative
 *  OnCollision trait) is byte-identical across dimensions — the only differences are WHICH event
 *  bus + WHICH OnCollision trait, both injected. Keeping this correctness-critical path (the H1
 *  enter/exit balance) in ONE place means a fix can't silently miss the other dimension.
 *
 *  Structural over the Rapier types: `narrowPhase`/`eventQueue` have the same handle-based
 *  method signatures in Rapier 2D and 3D, so a minimal interface accepts either. */

import type { Entity, World } from 'koota';
import { emit, entityRef } from './journal';
import { dispatchGameAction } from '../ui/actionRegistry';
import type { PhysicsEventBus } from '../managers/physicsEventBus';
import { updateContactIndex } from './physicsContactIndex';

/** The collider→entity reverse-map value both systems keep (keyed by Rapier collider handle). */
export interface ColliderInfo { entityId: number; entity: Entity; isSensor: boolean; bodyEntityId: number }
export type ColliderMap = Map<number, ColliderInfo>;
export type FireOnCollision = (self: Entity, other: Entity, phase: 'enter' | 'exit') => void;

interface NarrowPhaseLike {
  contactPairsWith(collider: number, f: (other: number) => void): void;
  intersectionPairsWith(collider: number, f: (other: number) => void): void;
}
interface EventQueueLike {
  drainCollisionEvents(f: (h1: number, h2: number, started: boolean) => void): void;
}

/** Build the declarative `OnCollision` dispatcher for a given trait (`OnCollision2D`/`3D`).
 *  Pipeline-safe: `dispatchGameAction` never throws on an unwired action name; `self` may be
 *  despawned (a synthesized exit), so guard `isAlive()`. */
export function makeFireOnCollision(OnCollisionTrait: Parameters<Entity['has']>[0]): FireOnCollision {
  return (self, other, phase) => {
    if (!self.isAlive() || !self.has(OnCollisionTrait)) return;
    const r = self.get(OnCollisionTrait) as { onEnter: string; onExit: string };
    const name = phase === 'enter' ? r.onEnter : r.onExit;
    if (!name) return;
    dispatchGameAction(name, { target: other, params: { self, other, phase } });
  };
}

/** Resolve a collider to its OWNING body entity id (Percept contact roll-up). This is resolved
 *  ONCE at attach time and stored on the ColliderInfo — an own-collider/solo collider owns itself;
 *  a compound child owns its parent BODY. (Resolving it here at drain time can't reliably tell a
 *  compound child from a solo collider whose parent is a non-body group, so we don't guess.) */
function bodyEntityOf(ci: ColliderInfo): number {
  return ci.entity.isAlive() ? ci.bodyEntityId : ci.entityId;
}

/** Stable Percept reference for a collider's entity: its GUID when live+guidable
 *  (survives scene reloads), else the cached numeric id. THE single seam every contact
 *  emit site uses — `@collision`/`@sensor` here AND `@contact` in physics2D/3DSystem —
 *  so "collider entity → stable ref" is defined once and can't drift. Falls back to the
 *  cached `entityId` for a despawned entity (the synthesized-exit path routes pairs whose
 *  entity may already be dead, where `entityRef`'s live-handle probing is unsafe). The
 *  numeric-id fallback still resolves to a name because `entityRef` dual-keys the side-table
 *  (records the name under both the GUID and the numeric id while the entity is alive). */
export function refOf(ci: ColliderInfo): string | number {
  return ci.entity.isAlive() ? entityRef(ci.entity) : ci.entityId;
}

/** Route ONE collider pair to all three sinks. `a`/`b` order is preserved for the collision
 *  journal payload; the sensor case picks whichever collider `isSensor`. */
function routePair(world: World, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit', bus: PhysicsEventBus, fire: FireOnCollision): void {
  if (a.isSensor || b.isSensor) {
    const sensorRec = a.isSensor ? a : b;
    const otherRec = a.isSensor ? b : a;
    emit('@sensor', { sensor: refOf(sensorRec), other: refOf(otherRec), phase }, world);
    bus.__emitSensor(world, sensorRec.entity, otherRec.entity, phase);
  } else {
    emit('@collision', { a: refOf(a), b: refOf(b), phase }, world);
    bus.__emitCollision(world, a.entity, b.entity, phase);
  }
  // Either collider may carry the OnCollision trait — fire for each, passing the OTHER as target.
  fire(a.entity, b.entity, phase);
  fire(b.entity, a.entity, phase);
}

/** Percept: update the queryable current-contact index for ONE live drain-path pair, rolled
 *  up to bodies (self-pairs excluded). Called ONLY from `drainContactEvents`, where both
 *  entities are alive so enter and exit roll up to the SAME body — NOT from the synthesized
 *  despawn-exit path, whose dead/reparented entities would roll up asymmetrically; body
 *  REMOVAL is instead cleaned by `dropEntityFromContactIndex` (see physicsContactIndex.ts). */
function indexLivePair(world: World, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit'): void {
  const ba = bodyEntityOf(a), bb = bodyEntityOf(b);
  if (ba !== bb) updateContactIndex(world, ba, bb, a.isSensor || b.isSensor, phase);
}

/** Drain Rapier's contact + sensor events for this step → the three sinks. Call only when dt>0.
 *  `onPair` (optional) fires for each resolved pair with the raw collider handles + phase — the
 *  dimension-specific hook where a system can read the contact manifold (point/normal/impact) and
 *  fan a rich `contact` event, since manifold reading is Rapier-2D-vs-3D specific. */
export function drainContactEvents(
  world: World, colliders: ColliderMap, eventQueue: EventQueueLike, bus: PhysicsEventBus, fire: FireOnCollision,
  onPair?: (h1: number, h2: number, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit') => void,
): void {
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    const a = colliders.get(h1);
    const b = colliders.get(h2);
    if (!a || !b) return; // one collider already removed this frame
    const phase = started ? 'enter' : 'exit';
    routePair(world, a, b, phase, bus, fire);
    indexLivePair(world, a, b, phase); // Percept contact index — live path only (both alive here)
    onPair?.(h1, h2, a, b, phase);
  });
}

/** Synthesize `exit` events for pairs still overlapping the given collider handles BEFORE they
 *  are freed — Rapier emits no stop event on collider removal/rebuild, so without this a
 *  despawn-inside-a-trigger (or geometry rebuild) leaves subscribers' overlap state stuck
 *  'entered'. Double-exit safe: the caller deletes its own collider entries before freeing, so a
 *  simultaneously-removed partner is already gone from `colliders`. */
export function synthesizeContactExits(colliderHandles: readonly number[], world: World, colliders: ColliderMap, narrowPhase: NarrowPhaseLike, bus: PhysicsEventBus, fire: FireOnCollision): void {
  for (const h of colliderHandles) {
    const self = colliders.get(h);
    if (!self) continue;
    const emitExit = (otherHandle: number) => {
      const other = colliders.get(otherHandle);
      if (!other || other.entityId === self.entityId) return; // gone, or same entity (compound)
      routePair(world, self, other, 'exit', bus, fire);
    };
    narrowPhase.contactPairsWith(h, emitExit);        // solid contacts
    narrowPhase.intersectionPairsWith(h, emitExit);   // sensor overlaps
  }
}
