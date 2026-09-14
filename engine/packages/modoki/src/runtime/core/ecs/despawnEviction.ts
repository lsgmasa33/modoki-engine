/** despawnEviction — delete a per-entity cache entry the moment its entity is destroyed (#868).
 *
 *  The third sanctioned shape for per-entity state, beside a packed-entity key and `EntityTable`
 *  (`docs/engine-concepts.md` § Entity). It is for FRAME-DERIVED CACHES: filled by one pipeline
 *  pass, keyed by the bare `entity.id()`, and read by id at later priorities or out of band —
 *  often by readers that hold only an id, so a generation check at the read has nothing to check.
 *  koota recycles a destroyed index for the next spawn, so without this such a cache answers for
 *  the newcomer with the dead entity's entry until the owner's next pass.
 *
 *  `world.onRemove(trait, cb)` runs synchronously inside `destroy()`, while the entity is still
 *  alive, and also on a plain removal of `trait` — so the entry is gone before any spawn can reclaim
 *  the index. Pick the trait the cache's population is defined by (an entity without it can never
 *  have an entry).
 *
 *  ONE WORLD AT A TIME. `bind(world)` is called by the owner on each pass with the world it is about
 *  to fill the cache from; binding a different world drops the previous subscription. The cache holds
 *  the last-processed world's data, so a destroy in any other world must not touch it — the same
 *  index there names a different entity. A rebind is one pointer compare when nothing changed.
 *
 *  Constraints:
 *   - `evict` runs inside koota's `destroyEntity`. Keep it to a `Map.delete` and a flag — a throw
 *     there leaves the entity half-destroyed.
 *   - Evicting an entry the owner treats as "unchanged since last pass" is not enough on its own:
 *     an owner with a change-detection short-circuit must be told to recompute (see
 *     `transformPropagationSystem`), or a respawn that looks identical is never rebuilt.
 *   - `world.reset()` drops every subscription without signalling it, and `bind` would then see the
 *     same World object and skip resubscribing. Nothing in the engine calls `reset()`; a caller that
 *     starts to must `unbind()` first. */

import type { Entity, Trait, World } from 'koota';

export interface DespawnEviction {
  /** Subscribe to `world`, dropping any other world's subscription. No-op when already bound to it. */
  bind(world: World): void;
  /** Drop the subscription (world swap, teardown). */
  unbind(): void;
}

export function createDespawnEviction(trait: Trait, evict: (id: number) => void): DespawnEviction {
  let bound: World | null = null;
  let unsubscribe: (() => void) | null = null;
  const onRemove = (entity: Entity) => evict(entity.id());
  return {
    bind(world) {
      // Cost only, not correctness: koota keeps subscribers in a Set, so resubscribing the same
      // callback would not double-evict — it would just churn the subscription on every pass.
      if (world === bound) return;
      unsubscribe?.();
      unsubscribe = world.onRemove(trait, onRemove);
      bound = world;
    },
    unbind() {
      unsubscribe?.();
      unsubscribe = null;
      bound = null;
    },
  };
}
