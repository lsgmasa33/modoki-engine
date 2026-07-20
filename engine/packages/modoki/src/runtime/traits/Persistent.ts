/** Persistent — marker trait. Tagging a root entity with Persistent tells
 *  SceneManager to serialize and respawn it across scene swaps. Trait data is
 *  preserved; entity IDs change because koota entity handles encode their
 *  owning world.
 *
 *  Identity lives on `EntityAttributes.guid` — the universal entity UUID.
 *  Persistent itself carries no data; it's purely a "survive scene swaps" flag.
 *
 *  Invariants (runtime-enforced by `markPersistent`):
 *  - Only root entities (parentId === 0) may be marked persistent. Children
 *    come along automatically with their root.
 *  - Every persistent entity has a non-empty `EntityAttributes.guid` (assigned
 *    by `markPersistent` if missing).
 *
 *  `markPersistent` is the only sanctioned way to add this trait. Direct
 *  `entity.add(Persistent)` skips the root-only check and the guid assignment;
 *  the dedup in `SceneManager.filterPersistentDuplicates` and the
 *  selection-restore lookup in the editor depend on guid being populated.
 *
 *  Persistent entities must be ECS-pure: trait data only. Anything held in a
 *  closure, an in-flight tween, a Web Audio node, etc. will be lost on swap
 *  because that state isn't in traits. Singletons with side-effects belong
 *  in services outside the ECS, keyed by trait data. */

import { trait, type Entity } from 'koota';
import { getTraitByName } from '../ecs/traitRegistry';

export const Persistent = trait({});

/** Mark a root entity as persistent. Throws if the entity is not a root
 *  (parentId !== 0 or no EntityAttributes). Assigns a fresh UUID to
 *  EntityAttributes.guid if the entity doesn't already have one. Returns the
 *  guid that ended up on the entity.
 *
 *  Uses the trait registry to look up EntityAttributes so this works in tests
 *  where the trait registry is mocked with test-local traits. */
export function markPersistent(entity: Entity, guid?: string): string {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) {
    throw new Error('markPersistent: EntityAttributes trait not registered.');
  }
  let attr: { parentId: number; guid?: string } | undefined;
  try {
    attr = entity.get(eaMeta.trait) as { parentId: number; guid?: string } | undefined;
  } catch {
    // entity doesn't have EntityAttributes
  }
  if (!attr) {
    throw new Error(
      'markPersistent: entity has no EntityAttributes; add EntityAttributes before calling markPersistent.',
    );
  }
  if (attr.parentId !== 0) {
    throw new Error(
      `markPersistent: only root entities (parentId === 0) may be persistent; got parentId=${attr.parentId}`,
    );
  }
  // Resolve guid: explicit argument wins, then existing entity guid, then fresh
  const finalGuid = guid ?? (attr.guid && attr.guid !== '' ? attr.guid : crypto.randomUUID());
  if (attr.guid !== finalGuid) {
    // Use set() so koota commits the mutation regardless of internal storage layout.
    entity.set(eaMeta.trait, { ...attr, guid: finalGuid });
  }
  entity.add(Persistent());
  return finalGuid;
}
