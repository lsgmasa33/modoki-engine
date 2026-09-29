/** Hierarchy legality — the ONE place that decides whether a parent link is allowed.
 *
 *  Extracted in #166 P7 because the rule had grown a second implementation. `reparentEntity`
 *  (editor, undoable) rejected a self-parent and an ancestor cycle; then the device's `set-traits`
 *  gained the ability to write `EntityAttributes.parentId` DIRECTLY — bypassing that check
 *  entirely — and had to grow its own guard after a cycle hung the subtree walk on real hardware.
 *  Two copies of a rule is exactly what conventions §9 says will diverge, so both now call this.
 *
 *  Deliberately in `runtime/` (L0 `core/ecs`), not `editor/`: the check is pure graph reasoning
 *  over `EntityAttributes.parentId`, it needs nothing from the editor, and the DEVICE is precisely
 *  where it was missing. Note this validates the LINK only — the editor's `reparentEntity` layers
 *  its own additional refusals on top (cross-scene provenance, prefab-instance boundaries), which
 *  are about authoring and stay there. */

import { getAllEntities, findEntity, readTraitData } from './entityUtils';
import { getAllTraits, getTraitByName } from './traitRegistry';
import { parentLinkRefusal, type ReparentRefusal } from './parentLink';
export type { ReparentRefusal };

/** The entity's current `EntityAttributes.parentId`, read through the registry: L0 core imports no trait. */
function currentParentOf(entityId: number): number {
  const meta = getTraitByName('EntityAttributes');
  return (meta ? (readTraitData(entityId, meta)?.parentId as number | undefined) : undefined) || 0;
}

/** True if `ancestorId` is an ancestor of `entityId` — i.e. making `ancestorId` a CHILD of
 *  `entityId` would close a loop. Bounded by the entity count, so it terminates even if the graph
 *  is ALREADY cyclic (which is reachable: a scene file or game code can author one). */
export function isAncestorOf(ancestorId: number, entityId: number): boolean {
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  let current = byId.get(entityId);
  let hops = 0;
  while (current && current.parentId !== 0 && hops++ <= byId.size) {
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

/** True if `entityId` carries a `resource`-category trait (Time, Input, Physics2D, a game config…) —
 *  the same category test behind the Hierarchy's `R` badge (`EntityInfo.isResource`), read off the one
 *  entity rather than a whole-world `getAllEntities()` scan, because parent checks call it per id. */
export function isResourceEntity(entityId: number): boolean {
  if (!entityId) return false;
  const e = findEntity(entityId);
  if (!e) return false;
  for (const m of getAllTraits()) {
    if (m.category !== 'resource') continue;
    try { if (e.has(m.trait)) return true; } catch { /* destroyed world */ }
  }
  return false;
}

/** Why `parentId` cannot HOLD a child, or null when it can (0, the scene root, always can).
 *
 *  A resource entity is a world singleton, not a node in the authored tree (#1248). A child under the
 *  Transient Time or Input singleton is dropped from every save and Play snapshot along with its parent,
 *  and since #1248 every scene shows an Input row with a guid, so that parent is one drag or one
 *  `parentGuid` away. This is the check for every path that CREATES a parent link — create, paste,
 *  instantiate, a cross-scene move — while `reparentRefusal` below covers moves. */
export function parentRefusal(parentId: number): 'resource' | null {
  return parentId !== 0 && isResourceEntity(parentId) ? 'resource' : null;
}

/** The parent a create/paste/drop gesture lands under: the one asked for, or the scene root when that
 *  one cannot hold a child (`parentRefusal`). For the editor's gestures, which re-root rather than refuse. */
export function parentOrRootFor(parentId: number): number {
  return parentRefusal(parentId) ? 0 : parentId;
}

/** Why this parent link is illegal, or null when it is fine.
 *
 *  `newParentId` 0 means "scene root" and is always legal. Returning a REASON rather than a boolean
 *  is what lets each caller phrase its own refusal: the agent surface must say what to do instead
 *  (conventions §5), while the editor's drag-drop just declines the drop. */
export function reparentRefusal(entityId: number, newParentId: number): ReparentRefusal | null {
  // The rule itself is `parentLinkRefusal` (parentLink.ts), shared with the file-direct scene-mutate (#1825); this is
  // the live world's graph. `currentParentOf` reads through the registry, as the rule's "a reorder is not a new link"
  // must, rather than the EntityInfo snapshot.
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  return parentLinkRefusal<number>({
    parentOf: (id) => (id === entityId ? currentParentOf(id) : byId.get(id)?.parentId) || null,
    isResource: isResourceEntity,
    size: byId.size,
  }, entityId, newParentId || null);
}
