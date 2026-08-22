import { trait } from 'koota';

/** UIEntry — stamped by the engine on every pooled entry instance root.
 *
 *  This is what makes a tap on a recycled entry recoverable. Court's tiles solve the same
 *  problem today by regexing the firing entity's NAME (`/^LevelTile_(\d+)$/`,
 *  `games/court/runtime/systems.ts`), because *"the tiles are 25 instances of ONE prefab, so
 *  the binding is authored once and physically cannot carry a per-instance value"*. A pooled
 *  view mints its own entities, so name-parsing stops being available at all — the engine owes
 *  a generic answer, and this is it.
 *
 *  ⚠️ **`index` is the DATA index, not the slot.** The slot is where the entity happens to sit
 *  in the pool this frame and means nothing to a game. Reading `slot` to identify content is
 *  the bug this trait exists to prevent.
 */
export const UIEntry = trait({
  /** Column in the data's index space. */
  x: 0,
  /** Row in the data's index space. */
  y: 0,
  /** `y * countX + x` — the flat data index, for the many consumers that are 1-D. */
  index: 0,
  /** Which pool slot this instance currently occupies. Engine bookkeeping; a game wanting to
   *  know WHAT it is looking at wants `index`. */
  slot: 0,
  /** GUID of the `UIScrollView` entity that owns this pool. */
  viewGuid: '' as string,
  /** Which entry KIND (a name from `UIEntries.prefabs`) this instance was built from. A pool is
   *  per-kind, so a slot never changes kind — but the resolver still needs to be told which one
   *  it is filling. */
  kind: '' as string,
  /** False while this instance is PARKED in the recycle bin.
   *
   *  ⚠️ A parked entry must be treated by Percept and Enact exactly as if it had been destroyed
   *  (owner, 2026-08-21): not listed by `get_scene_state`, not aimable, refused rather than
   *  acted on — and that covers its whole subtree, not just this root. This is deliberately NOT
   *  the same as `UIElement.isVisible`: a hidden entity today is still perfectly addressable and
   *  should stay that way. */
  live: false,
});
