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
import { emit, entityRef } from '../core/journal';
import { dispatchGameAction } from '../core/actionRegistry';
import type { PhysicsEventBus } from './physicsEventBus';
import { updateContactIndex } from './physicsContactIndex';

/** The collider→entity reverse-map value both systems keep (keyed by Rapier collider handle).
 *  `ref` is the entity's journal ref as last seen ALIVE — see {@link refOf}. Build one with
 *  {@link makeColliderInfo}, which seeds it. */
export interface ColliderInfo { entityId: number; entity: Entity; isSensor: boolean; bodyPacked: number; ref: string | number }

/** The one constructor for a {@link ColliderInfo}: caches the numeric id AND the journal ref while
 *  `entity` is known alive (it is being given a collider), so a later exit for a body that has
 *  despawned before any event named it still carries the ref its entity had. */
export function makeColliderInfo(entity: Entity, isSensor: boolean, bodyPacked: number): ColliderInfo {
  return { entityId: entity.id(), entity, isSensor, bodyPacked, ref: entityRef(entity) ?? entity.id() }; // alive: being given a collider
}
export type ColliderMap = Map<number, ColliderInfo>;
/** `refs` are both entities' journal refs as last seen ALIVE — the only identity a synthesized exit
 *  still has for a despawned `other` (#1227). */
export type FireOnCollision = (self: Entity, other: Entity, phase: 'enter' | 'exit', refs: { self: string | number; other: string | number }) => void;

interface NarrowPhaseLike {
  contactPairsWith(collider: number, f: (other: number) => void): void;
  intersectionPairsWith(collider: number, f: (other: number) => void): void;
}
interface EventQueueLike {
  drainCollisionEvents(f: (h1: number, h2: number, started: boolean) => void): void;
}

/** Build the declarative `OnCollision` dispatcher for a given trait (`OnCollision2D`/`3D`): the
 *  action gets `other` as `ctx.target` and `{ self, other, phase, selfRef, otherRef }` in
 *  `ctx.params`. On an exit `other` may be DEAD with its index reclaimed — `otherRef` is the ref it
 *  had while alive, and `entityRef(other)` answers `null` rather than name the newcomer (#1227).
 *  Pipeline-safe: `dispatchGameAction` never throws on an unwired action name; `self` may be
 *  despawned (a synthesized exit), so guard `isAlive()`. */
export function makeFireOnCollision(OnCollisionTrait: Parameters<Entity['has']>[0]): FireOnCollision {
  return (self, other, phase, refs) => {
    if (!self.isAlive() || !self.has(OnCollisionTrait)) return;
    const r = self.get(OnCollisionTrait) as { onEnter: string; onExit: string };
    const name = phase === 'enter' ? r.onEnter : r.onExit;
    if (!name) return;
    dispatchGameAction(name, { target: other, params: { self, other, phase, selfRef: refs.self, otherRef: refs.other } });
  };
}

/** Resolve a collider to its OWNING body's PACKED entity (Percept contact roll-up; #868). This is resolved
 *  ONCE at attach time and stored on the ColliderInfo — an own-collider/solo collider owns itself;
 *  a compound child owns its parent BODY. (Resolving it here at drain time can't reliably tell a
 *  compound child from a solo collider whose parent is a non-body group, so we don't guess.) */
function bodyEntityOf(ci: ColliderInfo): number {
  return ci.entity.isAlive() ? ci.bodyPacked : ci.entity.valueOf();
}

/** Stable Percept reference for a collider's entity: its GUID when live+guidable
 *  (survives scene reloads). THE single seam every contact emit site uses —
 *  `@collision`/`@sensor` here AND `@contact` in physics2D/3DSystem — so "collider entity →
 *  stable ref" is defined once and can't drift.
 *
 *  A despawned entity gets the ref CACHED on `ci` — the one the last live call returned (or
 *  {@link makeColliderInfo} seeded), never anything re-derived from the dead handle: koota's
 *  `has()`/`get()` do not check generation, so `entityRef(deadHandle)` on a reclaimed index names
 *  the NEW entity. It used to fall back to the cached numeric id, which split every pair: the
 *  enter carried the guid, the synthesized despawn-exit a number. Since #1210 every code-spawned
 *  entity carries a unique runtime guid, so that split reached almost every body (#1225); now an
 *  exit carries the ref its enter did. */
