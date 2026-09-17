/** Can the entity's Collider2D be vertex-edited on canvas? The ONE predicate behind collider-edit
 *  mode (#1213 B-2).
 *
 *  It used to live inline in SceneView's `ColliderEditButton`, whose effect turns the mode OFF the
 *  moment it stops being true. The `set-collider-edit` op could not see it, so `{on:true}` with a box
 *  collider (or nothing) selected set the mode, replied `colliderEditMode:true`, and the button's
 *  effect reset it to false on the next render — after the reply was already computed. Both callers
 *  ask this function now, so the op refuses exactly what the button would undo. */

import { getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { minPointsForShape } from '../../runtime/core/colliderPoints';

/** Why an entity is not editable, or `null` when it is. */
export function colliderEditBlocker(entityId: number | null | undefined): string | null {
  if (entityId == null) return 'nothing is selected';
  const colMeta = getAllTraits().find((t) => t.name === 'Collider2D');
  const ent = colMeta ? findEntity(entityId) : null;
  if (!ent || !colMeta) return 'the selected entity no longer exists';
  if (!ent.has(colMeta.trait)) return 'the selected entity has no Collider2D';
  const shape = (ent.get(colMeta.trait) as { shape: string }).shape;
  // Any point-list shape is editable (polygon/concave = 3, polyline = 2) — the single source of
  // truth, so a new point-shape never desyncs from this gate.
  return minPointsForShape(shape) !== null ? null : `its Collider2D shape '${shape}' has no editable points`;
}

export function isColliderEditable(entityId: number | null | undefined): boolean {
  return colliderEditBlocker(entityId) === null;
}
