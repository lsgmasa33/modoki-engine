import { trait } from 'koota';

/** EntityAttributes — metadata for any entity: display name and active state.
 *  `isActive` is the entity ON/OFF switch: when false, the entity AND all its
 *  descendants are skipped by systems, rendering, and game ticks (the child cascade is
 *  computed in `transformPropagationSystem` → `deactivatedEntities`). This is distinct
 *  from a renderable trait's `isVisible`, which hides only that one renderer; an entity
 *  draws a renderable iff the entity is active (incl. all ancestors) AND the trait is
 *  visible. */
export const EntityAttributes = trait({
  name: '' as string,
  /** Entity on/off — false hides the entity and cascades to all descendants. */
  isActive: true as boolean,
  /** Sibling order within parent (lower = earlier). Used for hierarchy ordering,
   *  2D z-ordering, and DOM render order. */
  sortOrder: 0,
  /** Parent entity ID (0 = root, no parent) */
  parentId: 0,
  /** Rendering layer — derived from which Renderable trait is present */
  layer: '' as '' | '3d' | '2d' | 'ui',
  /** Stable UUID — the entity's persistent identity. Survives scene swaps,
   *  cross-scene/cross-prefab references, and editor saves. Empty by default;
   *  assigned by `markPersistent` for persistent entities, or by serialize at
   *  save time for everything else. */
  guid: '' as string,
  /** Editor-only Hierarchy grouping tag — a "/"-delimited folder path (e.g.
   *  "Enemies/Ranged"). Set ONLY on ROOT entities (parentId 0); children ride
   *  their root's subtree under the folder, so they're never tagged. Empty = the
   *  entity is an ungrouped root. Purely organizational — it has NO runtime effect
   *  (no system reads it); it only drives how the Hierarchy panel groups roots. */
  editorFolder: '' as string,
});
