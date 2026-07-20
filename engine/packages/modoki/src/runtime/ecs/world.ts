/** ECS World — entity index helpers and world registry re-exports.
 *
 *  The singleton `world` export was removed; consumers must call getCurrentWorld()
 *  inside callbacks/functions (never capture at module load) so world swaps take
 *  effect immediately. */

import { type World } from 'koota';
import { getCurrentWorld, getEntityIndex, getGuidIndex, peekCurrentWorld } from './worldRegistry';
import { EntityAttributes } from '../traits/EntityAttributes';
import { emit, entityRef, isJournalEnabled } from '../systems/journal';

export { getCurrentWorld, setCurrentWorld, onWorldSwap, getGuidIndex, peekCurrentWorld } from './worldRegistry';

/** Read an entity's stable guid ('' if absent/un-guidable). Sync + dependency-free
 *  so the guid index can be maintained inside registerEntity. */
function guidOf(entity: any): string {
  try {
    return entity.has(EntityAttributes) ? ((entity.get(EntityAttributes)?.guid as string) || '') : '';
  } catch { return ''; }
}

// Pluggable structure-dirty callback — set by entityUtils at init to avoid circular imports.
let _onStructure: (() => void) | null = null;
/** Register the structure-dirty callback. Called once by entityUtils. */
export function setStructureCallback(fn: (() => void) | null) { _onStructure = fn; }

/** Find an entity by numeric ID in the given world (defaults to current main). */
export function findEntityById(entityId: number, world: World = getCurrentWorld()) {
  return getEntityIndex(world).get(entityId);
}

/** Find an entity by its stable guid in the given world (O(1) via the guid index).
 *  Returns undefined for ''/unknown. Self-healing: on a miss it does ONE full scan,
 *  repopulates the whole guid map, and retries — so correctness holds even if a guid
 *  mint site forgot to call indexEntityGuid (the explicit wiring is just for speed). */
export function findEntityByGuid(guid: string, world: World = getCurrentWorld()) {
  if (!guid) return undefined;
  const idx = getGuidIndex(world);
  let entity = idx.get(guid);
  if (entity && guidOf(entity) === guid) return entity;
  // Miss (or stale) → rescan once and retry.
  rebuildGuidIndexSync(world);
  entity = idx.get(guid);
  return entity && guidOf(entity) === guid ? entity : undefined;
}

/** (Re)index an entity's current guid. Call after a '' → guid mint so the index
 *  reflects the new guid without waiting for the scan fallback. */
export function indexEntityGuid(entity: any, world: World = getCurrentWorld()) {
  const guid = guidOf(entity);
  if (guid) getGuidIndex(world).set(guid, entity);
}

/** Percept (J3): journal a spawn/despawn — but ONLY in the currently-active world.
 *  Scene load spawns into a staging world and teardown drops an old world, both
 *  ≠ current, so this naturally skips the bulk load/teardown flood and records only
 *  runtime (gameplay/editor) spawns + deletes. Safe if no current world is set. */
function emitLifecycle(type: '@spawn' | '@despawn', entity: any, world: World) {
  // Cheapest guards first: skip entirely when journaling is off (prod) — no
  // entityRef/alloc. peek (not getCurrentWorld) — must NOT lazily allocate a world.
  if (!isJournalEnabled() || world !== peekCurrentWorld()) return;
  emit(type, { entity: entityRef(entity) }, world);
}

/** Register an entity in the given world's index. Called after world.spawn(). */
export function registerEntity(entity: any, world: World = getCurrentWorld()) {
  getEntityIndex(world).set(entity.id(), entity);
  const guid = guidOf(entity); // present for loaded/serialized entities; '' for fresh ones
  if (guid) getGuidIndex(world).set(guid, entity);
  _onStructure?.();
  emitLifecycle('@spawn', entity, world);
}

/** Unregister an entity from the given world's index. Called before entity.destroy(). */
export function unregisterEntity(entity: any, world: World = getCurrentWorld()) {
  emitLifecycle('@despawn', entity, world); // before index removal — entity still live
  getEntityIndex(world).delete(entity.id());
  const guid = guidOf(entity);
  if (guid) getGuidIndex(world).delete(guid);
}

/** Rebuild the guid→entity index by walking EntityAttributes-tagged entities.
 *  Sync (the trait is statically imported) so findEntityByGuid can self-heal. */
export function rebuildGuidIndexSync(world: World = getCurrentWorld()) {
  const idx = getGuidIndex(world);
  idx.clear();
  try {
    world.query(EntityAttributes).updateEach(([ea]: any[], entity: any) => {
      const g = (ea?.guid as string) || '';
      if (g && !idx.has(g)) idx.set(g, entity); // first wins (guids must be unique)
    });
  } catch { /* EntityAttributes not in this world */ }
}

// Expose live current-world getter for debug console: window.__ecsWorld
// Use a getter so it always reflects the current world, not a stale capture.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  Object.defineProperty(window, '__ecsWorld', {
    configurable: true,
    get: getCurrentWorld,
  });
}
