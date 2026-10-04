/** The single per-drag Transform undo step both gizmos (2D Canvas + 3D TransformControls)
 *  push at drag END — extracted so the close-over-before/after logic lives in ONE place
 *  and is unit-testable without rendering SceneView (gizmos: one-undo-per-drag). A drag
 *  produces exactly one of these (built at pointer/mouse-up from the start vs final
 *  transform), so undo reverses the whole gesture in one step. */

import type { UndoAction } from '../undo/undoManager';
import { fireDirtyListeners } from '../../runtime/core/renderDirty';
import { markOverrideIfInstance, putFieldRows, requireRowRecords } from '../undo/overrideMarkWrites';
import * as instanceEdits from '../instance/instanceEdits';

/** Minimal entity surface the undo closures touch. `get` is `| undefined` because a koota handle's
 *  is — declaring it never-undefined only compiled while `findEntity` returned `any` (#1151). */
export interface UndoEntity {
  has(trait: unknown): boolean;
  get(trait: unknown): Record<string, number> | undefined;
  set(trait: unknown, value: Record<string, number>): void;
}

export interface TransformUndoOptions {
  label: string;
  /** The Transform trait token passed to entity.has/get/set. */
  trait: unknown;
  /** Re-resolve the entity id from a guid-stable ref INSIDE the closures — a captured
   *  koota handle/raw id goes stale on delete/restore or a Play→Stop world rebuild. The editor passes the ref's
   *  `require`, which THROWS `UndoRefusedError` on a miss or a changed kind (#1819, I19): a null here is a no-op, which
   *  reads as done. */
  resolve: () => number | null;
  findEntity: (id: number) => UndoEntity | null | undefined;
  /** Only the Transform fields the drag changed, at drag start. */
  before: Record<string, number>;
  /** The same fields at drag end. */
  after: Record<string, number>;
  /** Stable GUID of the dragged entity (Percept V2b). When provided, the action is
   *  journalled as `!transform` with a `{ entity, before, after }` payload so Claude
   *  perceives the spatial edit — the changed field subset, old→new. Omit to skip
   *  journalling (the action then falls back to a bare `!edit`). */
  entityGuid?: string;
  /** The Transform fields this drag records as prefab-instance overrides: a deliberate edit, like the Inspector's. The
   *  builder records them when it is built, and its undo and redo put back each side's rows, so an undone drag is not
   *  saved as an override pinned at the old pose (#1709). Omit to record nothing. */
  markFields?: readonly string[];
}

/** Each built action's resolver, so a group can ask every member before it moves any. */
const _resolvers = new WeakMap<UndoAction, () => number | null>();

/** Build the undo action. `undo`/`redo` MERGE their field set onto the LIVE transform
 *  (not replace it) so an unrelated field changed between the drag and the undo isn't
 *  clobbered; both re-resolve the entity and no-op if it's gone. */
export function buildTransformUndoAction(opts: TransformUndoOptions): UndoAction {
  const { label, trait, resolve, findEntity, before, after, entityGuid, markFields } = opts;
  // Each side's rows (#2046 S7.2, rule 8): undo and redo put them back exactly, recomputing nothing. The before rows come
  // from the record as it stood before the commit, or none (the drag already wrote live, so rows read now would state the
  // dragged values, review F1): without them (no record) the step puts back the values.
  type Side = { fields: readonly string[]; rows: ReturnType<typeof instanceEdits.rowsOf> | null };
  let sides: { before: Side; after: Side } | undefined;
  const markId = markFields?.length ? resolve() : null;
  if (markId != null && markFields) {
    const was: Side = { fields: markFields, rows: instanceEdits.priorRowsOf([markId]) };
    for (const f of markFields) markOverrideIfInstance(markId, 'Transform', f);
    sides = { before: was, after: { fields: markFields, rows: was.rows && instanceEdits.rowsOf([markId]) } };
  }
  const apply = (fields: Record<string, number>, side?: Side) => {
    const id = resolve();
    if (id == null) return;
    const en = findEntity(id);
    if (!en?.has(trait)) return;
    requireRowRecords(side?.rows);
    en.set(trait, { ...en.get(trait), ...fields });
    if (side) putFieldRows([id], side.rows, 'Transform', side.fields);
    // A direct ECS write fires no dirty broadcast, and undo/redo has none of its own — so without
    // this the Game view (and anything else listening) kept the pre-undo position (#1141 sibling).
    fireDirtyListeners();
  };
  const action: UndoAction = { label, undo: () => apply(before, sides?.before), redo: () => apply(after, sides?.after) };
  _resolvers.set(action, resolve);
  if (entityGuid) {
    action.kind = '!transform';
    // Only the fields this gizmo mode changed — a translate reports {x,y,z}, a
    // rotate {rx,ry,rz}, etc. buildEditorPayload snapshot-clones this at emit.
    action.journalPayload = { entity: entityGuid, before: { ...before }, after: { ...after } };
  }
  return action;
}

/** Combine several per-member transform actions into ONE undo step for a group (multi-select)
 *  gizmo drag, so undo/redo reverses the whole gesture — every member together — in one step
 *  (gizmos: one-undo-per-drag, extended to N members). Journalled as a single `!transform`
 *  carrying every member's guid + before/after so Percept still perceives the group edit. */
export function buildGroupTransformUndoAction(label: string, actions: UndoAction[]): UndoAction {
  // Every member resolved before the first one moves (I19): a `require` that refuses on the third member must not leave
  // the first two moved under an entry that is then dropped.
  const precheck = () => { for (const a of actions) _resolvers.get(a)?.(); };
  const combined: UndoAction = {
    label,
    undo: () => { precheck(); for (const a of actions) a.undo(); },
    redo: () => { precheck(); for (const a of actions) a.redo(); },
  };
  const members = actions.map((a) => a.journalPayload).filter(Boolean) as Record<string, unknown>[];
  if (members.length) {
    combined.kind = '!transform';
    combined.journalPayload = { entities: members.map((m) => m.entity), members };
  }
  return combined;
}
