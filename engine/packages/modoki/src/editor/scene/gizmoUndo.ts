/** The single per-drag Transform undo step both gizmos (2D Canvas + 3D TransformControls)
 *  push at drag END — extracted so the close-over-before/after logic lives in ONE place
 *  and is unit-testable without rendering SceneView (gizmos: one-undo-per-drag). A drag
 *  produces exactly one of these (built at pointer/mouse-up from the start vs final
 *  transform), so undo reverses the whole gesture in one step. */

import type { UndoAction } from '../undo/undoManager';

/** Minimal entity surface the undo closures touch. */
export interface UndoEntity {
  has(trait: unknown): boolean;
  get(trait: unknown): Record<string, number>;
  set(trait: unknown, value: Record<string, number>): void;
}

export interface TransformUndoOptions {
  label: string;
  /** The Transform trait token passed to entity.has/get/set. */
  trait: unknown;
  /** Re-resolve the entity id from a guid-stable ref INSIDE the closures — a captured
   *  koota handle/raw id goes stale on delete/restore or a Play→Stop world rebuild. */
  resolve: () => number | null;
  findEntity: (id: number) => UndoEntity | undefined;
  /** Only the Transform fields the drag changed, at drag start. */
  before: Record<string, number>;
  /** The same fields at drag end. */
  after: Record<string, number>;
  /** Stable GUID of the dragged entity (Percept V2b). When provided, the action is
   *  journalled as `!transform` with a `{ entity, before, after }` payload so Claude
   *  perceives the spatial edit — the changed field subset, old→new. Omit to skip
   *  journalling (the action then falls back to a bare `!edit`). */
  entityGuid?: string;
}

/** Build the undo action. `undo`/`redo` MERGE their field set onto the LIVE transform
 *  (not replace it) so an unrelated field changed between the drag and the undo isn't
 *  clobbered; both re-resolve the entity and no-op if it's gone. */
export function buildTransformUndoAction(opts: TransformUndoOptions): UndoAction {
  const { label, trait, resolve, findEntity, before, after, entityGuid } = opts;
  const apply = (fields: Record<string, number>) => {
    const id = resolve();
    if (id == null) return;
    const en = findEntity(id);
    if (en?.has(trait)) en.set(trait, { ...en.get(trait), ...fields });
  };
  const action: UndoAction = { label, undo: () => apply(before), redo: () => apply(after) };
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
  const combined: UndoAction = {
    label,
    undo: () => { for (const a of actions) a.undo(); },
    redo: () => { for (const a of actions) a.redo(); },
  };
  const members = actions.map((a) => a.journalPayload).filter(Boolean) as Record<string, unknown>[];
  if (members.length) {
    combined.kind = '!transform';
    combined.journalPayload = { entities: members.map((m) => m.entity), members };
  }
  return combined;
}