export function refOf(ci: ColliderInfo): string | number {
  if (ci.entity.isAlive()) ci.ref = entityRef(ci.entity) ?? ci.ref;
  return ci.ref;
}

/** Route ONE collider pair to all three sinks. `a`/`b` order is preserved for the collision
 *  journal payload; the sensor case picks whichever collider `isSensor`. Every sink gets the SAME
 *  two refs, taken once through `refOf` — the handles beside them may be dead on a synthesized exit,
 *  the refs never are (#1227). */
function routePair(world: World, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit', bus: PhysicsEventBus, fire: FireOnCollision): void {
  const aRef = refOf(a), bRef = refOf(b);
  if (a.isSensor || b.isSensor) {
    const sensorRec = a.isSensor ? a : b;
    const otherRec = a.isSensor ? b : a;
    const refs = { sensor: a.isSensor ? aRef : bRef, other: a.isSensor ? bRef : aRef };
    emit('@sensor', { sensor: refs.sensor, other: refs.other, phase }, world);
    bus.__emitSensor(world, sensorRec.entity, otherRec.entity, phase, refs);
  } else {
    emit('@collision', { a: aRef, b: bRef, phase }, world);
    bus.__emitCollision(world, a.entity, b.entity, phase, { a: aRef, b: bRef });
  }
  // Either collider may carry the OnCollision trait — fire for each, passing the OTHER as target.
  fire(a.entity, b.entity, phase, { self: aRef, other: bRef });
  fire(b.entity, a.entity, phase, { self: bRef, other: aRef });
}

/** Percept: update the queryable current-contact index for ONE live drain-path pair, rolled
 *  up to bodies (self-pairs excluded). Called ONLY from `routeContactEvents`, where both
 *  entities are alive so enter and exit roll up to the SAME body — NOT from the synthesized
 *  despawn-exit path, whose dead/reparented entities would roll up asymmetrically; body
 *  REMOVAL is instead cleaned by `dropEntityFromContactIndex` (see physicsContactIndex.ts). */
function indexLivePair(world: World, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit'): void {
  const ba = bodyEntityOf(a), bb = bodyEntityOf(b);
  if (ba !== bb) updateContactIndex(world, ba, bb, a.isSensor || b.isSensor, phase);
}

/** ONE drained Rapier pair, resolved to entities and waiting to be routed. `manifold` is whatever
 *  the caller's `capture` hook snapshotted at drain time (see {@link collectContactEvents}). */
export interface DrainedPair<M = unknown> {
  h1: number; h2: number; a: ColliderInfo; b: ColliderInfo; phase: 'enter' | 'exit'; manifold: M | null;
}

/** Drain THIS step's Rapier contact + sensor events into `out`. Call after EVERY `world.step` —
 *  `new EventQueue(true)` auto-drains, so Rapier clears it at the start of the next step and a
 *  single drain after a substep loop would keep only the last substep's contacts.
 *
 *  ⚠️ **Draining and ROUTING are deliberately separate.** A subscriber must see the world the
 *  frame ENDS in, so the fan-out to the journal / event bus / `OnCollision` trait is deferred to
 *  {@link routeContactEvents}, called after the Rapier→ECS pull. Draining inside the loop and
 *  routing inside it too (#205 R2, 2026-08-12) silently handed every collision callback the
 *  PREVIOUS frame's Transform and velocity: `sling`'s bumper reads both, so it kicked the puck at
 *  its un-bounced approach speed and the puck gained energy on every hit.
 *
 *  `capture` is the one thing that CANNOT be deferred — Rapier's narrow-phase manifold for a
 *  contact is only valid until the next `world.step`, so a caller that wants the contact
 *  point/normal snapshots it here and reads velocities later. */
export function collectContactEvents<M>(
  colliders: ColliderMap, eventQueue: EventQueueLike, out: DrainedPair<M>[],
  capture?: (h1: number, h2: number, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit') => M | null,
): void {
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    const a = colliders.get(h1);
    const b = colliders.get(h2);
    if (!a || !b) return; // one collider already removed this frame
    const phase: 'enter' | 'exit' = started ? 'enter' : 'exit';
    out.push({ h1, h2, a, b, phase, manifold: capture ? capture(h1, h2, a, b, phase) : null });
  });
}

