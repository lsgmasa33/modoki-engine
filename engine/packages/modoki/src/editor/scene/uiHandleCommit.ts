/** The UI resize/move handles' ECS writes (`UIResizeOverlay.tsx`), kept out of the `.tsx` so the commit is testable.
 *
 *  A drag writes its live values raw on every pointer move ({@link writeUIHandleValues}), like the gizmo's drag, and
 *  {@link commitUIHandleDrag} turns the finished drag into one undo step. The commit is also where a prefab-instance
 *  member's override marks are settled: the save keeps a member's field only when it is marked, and the handles
 *  used to mark nothing, so a resize or move of an instance member was dropped by the next save (#1709). */

import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { pushAction } from '../undo/undoManager';
import { entityRef } from '../undo/entityRef';
import { placeholderGestureRefusal } from '../undo/entityActions';
import { notifyFieldEdited } from '../animation/recording';
import { resolveAffectedScenes } from './sceneDirty';
import { recordOverridesByDiff, markStateOf, putMarkState } from '../undo/overrideMarkWrites';

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
 *  put the value back on it (#1914 F3, `recordOverridesByDiff`). The mark gate would otherwise drop the drag on save. Undo and redo put
 *  back each side's marks. */
export function commitUIHandleDrag(
  entityId: number, trait: UIHandleTrait,
  before: Record<string, unknown>, after: Record<string, unknown>, label: string,
): void {
  const meta = getTraitByName(trait);
  if (!meta) return;
  const changed = Object.keys(after).filter((k) => !Object.is(before[k], after[k]));
  // A Missing Prefab placeholder's save drops the drag (#1818): put the values back, and push nothing.
  if (placeholderGestureRefusal([entityId], trait)) { writeUIHandleValues(entityId, trait, { ...before }); return; }
  // Marks are untouched since the drag started (its live writes are raw), so this is the state the undo restores.
  const oldMarks = markStateOf(entityId, trait, changed);
  recordOverridesByDiff(entityId, meta, changed);
  const newMarks = markStateOf(entityId, trait, changed);
  const ref = entityRef(entityId);
  const b = { ...before }, a = { ...after };
  pushAction({
    label,
    // `require` (I19): a target that is gone, or a placeholder now, refuses rather than reading as done.
    undo: () => { const id = ref.require(); writeUIHandleValues(id, trait, b); putMarkState(id, trait, oldMarks); },
    redo: () => { const id = ref.require(); writeUIHandleValues(id, trait, a); putMarkState(id, trait, newMarks); },
    // Without it the scene the member belongs to was never marked dirty, so a save could skip it.
    affectedScenes: resolveAffectedScenes([entityId]),
  });
  // Record mode: the drag wrote through `entity.set`, which bypasses writeTraitField, so the animation record hook
  // never saw it. Notify it for the fields that actually moved (no-op when not recording), so a drag keys the clip.
  for (const k of RECORDED[trait]) if (changed.includes(k)) notifyFieldEdited(entityId, trait, k, a[k]);
}
