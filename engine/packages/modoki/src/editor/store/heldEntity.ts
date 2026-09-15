/** heldEntity — editor state that points at an entity across user time follows "the same thing",
 *  never the entity index (#1221, the rule in docs/engine-concepts.md § Entity).
 *
 *  A selection, a collapsed Hierarchy node or a bound Animator/Director root is stored as a bare
 *  `entity.id()`, and koota recycles that index LIFO: delete the entity and the next spawn takes the
 *  id, so the newcomer silently shows as selected, collapsed or bound. A held entity records what the
 *  id meant when it was taken — the packed value (generation included), the guid, and the World — and
 *  {@link resolveHeld} answers what it means now:
 *
 *  - **the same entity is still there** → unchanged;
 *  - **it is gone, and a live entity carries its guid** → follow it. That is a seeded respawn
 *    (Timeline scrub, an Entries row — `spawnPrefabInstance`'s `guidSeed`) or an undo respawn: the
 *    same thing to the person looking at the panel (owner decision, 2026-09-15);
 *  - **it is gone, and it had a guid nothing carries yet** → PARKED (`id: null`): hidden now,
 *    resolved again later. A seeded spawn writes its guid AFTER `spawnEntity`, so at the structure
 *    event that creates it the replacement is not findable yet — the owner re-asks a frame later;
 *  - **it is gone and had no guid** (a `Time`/`Input` singleton) → dropped.
 *
 *  Another World is left alone: the swap owners (`selectionRestore.ts`, the Hierarchy collapse
 *  restore, the Timeline panel) remap across a world swap by their own rules. */

import type { Entity, World } from 'koota';
import { findEntityById, findEntityByGuid, peekEntityByGuid } from '../../runtime/core/ecs/world';
import { EntityAttributes } from '../../runtime/core/traits/EntityAttributes';

export interface HeldEntity {
  /** The id to show, or null while PARKED (gone, waiting for its guid to reappear). */
  readonly id: number | null;
  /** `entity.valueOf()` when last resolved — generation included. */
  readonly packed: number;
  /** The entity's guid when taken ('' if it had none): durable or runtime, whichever it carried. */
  readonly guid: string;
  readonly world: World;
}

function guidOf(entity: Entity): string {
  try { return entity.has(EntityAttributes) ? String((entity.get(EntityAttributes) as { guid?: string }).guid ?? '') : ''; } catch { return ''; }
}

/** Hold the entity living at `id` in `world`, or null when nothing registered lives there. */
export function holdEntity(id: number, world: World): HeldEntity | null {
  const entity = findEntityById(id, world);
  return entity ? { id, packed: entity.valueOf(), guid: guidOf(entity), world } : null;
}

/** What `held` names in `world` now: itself, the entity that took over its guid, a parked hold, or
 *  null (gone for good). Returns the SAME object when nothing changed, so a caller can compare by
 *  identity.
 *
 *  `rescan: false` (the default) is safe INSIDE a structure callback — see `peekEntityByGuid` — and
 *  therefore cannot see a guid written by a site that skipped `indexEntityGuid` (prefab.ts
 *  `rebuildInstance` was one). A caller OUTSIDE a structure change passes `rescan: true` to use the
 *  gated, self-healing `findEntityByGuid` and follow that write too (#1221 close-out review). */
export function resolveHeld(held: HeldEntity, world: World, opts: { rescan?: boolean } = {}): HeldEntity | null {
  if (held.world !== world) return held;
  if (held.id !== null && findEntityById(held.id, world)?.valueOf() === held.packed) return held;
  if (!held.guid) return null;
  const next = opts.rescan ? registeredLive(findEntityByGuid(held.guid, world), world) : peekEntityByGuid(held.guid, world);
  if (next && next.valueOf() !== held.packed) return { id: next.id(), packed: next.valueOf(), guid: held.guid, world };
  return held.id === null ? held : { ...held, id: null };
}

function registeredLive(entity: Entity | undefined, world: World): Entity | undefined {
  if (!entity) return undefined;
  try { if (!entity.isAlive()) return undefined; } catch { return undefined; }
  return findEntityById(entity.id(), world) === entity ? entity : undefined;
}