/** Fan every collected pair to the three sinks (tick-stamped journal + code-subscriber bus +
 *  declarative `OnCollision`) and the Percept contact index, in drain order. Call AFTER the
 *  Rapier→ECS pull so a subscriber reads post-step transforms/velocities — see
 *  {@link collectContactEvents}. `onPair` is the dimension-specific hook (the rich `@contact`
 *  detail event, which needs the snapshotted manifold plus the now-current velocities). */
export function routeContactEvents<M>(
  world: World, pairs: readonly DrainedPair<M>[], bus: PhysicsEventBus, fire: FireOnCollision,
  onPair?: (pair: DrainedPair<M>) => void,
): void {
  for (const p of pairs) {
    routePair(world, p.a, p.b, p.phase, bus, fire);
    indexLivePair(world, p.a, p.b, p.phase); // Percept contact index — live path only
    onPair?.(p);
  }
}

/** ONE pair still overlapping a collider that is about to be freed, waiting to be routed as
 *  an `exit` — see {@link collectContactExits}. Holds SHALLOW COPIES of the two `ColliderInfo`s,
 *  not the live entries: `applyBodyMaterial` (physics2D/3DSystem) toggles `info.isSensor` IN
 *  PLACE for a material/filter edit — that is an in-place apply, not a rebuild — so a partner
 *  whose `isSensor` flips between the collect and the flush would otherwise rewrite the channel
 *  {@link routeContactExits} routes on, and a `onSensor` subscriber would never receive the exit
 *  it is waiting for. Inline routing made that window zero-width; deferring it did not. */
export interface ContactExitPair { a: ColliderInfo; b: ColliderInfo }

/** Collect `exit` pairs for the given collider handles BEFORE they are freed — Rapier emits no
 *  stop event on collider removal/rebuild, so without this a despawn-inside-a-trigger (or
 *  geometry rebuild) leaves subscribers' overlap state stuck 'entered'. Double-exit safe: the
 *  caller deletes its own collider entries before freeing, so a simultaneously-removed partner is
 *  already gone from `colliders`.
 *
 *  ⚠️ **Collecting and ROUTING are deliberately separate, same as {@link collectContactEvents}
 *  above — but here the split is load-bearing rather than a frame-timing nicety.** The
 *  narrow-phase read must happen HERE, while `h`'s collider entries are still registered (the
 *  caller removes them right after). But routing reaches game code (`OnCollision` dispatch, bus
 *  subscribers), and the removal that triggers this collect happens INSIDE a
 *  `world.query(...).updateEach(...)` callback (physics2D/3DSystem's body-reconcile query) — koota
 *  snapshots each queried trait before the callback and writes it back unconditionally after, so a
 *  handler's `entity.set` on a queried trait fired synchronously here would be silently clobbered
 *  by that write-back (#445). Callers must collect into `out` here and call
 *  {@link routeContactExits} only after the query has closed. */
export function collectContactExits(colliderHandles: readonly number[], colliders: ColliderMap, narrowPhase: NarrowPhaseLike, out: ContactExitPair[]): void {
  for (const h of colliderHandles) {
    const self = colliders.get(h);
    if (!self) continue;
    const collect = (otherHandle: number) => {
      const other = colliders.get(otherHandle);
      if (!other || other.entityId === self.entityId) return; // gone, or same entity (compound)
      out.push({ a: { ...self }, b: { ...other } });   // copies — see ContactExitPair
    };
    narrowPhase.contactPairsWith(h, collect);        // solid contacts
    narrowPhase.intersectionPairsWith(h, collect);   // sensor overlaps
  }
}

/** Route pairs collected by {@link collectContactExits}, then clear `out` so the array is
 *  reusable. Deliberately does NOT call `indexLivePair` — synthesized exits involve
 *  dead/reparented entities that would roll up to the Percept contact index asymmetrically; body
 *  removal is instead cleaned by `dropEntityFromContactIndex` (see physicsContactIndex.ts), same
 *  as the synthesize path this replaces. */
export function routeContactExits(world: World, out: ContactExitPair[], bus: PhysicsEventBus, fire: FireOnCollision): void {
  for (const p of out) {
    routePair(world, p.a, p.b, 'exit', bus, fire);
  }
  out.length = 0;
}
