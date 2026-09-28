/** THE editor's override-mark writes: how an editor gesture tells the scene save that a prefab-instance field is
 *  the instance's own edit (#1709).
 *
 *  The save keeps a member's field only when it is MARKED (the mark gate in `captureInstanceOverrides`; the marks
 *  themselves are `runtime/loaders/overrideMarks.ts`). So every editor write that changes a field on a member has to
 *  leave the mark in the state the save needs, and every undo has to put it back. #1709 found gestures that wrote raw
 *  (the UI resize/move handles, every `sortOrder` rewrite, re-adding a trait the template defines) and saved nothing,
 *  and undos that restored the value but kept the mark, so an undone edit was saved pinned at the old value. The
 *  writes go through here instead of marking at each call site.
 *
 *  Two rules, on purpose:
 *  - {@link markOverrideIfInstance} marks unconditionally. It is what a DELIBERATE field edit does (the Inspector, a
 *    gizmo commit, agent `setTrait`): the user typed that value, so it stays an override even when it equals the base.
 *  - {@link reconcileOverrideMarks} applies the save's by-value rule: marked where the live value differs from the
 *    instance's base, unmarked where it equals it. It is for a write the user did not aim at that field: a sibling
 *    renumber rewrites every child's `sortOrder`, and marking them all would pin the whole child order of the
 *    instance, so a later template reorder or insert could never reach it (hub, 2026-09-28). The UI handles and a
 *    re-added trait use it too: the handle writes every axis of its field group, and a re-added trait is the
 *    template's defaults wherever the user did not set a value.
 *
 *  The base is {@link instanceBase}, the one the Inspector highlight and the override list diff against. */

import { getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { markOverride, unmarkOverride, getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { collectComparableTraits, getOverrideValues, getCachedPrefabSync, instanceBase, baseTokenResolver } from '../scene/prefab';
import { makeReorderSiblingsAction, type SiblingSortChange } from './reorderSiblingsUndo';
import type { UndoAction } from './undoManager';

interface MemberPi { source?: string; localId?: number; rootInstanceId?: number }

/** The entity, when it is a prefab-instance member (the root included). */
function memberEntity(entityId: number) {
  const piMeta = getTraitByName('PrefabInstance');
  const entity = findEntity(entityId);
  if (!piMeta || !entity || !entity.has(piMeta.trait)) return null;
  return { entity, pi: entity.get(piMeta.trait) as MemberPi };
}

/** Record a deliberate per-instance override when the user edits a field on a
 *  prefab-instance member, so the change survives serialize even if the prefab
 *  base is later edited to coincide with it — AND so override capture can tell a
 *  real edit from a field that merely diverged from the base when the prefab was
 *  re-imported under an un-edited instance (the rigged-reimport root-bone bug).
 *  No-op for non-instance entities and for the PrefabInstance trait itself.
 *  See overrideMarks.ts + getOverrideValues/captureInstanceOverrides. */
export function markOverrideIfInstance(entityId: number, traitName: string, field: string): void {
  if (traitName === 'PrefabInstance') return;
  const m = memberEntity(entityId);
  if (m) markOverride(m.entity, traitName, field);
}

/** The fields of `meta` on member `entityId` whose live value differs from what the instance resolves them to with
 *  no override of its own, or null when that base cannot be read (its template is not cached). A trait the template
 *  does not define here counts as differing whole (`getOverrideValues`' added-trait rule). */
function fieldsOffBase(entityId: number, meta: TraitMeta, pi: MemberPi): Set<string> | null {
  if (!pi.source || !pi.localId) return null;
  const prefab = getCachedPrefabSync(pi.source);
  if (!prefab) return null;
  const root = pi.rootInstanceId || 0;
  const current = collectComparableTraits(entityId, [meta]);
  const diffs = getOverrideValues(pi.localId, current, root ? instanceBase(root, prefab) : prefab, root ? baseTokenResolver(root) : undefined);
  return new Set(Object.keys(diffs[meta.name] ?? {}));
}

/** Settle the marks on `fields` of `meta` (every field the entity's trait holds when omitted) to the save's by-value
 *  rule: marked where the live value differs from the instance's base, unmarked where it equals it. A base that
 *  cannot be read marks, so what the screen shows is kept. No-op off an instance, for a tag, and for a trait the
 *  entity does not have. */
export function reconcileOverrideMarks(entityId: number, meta: TraitMeta, fields?: readonly string[]): void {
  if (meta.name === 'PrefabInstance' || meta.category === 'tag') return;
  const m = memberEntity(entityId);
  if (!m || !m.entity.has(meta.trait)) return;
  const off = fieldsOffBase(entityId, meta, m.pi);
  const list = fields ?? Object.keys(collectComparableTraits(entityId, [meta])[meta.name] ?? {});
  for (const f of list) {
    if (off === null || off.has(f)) markOverride(m.entity, meta.name, f);
    else unmarkOverride(m.entity, meta.name, f);
  }
}

/** Write one field, then settle its mark by {@link reconcileOverrideMarks}. THE write for a field an editor gesture
 *  changes without the user aiming at it: every `sortOrder` rewrite (reorder, renumber, reparent, duplicate, paste,
 *  scene move) goes through this. */
export function writeTraitFieldMarked(entityId: number, meta: TraitMeta, field: string, value: unknown): void {
  writeTraitField(entityId, meta, field, value);
  reconcileOverrideMarks(entityId, meta, [field]);
}

/** The Hierarchy's sibling renumber as one undo step, built (but not applied: call `redo()` once, then push it) with
 *  the marks it must put back. Forward, each `sortOrder` is written marked by value ({@link writeTraitFieldMarked}):
 *  marking every renumbered sibling would pin the instance's whole child order against the template. Back, each
 *  sibling gets its old value AND its old mark ({@link restorableSortOrderWrite}), snapshotted HERE, before the
 *  renumber runs: a snapshot taken after it would hold the marks the renumber added, and the undo would pin the old
 *  order (#1709). Lives here, not in the panel, so the ordering is testable. */
export function makeSortOrderRenumberAction(changes: SiblingSortChange[], label = 'Renumber siblings'): UndoAction | null {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return null;
  return makeReorderSiblingsAction(
    changes, (id, sort) => writeTraitFieldMarked(id, attrMeta, 'sortOrder', sort), label,
    restorableSortOrderWrite(changes.map((c) => c.id)),
  );
}

/** The UNDO of a `sortOrder` rewrite on `ids`: a writer that restores the value AND the `sortOrder` mark each entity
 *  has now (call it before the rewrite). Re-reconciling on the way back would drop a stored override that happened to
 *  equal the base, and the save would lose it (#1709 close-out review). */
function restorableSortOrderWrite(ids: readonly number[]): (id: number, sort: number) => void {
  const attrMeta = getTraitByName('EntityAttributes');
  const was = new Map(ids.map((id) => [id, markStateOf(id, 'EntityAttributes', ['sortOrder'])]));
  return (id, sort) => {
    if (!attrMeta) return;
    writeTraitField(id, attrMeta, 'sortOrder', sort);
    const state = was.get(id);
    if (state) putMarkState(id, 'EntityAttributes', state);
  };
}

/** Whether each of `fields` of `traitName` is marked on the entity now: taken before a write, so its undo can put
 *  the marks back with {@link putMarkState} (and after it, for the redo). */
export type MarkState = Record<string, boolean>;
export function markStateOf(entityId: number, traitName: string, fields: readonly string[]): MarkState {
  const e = findEntity(entityId);
  const set = e ? getOverrideMarkSet(e) : undefined;
  const out: MarkState = {};
  for (const f of fields) out[f] = !!set?.has(`${traitName}.${f}`);
  return out;
}
export function putMarkState(entityId: number, traitName: string, state: MarkState): void {
  const e = findEntity(entityId);
  if (!e) return;
  for (const [f, marked] of Object.entries(state)) {
    if (marked) markOverride(e, traitName, f);
    else unmarkOverride(e, traitName, f);
  }
}
