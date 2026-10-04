/** The UI resize/move handles' ECS writes (`UIResizeOverlay.tsx`), kept out of the `.tsx` so the commit is testable.
 *
 *  A drag writes its live values raw on every pointer move ({@link writeUIHandleValues}), like the gizmo's drag, and
 *  {@link commitUIHandleDrag} turns the finished drag into one undo step. The commit is also where a prefab-instance
 *  member's override is recorded: the save keeps a member's field only when its record lists it, and the handles
 *  used to record nothing, so a resize or move of an instance member was dropped by the next save (#1709). */

import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { pushAction } from '../undo/undoManager';
import { entityRef } from '../undo/entityRef';
import { placeholderGestureRefusal } from '../undo/entityActions';
import { notifyFieldEdited } from '../animation/recording';
import { resolveAffectedScenes } from './sceneDirty';
import { recordOverridesByDiff, putFieldRows, requireRowRecords } from '../undo/overrideMarkWrites';
import * as instanceEdits from '../instance/instanceEdits';

export type UIHandleTrait = 'UIElement' | 'UIAnchor';

/** The fields the animation recorder keys for a handle drag: the offsets a move handle changes and the size a
 *  resize handle changes. A unit switch the resize made is saved, but not keyed. */
const RECORDED: Record<UIHandleTrait, readonly string[]> = {
  UIAnchor: ['top', 'left', 'right', 'bottom'],
  UIElement: ['width', 'height'],
};

/** Merge `values` into the entity's `trait`, raw: no undo and no override mark. A drag's live frames. */
export function writeUIHandleValues(entityId: number, trait: UIHandleTrait, values: Record<string, unknown>): void {
  const meta = getTraitByName(trait);
  if (!meta) return;
  const entity = findEntity(entityId);
  if (!entity || !entity.has(meta.trait)) return;
  entity.set(meta.trait, { ...(entity.get(meta.trait) as Record<string, unknown>), ...values });
  markUIDirty();
}

/** Commit a finished handle drag as one undo step: `before` is the trait's values when the drag started, `after`
 *  the live values now (the drag already wrote them). On a prefab-instance member, the fields the drag changed are
 *  recorded where they differ from the instance's base, and a record an earlier write made is kept even where the drag
 *  put the value back on it (#1914 F3, `recordOverridesByDiff`). The save would otherwise drop the drag. Undo and redo put back each
 *  side's rows. */
export function commitUIHandleDrag(
  entityId: number, trait: UIHandleTrait,
  before: Record<string, unknown>, after: Record<string, unknown>, label: string,
): void {
  const meta = getTraitByName(trait);
  if (!meta) return;
  const changed = Object.keys(after).filter((k) => !Object.is(before[k], after[k]));
  // A Missing Prefab placeholder's save drops the drag (#1818): put the values back, and push nothing.
  if (placeholderGestureRefusal([entityId], trait)) { writeUIHandleValues(entityId, trait, { ...before }); return; }
  // From the record as it stood before the commit, or none: the drag already wrote live, so rows read now would state the
  // dragged values (review F1). Without them (no record) the step puts back the values only.
  const oldRows = instanceEdits.priorRowsOf([entityId]);
  recordOverridesByDiff(entityId, meta, changed);
  const newRows = oldRows && instanceEdits.rowsOf([entityId]);
  const ref = entityRef(entityId);
  const b = { ...before }, a = { ...after };
  pushAction({
    label,
    // `require` (I19): a target that is gone, or a placeholder now, refuses rather than reading as done.
    // Each side's rows go back exactly (#2046 S7.2, rule 8).
    undo: () => { const id = ref.require(); requireRowRecords(oldRows); writeUIHandleValues(id, trait, b); putFieldRows([id], oldRows, trait, changed); },
    redo: () => { const id = ref.require(); requireRowRecords(newRows); writeUIHandleValues(id, trait, a); putFieldRows([id], newRows, trait, changed); },
    // Without it the scene the member belongs to was never marked dirty, so a save could skip it.
    affectedScenes: resolveAffectedScenes([entityId]),
  });
  // Record mode: the drag wrote through `entity.set`, which bypasses writeTraitField, so the animation record hook
  // never saw it. Notify it for the fields that actually moved (no-op when not recording), so a drag keys the clip.
  for (const k of RECORDED[trait]) if (changed.includes(k)) notifyFieldEdited(entityId, trait, k, a[k]);
}
