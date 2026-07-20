/** physicsContactIndex — the queryable "what is this body touching RIGHT NOW" state
 *  (Percept). A per-world index of each BODY entity's CURRENT solid `contacts` and
 *  sensor `overlaps`, maintained INCREMENTALLY from the enter/exit events that
 *  `physicsContactEvents.routePair` already fires (solid + sensor, both dimensions, and
 *  the synthesized despawn-exit path). NOT a per-frame scan — membership only changes on
 *  a begin/stop event, so a settled pile of crates costs nothing.
 *
 *  This is the STATE counterpart to the `@contact`/`@sensor` journal EVENTS: the journal
 *  answers "when did they touch?"; this answers "what are they touching now?" — which the
 *  event stream can't, once a resting contact's begin-event has scrolled past. It is a
 *  derived observation (like the world-transform / world-AABB folds), NOT authored data,
 *  so it lives here and is folded into `get_scene_state`, not stored on a trait.
 *
 *  ROLLED UP TO BODIES: contacts fire at COLLIDER entities (a compound body's extra
 *  colliders are child entities), but the pairs are resolved to their owning body entity
 *  before indexing (see `routePair`), and self-contacts (two colliders of one body) are
 *  excluded. IDs are the OTHER body's runtime entity id — world-scoped, but the index is
 *  per-world and read within the same world, and the scene-state fold resolves each to a
 *  stable GUID at read time.
 *
 *  Determinism: pure refcount membership + a sorted read; no wall-clock / Math.random, so
 *  the determinism guard is unaffected and a fixed-dt run reproduces the same sets.
 *
 *  Two responsibilities, deliberately split (learned from review):
 *   - LIVE separation (two bodies that stay alive move apart) → the incremental
 *     enter/exit from the DRAIN path (`drainContactEvents` → updateContactIndex), where
 *     both entities are alive so the collider→body roll-up is symmetric with the enter.
 *   - REMOVAL (a body despawns/rebuilds) → `dropEntityFromContactIndex(world, bodyId)` from the
 *     systems' `removeBody` + zero-body early-out. We do NOT trust the synthesized-exit
 *     roll-up here: a dead/reparented compound child re-resolves to a DIFFERENT body than
 *     its enter did, so decrementing by that would leak; force-clearing by body identity
 *     is exact regardless.
 *
 *  KNOWN LIMITATION (minor, documented): toggling a collider's `isSensor` IN PLACE while
 *  it is touching (an in-place material edit, no rebuild) can leave a transient phantom in
 *  the original bucket — enter counted it under `contacts`, the post-toggle exit tries the
 *  `overlaps` bucket. It self-heals when either body is removed (dropEntityFromContactIndex) or the
 *  scene swaps/Stops. This mirrors the engine's own in-place-toggle semantics (the
 *  stateless @collision/@sensor sinks also don't re-balance across a mid-contact toggle);
 *  a full fix would need per-collider-pair classification, not worth it for this edge. */

import type { World } from 'koota';
import { onWorldSwap } from '../ecs/world';
import { getPlayState, onPlayStateChange } from './playState';

// REFCOUNTED (not a plain Set): contacts fire per COLLIDER pair, but we roll up to
// BODIES — so one body pair can be reported by SEVERAL collider pairs at once (a table
// with two legs on the floor, a character whose body capsule AND foot sphere both touch
// the ground). A Set would drop the whole body pair the moment the FIRST collider lifts,
// falsely reporting "no longer touching" while another collider still does. So each
// other-body maps to a COUNT of active collider pairs; it's present while count > 0.
interface BodyContacts { contacts: Map<number, number>; overlaps: Map<number, number>; }

// Per-world: bodyEntityId → its current contact/overlap counters. A regular Map (not Weak):
// cleared explicitly on the same lifecycle events the physics world itself is (scene swap,
// Play→Stop) so it can't outlive its world's entity ids.
const index = new Map<World, Map<number, BodyContacts>>();

function bucketFor(world: World, body: number): BodyContacts {
  let wm = index.get(world);
  if (!wm) { wm = new Map(); index.set(world, wm); }
  let b = wm.get(body);
  if (!b) { b = { contacts: new Map(), overlaps: new Map() }; wm.set(body, b); }
  return b;
}

