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

import { getAllEntities } from './entityUtils';

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

export type ReparentRefusal = 'self-parent' | 'cycle';

/** Why this parent link is illegal, or null when it is fine.
 *
 *  `newParentId` 0 means "scene root" and is always legal. Returning a REASON rather than a boolean
 *  is what lets each caller phrase its own refusal: the agent surface must say what to do instead
 *  (conventions §5), while the editor's drag-drop just declines the drop. */
export function reparentRefusal(entityId: number, newParentId: number): ReparentRefusal | null {
  if (entityId === newParentId) return 'self-parent';
  if (newParentId !== 0 && isAncestorOf(entityId, newParentId)) return 'cycle';
  return null;
}