function bump(counts: Map<number, number>, other: number): void {
  counts.set(other, (counts.get(other) ?? 0) + 1);
}
function drop(counts: Map<number, number>, other: number): void {
  const n = (counts.get(other) ?? 0) - 1;
  if (n <= 0) counts.delete(other); else counts.set(other, n);
}

/** Drop a body's entry if it now holds no contacts AND no overlaps (keep the index tight). */
function pruneIfEmpty(wm: Map<number, BodyContacts>, body: number): void {
  const b = wm.get(body);
  if (b && b.contacts.size === 0 && b.overlaps.size === 0) wm.delete(body);
}

/** Add (enter) or remove (exit) ONE rolled-up body pair. `sensor` picks the `overlaps`
 *  counter (a sensor/trigger overlap) vs `contacts` (a solid, load-bearing contact).
 *  Symmetric — each body counts the other. Callers must have already excluded self-pairs
 *  (a===b). Refcounted so multiple collider pairs between the same two bodies coexist. */
export function updateContactIndex(world: World, a: number, b: number, sensor: boolean, phase: 'enter' | 'exit'): void {
  const key = sensor ? 'overlaps' : 'contacts';
  if (phase === 'enter') {
    bump(bucketFor(world, a)[key], b);
    bump(bucketFor(world, b)[key], a);
  } else {
    const wm = index.get(world);
    if (!wm) return;
    const ba = wm.get(a); if (ba) { drop(ba[key], b); }
    const bb = wm.get(b); if (bb) { drop(bb[key], a); }
    pruneIfEmpty(wm, a);
    pruneIfEmpty(wm, b);
  }
}

/** The body's CURRENT contacts + overlaps as sorted entity-id arrays, or undefined when it
 *  is touching nothing. Sorted so the output is stable across runs (determinism). The
 *  scene-state fold resolves these ids to GUIDs. */
export function getContactState(world: World, entityId: number): { contacts: number[]; overlaps: number[] } | undefined {
  const b = index.get(world)?.get(entityId);
  if (!b || (b.contacts.size === 0 && b.overlaps.size === 0)) return undefined;
  return {
    contacts: [...b.contacts.keys()].sort((x, y) => x - y),
    overlaps: [...b.overlaps.keys()].sort((x, y) => x - y),
  };
}

/** Force-remove an ENTITY from the index: drop its own entry AND every partner's reference
 *  to it (regardless of refcount — it's gone). The index is keyed by the OWNING entity of a
 *  contact — a body (own/compound colliders roll up to it) OR a solo collider (owns itself).
 *  Called from the physics systems' `removeBody` / `removeSoloCollider` + the zero-body
 *  early-out, so contacts are cleaned by ENTITY identity — NOT by re-resolving a synthesized-exit
 *  roll-up from a dead/reparented collider (which can key to the wrong entity and leak). This is
 *  the load-bearing cleanup; the incremental drain-path update only handles LIVE separation. */
export function dropEntityFromContactIndex(world: World, entityId: number): void {
  const wm = index.get(world);
  if (!wm) return;
  const b = wm.get(entityId);
  if (!b) return;
  for (const other of new Set([...b.contacts.keys(), ...b.overlaps.keys()])) {
    const ob = wm.get(other);
    if (ob) { ob.contacts.delete(entityId); ob.overlaps.delete(entityId); pruneIfEmpty(wm, other); }
  }
  wm.delete(entityId);
}

/** Drop a world's whole index (scene swap / Stop / explicit teardown). */
export function clearContactIndex(world: World): void { index.delete(world); }

/** Test-only: wipe everything. */
export function _resetContactIndex(): void { index.clear(); }

// Same lifecycle as the physics world itself (physicsWorldRegistry): clear on scene swap
// and on Play→Stop, so a body's stale contacts can never survive into a fresh world whose
// entity ids are reassigned. Shipped games never Stop; the swap path covers navigation.
onWorldSwap((_next, old) => clearContactIndex(old));
onPlayStateChange(() => { if (getPlayState() === 'stopped') index.clear(); });
