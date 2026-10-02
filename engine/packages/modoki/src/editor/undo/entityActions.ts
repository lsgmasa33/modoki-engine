/** Editor-only entity actions with undo support.
 *  Wraps runtime entityUtils with undo/redo tracking. */

import { emptyDocMap, hasDocKey } from '../../runtime/core/docKeys';
import { getCurrentWorld, spawnEntity, findEntityByGuid, indexEntityGuid } from '../../runtime/core/ecs/world';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { reparentRefusal, parentRefusal, type ReparentRefusal } from '../../runtime/core/ecs/hierarchy';
import {
  findEntity, readTraitData, readTraitDataFull, writeTraitField,
  getAllEntities, deleteEntity, markStructureDirty, cloneTraitValues, subtreeIds, carryEntityIdFields,
} from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { remapGuidValues } from '../../runtime/core/assetRefRules';
import { planCopyGuids } from '../../runtime/core/copyIdentity';
import { markOverride, getCarriedOverrideMarks, restoreOverrideMarks, clearOverrideMarks } from '../../runtime/loaders/overrideMarks';
import { markOverrideIfInstance, recordOverridesByDiff, writeTraitFieldMarked, markStateOf, putMarkState, captureMarks, restoreMarks, recordDetachedMarks, relinkDetachedMembersMarked, takeUnmarkedFromBase, type MarkCapture, type MarkState } from './overrideMarkWrites';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { traitRemoveRefusal, traitWriteRefusal } from '../../runtime/core/ecs/traitEditPolicy';
import { endFrames, captureRootLinks, restoreRootLinks, promoteOwnedRoots, applyGuidRemap, type DetachedMember } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, linkOwnerBeforeMove, frameDocReader, frameRootDoc, noteFrameRootDoc, type TemplateDoc } from '../../runtime/core/ecs/identityParents';
import { isStoredRoot, isOwnedRoot, durableGuid, type MemberPi } from '../../runtime/core/assetRefRules';
import { captureMarkers, restoreMarkers, type CarriedMarkers } from '../../runtime/core/carriedMarkers';
import { copyUnresolvedRef, recordGuidMints, keptGuidMints } from './unresolvedRefCopy';
import { keptStateOf, restoreKeptState, type KeptState } from '../../runtime/core/ecs/keptOrphanRows';
import { reparentSuffixes, reparentWrite, mergeTrs, IDENTITY_TRS, type PoseHierarchy } from '../../runtime/scene/transformSpace';
import { pushAction, peekUndo, type EditDetail } from './undoManager';
import { packedOf, type PackedEntity } from '../../runtime/core/ecs/entityTable';
import { currentFieldGesture } from './fieldGesture';
import { UndoRefusedError } from './undoFailure';
import type { EditorJournalType } from '../editorJournal';
import { arrive, checkRef, refsCheck, type StepCheck, type CheckPass } from './stepCheck';
import { entityRef, ensureGuid, buildGuidIndex, resolveWith, requireWith, requireAll, renamesOf, requireDetachedMembers, journalRefOf, type EntityRef } from './entityRef';
import { placeholderWriteRefusal, placeholderWriteRefusalAny, entityNameOf } from './placeholderGate';
import { useEditorStore } from '../store/editorStore';
import { notifyFieldEdited } from '../animation/recording';
import { prefabEditWorldGuid } from '../scene/prefabEditWorld';
import { nestedDeclaredKeys, type TemplateKeyDoc } from '../../runtime/loaders/templateKeyRecovery';
import { resolveAffectedScenes, rawSourceScene, adoptParentScene } from '../scene/sceneDirty';
import { assertPrefabEditAllows, prefabEditRefusal, type PrefabEditRefusalReason } from '../scene/prefabEditRefusal';
import { SCAFFOLD_PREFIX } from '../scene/prefabEditGuids';
import { restructureRefusal, reorderWriteRefusal, isSuppliedByPrefab, suppliedByPrefabChecker, RESTRUCTURE_REFUSAL_TEXT } from '../scene/restructureRefusal';
import { prefabNestingReader, getCachedPrefabSync } from '../scene/prefabCache';
import { rebaseStaleInstancesSoon } from '../scene/prefabRebuild';
import { leftBehindReader } from '../scene/prefabBase';
import { translateLocalIds } from '../../runtime/loaders/memberTranslation';
import * as instanceEdits from '../instance/instanceEdits';

// The override-mark writes live in `overrideMarkWrites.ts` (#1709); re-exported for the callers that import them here.
export { markOverrideIfInstance };

function markFieldOverrideIfInstance(entityId: number, meta: TraitMeta, field: string): void {
  markOverrideIfInstance(entityId, meta.name, field);
}

/** Put a freshly spawned copy (Duplicate, Paste Entity) last among `parentId`'s children: max sibling sortOrder + 1.
 *  `respawnFromSnapshot` copies the source's EntityAttributes verbatim, sortOrder included, so the copy would
 *  collide with its source and break drag-to-reorder's distinct-position math. Excludes the copy itself from the max
 *  so the copied value can't inflate the result. Written marked: a copied instance ROOT saves its sortOrder only
 *  when marked (#1709). A copy of a Missing Prefab placeholder takes one too, wherever it lands: both shapes its save
 *  writes keep it (#1901). */
export function assignFreshSortOrder(newId: number, parentId: number): void {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return;
  const siblings = getAllEntities().filter((e) => e.parentId === parentId && e.id !== newId);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map((e) => e.sortOrder)) + 1 : 0;
  writeTraitFieldMarked(newId, attrMeta, 'sortOrder', nextSort);
}

/** Why the Hierarchy's sibling drop of `moverId` under `targetParent` must not run, decided BEFORE its renumber writes
 *  anything, so a refused drop leaves no renumber entry behind (#1818 close-out re-review). `reparent`: the reparent's
 *  own refusal (self-parent, cycle, prefab edit: `planReparent`), which the caller leaves to `requestReparent` to report
 *  as it always has. `restructure`: an object a prefab supplies, whose place is the prefab's (#1869). A Missing Prefab
 *  placeholder is reordered like any entity: both shapes its save writes keep the order (#1901). */
export function siblingDropRefusal(moverId: number, targetParent: number): { kind: 'reparent' } | { kind: 'restructure'; reason: string } | null {
  if (planReparent(moverId, targetParent).kind === 'refused') return { kind: 'reparent' };
  // A sibling drop gives the mover a new place, so a prefab-supplied mover is refused even under its own parent (#1869).
  const restructure = restructureRefusal({ id: moverId, parentId: targetParent, reorder: true });
  return restructure ? { kind: 'restructure', reason: restructure } : null;
}

/** Whether the Hierarchy's renumber after a tie leaves sibling `id`'s `sortOrder` where it is, numbering the rest around
 *  it (`planCollidingDrop`'s `fixed`): an object a prefab supplies, whose place is the prefab's — a renumber would reorder
 *  the instance (#1869). */
export function siblingKeepsItsPlace(id: number, supplied: (id: number) => boolean = isSuppliedByPrefab): boolean {
  return supplied(id);
}

/** {@link siblingKeepsItsPlace} for one renumber's siblings, asked against one world (`suppliedByPrefabChecker`). */
export function siblingsKeepingTheirPlace(): (id: number) => boolean {
  const supplied = suppliedByPrefabChecker();
  return (id) => siblingKeepsItsPlace(id, supplied);
}

/** The words for a colliding drop `planCollidingDrop` found no room for, naming the sibling that keeps its place: an
 *  object a prefab supplies, the one kind that does since a Missing Prefab placeholder's order is saved (#1901). */
export function stuckDropText(stuck: number): string {
  return `Can't place it here: "${entityNameOf(stuck)}" and its neighbour share one place in the prefab's order, so there is no room between them, and the prefab's own objects are not renumbered. Place it before or after both.`;
}

/** Say a write was refused before it changed anything (#1818): the console for the record, and a toast, since the
 *  Inspector or the Hierarchy that asked shows no error of its own. Returns `reason` so a writer can hand it on (the
 *  agent ops reply with it). */
export function reportWriteRefusal(reason: string): string {
  console.error(`[entityActions] refused: ${reason}`);
  try { useEditorStore.getState().showToast(reason, 'warn'); } catch { /* no store (a headless caller): the log stands */ }
  return reason;
}

/** A gesture that writes `trait` LIVE while it runs and commits at its end (a gizmo, collider-point or UI-handle drag):
 *  the placeholder gate's refusal for it (#1818, I21), reported, or null. A Missing Prefab placeholder keeps the
 *  entry's root traits (a Transform among them), so the gizmo can drag one, and its save writes the kept record's values
 *  back over the drag. A refused caller puts the live values back to where the gesture started and pushes no entry. */
export function placeholderGestureRefusal(ids: readonly number[], trait: string): string | null {
  const refused = placeholderWriteRefusalAny(ids, trait);
  return refused ? reportWriteRefusal(refused) : null;
}

/** The open field GESTURE: the record each entity's field held when it began, its coalesce key, the Inspector field
 *  session it belongs to (`fieldGesture.ts`), and the undo entry its last write left on top. Keyed by the PACKED entity:
 *  a gesture outlives the frame, and a recycled index must not inherit another entity's record (#868). */
let gesture: { key: string; session: string; marks: Map<PackedEntity, MarkState>; records: Map<PackedEntity, instanceEdits.FieldRecordState | null>; top: unknown } | null = null;

/** Put back the record `field` held on each of `ids` when the gesture this write CONTINUES began (#1914, the hub's
 *  #1922 finding), so the write then records over it (`markFieldOverrideIfInstance`). An Inspector number field commits
 *  on every keystroke, so retyping 200 over a base of 200 wrote 2 and 20 first, each different from the base, and the
 *  recorder (which never takes a record off, F3) kept the record. Unity commits a typed field once, at Enter/blur, so a
 *  retype records nothing. Here every keystroke still writes live; the record a gesture leaves is what it started with
 *  plus what its FINAL value differs in.
 *
 *  What one gesture is: an Inspector field's edit SESSION (`BufferedEdit.session`) while nothing else was pushed in
 *  between — no clock, so a slow typist is one gesture, and a missed blur (#242: focus events need not fire) only joins
 *  two typings with no other edit between them. Outside a field session every write is its own gesture, as each scripted
 *  write is in Unity: an agent's two `setTrait`s, a scrub's frames (owner ruling F3 for each). Not the undo's coalesce
 *  chain: two discrete writes inside its window would be one gesture, and the second, landing on the base, would drop
 *  the first's record. Call it AFTER reading the undo's mark state: the undo restores what the entity held before THIS
 *  write (a merged chain keeps its first entry's anyway). `endGestureWrite` closes the write. */
function resumeGesture(key: string | undefined, ids: readonly number[], trait: string, field: string): void {
  const session = currentFieldGesture();
  if (key === undefined || session === null) { gesture = null; return; } // a write no gesture continues
  const continues = !!gesture && gesture.key === key && gesture.session === session && gesture.top === peekUndo();
  const packed = (id: number) => { const e = findEntity(id); return e ? packedOf(e) : undefined; };
  if (continues) {
    for (const id of ids) {
      const p = packed(id);
      const m = p === undefined ? undefined : gesture!.marks.get(p);
      if (m) putMarkState(id, trait, m);
      const r = p === undefined ? undefined : gesture!.records.get(p);
      if (r) instanceEdits.putFieldRecord(r); // #2001 S4: the door's record of the gesture's start, as the marks
    }
    return;
  }
  const marks = new Map<PackedEntity, MarkState>();
  const records = new Map<PackedEntity, instanceEdits.FieldRecordState | null>();
  for (const id of ids) {
    const p = packed(id);
    if (p === undefined) continue;
    marks.set(p, markStateOf(id, trait, [field]));
    records.set(p, instanceEdits.fieldRecordOf(id, trait));
  }
  gesture = { key, session, marks, records, top: undefined };
}

/** After a gesture's write is pushed: the entry it left on top, which only a continuing write may find there. */
function endGestureWrite(): void {
  if (gesture) gesture.top = peekUndo();
}

/** Write a field with undo tracking. Returns the refusal's words when the placeholder gate refuses it (#1818), else
 *  null. */
export function writeTraitFieldWithUndo(entityId: number, meta: TraitMeta, field: string, value: unknown): string | null {
  const refused = placeholderWriteRefusal(entityId, meta.name, field) ?? reorderWriteRefusal([entityId], meta.name, field, value);
  if (refused) return reportWriteRefusal(refused);
  let oldValue: unknown;
  if (meta.category === 'tag') {
    const entity = findEntity(entityId);
    oldValue = entity ? entity.has(meta.trait) : false;
  } else {
    // readTraitDataFull (not the curated readTraitData) so off-meta fields — e.g. the
    // Animator `clips` bank, AudioSource clips, AoS object fields — capture their REAL
    // prior value; readTraitData drops them, so undo would restore `undefined` (wipe).
    const data = readTraitDataFull(entityId, meta);
    oldValue = data ? data[field] : undefined;
  }
  // Resolve BEFORE the write — a field edit never changes sourceScene, but this is
  // the uniform "resolve before mutation" convention (Phase 12, M2) every affected-
  // scene call in this file follows.
  const affectedScenes = resolveAffectedScenes([entityId]);
  // The undo puts the mark back as it was, or an undone edit is saved as an override at the old value (#1709): as it was
  // before the GESTURE, which is also the state the write records over.
  const coalesceKey = fieldCoalesceKey(meta, field, [entityId]);
  const oldMarks = markStateOf(entityId, meta.name, [field]);
  resumeGesture(coalesceKey, [entityId], meta.name, field);
  writeTraitField(entityId, meta, field, value);
  markFieldOverrideIfInstance(entityId, meta, field);
  // The redo puts back the record THIS write left, not a fresh diff (#1914, work-qa's finding A): inside a field session the
  // write records over the gesture's start (`resumeGesture`), so a redo that re-recorded by diff gave 2 and 20 their
  // records back and left 200 — the base — recorded after undo×3, redo×3.
  const newMarks = markStateOf(entityId, meta.name, [field]);
  // Capture a guid-based ref so undo/redo survive a world rebuild (Play→Stop).
  const ref = entityRef(entityId);
  _pushAction({
    label: `Edit ${meta.name}.${field || 'toggle'}`,
    // `require` (I19): a target a world swap removed, or turned into a placeholder, refuses rather than reading as done.
    undo: () => { const id = ref.require(); writeTraitField(id, meta, field, oldValue); putMarkState(id, meta.name, oldMarks); },
    redo: () => { const id = ref.require(); writeTraitField(id, meta, field, value); putMarkState(id, meta.name, newMarks); },
    check: refsCheck(() => [ref]), // #2010: the same `require`, askable before a batch runs
    coalesceKey,
    detail: editDetail([ref], meta, field, [oldValue], [value]),
    affectedScenes,
  });
  endGestureWrite();
  // Animation record mode: key this field at the playhead (no-op unless recording).
  notifyFieldEdited(entityId, meta.name, field, value);
  return null;
}

/** Write one field to the same trait across many entities, captured as a single
 *  undo entry. Each entity's prior value (or tag membership) is snapshotted
 *  individually so undo restores them even when they differed (mixed values).
 *  Only the named field is touched — other (possibly mixed) fields are left
 *  per-entity as they were. */
export function writeTraitFieldMultiWithUndo(entityIds: number[], meta: TraitMeta, field: string, value: unknown): string | null {
  if (entityIds.length === 0) return null;
  // One refusal for the whole selection (#1818): skipping the placeholder would write the rest as one entry the user
  // did not ask for.
  // …and one for a reorder of an object a prefab supplies (#1869).
  const refused = placeholderWriteRefusalAny(entityIds, meta.name, field) ?? reorderWriteRefusal(entityIds, meta.name, field, value);
  if (refused) return reportWriteRefusal(refused);
  const oldValues = entityIds.map((id) => {
    if (meta.category === 'tag') {
      const entity = findEntity(id);
      return entity ? entity.has(meta.trait) : false;
    }
    const data = readTraitDataFull(id, meta); // off-meta fields (see writeTraitFieldWithUndo)
    return data ? data[field] : undefined;
  });
  const affectedScenes = resolveAffectedScenes(entityIds);
  const coalesceKey = fieldCoalesceKey(meta, field, entityIds);
  const oldMarks = entityIds.map((id) => markStateOf(id, meta.name, [field])); // put back by the undo (#1709)
  resumeGesture(coalesceKey, entityIds, meta.name, field);
  entityIds.forEach((id) => { writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); });
  const newMarks = entityIds.map((id) => markStateOf(id, meta.name, [field])); // put back by the redo (finding A, above)
  // Guid refs (positionally aligned with oldValues) so undo/redo survive a rebuild.
  const refs = entityIds.map((id) => entityRef(id));
  const suffix = entityIds.length > 1 ? ` (${entityIds.length})` : '';
  _pushAction({
    label: `Edit ${meta.name}.${field || 'toggle'}${suffix}`,
    // Every ref required before the first write (I19): one missing entity refuses the whole entry, never half of it.
    undo: () => { const ids = requireAll(refs); ids.forEach((id, i) => { writeTraitField(id, meta, field, oldValues[i]); putMarkState(id, meta.name, oldMarks[i]!); }); },
    redo: () => { const ids = requireAll(refs); ids.forEach((id, i) => { writeTraitField(id, meta, field, value); putMarkState(id, meta.name, newMarks[i]!); }); },
    check: refsCheck(() => refs), // #2010
    coalesceKey,
    detail: editDetail(refs, meta, field, oldValues, refs.map(() => value)),
    affectedScenes,
  });
  endGestureWrite();
  // Animation record mode: key each edited entity's field at the playhead.
  entityIds.forEach((id) => notifyFieldEdited(id, meta.name, field, value));
  return null;
}

/** Write the same trait field across many entities where the NEW value is derived
 *  per-entity from that entity's CURRENT value, captured as one undo entry. Unlike
 *  writeTraitFieldMultiWithUndo (one value broadcast to all), this preserves each
 *  entity's other state — essential for fields holding composite values (e.g.
 *  UIAction.bindings, an array of objects) where the user edits ONE sub-field and
 *  every other sub-field must stay per-entity. `compute(oldValue, id)` returns the
 *  entity's new field value; return the old value unchanged to skip an entity. */
export function writeTraitFieldPerEntityWithUndo(
  entityIds: number[], meta: TraitMeta, field: string,
  compute: (oldValue: unknown, id: number) => unknown, label: string,
): string | null {
  if (entityIds.length === 0) return null;
  const refused = placeholderWriteRefusalAny(entityIds, meta.name, field); // #1818, as above
  if (refused) return reportWriteRefusal(refused);
  const entries = entityIds.map((id) => {
    // readTraitDataFull: `compute` derives the new value from the old, so an off-meta
    // field (Animator `clips` bank, etc.) MUST read its real value here — with the curated
    // readTraitData it came back undefined and `compute` wrote an empty bank (clip-name
    // rename wiped the whole clips list).
    const data = readTraitDataFull(id, meta);
    const oldValue = data ? data[field] : undefined;
    return { id, ref: entityRef(id), oldValue, newValue: compute(oldValue, id), oldMarks: markStateOf(id, meta.name, [field]) };
  }).filter((e) => !Object.is(e.oldValue, e.newValue));
  if (entries.length === 0) return null;
  const reordered = entries.map((e) => reorderWriteRefusal([e.id], meta.name, field, e.newValue)).find((r) => r); // #1869
  if (reordered) return reportWriteRefusal(reordered);
  const affectedScenes = resolveAffectedScenes(entries.map((e) => e.id));
  // One gesture with the writers above (#1932, R4-L1 finding 2): a composite sub-field typed in a `BufferedNumberInput`
  // (a binding's value, a material override's constant, an anim bank's numbers) commits on every keystroke, so retyping
  // the base value recorded its "2" and "20", and F3 kept the record. After the old marks are read (`entries`).
  const coalesceKey = fieldCoalesceKey(meta, field, entityIds);
  resumeGesture(coalesceKey, entries.map((e) => e.id), meta.name, field);
  entries.forEach(({ id, newValue }) => { writeTraitField(id, meta, field, newValue); markFieldOverrideIfInstance(id, meta, field); });
  // The redo puts back the record THIS write left, not a fresh diff (finding A, as above).
  const newMarks = entries.map((e) => markStateOf(e.id, meta.name, [field]));
  const suffix = entries.length > 1 ? ` (${entries.length})` : '';
  _pushAction({
    label: `${label}${suffix}`,
    // Resolved by guid each invocation, so undo/redo survive a rebuild; every ref before the first write (I19).
    undo: () => { const ids = requireAll(entries.map((e) => e.ref)); entries.forEach(({ oldValue, oldMarks }, i) => { writeTraitField(ids[i], meta, field, oldValue); putMarkState(ids[i], meta.name, oldMarks); }); },
    redo: () => { const ids = requireAll(entries.map((e) => e.ref)); entries.forEach(({ newValue }, i) => { writeTraitField(ids[i], meta, field, newValue); putMarkState(ids[i], meta.name, newMarks[i]!); }); },
    check: refsCheck(() => entries.map((e) => e.ref)), // #2010
    coalesceKey,
    detail: editDetail(entries.map((e) => e.ref), meta, field, entries.map((e) => e.oldValue), entries.map((e) => e.newValue)),
    affectedScenes,
  });
  endGestureWrite();
  entries.forEach(({ id, newValue }) => notifyFieldEdited(id, meta.name, field, newValue));
  return null;
}

/** Write SEVERAL fields of one trait per-entity as a SINGLE undo entry. `compute`
 *  receives the entity's FULL live trait data (including AoS object/array fields not in
 *  meta.fields, via readTraitDataFull) and returns a partial patch {field: newValue}.
 *  Use for compound edits that must undo in one step — e.g. a SpriteAnimator track
 *  rename/add/delete that touches both `clips` and the active `clip`. Resolves entities
 *  by guid at apply-time so undo/redo survive Play→Stop world rebuilds.
 *  NOTE (Percept V1): this compound multi-field helper does NOT attach a structured
 *  `EditDetail` — that shape describes a single {field, old, new}, which can't represent
 *  a multi-field patch. Its `!edit` journal event is label-only. Reachable via
 *  SpriteAnimator clip/track ops; the single-field helpers above carry full detail. */
export function writeTraitFieldsPerEntityWithUndo(
  entityIds: number[], meta: TraitMeta,
  compute: (oldFull: Record<string, unknown> | null, id: number) => Record<string, unknown>,
  label: string,
): string | null {
  if (entityIds.length === 0) return null;
  const entries = entityIds.map((id) => {
    const full = readTraitDataFull(id, meta);
    const patch = compute(full, id);
    const oldValues: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) oldValues[k] = full ? full[k] : undefined;
    return { id, ref: entityRef(id), oldValues, patch, oldMarks: markStateOf(id, meta.name, Object.keys(patch)) };
  }).filter((e) => Object.keys(e.patch).length > 0);
  if (entries.length === 0) return null;
  // #1818, as above — per field, since the patch decides which fields this write touches.
  for (const e of entries) {
    for (const field of Object.keys(e.patch)) {
      const refused = placeholderWriteRefusal(e.id, meta.name, field);
      if (refused) return reportWriteRefusal(refused);
    }
  }
  const affectedScenes = resolveAffectedScenes(entries.map((e) => e.id));
  const writeMany = (id: number, values: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(values)) { writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); }
  };
  const applyAll = () => {
    const ids = requireAll(entries.map((e) => e.ref)); // I19
    entries.forEach(({ patch }, i) => writeMany(ids[i], patch));
  };
  applyAll();
  const suffix = entries.length > 1 ? ` (${entries.length})` : '';
  _pushAction({
    label: `${label}${suffix}`,
    // Raw writes plus the old marks: `writeMany` would MARK the old values, saving an undone edit as an override (#1709).
    undo: () => {
      const ids = requireAll(entries.map((e) => e.ref)); // I19
      entries.forEach(({ oldValues, oldMarks }, i) => {
        for (const [field, value] of Object.entries(oldValues)) writeTraitField(ids[i], meta, field, value);
        putMarkState(ids[i], meta.name, oldMarks);
      });
    },
    redo: applyAll,
    check: refsCheck(() => entries.map((e) => e.ref)), // #2010
    affectedScenes,
  });
  entries.forEach(({ id, patch }) => { for (const [field, value] of Object.entries(patch)) notifyFieldEdited(id, meta.name, field, value); });
  return null;
}

/** Keys of `values` the trait actually declares. A clipboard entry captured before a
 *  registry change can carry fields the trait has since dropped. AoS traits expose
 *  `schema` as a function — nothing to filter against, so the values pass through and
 *  the trait factory takes what it knows. */
export function filterToTraitSchema(meta: TraitMeta, values: Record<string, unknown>): Record<string, unknown> {
  const schema = (meta.trait as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object') return values;
  return Object.fromEntries(Object.entries(values).filter(([k]) => k in (schema as object)));
}

/** Add a component trait to every selected entity that doesn't already have it,
 *  as a single undo entry. Entities that already carry the trait are skipped so
 *  their existing data isn't clobbered. No-op (no undo entry) if all already have it.
 *
 *  `values` (optional) prefills the new trait — this is what "Paste Component As New"
 *  is: an add-component that isn't left at defaults. It lives here rather than in a
 *  separate paste action because add-and-populate must be ONE undo entry (composing
 *  add + write would push two, and a single Cmd+Z would leave a half-pasted component
 *  behind), and because a parallel copy of this body would silently miss future fixes
 *  to the add path. Values are cloned per entity so two pasted entities never share an
 *  array. `label` overrides the action label ("Paste X As New" vs "Add X"). */
export function addTraitToEntitiesWithUndo(
  entityIds: number[], meta: TraitMeta,
  values?: Record<string, unknown>,
  label = `Add ${meta.name}`,
): string | null {
  const refused = traitWriteRefusal(meta.name); // #1454: callers hide the action; this is the one seam they share
  if (refused) { console.error(`[entityActions] ${refused}`); return refused; }
  const targets = entityIds.filter((id) => {
    const e = findEntity(id);
    return !!e && !e.has(meta.trait);
  });
  if (targets.length === 0) return null;
  const onPlaceholder = placeholderWriteRefusalAny(targets, meta.name); // #1818: the save would drop the component
  if (onPlaceholder) return reportWriteRefusal(onPlaceholder);
  const affectedScenes = resolveAffectedScenes(targets);
  const initial = values ? filterToTraitSchema(meta, values) : undefined;
  const refs = targets.map((id) => entityRef(id));
  // Only this trait's: the add changes no other mark, and its undo's restore must not touch another trait's fields.
  const oldMarks = targets.map((id) => captureMarks(id, meta.name));
  instanceEdits.prepare(targets); // #2014: the door's record, re-seeded before the capture could see the add
  const apply = () => {
    requireAll(refs).forEach((id) => { // I19: every target, before the first add
      // Clone per entity AND per apply: without it, redo would re-seat the same
      // object on every target and they'd share one array.
      findEntity(id)?.add(initial ? meta.trait(cloneTraitValues(initial)) : meta.trait());
      instanceEdits.addComponent(id, meta.name); // #2001 S4: the door's `addComponent` (dual write)
      // A trait the TEMPLATE defines here, added back after the instance removed it, is value-diffed by the save,
      // which keeps only marked fields: unmarked, the re-added values were dropped and the reload showed the
      // template's (#1677). Every field that differs from the base is the instance's own now.
      recordOverridesByDiff(id, meta);
    });
    markUIDirty(); markStructureDirty();
  };
  const revert = () => {
    requireAll(refs).forEach((id, i) => { findEntity(id)?.remove(meta.trait); restoreMarks(id, oldMarks[i]!); });
    markUIDirty(); markStructureDirty();
  };
  apply();
  _pushAction({
    label: `${label}${targets.length > 1 ? ` (${targets.length})` : ''}`,
    undo: revert,
    redo: apply,
    check: refsCheck(() => refs), // #2010
    affectedScenes,
  });
  // Prefilled fields are real field edits: tell the animation recorder, exactly as the
  // trait-field writers do. Without this an armed Auto-Key misses a pasted component's
  // values while catching a Paste-Values onto an existing one.
  if (initial) {
    targets.forEach((id) => {
      for (const [field, value] of Object.entries(initial)) notifyFieldEdited(id, meta.name, field, value);
    });
  }
  return null;
}

/** Remove a component trait from every selected entity that has it, as a single
 *  undo entry. Each entity's trait data is snapshotted so undo restores the
 *  original values. No-op if none carry the trait. */
export function removeTraitFromEntitiesWithUndo(entityIds: number[], meta: TraitMeta): string | null {
  const refused = traitRemoveRefusal(meta.name); // #1454, as above
  if (refused) { console.error(`[entityActions] ${refused}`); return refused; }
  const targets: { ref: EntityRef; data: Record<string, unknown> | null; marks: MarkCapture }[] = [];
  for (const id of entityIds) {
    const e = findEntity(id);
    // readTraitDataFull + clone, for the SAME reason snapshotEntity uses them: readTraitData
    // returns only the curated meta.fields subset, so removing an Animator and undoing came
    // back with an EMPTY clip bank — the values this snapshot exists to restore were never
    // captured. Sibling of QA-CTX-0003, found by its close-out sweep.
    if (e && e.has(meta.trait)) {
      const full = readTraitDataFull(id, meta);
      // Its marks go with its data (#1800): a rebuild before the undo re-seeds them from the file, which records the
      // component as removed, and the save keeps only marked fields.
      targets.push({ ref: entityRef(id), data: full ? cloneTraitValues(full) : null, marks: captureMarks(id, meta.name) });
    }
  }
  if (targets.length === 0) return null;
  const onPlaceholder = placeholderWriteRefusalAny(entityIds.filter((id) => findEntity(id)?.has(meta.trait)), meta.name); // #1818
  if (onPlaceholder) return reportWriteRefusal(onPlaceholder);
  const affectedScenes = resolveAffectedScenes(entityIds);
  const apply = () => {
    requireAll(targets.map((t) => t.ref)).forEach((id) => findEntity(id)?.remove(meta.trait)); // I19
    markUIDirty(); markStructureDirty();
  };
  const revert = () => {
    requireAll(targets.map((t) => t.ref)).forEach((id, i) => {
      findEntity(id)?.add(meta.trait((targets[i].data ?? {}) as Record<string, unknown>));
      restoreMarks(id, targets[i].marks);
    });
    markUIDirty(); markStructureDirty();
  };
  // #2001 S4: the door's `removeComponent` (dual write) — targets read before the removal, committed after it.
  const commitRecord = instanceEdits.beginRemoveComponent(requireAll(targets.map((t) => t.ref)), meta.name);
  apply();
  commitRecord();
  _pushAction({
    label: `Remove ${meta.name}${targets.length > 1 ? ` (${targets.length})` : ''}`,
    undo: revert,
    redo: apply,
    check: refsCheck(() => targets.map((t) => t.ref)), // #2010
    affectedScenes,
  });
  return null;
}

/** Paste copied trait values onto every selected entity that ALREADY carries the
 *  trait, as a single undo entry. Fields are matched against each target's own
 *  live keys, so a clipboard entry captured before a trait gained/lost a field
 *  pastes the overlap rather than writing a stale key. Values are cloned per
 *  entity (see `cloneTraitValues`) so pasting onto several entities never leaves
 *  them sharing one array. Prefab-instance overrides are marked by the underlying
 *  writer. No-op if no target carries the trait or nothing overlaps.
 *  Caller must ensure `values` came from this same trait — see `isTraitCopyable`
 *  + the exact-name match the Inspector's Paste Values enforces. */
export function pasteTraitValuesWithUndo(entityIds: number[], meta: TraitMeta, values: Record<string, unknown>) {
  const targets = entityIds.filter((id) => {
    const e = findEntity(id);
    return !!e && e.has(meta.trait);
  });
  if (targets.length === 0) return;
  writeTraitFieldsPerEntityWithUndo(targets, meta, (oldFull) => {
    if (!oldFull) return {};
    // `emptyDocMap()`/`hasDocKey` (#986): `oldFull`'s keys come from readTraitDataFull, whose AoS
    // fallback enumerates a live trait object populated from scene JSON, and `values` is the
    // clipboard bag — so a prototype-named key both tested present and pasted a FUNCTION.
    const patch: Record<string, unknown> = emptyDocMap();
    for (const key of Object.keys(oldFull)) if (hasDocKey(values, key)) patch[key] = values[key];
    return cloneTraitValues(patch);
  }, `Paste ${meta.name} Values`);
}

/** Paste copied trait values as a NEW component on every selected entity that lacks the
 *  trait, as a single undo entry (undo removes the trait outright). Thin alias for the
 *  prefilled `addTraitToEntitiesWithUndo` — see there for why add-and-populate is one
 *  action. Entities that already carry the trait keep their values. */
export function pasteTraitAsNewWithUndo(entityIds: number[], meta: TraitMeta, values: Record<string, unknown>) {
  addTraitToEntitiesWithUndo(entityIds, meta, values, `Paste ${meta.name} As New`);
}

// ── Action callback (for backward compat during migration) ──

type ActionCallback = (action: { label: string; undo: () => void; redo: () => void; coalesceKey?: string; detail?: EditDetail; kind?: EditorJournalType; journalPayload?: Record<string, unknown>; affectedScenes?: string[]; check?: StepCheck }) => void;

/** GUID for a parent id in a structural journal payload: 'root' for 0, else the
 *  entity's stable guid (`id:<n>` only for an un-guidable entity — see `journalRefOf`). */
function parentGuid(parentId: number): string {
  return parentId ? journalRefOf(entityRef(parentId).guid, parentId) : 'root';
}

/** Build the structured `!edit` diff (Percept V1) from positionally-aligned refs +
 *  old/new value arrays. Uses each ref's stable guid (raw-id string only for an
 *  un-guidable entity). `refs`, `olds`, `news` must be index-aligned. */
function editDetail(refs: EntityRef[], meta: TraitMeta, field: string, olds: unknown[], news: unknown[]): EditDetail {
  return {
    trait: meta.name,
    field: field || '',
    entities: refs.map((r) => journalRefOf(r.guid, r.rawId)),
    old: olds,
    new: news,
  };
}

/** Coalesce key for a field edit: per-keystroke writes to the SAME field on the
 *  SAME entity set merge into one undo entry (editor-inspector.md F6 / undoManager
 *  COALESCE_MS window). Value edits only — tag toggles are discrete clicks, not
 *  keystrokes, so they each stay their own undo step (coalesceKey undefined). */
function fieldCoalesceKey(meta: TraitMeta, field: string, ids: number[]): string | undefined {
  if (meta.category === 'tag') return undefined;
  return `field:${[...ids].sort((a, b) => a - b).join(',')}:${meta.name}.${field}`;
}
let _pushAction: ActionCallback = pushAction;

export function setActionCallback(cb: ActionCallback) { _pushAction = cb; }

// ── Delete with undo ──

export interface EntitySnapshot {
  id: number;
  traits: { meta: TraitMeta; data: Record<string, unknown> | true }[];
  children: EntitySnapshot[];
  /** The entity's prefab override marks ("Trait.field"), when it has any. Marks are keyed by the
   *  packed entity (#868), so a respawn gets them only from here — see overrideMarks.ts. */
  marks?: string[];
  /** Its unregistered markers (`Transient`, `TemplateAddedKey`), which the registry walk above never
   *  sees (#1427). Restored by an undo's respawn; a copy drops them (`copySnapshot`), all
   *  but the template key of a node inside a copied whole instance (#1430). */
  markers?: CarriedMarkers;
  /** The document its frame was expanded from, when it is a prefab-instance root with a record of its own
   *  (#1483). A respawn is a new entity, so the record keyed by the old one does not reach it; without this a
   *  duplicated, pasted or undo-restored instance read as expanded from whatever the cache holds, and the
   *  stale-frame guards could not see it. A copy keeps it too: it was built from the same document. */
  frameDoc?: { source: string; doc: TemplateDoc };
  /** What R2 keeps for it as a stored root — orphan member rows and unreached legacy channels (#1788). The store is keyed
   *  by the root's guid beside the tree, so a respawn or a copy got none of it: a duplicated instance saved without
   *  either, and only the original took the scene's edit once the template brought the member or frame back. */
  kept?: KeptState;
  /** The fields ("Trait.field") the layers enclosing its frame give it from OUTSIDE the snapshotted subtree
   *  (`layerFieldsLeftBehind`, #1914): a copy that makes its frame a stored root shows them with no layer to give them,
   *  so it records them (`copySnapshot`). An undo's respawn, which puts the entity back where it was, ignores them. */
  layerMarks?: string[];
}

/** Is this a copy of the prefab-edit world's scaffolding (a `SCAFFOLD_PREFIX` entity)? */
function isScaffoldSnapshot(snapshot: EntitySnapshot): boolean {
  const ea = snapshot.traits.find((t) => t.meta.name === 'EntityAttributes')?.data;
  const name = ea && ea !== true ? ea.name : undefined;
  return typeof name === 'string' && name.startsWith(SCAFFOLD_PREFIX);
}

/** Every prefab a snapshot's subtree is an instance of (its `PrefabInstance.source`s, at any depth): what a paste or a
 *  duplicate of it would expand, for the prefab-edit self-nesting refusal. */
function snapshotPrefabs(snapshot: EntitySnapshot): string[] {
  const out: string[] = [];
  const walk = (s: EntitySnapshot) => {
    for (const { meta, data } of s.traits) {
      const source = meta.name === 'PrefabInstance' && data !== true ? data.source : undefined;
      if (typeof source === 'string' && source) out.push(source);
    }
    s.children.forEach(walk);
  };
  walk(snapshot);
  return out;
}

export function snapshotEntity(entityId: number, scope?: SnapshotScope): EntitySnapshot | null {
  const entity = findEntity(entityId);
  if (!entity) return null;
  scope ??= snapshotScope(entityId);
  const traits: EntitySnapshot['traits'] = [];
  for (const meta of getAllTraits()) {
    if (!entity.has(meta.trait)) continue;
    if (meta.category === 'tag') { traits.push({ meta, data: true }); }
    // readTraitDataFull, NOT readTraitData: the latter returns only the curated
    // Inspector subset in `meta.fields`, so any persistent field a custom Inspector
    // section owns (Animator.clips/clip, AudioSource.clips, AoS object fields) was
    // silently DROPPED from the snapshot — a duplicate came back with an empty clip
    // bank, and delete+undo lost it outright (QA-CTX-0003). cloneTraitValues because
    // readTraitDataFull hands back LIVE references into the trait store: without it a
    // duplicate would share the source's array and editing one would mutate the other.
    else { const data = readTraitDataFull(entityId, meta); if (data) traits.push({ meta, data: cloneTraitValues(data) }); }
  }
  const childEntities = getAllEntities().filter(e => e.parentId === entityId);
  const children = childEntities.map(c => snapshotEntity(c.id, scope)).filter((s): s is EntitySnapshot => s !== null);
  const marks = getCarriedOverrideMarks(entity);
  const layerMarks = scope.layerMarksOf(traits);
  const markers = captureMarkers(entity);
  const frameDoc = frameRootDoc(getCurrentWorld(), entity);
  const kept = keptStateOf(durableGuidOf(traits));
  return {
    id: entityId, traits, children,
    ...(marks && marks.size > 0 ? { marks: [...marks] } : {}),
    ...(layerMarks.length ? { layerMarks } : {}),
    ...(markers ? { markers } : {}),
    ...(frameDoc ? { frameDoc } : {}),
    ...(kept ? { kept } : {}),
  };
}

/** One snapshot's view of the subtree it captures: what the layers outside it give each member (`leftBehindReader`). */
interface SnapshotScope { layerMarksOf: (traits: EntitySnapshot['traits']) => string[] }

function snapshotScope(rootId: number): SnapshotScope {
  const read = leftBehindReader(rootId);
  return {
    layerMarksOf: (traits) => {
      const pi = traits.find((t) => t.meta.name === 'PrefabInstance')?.data;
      return pi && pi !== true ? read(pi as MemberPi) : [];
    },
  };
}

/** Deep-clone a snapshot as a COPY — the ONE function every live copy of a subtree goes through: duplicate (the
 *  Hierarchy menu, the keyboard, the `modoki_duplicate_entity` agent op) and paste. The device's `duplicate-entity` op
 *  applies the same plan to its own snapshot shape (`engine/app/debug/liveLifecycle.ts`).
 *
 *  - **A fresh `EntityAttributes.guid` for every entity, and every reference inside the subtree carried to the copy**
 *    (#1338). respawnFromSnapshot copies traits verbatim, so without the first a duplicated entity shares the source's
 *    guid — colliding guids break selection restore, prefab structural-override keys (the duplicate-key React crash)
 *    and asset refs — and without the second a `UIAction` target or an `entityRef` field aimed at the source's own child
 *    keeps driving the SOURCE, silently. A ref to an entity outside the subtree is left alone.
 *  - **Each node's prefab link, decided per node by the frame it is a row of** (`CopyLink`, #1756): kept while that
 *    frame is in the copy, a nested root whose owner is not becomes an independent instance (#1354), and a member whose
 *    frame is not becomes a plain ADDED node. This used to be one verdict for the whole copy, read off its root, so a
 *    member moved into a copied group was copied still linked — a second claimant of its row, and the original was lost
 *    on reload. It also means no copied `rootInstanceId` names an entity outside the copy, which a paste into another
 *    world would read as whatever holds that id there.
 *  - **A kept member's new guid is the one a reload will derive**, so a carried ref survives save + reload.
 *  The rules and their reasoning live in `runtime/core/copyIdentity.ts` (`planCopyGuids`). The clone is computed ONCE
 *  per duplicate/paste, so undo→redo re-spawns the same identity. */
export function copySnapshot(snapshot: EntitySnapshot): EntitySnapshot {
  const dataOf = (s: EntitySnapshot, name: string): Record<string, unknown> | null => {
    const t = s.traits.find((x) => x.meta.name === name);
    return t && t.data !== true ? t.data : null;
  };
  const markedKey = (s: EntitySnapshot): string => {
    const tk = s.markers?.TemplateAddedKey;
    return tk && tk !== true && typeof tk.key === 'string' ? tk.key : '';
  };
  // In a prefab being EDITED, a copy is new content of that document, so a keyed node in it takes a fresh key: keys are
  // unique within a document (#1809, owner ruling), and a copy keeping the original's wrote the same key twice into the
  // saved file. EXCEPT a key a NESTED prefab declares: that is the nested template's node, which the copy still is —
  // re-keyed, the save wrote it as the edited prefab's own and removed the template's (close-out review). The test is
  // "a deeper document declares it", not "the edited one does": the cached edited document knows nothing minted this
  // session, so a copy of a copy kept that key and repeated it (close-out re-review). Unity's rule: an added object gets
  // a new fileID, a nested prefab's object keeps its own. In a SCENE, a copied whole instance is another instance of the
  // same template and keeps every key (#1430). Minted once per node, so the plan derives with the key the marker carries.
  const edited = prefabEditWorldGuid();
  const editedDoc = edited ? getCachedPrefabSync(edited) : null;
  const deeper = editedDoc
    ? nestedDeclaredKeys(editedDoc as unknown as TemplateKeyDoc, (g) => getCachedPrefabSync(g) as unknown as TemplateKeyDoc | null)
    : null;
  const fresh = deeper ? new Map<EntitySnapshot, string>() : null;
  const keyOf = (s: EntitySnapshot): string => {
    const key = markedKey(s);
    if (!key || !fresh || deeper!.has(key)) return key;
    let minted = fresh.get(s);
    if (!minted) fresh.set(s, (minted = newGuid()));
    return minted;
  };
  const { guidOf, remap, keyed, links } = planCopyGuids(snapshot, (s) => s.children, dataOf, (s) => s.id, newGuid, keyOf, frameDocReader(getCurrentWorld()));
  // Once every new guid is known: a parent's ref can name a child and vice versa.
  // A copy is a new identity, so it carries no unregistered markers (`carriedMarkers.ts`) — except
  // the template key of a node the plan derived through it, inside a copy of a whole instance (#1430),
  // and the record a missing prefab's placeholder carries, re-guided so the copy shares no identity (#1699).
  type RefData = { source: string; kind: string; record: string };
  const refOf = (s: EntitySnapshot): RefData | null => {
    const ref = s.markers?.UnresolvedPrefabRef;
    return ref && ref !== true ? ref as RefData : null;
  };
  // ONE remap for the whole copy, built before anything is rewritten: the entities' new guids and every record's
  // re-minted identities. A record's ref to an entity copied with it, and a copied entity's ref into a record's member,
  // both follow the copy (#1338's rule, #1763). A record's mints win on the guids it states.
  const fullRemap = new Map(remap);
  const collectMints = (s: EntitySnapshot): void => {
    const ref = refOf(s);
    if (ref) for (const [g, m] of recordGuidMints(ref, (dataOf(s, 'EntityAttributes')?.guid as string) ?? '', guidOf.get(s)!, newGuid)) fullRemap.set(g, m);
    for (const c of s.children) collectMints(c);
  };
  // …and every identity a stored root's KEPT state names (#1788): an orphan row pins a member guid no live entity holds,
  // so `planCopyGuids` never saw it. A guid the plan already moved keeps the plan's.
  const collectKeptMints = (s: EntitySnapshot): void => {
    if (s.kept && links.get(s) !== 'strip') for (const [g, m] of keptGuidMints(s.kept, newGuid)) if (!fullRemap.has(g)) fullRemap.set(g, m);
    for (const c of s.children) collectKeptMints(c);
  };
  collectMints(snapshot);
  collectKeptMints(snapshot);
  const markersOf = (s: EntitySnapshot): EntitySnapshot['markers'] => {
    const out: NonNullable<EntitySnapshot['markers']> = {};
    if (keyed.has(s)) out.TemplateAddedKey = { key: keyOf(s) };
    const ref = refOf(s);
    if (ref) out.UnresolvedPrefabRef = copyUnresolvedRef(ref, fullRemap);
    return Object.keys(out).length ? out : undefined;
  };
  const copy = (s: EntitySnapshot): EntitySnapshot => {
    const link = links.get(s);
    const traits: EntitySnapshot['traits'] = [];
    for (const t of s.traits) {
      if (t.data === true) { traits.push(t); continue; }
      if (t.meta.name === 'PrefabInstance' && link === 'strip') continue;
      const data = remapGuidValues(t.data, fullRemap) as Record<string, unknown>;
      if (t.meta.name === 'EntityAttributes') traits.push({ meta: t.meta, data: { ...data, guid: guidOf.get(s)! } });
      // A stored root has no row, so no owner either (#1437/#1468). A new object: the snapshot is replayed on redo.
      else if (t.meta.name === 'PrefabInstance' && link === 'promote') traits.push({ meta: t.meta, data: { ...data, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '' } });
      else traits.push({ meta: t.meta, data });
    }
    const { marks, layerMarks, kept, ...rest } = s;
    // What the layers the copy leaves behind gave a member becomes its own record (#1914, `EntitySnapshot.layerMarks`).
    const recorded = [...new Set([...(marks ?? []), ...(layerMarks ?? [])])];
    return {
      ...rest,
      // A stripped node is no instance any more, so it has no rows to keep.
      ...(kept && link !== 'strip' ? { kept: remapGuidValues(kept, fullRemap) as KeptState } : {}),
      // An override mark means something only on a member of an instance: a stripped node is an added node.
      ...(recorded.length && link !== 'strip' ? { marks: recorded } : {}),
      markers: markersOf(s),
      traits,
      children: s.children.map(copy),
    };
  };
  return copy(snapshot);
}

/** Rebuild a snapshot's subtree under `newParentId`; returns the new root id. Every entity gets a
 *  fresh ECS id, so a numeric entity reference held INSIDE the subtree (a registry field flagged
 *  `entityId` — `PrefabInstance.rootInstanceId`) is carried from the old id to the new one after the
 *  whole subtree exists; a reference to an entity outside it is left alone. Without that, a restored
 *  or duplicated prefab instance kept naming the SOURCE root (or a dead id), and the next save folded
 *  the copy into the source instance (#1338). `EntityAttributes.parentId` is set directly. */
export function respawnFromSnapshot(snapshot: EntitySnapshot, newParentId: number = 0): number {
  const idMap = new Map<number, number>();
  const spawned: [EntitySnapshot, number][] = [];
  const spawnTree = (snap: EntitySnapshot, parentId: number): number => {
    const traitArgs: any[] = [];
    for (const { meta, data } of snap.traits) {
      if (data === true) { traitArgs.push(meta.trait()); }
      else {
        const patched = meta.name === 'EntityAttributes' ? { ...data, parentId } : data;
        traitArgs.push(meta.trait(patched as Record<string, unknown>));
      }
    }
    const entity = spawnEntity(getCurrentWorld(), ...traitArgs);
    // Clear first: the 8-bit generation wraps, so a dead member's marks can match this packed value.
    clearOverrideMarks(entity);
    if (snap.marks) restoreOverrideMarks(entity, snap.marks);
    restoreMarkers(entity, snap.markers);
    if (snap.frameDoc) noteFrameRootDoc(getCurrentWorld(), entity, snap.frameDoc);
    if (snap.kept) restoreKeptState(durableGuidOf(snap.traits), snap.kept);
    const id = entity.id();
    idMap.set(snap.id, id);
    spawned.push([snap, id]);
    for (const child of snap.children) spawnTree(child, id);
    return id;
  };
  const newId = spawnTree(snapshot, newParentId);
  carryEntityIdFields(spawned.map(([snap, id]) => ({ id, traits: snap.traits.map((t) => ({ name: t.meta.name, data: t.data })) })), idMap);
  return newId;
}

/** The durable EntityAttributes.guid in a snapshot's traits ('' if none) — the key R2 keeps a stored root's state under. */
function durableGuidOf(traits: EntitySnapshot['traits']): string {
  const ea = traits.find((t) => t.data !== true && t.meta.name === 'EntityAttributes');
  return durableGuid(ea && ea.data !== true ? (ea.data as Record<string, unknown>).guid as string | undefined : '');
}

/** The EntityAttributes.guid carried in a snapshot's root traits ('' if none).
 *  respawnFromSnapshot restores this verbatim, so it's the stable handle to the
 *  respawned entity across a world rebuild. */
function rootGuidOf(snap: EntitySnapshot): string {
  const ea = snap.traits.find((t) => t.data !== true && t.meta.name === 'EntityAttributes');
  return ea && ea.data !== true ? ((ea.data as Record<string, unknown>).guid as string) || '' : '';
}

/** The name in a snapshot's root traits ('' if none): what a refusal calls a deleted entity. */
function snapshotNameOf(snap: EntitySnapshot): string {
  const ea = snap.traits.find((t) => t.data !== true && t.meta.name === 'EntityAttributes');
  return ea && ea.data !== true ? String((ea.data as Record<string, unknown>).name ?? '') : '';
}

/** Every durable guid a snapshot tree respawns with. */
function snapshotGuids(snap: EntitySnapshot, out: Set<string> = new Set()): Set<string> {
  const g = durableGuidOf(snap.traits);
  if (g) out.add(g);
  for (const c of snap.children) snapshotGuids(c, out);
  return out;
}

/** A delete's undo, before it respawns anything (#1819, I19/I20): every instance root a respawned member links back
 *  to, outside what the undo itself respawns, must still be a live INSTANCE root. After a world swap it can be gone,
 *  or a Missing Prefab placeholder (no `PrefabInstance`), and relinking a member to it leaves a member whose root is
 *  not an instance, which the next reload drops (I6). Throws `UndoRefusedError`, so nothing has been respawned yet. */
function requireRootLinks(links: readonly { guid: string; rootGuid: string }[], respawned: ReadonlySet<string>, renamed?: ReadonlyMap<string, string>, pass?: CheckPass): void {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || !links.length) return;
  // Asked by a batch's pre-pass (#2010): against the pass, where a root an earlier sub brings back is not a miss.
  const idx = pass?.index ?? buildGuidIndex();
  for (const { rootGuid } of links) {
    if (respawned.has(rootGuid)) continue;
    let g = rootGuid;
    for (let hops = 0; renamed?.has(g) && hops < renamed.size; hops++) g = renamed.get(g)!;
    if (pass?.arriving.has(g)) continue;
    const root = idx.get(g);
    const ref = root != null ? entityRef(root, false) : null;
    if (!ref) throw new UndoRefusedError(`The prefab instance (${rootGuid}) a deleted member belongs to is no longer in the scene, so its members would come back linked to nothing.`, 'the prefab instance its members belong to is no longer in the scene');
    // `require` names the placeholder case in its own words; the check covers a root that is plain now (detached).
    ref.require({ kind: 'entity', check: (id) => (findEntity(id)?.has(piMeta.trait) ? null : 'is no longer a prefab instance, so its deleted members cannot be linked back to it') });
  }
}

/** The check of a step that spawns one subtree from `snap` (create, duplicate, paste; #2010): the undo deletes it, so it
 *  needs the spawned root; the redo respawns it, so it needs the parent and brings the subtree back. A null `snap`
 *  respawns nothing. */
function spawnCheck(selfRef: EntityRef, parentRef: EntityRef | null, snap: EntitySnapshot | null): StepCheck {
  const guids = snap ? [...snapshotGuids(snap)] : [];
  return {
    undo: (pass) => checkRef(pass, selfRef),
    redo: (pass) => { if (!snap) return; if (parentRef) checkRef(pass, parentRef); arrive(pass, guids); },
  };
}

// ── Create with undo ──

// TraitSpec moved to runtime/scene/entityCreateSpecs.ts (#166) so the device's undo-free create
// path and this undoable one cannot drift apart. Re-exported here for existing importers.
export type { TraitSpec } from '../../runtime/scene/entityCreateSpecs';
import type { TraitSpec } from '../../runtime/scene/entityCreateSpecs';

/** Spawn an entity from trait specs, select it, and push a create/delete undo action.
 *  `selectEntity` is injected so this stays free of the editor store and unit-testable.
 *  Returns the new entity id, or null if a referenced trait isn't registered. */
export function createEntityWithUndo(
  label: string,
  parentId: number,
  traitSpecs: TraitSpec[],
  selectEntity: (id: number | null) => void,
): number | null {
  // Prefab edit keeps everything under the root (#1836): a create at the top level would be dropped by the save.
  assertPrefabEditAllows({ kind: 'add', parentId });
  const allTraitsList = getAllTraits();
  // Auto-assign sortOrder to (max sibling sortOrder + 1) so new entities go to the end
  // and have unique values — required for drag-to-reorder to compute distinct positions.
  const siblings = getAllEntities().filter(e => e.parentId === parentId);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map(s => s.sortOrder)) + 1 : 0;
  const traitInits: any[] = [];
  for (const spec of traitSpecs) {
    const meta = allTraitsList.find(t => t.name === spec.name);
    if (!meta) { console.error(`[createEntity] Cannot create entity: ${spec.name} trait not registered`); return null; }
    const data = spec.name === 'EntityAttributes' && spec.data && spec.data.sortOrder === undefined
      ? { ...spec.data, sortOrder: nextSort }
      : spec.data;
    traitInits.push(data !== undefined ? meta.trait(data) : meta.trait());
  }
  instanceEdits.beginAddChild(parentId); // #2001 S4: re-seeded before the spawn, so the capture cannot see it
  const entity = spawnEntity(getCurrentWorld(), ...traitInits);
  let currentId = entity.id();
  // Under a base entity it belongs to that base (#1429) — before the snapshot, so redo keeps the stamp.
  adoptParentScene(currentId);
  // Mint+persist a guid BEFORE snapshotting so the snapshot carries it: respawn
  // restores the same guid and the Play snapshot serializes it, so undo/redo can
  // re-find the entity after a world rebuild.
  ensureGuid(currentId);
  instanceEdits.addChild(currentId); // #2001 S4: the door's `addChild` — under a member, its row's `own` links it
  const snap = snapshotEntity(currentId);
  const guid = rootGuidOf(snap!);
  const selfRef = entityRef(currentId);
  const parentRef = parentId ? entityRef(parentId) : null;
  // Resolved AFTER adoptParentScene: a create under a base entity dirties that base, not the primary.
  const affectedScenes = resolveAffectedScenes([currentId]);
  selectEntity(currentId);
  _pushAction({
    label,
    // By guid only, and a miss refuses (#1827, I19): after a world swap the raw id names whatever entity holds it now.
    undo: () => { deleteEntity(selfRef.require()); selectEntity(null); },
    // The parent is required, never the scene root (#1793's fork, owner ruling R): a parent that is gone refuses.
    redo: () => { if (snap) { currentId = respawnFromSnapshot(snap, parentRef ? parentRef.require() : 0); selectEntity(currentId); } },
    check: spawnCheck(selfRef, parentRef, snap),
    kind: '!create',
    journalPayload: { entity: journalRefOf(guid, currentId), parent: parentGuid(parentId) },
    affectedScenes,
  });
  return currentId;
}

/** A nested entity subtree spec: traits for this node + recursive children. */
export interface SubtreeSpec { traits: TraitSpec[]; children?: SubtreeSpec[] }

/** Create a nested entity SUBTREE (an entity + recursive children) as ONE undo action —
 *  undo removes the whole subtree, redo respawns it. Mirrors createEntityWithUndo but
 *  for a hierarchy (e.g. a SkinnedSprite2D + its Bone2D chain). Each node's
 *  EntityAttributes.parentId is forced to its actual spawned parent, so the caller's
 *  specs don't need to know the ids. */
/** Spawn a nested entity subtree WITHOUT undo — returns the root id (or null). Each
 *  node's EntityAttributes.parentId is forced to its actual spawned parent. Used by
 *  createEntitySubtreeWithUndo and by prefab generation (spawn → serialize → delete). */
export function spawnEntitySubtree(parentId: number, root: SubtreeSpec): number | null {
  const allTraitsList = getAllTraits();
  const spawnNode = (node: SubtreeSpec, parent: number): number | null => {
    const siblings = getAllEntities().filter((e) => e.parentId === parent);
    const nextSort = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
    const inits: any[] = [];
    for (const spec of node.traits) {
      const meta = allTraitsList.find((t) => t.name === spec.name);
      if (!meta) { console.error(`[spawnEntitySubtree] Cannot create: ${spec.name} trait not registered`); return null; }
      let data = spec.data;
      if (spec.name === 'EntityAttributes') {
        data = { ...(spec.data ?? {}), parentId: parent };
        if ((data as Record<string, unknown>).sortOrder === undefined) (data as Record<string, unknown>).sortOrder = nextSort;
      }
      inits.push(data !== undefined ? meta.trait(data) : meta.trait());
    }
    const ent = spawnEntity(getCurrentWorld(), ...inits);
    const id = ent.id();
    ensureGuid(id);
    for (const child of node.children ?? []) spawnNode(child, id);
    return id;
  };
  const rootId = spawnNode(root, parentId);
  if (rootId != null) markStructureDirty();
  return rootId;
}

export function createEntitySubtreeWithUndo(
  label: string,
  parentId: number,
  root: SubtreeSpec,
  selectEntity: (id: number | null) => void,
): number | null {
  instanceEdits.beginAddChild(parentId); // #2001 S4, before the spawn
  const rootId = spawnEntitySubtree(parentId, root);
  if (rootId == null) return null;
  adoptParentScene(rootId); // #1429 — see createEntityWithUndo
  instanceEdits.addChild(rootId); // #2001 S4: the door's `addChild`
  let currentId = rootId;
  const snap = snapshotEntity(currentId);
  const guid = rootGuidOf(snap!);
  const selfRef = entityRef(currentId);
  const parentRef = parentId ? entityRef(parentId) : null;
  const affectedScenes = resolveAffectedScenes([currentId]);
  selectEntity(currentId);
  _pushAction({
    label,
    // By guid only, and a miss refuses (#1827, I19): after a world swap the raw id names whatever entity holds it now.
    undo: () => { deleteEntity(selfRef.require()); selectEntity(null); },
    redo: () => { if (snap) { currentId = respawnFromSnapshot(snap, parentRef ? parentRef.require() : 0); selectEntity(currentId); } },
    check: spawnCheck(selfRef, parentRef, snap),
    kind: '!create',
    journalPayload: { entity: journalRefOf(guid, currentId), parent: parentGuid(parentId) },
    affectedScenes,
  });
  return currentId;
}

// ── Duplicate with undo ──

/** Deep-duplicate an entity (and all its children) into the SAME parent as the
 *  original, select the copy, and push a duplicate/delete undo action.
 *  Mirrors the create/delete pattern: snapshotEntity deep-captures the subtree
 *  (traits + children, recursively), respawnFromSnapshot rebuilds it.
 *  `selectEntity` is injected so this stays free of the editor store and unit-testable.
 *  Returns the new entity id, or null if the source entity doesn't exist. */
export function duplicateEntity(
  entityId: number,
  selectEntity: (id: number | null) => void,
): number | null {
  const captured = snapshotEntity(entityId);
  if (!captured) return null;
  // Mint fresh guids for the whole copied subtree ONCE (stable across undo/redo), and decide each node's prefab link by
  // the frame it is a row of (#1756) — `copySnapshot`, shared with paste.
  const snapshot = copySnapshot(captured);
  // Duplicate into the same parent as the original.
  const attrMeta = getAllTraits().find(m => m.name === 'EntityAttributes');
  const attrData = attrMeta ? readTraitData(entityId, attrMeta) : null;
  const parentId = (attrData?.parentId as number) || 0;
  // Prefab edit (#1817, #1836): a duplicate of the root lands beside it, outside what the save writes, and a copy
  // holding an instance of the edited prefab would nest it in itself. Asked before anything spawns.
  assertPrefabEditAllows({ kind: 'add', parentId, prefabs: snapshotPrefabs(captured), read: prefabNestingReader() });

  // copySnapshot already minted a fresh root guid; use it as the
  // stable handle so undo/redo survive a world rebuild. Parent resolved by ref.
  const guid = rootGuidOf(snapshot);
  const parentRef = parentId ? entityRef(parentId) : null;
  // Spawn + post-spawn fixup (sortOrder; the copy's rootInstanceIds are carried by respawnFromSnapshot).
  // Shared by the initial spawn and redo so identity stays consistent.
  const spawnCopy = (p: number): number => {
    const id = respawnFromSnapshot(snapshot, p);
    assignFreshSortOrder(id, p);
    return id;
  };
  instanceEdits.beginAddChild(parentId); // #2001 S4, before the spawn
  let currentId = spawnCopy(parentId);
  instanceEdits.afterCopy(currentId);
  const selfRef = entityRef(currentId); // the copy's fresh guid, minted by copySnapshot
  // Resolved from the COPY, after spawn — its sourceScene mirrors the source's
  // (respawnFromSnapshot copies EntityAttributes verbatim, sourceScene included).
  const affectedScenes = resolveAffectedScenes([currentId]);
  selectEntity(currentId);
  _pushAction({
    label: 'Duplicate Entity',
    // By guid only, and a miss refuses (#1827, I19): after a world swap the raw id names whatever entity holds it now.
    undo: () => { deleteEntity(selfRef.require()); selectEntity(null); },
    redo: () => {
      currentId = spawnCopy(parentRef ? parentRef.require() : 0);
      // The redo respawns the copy after a template change the stack does not hold (a saved prefab edit). The first spawn
      // needs none: its source is a live frame, which every such change already rebased.
      rebaseRespawned([snapshot]);
      currentId = liveIdOf(guid, currentId);
      selectEntity(currentId);
    },
    check: spawnCheck(selfRef, parentRef, snapshot),
    kind: '!duplicate',
    // Source guid from the attrData already read above — do NOT entityRef(entityId) here:
    // that mints+writes a guid to the SOURCE, dirtying authored data purely to log it.
    journalPayload: { entity: journalRefOf(guid, currentId), source: journalRefOf(attrData?.guid as string, entityId), parent: parentGuid(parentId) },
    affectedScenes,
  });
  return currentId;
}

/** What the Hierarchy's Copy / Cut holds. A CUT names its source by `entityRef` AND by the world it was cut in:
 *  runtime ids are reassigned on every reload, so a raw id held across a scene load, a hot reload or a prefab-edit
 *  swap named whatever entity held that index afterwards, and ⌘V moved THAT one. */
export interface EntityClipboard {
  snapshot: EntitySnapshot;
  op: 'copy' | 'cut';
  source: EntityRef;
  /** A cut's world only: a copy never re-finds its source, and holding a replaced world keeps it alive. */
  world?: ReturnType<typeof getCurrentWorld>;
}

/** Take `entityId` onto the clipboard, or null when it has no snapshot. */
export function clipEntity(entityId: number, op: 'copy' | 'cut'): EntityClipboard | null {
  const snapshot = snapshotEntity(entityId);
  // mint:false — cutting must not write a guid into the source; the world check below covers a guid-less one.
  return snapshot ? { snapshot, op, source: entityRef(entityId, false), ...(op === 'cut' ? { world: getCurrentWorld() } : {}) } : null;
}

/** The live entity a CUT still names, or null when it names nothing: the world was replaced since the cut (the
 *  same guid may now belong to another file's entity, #1293), or the entity is gone. Refuse, never re-target. */
export function cutSourceId(clip: EntityClipboard): number | null {
  if (clip.world !== getCurrentWorld()) return null;
  return clip.source.resolve();
}

/** Bring the prefab frames a respawn from these snapshots made onto their prefabs' CURRENT documents (#1820). A snapshot
 *  outlives a template change that is not on this undo stack — a prefab-edit save, an outside edit, and for the clipboard
 *  an Apply or a Replace too — so a Paste, a Duplicate's redo and a Delete's undo respawn frames expanded
 *  from an older document; nothing else rebases them before a reload. Synchronous when every prefab is cached
 *  (`rebaseStaleInstancesSoon`). A rebuilt frame root is respawned at a NEW id, so a caller re-finds its entity by guid.
 *  (A create's redo does not call it: its snapshot is of an entity built from trait specs, which holds no prefab frame.) */
function rebaseRespawned(snapshots: readonly EntitySnapshot[], alsoSources: Iterable<string> = []): void {
  const sources = new Set([...snapshots.flatMap(snapshotPrefabs), ...alsoSources]);
  if (sources.size) rebaseStaleInstancesSoon({ sources });
}

/** The frames that SURVIVE a delete while rows of theirs go with it (#1820 residual): a member, or an owned nested root,
 *  whose frame root is not among `snapshots`. Each with the document its record held at the delete.
 *
 *  `rebaseRespawned` rebuilds frames whose OWN record is stale, and a surviving frame's is not: leaving prefab edit rebased
 *  it onto the saved document, so the rows Delete's undo respawns — expanded from the old one — were left on the old
 *  document with nothing to see them (a template value frozen as the row's own, a row the template dropped, a nested
 *  root's parent row). So the undo checks each frame BEFORE anything respawns (`prepare`), refusing a row the current
 *  document dropped; and after the respawn re-records the frame as the current document holding the respawned rows'
 *  OLD content (`rebase`), which makes it stale to the ordinary rebuild: captured against that record (the mark gate
 *  carries only the rows' real overrides), rebuilt onto the current document. Unity's rule — an instance merges against
 *  the CURRENT asset — with no rebuild path of its own. */
function survivingFrameRows(snapshots: readonly EntitySnapshot[]) {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const world = getCurrentWorld();
  type Row = { guid: string; name: string; row: number; owned: boolean };
  const frames = new Map<number, { rootGuid: string; source: string; doc: TemplateDoc; rows: Row[] }>();
  if (piMeta && eaMeta) {
    const deleted = new Set<number>();
    const nodes: EntitySnapshot[] = [];
    const walk = (s: EntitySnapshot) => { deleted.add(s.id); nodes.push(s); s.children.forEach(walk); };
    snapshots.forEach(walk);
    const identity = worldIdentityParents(world);
    for (const s of nodes) {
      const frame = identity.frameOf(s.id);
      if (!frame || deleted.has(frame)) continue;
      const pi = readTraitData(s.id, piMeta) as MemberPi | null;
      const ea = readTraitData(s.id, eaMeta) as { guid?: string; name?: string } | null;
      const handle = findEntity(frame);
      const rec = handle ? frameRootDoc(world, handle) : undefined;
      const rootGuid = (readTraitData(frame, eaMeta)?.guid as string | undefined) ?? '';
      if (!pi || !ea?.guid || !rec || !rootGuid) continue;
      const owned = isOwnedRoot(pi, s.id);
      const row = (owned ? pi.parentLocalId : pi.localId) ?? 0;
      if (!row) continue;
      let f = frames.get(frame);
      if (!f) frames.set(frame, f = { rootGuid, source: rec.source, doc: rec.doc, rows: [] });
      f.rows.push({ guid: ea.guid, name: ea.name ?? '', row, owned });
    }
  }

  /** Every check, before anything respawns (I19); a refusal throws. Returns the re-record to run after the respawn and
   *  its relinks, which answers the sources the rebase must include. */
  const prepare = (idx: Map<string, number>, renames: ReadonlyMap<string, string>, pass?: CheckPass): (() => string[]) => {
    // The world the undo runs in: leaving prefab edit replaces the one the delete was taken in.
    const world = getCurrentWorld();
    const plans: { root: number; source: string; doc: TemplateDoc; rows: { guid: string; owned: boolean; to: number }[] }[] = [];
    for (const f of frames.values()) {
      let g = f.rootGuid;
      for (let hops = 0; renames.has(g) && hops < renames.size; hops++) g = renames.get(g)!;
      const root = idx.get(g);
      let now: TemplateDoc;
      if (root == null && pass?.arriving.has(g)) {
        // A batch's pre-pass (#2010), where an earlier sub brings this frame's root back: respawned, it is rebased onto
        // its prefab's CURRENT document (`rebaseRespawned`), which is what this undo will find, so the rows are judged
        // against that. Not cached: what it will hold cannot be told, and the pass goes blind.
        const current = getCachedPrefabSync(f.source) as TemplateDoc | null;
        if (!current) { pass.blind = true; continue; }
        if (current === f.doc) continue;
        now = current;
      } else {
        const handle = root != null ? findEntity(root) : undefined;
        const rec = handle ? frameRootDoc(world, handle) : undefined;
        // A root that is gone or no longer this frame is `requireRootLinks`' refusal, not this one.
        if (root == null || !rec || rec.source !== f.source || rec.doc === f.doc) continue;
        now = rec.doc;
      }
      const lid = translateLocalIds(f.doc, now) ?? ((n: number) => n);
      const nowRows = new Set((now.entities ?? []).map((e) => e.localId));
      const oldRows = new Map((f.doc.entities ?? []).map((e) => [e.localId, e]));
      const replaced = new Map<number, NonNullable<TemplateDoc['entities']>[number]>();
      const rows: { guid: string; owned: boolean; to: number }[] = [];
      for (const r of f.rows) {
        const to = lid(r.row);
        const old = oldRows.get(r.row);
        const ea = old?.traits?.EntityAttributes as { parentId?: number } | undefined;
        const parent = ea?.parentId ? lid(ea.parentId) : 0;
        if (!to || !nowRows.has(to) || (ea?.parentId && (!parent || !nowRows.has(parent)))) {
          const name = r.name ? `"${r.name}"` : 'A deleted member';
          throw new UndoRefusedError(
            `${name} (${r.guid}) is no longer where its prefab puts it: a prefab edit saved since the delete removed its row` +
            `${to && nowRows.has(to) ? "'s parent" : ''}, so undoing the delete would bring back a member the prefab does not have. Nothing was restored.`,
            `${name} is no longer in its prefab`);
        }
        if (old) replaced.set(to, { ...old, localId: to, ...(old.traits ? { traits: { ...old.traits, ...(ea ? { EntityAttributes: { ...ea, parentId: parent } } : {}) } } : {}) });
        rows.push({ guid: r.guid, owned: r.owned, to });
      }
      const doc: TemplateDoc = { ...now, entities: (now.entities ?? []).map((e) => (e.localId !== undefined && replaced.get(e.localId)) || e) };
      if (root != null) plans.push({ root, source: f.source, doc, rows });
    }
    return () => {
      if (!piMeta) return [];
      for (const p of plans) {
        for (const r of p.rows) {
          const e = findEntityByGuid(r.guid);
          const pi = e?.has(piMeta.trait) ? (e.get(piMeta.trait) as Record<string, unknown>) : null;
          const field = r.owned ? 'parentLocalId' : 'localId';
          // ⚠️ TRACED, NOT DRIVEN (close-out review): a renumber needs a template change the undo history survives, and
          // neither kind renumbers — a prefab-edit save keeps every localId (`planPrefabRows`' preserve map), an outside
          // edit clears the stack. Deleting this line leaves every test green; it keeps the row matching the composite.
          if (e && pi && pi[field] !== r.to) e.set(piMeta.trait, { ...pi, [field]: r.to });
        }
        const handle = findEntity(p.root);
        const rec = handle ? frameRootDoc(world, handle) : undefined;
        if (handle && rec) noteFrameRootDoc(world, handle, { ...rec, doc: p.doc });
      }
      return plans.map((p) => p.source);
    };
  };
  return { prepare };
}

/** The live id of the entity `guid` names, else `fallback` (an un-guidable entity keeps its respawned id). */
function liveIdOf(guid: string, fallback: number): number {
  return (guid && findEntityByGuid(guid)?.id()) || fallback;
}

/** Paste a copied snapshot under `parentId` (0 = the root) as a fresh deep copy: the Hierarchy's ⌘V after a Copy.
 *  Fresh guids ONCE and each node's prefab link by its frame (`copySnapshot`, #1756, shared with duplicate), a
 *  unique sortOrder at the end of the parent's children, and the TARGET's scene (#1760): the parent's, or the
 *  primary at the root, never the source's stamp — the clipboard outlives a scene load, so that stamp can name a
 *  scene that is not loaded, and the copy was then saved into no file (`adoptParentScene`). One undo entry. */
export function pasteEntityCopy(
  snapshot: EntitySnapshot,
  parentId: number,
  selectEntity: (id: number | null) => void,
): number {
  // Prefab edit (#1817, #1836): a paste outside the root is lost on save, and one holding an instance of the edited
  // prefab nests it in itself — the clipboard outlives the world, so it can carry one copied from a scene.
  assertPrefabEditAllows({ kind: 'add', parentId, prefabs: snapshotPrefabs(snapshot), read: prefabNestingReader(), scaffold: isScaffoldSnapshot(snapshot) });
  const copy = copySnapshot(snapshot);
  const parentRef = parentId ? entityRef(parentId) : null;
  // The clipboard outlives a template change (an Apply, a Replace, a prefab-edit save, an outside edit): `rebaseRespawned`.
  let selfRef: EntityRef | null = null;
  const spawn = (p: number): number => {
    const id = respawnFromSnapshot(copy, p);
    adoptParentScene(id);
    assignFreshSortOrder(id, p);
    selfRef ??= entityRef(id);
    rebaseRespawned([copy]);
    return selfRef.resolve() ?? id;
  };
  instanceEdits.beginAddChild(parentId); // #2001 S4, before the spawn
  let currentId = spawn(parentId);
  instanceEdits.afterCopy(currentId);
  const affectedScenes = resolveAffectedScenes([currentId]);
  selectEntity(currentId);
  _pushAction({
    label: 'Paste Entity',
    // By guid only, and a miss refuses (#1827, I19): after a world swap the raw id names whatever entity holds it now.
    undo: () => { deleteEntity(selfRef!.require()); selectEntity(null); },
    redo: () => { currentId = spawn(parentRef ? parentRef.require() : 0); selectEntity(currentId); },
    check: spawnCheck(selfRef!, parentRef, copy),
    affectedScenes,
  });
  return currentId;
}

/** Delete many entities as a SINGLE coalesced undo entry.
 *  - Drops ids whose ancestor is also selected: the ancestor's snapshot already
 *    captures the whole subtree, so deleting both would double-handle it and
 *    corrupt the partial-undo state.
 *  - `setSelection` (optional) is a RAW selection setter that must NOT push its
 *    own undo entry (e.g. a direct store `setState`). Folding the selection
 *    change into this action's closures keeps one undo entry total: undo
 *    restores the entities AND reselects them; redo clears the selection.
 *  No-op (no undo entry) if nothing resolves to a live root. */
export function deleteEntitiesWithUndo(
  entityIds: number[],
  setSelection?: (ids: number[]) => void,
): void {
  if (entityIds.length === 0) return;
  // The prefab-edit root, or the 2D stage above it: every later save would fail "prefab root not found" (#1836).
  assertPrefabEditAllows({ kind: 'delete', ids: entityIds });

  // Keep only roots — an id whose parent chain hits another selected id is a
  // descendant and is captured by that ancestor's snapshot.
  const idSet = new Set(entityIds);
  const byId = new Map(getAllEntities().map(e => [e.id, e]));
  const isDescendantOfSelected = (id: number): boolean => {
    let cur = byId.get(id);
    while (cur && cur.parentId !== 0) {
      if (idSet.has(cur.parentId)) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };

  const snaps: { snapshot: EntitySnapshot; guid: string; name: string; parentRef: EntityRef | null }[] = [];
  for (const id of entityIds) {
    if (isDescendantOfSelected(id)) continue;
    // Mint+persist a guid BEFORE snapshotting (a delete target may be guid-less)
    // so the snapshot carries it and redo can re-find the entity after a rebuild.
    ensureGuid(id);
    const snapshot = snapshotEntity(id);
    if (!snapshot) continue;
    let parentId = 0;
    for (const { meta, data } of snapshot.traits) {
      if (meta.name === 'EntityAttributes' && data !== true) {
        parentId = ((data as Record<string, unknown>).parentId as number) || 0;
        break;
      }
    }
    snaps.push({ snapshot, guid: rootGuidOf(snapshot), name: snapshotNameOf(snapshot), parentRef: parentId ? entityRef(parentId) : null });
  }
  if (snaps.length === 0) return;

  // Resolve BEFORE deleting — the entities are about to be destroyed, and undo/redo
  // share this same set (they act on the same subtree either way).
  const affectedScenes = resolveAffectedScenes(snaps.map(s => s.snapshot.id));
  // Members moved out of an instance deleted here are unlinked by the delete (#1437); undo relinks them. And a
  // member deleted as its own target beside its root's subtree may respawn first: undo re-points it (#1437).
  const rootLinks = captureRootLinks(collectSubtreeIds(getAllEntities().map((e) => [e.id, e.parentId] as const), snaps.map(s => s.snapshot.id)));
  const respawnedGuids = new Set<string>();
  for (const s of snaps) snapshotGuids(s.snapshot, respawnedGuids);
  // Taken while the rows are still live: which surviving frame each one is a row of, and that frame's document (#1820).
  const survivors = survivingFrameRows(snaps.map((s) => s.snapshot));
  // #2001 S4: the door's delete (`removeMember`, and the unlink of an added node or instance) — targets read before the
  // delete, committed after it (rule 3: a deleted member's records stay).
  const commitRecord = instanceEdits.beginDelete(snaps.map((s) => s.snapshot.id));
  let detached: DetachedMember[] = recordDetachedMarks(snaps.flatMap(s => deleteEntity(s.snapshot.id)));
  commitRecord();
  setSelection?.([]);

  // The redo's refusal: a target that is gone. Asked by the redo and by a batch's pre-pass (#2010), through `has`.
  const requireTargets = (has: (guid: string) => number | undefined): number[] => snaps.map((s) => {
    const id = s.guid ? has(s.guid) : undefined;
    if (id == null) throw new UndoRefusedError(`"${s.name}" (${journalRefOf(s.guid, s.snapshot.id)}) is no longer in the scene, so there is nothing to delete again.`, `"${s.name}" is no longer in the scene`);
    return id;
  });
  _pushAction({
    label: snaps.length > 1 ? `Delete ${snaps.length} Entities` : 'Delete Entity',
    undo: () => {
      // Every ref first (I19): a parent or an instance root that is gone refuses before anything respawns. Through the
      // rename the delete's frame-ending made (a promoted member keeps a new guid until `relinkDetachedMembersMarked` below
      // takes it back), since the refs were taken before it.
      const idx = buildGuidIndex();
      const renames = renamesOf(detached);
      const parents = snaps.map(s => (s.parentRef ? requireWith(s.parentRef, idx, undefined, renames) : 0));
      requireRootLinks(rootLinks, respawnedGuids, renames);
      requireDetachedMembers(detached, idx, renames, respawnedGuids);
      const rebaseRows = survivors.prepare(idx, renames);
      const liveIds = snaps.map((s, i) => respawnFromSnapshot(s.snapshot, parents[i]));
      // The relink FIRST: it reverses the frame-ending's guid rename, and `restoreRootLinks` finds each root by the guid
      // it had before that rename. The other way round a renamed root was skipped, and its respawned member kept the
      // snapshot's raw `rootInstanceId`, stale after a world swap (#1819 close-out re-review). The relink reads no link.
      relinkDetachedMembersMarked(detached);
      restoreRootLinks(rootLinks);
      // After the links are back: a prefab-edit save or an outside edit since the delete changed a template (#1820).
      // and the rows of a frame that survived the delete, whose own record that edit already moved on (`survivingFrameRows`).
      rebaseRespawned(snaps.map((x) => x.snapshot), rebaseRows());
      // What the rebase leaves: a node whose frame is current still holds the snapshot's values — a nested root deleted as
      // its own target, or a legacy member the delete unlinked where it stood, whose base changed through a row an
      // enclosing frame states (#1800 close-out review). Their unmarked fields take the CURRENT template's (#1800 owner
      // ruling). By guid: a rebuilt frame respawns at new ids, and a relinked member has its pre-delete guid back.
      for (const g of [...respawnedGuids, ...detached.map((d) => d.guid)]) { const e = findEntityByGuid(g); if (e) takeUnmarkedFromBase(e.id()); }
      setSelection?.(snaps.map((x, i) => liveIdOf(x.guid, liveIds[i]!)));
    },
    redo: () => {
      // Resolve each entity by its (restored) root guid — robust across rebuild + id reuse. All of them before the first
      // delete (I19): a target that is gone refuses the redo rather than deleting the rest and reading as done.
      const idx = buildGuidIndex();
      const ids = requireTargets((g) => idx.get(g));
      detached = recordDetachedMarks(ids.flatMap(id => deleteEntity(id)));
      setSelection?.([]);
    },
    // #2010: the undo's checks above, in its order, against a batch's pass; then what the undo brings back (the deleted
    // subtrees, and each promoted member's pre-delete guid in place of the one the frame-ending gave it).
    check: {
      undo: (pass) => {
        const renames = renamesOf(detached);
        for (const s of snaps) if (s.parentRef) checkRef(pass, s.parentRef, undefined, renames);
        requireRootLinks(rootLinks, respawnedGuids, renames, pass);
        requireDetachedMembers(detached, pass.index, renames, new Set([...respawnedGuids, ...pass.arriving]));
        survivors.prepare(pass.index, renames, pass);
        arrive(pass, [...respawnedGuids, ...renames.keys()]);
      },
      redo: (pass) => {
        // A target an earlier sub brings back is there when this runs; its guid has no id yet, so any number stands in.
        requireTargets((g) => (pass.arriving.has(g) ? -1 : pass.index.get(g)));
        // A promotion renames the members it frees (#1447), and a redo's names are minted fresh, which nothing can name yet.
        if (detached.some((d) => d.renamed?.length)) pass.blind = true;
      },
    },
    kind: '!delete',
    journalPayload: { entities: snaps.map(s => journalRefOf(s.guid, s.snapshot.id)) },
    affectedScenes,
  });
}

/** Delete one entity as one undo entry: `deleteEntitiesWithUndo` with a single target, so the two cannot drift. It
 *  had its own body, which captured no root links (a member deleted as its own target came back holding its dead
 *  root's raw id, #1827's `carryEntityIdFields` row) and whose redo no-opped on a miss. */
export function deleteEntityWithUndo(entityId: number): void {
  deleteEntitiesWithUndo([entityId]);
}

// ── Reparent with undo ──

/** The live hierarchy a reparent walks, read ON DEMAND, node by node — only the two chains the move asks about. Never the
 *  per-frame `worldTransforms` cache (#1848): it is only as fresh as the last propagation pass, so a parent created, or a
 *  mover edited, since then was read at its stale pose — the mover jumped by the new parent's offset, or the reparent
 *  undid the edit. An entity with no Transform places nothing (`PoseHierarchy.places`), as in `transformPropagationSystem`. */
function liveHierarchy(transformMeta: TraitMeta, attrMeta: TraitMeta): PoseHierarchy<number> {
  return {
    parentOf: (id) => Number(readTraitData(id, attrMeta)?.parentId) || null,
    places: (id) => !!readTraitData(id, transformMeta),
    trsOf: (id) => mergeTrs(IDENTITY_TRS, readTraitData(id, transformMeta) ?? {}),
  };
}

/** The minimal Transform write that keeps `entityId`'s world pose under `newParentId` (0 = the root), from its LIVE local
 *  pose and the live chains — `reparentWrite`, the owner the file route shares. */
function liveReparentWrite(entityId: number, newParentId: number, local: Record<string, unknown>, transformMeta: TraitMeta, attrMeta: TraitMeta):
  ReturnType<typeof reparentWrite> {
  const { from, to } = reparentSuffixes(liveHierarchy(transformMeta, attrMeta), entityId, newParentId || null);
  return reparentWrite(mergeTrs(IDENTITY_TRS, local), from, to);
}

/** Whether moving `entityId` under `newParentId` must be refused because the new chain has ZERO scale (#1848,
 *  docs/scene-loading.md § "A reparent keeps the world pose"): no local transform keeps the world pose there. `planReparent` asks it, so every entry point refuses before it
 *  writes anything; `reparentEntity` and `moveEntityToScene` keep it as the backstop for a direct caller. */
function collapsesUnder(entityId: number, newParentId: number): boolean {
  const transformMeta = getTraitByName('Transform');
  const attrMeta = getTraitByName('EntityAttributes');
  const local = transformMeta && attrMeta && newParentId ? readTraitData(entityId, transformMeta) : null;
  return !!local && 'collapsed' in liveReparentWrite(entityId, newParentId, local, transformMeta!, attrMeta!);
}

/** A move under a zero-scale parent (`collapsesUnder`). */
export type CollapsedParentRefusal = 'collapsed-parent';

/** The editor's words for a move refused under a zero-scale parent, used by every entry point. */
export const COLLAPSED_PARENT_REFUSAL_TEXT = "The new parent's chain has ZERO scale, which collapses every child onto its origin, so no local transform keeps the moved object's world pose. Give that ancestor a non-zero scale first.";

/** The root of the OUTERMOST prefab instance `nodeId` sits in: the instance root of its topmost ancestor
 *  (itself included) that carries `PrefabInstance`, or 0 when none does. A member moved anywhere under the
 *  same outermost instance stays linked, across nested instances and scene-added nodes alike (#1437). */
function outermostInstanceRoot(nodeId: number): number {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return 0;
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  let top = 0;
  const seen = new Set<number>();
  for (let cur = byId.get(nodeId); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    const pi = findEntity(cur.id)?.get(piMeta.trait) as { rootInstanceId?: number } | undefined;
    if (pi) top = pi.rootInstanceId || cur.id;
  }
  return top;
}

/** Which links a move of `entityId` under `newParentId` cuts — decided BEFORE the move, while the mover still
 *  sits where it was (#1445). Null when it cuts none. A move that stays inside its outermost instance is saved
 *  as a move (#1437) and splits nothing. One that carries a subtree OUT cuts a link exactly where it SPLITS: a
 *  member on the other side from its instance root is unpacked (`strip`), an owned nested root on the other
 *  side from the instance whose row expanded it is made standalone (`promote`, #1447). Stored roots keep
 *  everything. Either way, a member the move leaves ABOVE its frame is unpacked too (#1450). */
function planMoveUnlinks(entityId: number, newParentId: number): { strip: number[]; promote: number[] } | null {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return null;
  const top = outermostInstanceRoot(entityId);
  if (!top) return null;
  const leaving = outermostInstanceRoot(newParentId) !== top;
  const all = getAllEntities();
  const inSub = new Set(collectSubtreeIds(all.map((e) => [e.id, e.parentId] as const), [entityId]));
  // Where each entity's template puts it, and which instance owns each owned root — before the move.
  const identity = worldIdentityParents(getCurrentWorld());
  const parentOf = new Map(all.map((e) => [e.id, e.parentId]));
  const strip: number[] = [];
  const promote: number[] = [];
  if (leaving) for (const e of all) {
    const pi = findEntity(e.id)?.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number } | undefined;
    if (!pi) continue;
    const root = pi.rootInstanceId || 0;
    if (isStoredRoot(pi, e.id)) continue; // a stored root
    if (isOwnedRoot(pi, e.id)) {
      // An owned nested root belongs to the instance whose row expanded it — its owner.
      const owner = identity.ownerOf(e.id);
      if (owner && inSub.has(owner) !== inSub.has(e.id)) promote.push(e.id);
    } else if (root && inSub.has(root) !== inSub.has(e.id)) {
      strip.push(e.id);
    }
  }
  // A linked member is written by its FRAME's save — the first promoted root on its ownership chain, else the
  // stored root the chain reaches — and a frame is saved from its root down. So a member is written nowhere, and
  // vanishes on reload with the instance, in two shapes (close-out reviews, #1450): it sits ABOVE its frame, or
  // it ends up in a different outermost instance from that frame. Unpacked instead. A member merely BESIDE its
  // frame inside the same outermost instance is a #1437 move and stays linked, and so is one above an OWNED
  // root that is not its frame (that root is saved inside the frame's instance). Judged on the tree AFTER the
  // move — and on every move: one that stays inside the outermost instance can put a root under its own member.
  const promoted = new Set(promote);
  const stripped = new Set(strip);
  const after = new Map(parentOf);
  after.set(entityId, newParentId);
  const piOf = (id: number) => findEntity(id)?.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number } | undefined;
  /** The outermost instance `id` sits INSIDE after the move: the root of its topmost linked ancestor, not counting
   *  its own link or one this plan strips; 0 when none. */
  const topAbove = (id: number): number => {
    let top = 0;
    const seen = new Set<number>([id]);
    for (let cur = after.get(id) ?? 0; cur && !seen.has(cur); cur = after.get(cur) ?? 0) {
      seen.add(cur);
      const p = stripped.has(cur) ? undefined : piOf(cur);
      if (p) top = p.rootInstanceId || cur;
    }
    return top;
  };
  /** `id`'s frame: the first promoted root on its ownership chain, or the stored root the chain reaches. */
  const frameOf = (id: number): number => {
    const seen = new Set<number>();
    for (let root = piOf(id)?.rootInstanceId || 0; root && !seen.has(root);) {
      seen.add(root);
      if (promoted.has(root)) return root;
      const rp = piOf(root);
      if (!rp?.parentLocalId) return root; // a stored root
      root = identity.ownerOf(root);
    }
    return 0;
  };
  /** Whether the save cannot write `id` as linked where the move leaves it: its identity parent is unpacked, or it
   *  sits above its frame, or outside its outermost. The first is close-out review 3: a live child of an unpacked
   *  member that never moved (so it sits at its row) — an owned root there reloaded as a stored one under new
   *  guids, and a member reloaded plain while the editor still showed it linked. (It read "no recorded home"
   *  before #1468 Phase 6; "not moved" is the same set, now read from the document.) */
  const unwritable = (id: number): boolean => {
    const pi = piOf(id);
    if (pi && !identity.moved(id) && stripped.has(parentOf.get(id) ?? 0)) return true;
    const frame = frameOf(id);
    if (!frame || frame === id) return false;
    const seen = new Set<number>();
    for (let cur = after.get(frame) ?? 0; cur && !seen.has(cur); cur = after.get(cur) ?? 0) {
      if (cur === id) return true;
      seen.add(cur);
    }
    return topAbove(id) !== (topAbove(frame) || frame);
  };
  /** The owned roots on `id`'s ownership chain below its frame — whose promotion would change that frame. */
  const ownedChain = (id: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let root = piOf(id)?.rootInstanceId || 0; root && !seen.has(root) && !promoted.has(root);) {
      seen.add(root);
      const rp = piOf(root);
      if (!rp?.parentLocalId) break; // a stored root
      out.push(root);
      root = identity.ownerOf(root);
    }
    return out;
  };
  // Settled ONE entity at a time, re-judging everything after each (close-out review 2): an unwritable OWNED root
  // is PROMOTED — #1447's rule for an owned root split from its owner — and becomes the frame its members and the
  // roots it owns are judged against; an unwritable member is unpacked, which can leave what hangs below it outside
  // every instance. So each verdict can flip another, and a pass over the entity list in storage order decided by
  // that order: a member under an unpacked one stayed linked and the save dropped it; an owned root under one was
  // left owned and reloaded under new guids; an INNER was promoted along with the MID it would have followed. Each
  // pass acts on an entity nothing else pending can flip — no unwritable tree ancestor, no unwritable owned root on
  // its chain — or, failing that, the shallowest with no unwritable owned root on its chain. Promotion and unpacking
  // only grow, so it ends.
  const linkedMember = (id: number): boolean => {
    const pi = piOf(id);
    return !!pi?.rootInstanceId && !isStoredRoot(pi, id) && !promoted.has(id) && !stripped.has(id);
  };
  const ancestorsAfter = (id: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>([id]);
    for (let cur = after.get(id) ?? 0; cur && !seen.has(cur); cur = after.get(cur) ?? 0) { seen.add(cur); out.push(cur); }
    return out;
  };
  for (;;) {
    const bad = all.map((e) => e.id).filter((id) => linkedMember(id) && unwritable(id));
    if (!bad.length) break;
    const badSet = new Set(bad);
    const free = (id: number) => !ancestorsAfter(id).some((a) => badSet.has(a)) && !ownedChain(id).some((r) => r !== id && badSet.has(r));
    // Nothing free: still an owner before the roots it owns (close-out review 3 — the shallowest alone promoted an
    // INNER ahead of its MID), and among those the shallowest.
    const unowned = bad.filter((id) => !ownedChain(id).some((r) => r !== id && badSet.has(r)));
    const shallowest = (ids: number[]) => ids.reduce((a, b) => (ancestorsAfter(b).length < ancestorsAfter(a).length ? b : a));
    const pick = bad.find(free) ?? shallowest(unowned.length ? unowned : bad);
    if (piOf(pick)?.rootInstanceId === pick) { promote.push(pick); promoted.add(pick); } else { strip.push(pick); stripped.add(pick); }
  }
  return strip.length || promote.length ? { strip, promote } : null;
}

/** A reparent keeps the world pose by rewriting the local Transform. On an entity still linked to a prefab
 *  instance those local values are overrides, and the save keeps an instance field only when it is MARKED
 *  (`captureInstanceOverrides`), so an unmarked compensated field reloaded at the prefab's value and the
 *  entity jumped (#1436 review: a root dropped under a moved parent reloaded at that parent's origin).
 *  Marks each field the compensation changed — on a STORED instance root only (top-level or user-added).
 *  A member moved inside its own instance needs no mark: while it sits away from its template parent the
 *  save writes every Transform field that differs from the base (`captureInstanceOverrides`, #1437), and
 *  once it is moved back nothing is left pinned. A mark would outlive the move and pin the pose. The same
 *  holds for an OWNED nested root, whose "away from its template parent" is asked of its owner's frame
 *  (`ownedRootMoved`, #1481). */
function markCompensatedTransform(id: number, oldLocal: Record<string, unknown>, newLocal: Record<string, number>): void {
  const piMeta = getTraitByName('PrefabInstance');
  const entity = findEntity(id);
  if (!piMeta || !entity?.has(piMeta.trait)) return;
  if (!isStoredRoot(entity.get(piMeta.trait) as MemberPi, id)) return;
  for (const f of Object.keys(newLocal)) {
    if (Math.abs(newLocal[f]! - Number(oldLocal[f] ?? 0)) > 1e-6) markOverride(entity, 'Transform', f);
  }
}

export function reparentEntity(entityId: number, newParentId: number, newSortOrder?: number): boolean {
  // Self-parent + cycle now live in runtime/core/ecs/hierarchy.ts, shared with the device's
  // set-traits guard — the same rule in two places is what #166 P7 found diverging (§9).
  if (reparentRefusal(entityId, newParentId)) return false;
  // The prefab-edit root stays where it is, and nothing the save writes leaves it (#1836). `planReparent` asks the same.
  if (prefabEditRefusal({ kind: 'reparent', id: entityId, parentId: newParentId })) return false;

  const allTraits = getAllTraits();
  const transformMeta = allTraits.find(m => m.name === 'Transform');
  const attrMeta = allTraits.find(m => m.name === 'EntityAttributes');
  if (!attrMeta) return false;

  const oldAttr = readTraitData(entityId, attrMeta);
  if (!oldAttr) return false;
  const oldParentId = (oldAttr.parentId as number) || 0;
  const oldSortOrder = (oldAttr.sortOrder as number) || 0;
  // Off the trait itself: `readTraitData` returns only `meta.fields`, which leaves editorFolder out, so
  // reading it from `oldAttr` was always '' and the folder clear below never ran (#1434).
  const oldFolder = ((findEntity(entityId)?.get(attrMeta.trait as never) as { editorFolder?: string } | undefined)?.editorFolder) || '';

  const parentChanged = oldParentId !== newParentId;
  const orderChanged = newSortOrder !== undefined && newSortOrder !== oldSortOrder;
  if (!parentChanged && !orderChanged) return false;
  // A prefab-supplied object neither moves nor takes a new place (#1869). The backstop for a direct caller, as the checks
  // above are: every entry point asks `planReparent`, which says it.
  if (restructureRefusal({ id: entityId, parentId: newParentId, reorder: orderChanged })) return false;

  // Base-scene persistence guard (Phase 6): refuse a reparent that would put an
  // entity under a parent from a DIFFERENT source scene. The entry points reach a
  // scene-crossing parent through `applyReparent`, which turns it into a prompted
  // scene move (#1429); this stays the backstop for a direct caller. Cross-scene parenting
  // breaks save provenance (a foreign child silently vanishes from either
  // scene's save) and teardown (a scene-scoped subtree walk expects to stay
  // within one scene) — see scene-loading.md Phase 6.
  if (parentChanged && newParentId !== 0) {
    const newParentAttr = readTraitData(newParentId, attrMeta);
    const entitySource = (oldAttr.sourceScene as string) || '';
    const parentSource = (newParentAttr?.sourceScene as string) || '';
    if (entitySource !== parentSource) {
      console.warn(
        `[reparentEntity] refused: cross-scene parenting (entity sourceScene="${entitySource || 'primary'}", ` +
        `new parent sourceScene="${parentSource || 'primary'}") — scene-loading.md Phase 6 guard.`,
      );
      return false;
    }
  }

  // Maintenance rule: editorFolder (the Hierarchy grouping tag) is only valid on
  // ROOTS. When an entity gains a parent it stops being a root, so drop its folder
  // tag — folded into this action's undo/redo so Cmd+Z restores the tag too.
  const clearFolder = parentChanged && newParentId !== 0 && oldFolder !== '';

  // Keep the world pose (only if the entity has a Transform), writing only what the move changes (#1848).
  let oldLocal: Record<string, any> | null = null;
  let newLocal: Record<string, number> | null = null;

  if (parentChanged && transformMeta) {
    oldLocal = readTraitData(entityId, transformMeta);
    if (oldLocal) {
      const kept = liveReparentWrite(entityId, newParentId, oldLocal, transformMeta, attrMeta);
      if ('collapsed' in kept) { reportWriteRefusal(`"${entityNameOf(entityId)}" was not moved: ${COLLAPSED_PARENT_REFUSAL_TEXT}`); return false; }
      newLocal = kept.write as Record<string, number> | null;
      if (newLocal) for (const [f, v] of Object.entries(newLocal)) writeTraitField(entityId, transformMeta, f, v);
    }
  }

  // Taken BEFORE the parent write (#1445): afterwards the mover's own ancestry runs through its new parent, so a
  // drop into ANOTHER instance read as staying inside the one it had left.
  const detachPlan = parentChanged ? planMoveUnlinks(entityId, newParentId) : null;

  // An OWNED nested root records which instance's row it is BEFORE it leaves: after the write its live parent
  // no longer says (`identityParents.ts`). Kept across the undo — back at its row, the link and the live parent
  // agree. (A plain member records nothing: its template parent is read from the document.)
  // The marks an undo puts back: taken before ANY write here, since the sortOrder write below marks (#1709), and a
  // snapshot after it made the undo restore that mark, pinning the old order as an override.
  const oldMarks = captureMarks(entityId);
  // #2001 S4: the door's reparent (`setPlacement` + `own` relinks) — targets read before the parent write, committed
  // after the compensation below.
  const commitRecord = parentChanged ? instanceEdits.beginReparent(entityId) : null;
  if (parentChanged) linkOwnerBeforeMove(getCurrentWorld(), entityId);
  if (parentChanged) writeTraitField(entityId, attrMeta, 'parentId', newParentId);
  if (newSortOrder !== undefined) writeTraitFieldMarked(entityId, attrMeta, 'sortOrder', newSortOrder);
  if (clearFolder) writeTraitField(entityId, attrMeta, 'editorFolder', '');

  // Leaving the OUTERMOST instance cuts exactly the links the move splits (#1447): a member carried away from its
  // instance root, or left behind by it, is unpacked into a plain entity that keeps its guid; an OWNED nested
  // instance separated from the instance whose row expanded it becomes a standalone instance of its own prefab
  // (owner ruling 2026-09-19 — it used to unpack too). Everything that moves together stays linked: a stored
  // root dropped anywhere stays an instance, and inside another instance becomes its user-added nested one
  // (#1436). A move that stays inside the outermost instance is saved as a `moved` entry (#1437) and cuts only a
  // member it leaves above its frame — a root dropped under its own member unpacks that member (#1450, owner
  // ruling 2026-09-19: unpack, not refuse). All of it is part of this action's undo/redo.
  const piMeta = getTraitByName('PrefabInstance');
  // `ownerRef` addresses the instance root by guid (null: the target IS the root): `data.rootInstanceId`
  // is a bare ecs id, which a world rebuild (Play→Stop) reassigns, and an undo restoring the stale id
  // left the instance naming a dead root — the next save wrote neither root nor members.
  // An unpacked member keeps its marks (#1794 close-out review): the undo re-links it, and a rebuild in between re-seeds the
  // marks from a file that holds it plain, so the next save dropped its overrides. A PROMOTED root needs none: it is saved
  // as the standalone instance it became, whose overrides mark it again on the reload (the second review, measured).
  const detachTargets: { ref: EntityRef; ownerRef: EntityRef | null; data: Record<string, unknown>; marks: MarkCapture }[] = [];
  const promoteTargets: { ref: EntityRef; data: Record<string, unknown> }[] = [];
  if (piMeta && detachPlan) {
    for (const id of detachPlan.strip) {
      const pd = findEntity(id)!.get(piMeta.trait) as Record<string, unknown>;
      const owner = pd.rootInstanceId as number;
      detachTargets.push({ ref: entityRef(id), ownerRef: owner === id ? null : entityRef(owner), data: { ...pd }, marks: captureMarks(id) });
    }
    for (const id of detachPlan.promote) promoteTargets.push({ ref: entityRef(id), data: { ...(findEntity(id)!.get(piMeta.trait) as Record<string, unknown>) } });
  }
  // What the last apply renamed, for its undo. (The values the outer row set on a promoted instance need no
  // re-marking: every expansion marks the row overrides it applies, so the save already keeps them.)
  let renamed = new Map<string, string>();
  // …and what its frame-ending promoted or unlinked OUTSIDE the plan (#1453).
  let orphans: DetachedMember[] = [];
  const applyDetach = () => {
    if (!piMeta) return;
    const idx = buildGuidIndex();
    const ids = detachTargets.map((t) => resolveWith(t.ref, idx)).filter((id): id is number => id != null);
    // A member moved away from an unpacked one keeps its path (#1437), and one still linked to an unpacked
    // owned root's frame is promoted or unlinked with it (#1453).
    orphans = recordDetachedMarks(endFrames(new Set(ids)));
    for (const id of ids) findEntity(id)?.remove(piMeta.trait);
    const roots = promoteTargets.map((t) => resolveWith(t.ref, idx)).filter((id): id is number => id != null);
    renamed = promoteOwnedRoots(roots);
  };
  const undoDetach = () => {
    if (!piMeta) return;
    // Renames reversed last-applied first: the plan's promotions, then the orphans' (inside the relink).
    applyGuidRemap(new Map([...renamed].map(([a, b]) => [b, a])));
    relinkDetachedMembersMarked(orphans);
    const idx = buildGuidIndex();
    for (const t of promoteTargets) {
      const id = resolveWith(t.ref, idx);
      // Its own root: the id, not the stored one, which a world rebuild (Play→Stop) reassigns.
      if (id != null) findEntity(id)?.set(piMeta.trait, { ...t.data, rootInstanceId: id });
    }
    for (const t of detachTargets) {
      const id = resolveWith(t.ref, idx);
      if (id == null) continue;
      const owner = t.ownerRef ? resolveWith(t.ownerRef, idx) : id;
      // An owner that no longer resolves (a derived guid the rebuild re-derived differently) is left
      // unlinked: its stale id may now name an unrelated entity, and a member naming one is dropped
      // by the save, whereas a plain entity is written.
      if (owner == null) continue;
      findEntity(id)?.add(piMeta.trait({ ...t.data, rootInstanceId: owner }));
      restoreMarks(id, t.marks);
    }
  };
  const detaching = detachTargets.length > 0 || promoteTargets.length > 0;
  // Guid refs so undo/redo survive a world rebuild. Root (0) stays literal 0. Taken BEFORE the detach: a
  // promotion renames members (#1447), and the old parent can be one of them — undo reverses the rename first,
  // so a ref taken after it named nothing and the mover went to the scene root (close-out review).
  const ref = entityRef(entityId);
  const oldParentRef = oldParentId ? entityRef(oldParentId) : null;
  const newParentRef = newParentId ? entityRef(newParentId) : null;
  if (detaching) applyDetach();
  // A member that STAYS linked keeps deriving from the row parent it left (#1437) with nothing recorded on it:
  // every identity walk reads its template parent from the document (`identityParents.ts`, #1468 Phase 6).
  if (oldLocal && newLocal) markCompensatedTransform(entityId, oldLocal, newLocal);
  commitRecord?.({ compensated: oldLocal && newLocal ? { old: oldLocal, next: newLocal } : undefined, detaching });
  markStructureDirty();

  const savedOldLocal = oldLocal ? { ...oldLocal } : null;
  const savedNewParentId = newParentId;
  const savedNewLocal = newLocal;

  const entityName = getAllEntities().find(e => e.id === entityId)?.name || `Entity ${entityId}`;
  const parentName = newParentId === 0 ? 'root' : (getAllEntities().find(e => e.id === newParentId)?.name || `Entity ${newParentId}`);
  const label = parentChanged ? `Reparent "${entityName}" → ${parentName}` : `Reorder "${entityName}"`;

  // The cross-scene-parenting guard above already refuses any reparent that would
  // change the entity's effective scene, so its sourceScene is the SAME before and
  // after — one scene, resolved once, post-mutation is fine.
  const affectedScenes = resolveAffectedScenes([entityId]);

  _pushAction({
    label,
    undo: () => {
      // The mover and its old parent, both required before the first write (I19): a parent that is gone refuses
      // rather than putting the mover at the scene root. Through the promotion's rename, which `undoDetach` reverses
      // only after this: both refs were taken before it, and either one can be a member it renamed (#1447).
      const idx = buildGuidIndex();
      const renames = detaching ? renamesOf(orphans, new Map(renamed)) : undefined;
      const id = requireWith(ref, idx, undefined, renames);
      const parent = oldParentRef ? requireWith(oldParentRef, idx, undefined, renames) : 0;
      if (detaching) undoDetach(); // re-tag the detached members first, and take back a promotion's rename
      writeTraitField(id, attrMeta!, 'parentId', parent);
      writeTraitField(id, attrMeta!, 'sortOrder', oldSortOrder);
      if (clearFolder) writeTraitField(id, attrMeta!, 'editorFolder', oldFolder);
      // Only the keys the move wrote: an edit since to any other field is not the move's to undo.
      if (savedOldLocal && savedNewLocal && transformMeta) { for (const f of Object.keys(savedNewLocal)) writeTraitField(id, transformMeta, f, savedOldLocal[f]); }
      restoreMarks(id, oldMarks);
      markStructureDirty();
    },
    redo: () => {
      const id = ref.require();
      writeTraitField(id, attrMeta!, 'parentId', newParentRef ? newParentRef.require() : 0);
      // As the original action: only a move that SET a sortOrder writes it. (Before #1914 R2 re-writing the unchanged
      // value un-recorded a stored override equal to the base; no write removes a record now.)
      if (newSortOrder !== undefined) writeTraitFieldMarked(id, attrMeta!, 'sortOrder', newSortOrder);
      if (clearFolder) writeTraitField(id, attrMeta!, 'editorFolder', '');
      if (savedNewLocal && transformMeta) { for (const [f, v] of Object.entries(savedNewLocal)) writeTraitField(id, transformMeta, f, v); }
      if (detaching) applyDetach(); // re-strip after the move
      if (savedOldLocal && savedNewLocal) markCompensatedTransform(id, savedOldLocal, savedNewLocal);
      markStructureDirty();
    },
    // #2010: each half's refs, as above. A move that detaches changes which entities are instance members, and a
    // promotion renames them, which no later check can read off the pass: it ends the pre-pass.
    check: {
      undo: (pass) => {
        const renames = detaching ? renamesOf(orphans, new Map(renamed)) : undefined;
        checkRef(pass, ref, undefined, renames);
        if (oldParentRef) checkRef(pass, oldParentRef, undefined, renames);
        if (detaching) pass.blind = true;
      },
      redo: (pass) => {
        checkRef(pass, ref);
        if (newParentRef) checkRef(pass, newParentRef);
        if (detaching) pass.blind = true;
      },
    },
    kind: '!reparent',
    // `from`/`to` are parent guids ('root' for scene root); equal when this is a pure
    // reorder (sortOrder change under the same parent).
    journalPayload: { entity: journalRefOf(ref.guid, entityId), from: parentGuid(oldParentId), to: parentGuid(savedNewParentId), reorder: !parentChanged },
    affectedScenes,
  });

  return true;
}

// ── Move between scenes (scene-loading.md Phase 14) ──

/** One entityRef-shaped field rewritten by a guid rekey — informational (which
 *  field on which entity changed); `rewriteEntityRefsForGuid` is symmetric under
 *  swapping its two arguments, so undo/redo just call it again in the opposite
 *  direction rather than replaying this list — see `moveEntityToScene`'s rekey
 *  handling below. */
interface RefRewrite { ref: EntityRef; traitName: string; field: string; prev: unknown }

/** Every registry-declared `{meta, field}` pair whose FieldHint is `type:
 *  'entityRef'` — swept off the trait registry so a newly-registered entityRef
 *  field is covered automatically, with no hardcoded field list to keep in sync.
 *  Deliberately does NOT include UIAction.bindings (`type: 'bindings'`, an AoS
 *  array of `{target, ...}` rows) — that field is special-cased in
 *  `rewriteEntityRefsForGuid` because a generic per-field sweep can't see inside
 *  an array-of-objects. */
function entityRefFields(): { meta: TraitMeta; field: string }[] {
  const out: { meta: TraitMeta; field: string }[] = [];
  for (const meta of getAllTraits()) {
    for (const [field, hint] of Object.entries(meta.fields)) {
      if (hint.type === 'entityRef') out.push({ meta, field });
    }
  }
  return out;
}

/** Rewrite every LIVE reference to `oldGuid` → `newGuid`, across every entity in
 *  the current world (i.e. the whole loaded scene chain — both the source and
 *  target scene are in the same world once additively loaded). Covers every
 *  registry `entityRef` field plus `UIAction.bindings[].target` (§0.4 — a
 *  `bindings` field is an AoS array, not swept by `entityRefFields`). Returns the
 *  rewrites performed so the caller can fold them into ONE undo action.
 *
 *  Does NOT touch `EntityAttributes.parentId` — that is a live numeric ecs id at
 *  runtime (D1), not a guid; only its SERIALIZED form is a guid, re-derived by
 *  the serializer from the live parent, so renaming the parent's guid needs no
 *  rewrite here.
 *
 *  A ref living in a SIBLING scene file that is not currently loaded cannot be
 *  reached or rewritten by this function — surface that risk to the user via
 *  `preflightSceneMove` (sceneMoveScan.ts) before rekeying, not here. */
function rewriteEntityRefsForGuid(oldGuid: string, newGuid: string): RefRewrite[] {
  if (!oldGuid || oldGuid === newGuid) return [];
  const rewrites: RefRewrite[] = [];
  const refFields = entityRefFields();
  const bindingsMeta = getTraitByName('UIAction');
  for (const info of getAllEntities()) {
    for (const { meta, field } of refFields) {
      const entity = findEntity(info.id);
      if (!entity || !entity.has(meta.trait)) continue;
      const data = readTraitData(info.id, meta);
      if (!data || data[field] !== oldGuid) continue;
      rewrites.push({ ref: entityRef(info.id), traitName: meta.name, field, prev: oldGuid });
      writeTraitField(info.id, meta, field, newGuid);
    }
    if (bindingsMeta) {
      const entity = findEntity(info.id);
      if (!entity || !entity.has(bindingsMeta.trait)) continue;
      const full = readTraitDataFull(info.id, bindingsMeta);
      const bindings = full?.bindings as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(bindings) || bindings.length === 0) continue;
      let changed = false;
      const next = bindings.map((b) => {
        if (b.target !== oldGuid) return b;
        changed = true;
        return { ...b, target: newGuid };
      });
      if (changed) {
        rewrites.push({ ref: entityRef(info.id), traitName: 'UIAction', field: 'bindings', prev: bindings });
        writeTraitField(info.id, bindingsMeta, 'bindings', next);
      }
    }
  }
  return rewrites;
}

export interface SceneMoveResult {
  ok: boolean;
  reason?: 'no-entity' | 'no-attrs' | 'same-scene' | 'trait-missing' | 'collapsed-parent' | SceneMoveRefusal | RestructureRefusal;
  /** Live ids of every entity re-stamped (the subtree, root first). */
  movedIds: number[];
  /** True when the root's parentId was cleared (landed at the target scene's
   *  root) rather than reparented under an explicit `opts.newParentId`. */
  reRooted: boolean;
  /** Guid rekeys performed (empty unless `opts.rekeyGuids` was supplied). */
  rekeyed: { oldGuid: string; newGuid: string }[];
}

export interface SceneMoveOptions {
  /** Reparent the moved root directly under this entity in the TARGET scene —
   *  `applyReparent`'s scene move (#1429): the Hierarchy row drop, cut → paste and
   *  the agent `reparent-entity {moveToScene}` all arrive here. Only the moved
   *  subtree goes; the old parent is left behind untouched. Only honoured when this entity's OWN sourceScene
   *  already equals `targetScene` — otherwise it would recreate the cross-scene-
   *  parented state Phase 6's guard exists to prevent, so the move silently
   *  falls back to landing at the target scene's root (same as a group-header
   *  drop). */
  newParentId?: number;
  /** Guids in the subtree to rekey (from a pre-flight collision scan, see
   *  sceneMoveScan.ts). For each, a fresh guid is minted and every pointing
   *  entityRef/binding across the whole loaded chain is rewritten in this SAME
   *  undo action. Not wired to the Hierarchy UI yet (owner decision: the confirm
   *  dialog is advisory-only) — this exists for a future caller/test. */
  rekeyGuids?: Set<string>;
  /** The moved root's sortOrder under `newParentId` (a drop between two rows). Ignored when the move
   *  re-roots. Absent: it lands after the target's existing children. */
  sortOrder?: number;
  label?: string;
}

const NULL_MOVE_RESULT: Omit<SceneMoveResult, 'reason'> = { ok: false, movedIds: [], reRooted: false, rekeyed: [] };

/** Change which scene FILE authors this subtree — "promote" (level → base,
 *  `targetScene` = the base's guid) or "demote" (base → level, `targetScene` =
 *  ''). This is **not** a reparent: Phase 6's cross-scene-parenting guard stays
 *  in force unchanged and is trivially satisfied afterwards, because the WHOLE
 *  subtree re-stamps `sourceScene` together (scene-loading.md
 *  Phase 14). Staged write (plan M3): mutates the live world, marks BOTH scenes
 *  dirty, and pushes ONE undo action — no file changes until the next Save All. */
export function moveEntityToScene(entityId: number, targetScene: string, opts?: SceneMoveOptions): SceneMoveResult {
  const attrMeta = getTraitByName('EntityAttributes');
  if (!attrMeta) return { ...NULL_MOVE_RESULT, reason: 'trait-missing' };
  const oldAttr = readTraitData(entityId, attrMeta);
  if (!oldAttr) return { ...NULL_MOVE_RESULT, reason: 'no-attrs' };
  const fromScene = (oldAttr.sourceScene as string) || '';
  if (fromScene === targetScene) return { ...NULL_MOVE_RESULT, reason: 'same-scene' };
  // Asked HERE, inside the move, so no entry point can reach the move without it (#1757): the Hierarchy's
  // scene-group, scene-folder and empty-area drops called this directly and skipped `planReparent`'s check.
  const refusal = sceneMoveRefusal(entityId);
  if (refusal) return { ...NULL_MOVE_RESULT, reason: refusal };
  // A scene move re-parents too (a re-root, or under `newParentId`): a prefab-supplied object does not move (#1869).
  if (restructureRefusal({ id: entityId, parentId: opts?.newParentId ?? 0, move: true })) return { ...NULL_MOVE_RESULT, reason: 'restructure' };

  const flat = getAllEntities();
  const byId = new Map(flat.map((e) => [e.id, e]));
  const rootInfo = byId.get(entityId);
  if (!rootInfo) return { ...NULL_MOVE_RESULT, reason: 'no-entity' };
  // Same walk serializeScene uses for its sourceScene exclusions (editor/scene/
  // serialize.ts) — a half-moved subtree is exactly the cross-scene-parented
  // state the Phase 6 guard exists to prevent.
  const ids = subtreeIds(flat, entityId);

  const allTraitsList = getAllTraits();
  const transformMeta = allTraitsList.find((m) => m.name === 'Transform');

  // Re-root vs. reparent-under-a-row (owner decision, see SceneMoveOptions doc).
  const oldParentId = (oldAttr.parentId as number) || 0;
  let newParentId = 0;
  if (opts?.newParentId) {
    const parentInfo = byId.get(opts.newParentId);
    // Re-root rather than land under a resource row: a child of the Transient Time/Input singleton is
    // dropped from every save (#1248 — `parentRefusal`, the rule every parent-creating path shares).
    if (parentInfo && (parentInfo.sourceScene || '') === targetScene && !parentRefusal(opts.newParentId)) newParentId = opts.newParentId;
  }
  const reRooted = newParentId === 0;
  const parentChanged = oldParentId !== newParentId;
  const oldFolder = rootInfo.editorFolder || '';
  // Maintenance rule mirrored from reparentEntity: editorFolder (Hierarchy
  // grouping tag) is root-only. Clear it when the root GAINS a parent; keep it
  // when re-rooting (the entity IS a root of the target scene, so the tag still
  // means something there).
  const clearFolder = parentChanged && newParentId !== 0 && oldFolder !== '';

  // Preserve world pose across the parent change (owner decision), writing only what the move changes — the owner
  // reparentEntity computes with (#1848).
  let oldLocal: Record<string, number> | null = null;
  let newLocal: Record<string, number> | null = null;
  if (parentChanged && transformMeta) {
    oldLocal = readTraitData(entityId, transformMeta) as Record<string, number> | null;
    if (oldLocal) {
      const kept = liveReparentWrite(entityId, newParentId, oldLocal, transformMeta, attrMeta);
      if ('collapsed' in kept) {
        reportWriteRefusal(`"${rootInfo.name}" was not moved: ${COLLAPSED_PARENT_REFUSAL_TEXT}`);
        return { ...NULL_MOVE_RESULT, reason: 'collapsed-parent' };
      }
      newLocal = kept.write as Record<string, number> | null;
    }
  }

  // sortOrder: land after the target's existing siblings (mirrors
  // createEntityWithUndo's auto-assign) so it can't collide with one of them.
  const siblingScope = newParentId !== 0
    ? flat.filter((e) => e.parentId === newParentId)
    : flat.filter((e) => e.parentId === 0 && (e.sourceScene || '') === targetScene);
  const oldSortOrder = rootInfo.sortOrder;
  const newSortOrder = newParentId !== 0 && opts?.sortOrder !== undefined ? opts.sortOrder
    : siblingScope.length > 0 ? Math.max(...siblingScope.map((e) => e.sortOrder)) + 1 : 0;

  // Capture undo state for every entity in the subtree BEFORE mutating — guid
  // refs survive a world rebuild (entityRef.ts).
  const perEntity = ids.map((id) => ({ ref: entityRef(id), prevSourceScene: byId.get(id)?.sourceScene || '' }));
  const rootRef = perEntity[0].ref; // subtreeIds puts the root first
  const oldParentRef = oldParentId ? entityRef(oldParentId) : null;
  const newParentRef = newParentId ? entityRef(newParentId) : null;

  // Every entity of the moved tree and the parent it goes under, required before the first write (I19): a member or a
  // parent that is gone refuses the step, rather than stamping part of the tree or landing the root at the scene root.
  // `minted` translates a rekeyed guid, for the undo, which runs while those entities still carry the rekey's guid.
  const requireMove = (parentRef: EntityRef | null, minted?: ReadonlyMap<string, string>, pass?: CheckPass): { ids: number[]; parent: number } => {
    // Asked by a batch's pre-pass too (#2010): against the pass, where an entity an earlier sub brings back is not a miss.
    const idx = pass?.index ?? buildGuidIndex();
    const ids = perEntity.map(({ ref }) => {
      const now = minted?.get(ref.guid);
      if (pass && pass.arriving.has(now ?? ref.guid)) return -1;
      if (!now) return requireWith(ref, idx);
      const id = idx.get(now);
      if (id == null) throw new UndoRefusedError(`"${ref.name}" (${now}) is no longer in the scene.`, `"${ref.name}" is no longer in the scene`);
      return id;
    });
    if (pass) { if (parentChanged && parentRef) checkRef(pass, parentRef); return { ids, parent: 0 }; }
    return { ids, parent: parentChanged && parentRef ? parentRef.require() : 0 };
  };
  const applyStamps = () => {
    const { ids, parent } = requireMove(newParentRef);
    for (const id of ids) writeTraitField(id, attrMeta, 'sourceScene', targetScene);
    const rid = ids[0];
    if (parentChanged) writeTraitField(rid, attrMeta, 'parentId', parent);
    writeTraitFieldMarked(rid, attrMeta, 'sortOrder', newSortOrder);
    if (clearFolder) writeTraitField(rid, attrMeta, 'editorFolder', '');
    if (newLocal && transformMeta) for (const [f, v] of Object.entries(newLocal)) writeTraitField(rid, transformMeta, f, v);
    if (oldLocal && newLocal) markCompensatedTransform(rid, oldLocal, newLocal);
  };
  const undoStamps = ({ ids, parent }: { ids: number[]; parent: number }) => {
    perEntity.forEach(({ prevSourceScene }, i) => writeTraitField(ids[i], attrMeta, 'sourceScene', prevSourceScene));
    const rid = ids[0];
    if (parentChanged) writeTraitField(rid, attrMeta, 'parentId', parent);
    writeTraitField(rid, attrMeta, 'sortOrder', oldSortOrder);
    if (clearFolder) writeTraitField(rid, attrMeta, 'editorFolder', oldFolder);
    // Only the keys the move wrote: an edit since to any other field is not the move's to undo.
    if (oldLocal && newLocal && transformMeta) for (const f of Object.keys(newLocal)) writeTraitField(rid, transformMeta, f, oldLocal[f]);
    restoreMarks(rid, rootMarks);
  };
  const rootMarks = captureMarks(entityId);
  // #2001 S4: the door's reparent, as `reparentEntity` (a scene move refuses an instance-member split, so no detach).
  const commitRecord = parentChanged ? instanceEdits.beginReparent(entityId) : null;
  applyStamps();
  commitRecord?.({ compensated: oldLocal && newLocal ? { old: oldLocal, next: newLocal } : undefined });

  // Rekey (owner decision D: machinery built, not wired to the Hierarchy confirm
  // dialog yet). `rewriteEntityRefsForGuid` is symmetric under argument order, so
  // undo/redo just call it again reversed rather than replaying a captured list.
  const rekeyPairs = ids
    .map((id) => ({ id, guid: byId.get(id)?.guid || '' }))
    .filter((e) => e.guid && opts?.rekeyGuids?.has(e.guid))
    .map((e) => ({ oldGuid: e.guid, newGuid: newGuid() }));
  const applyRekeys = () => {
    for (const { oldGuid, newGuid: minted } of rekeyPairs) {
      const ent = findEntityByGuid(oldGuid);
      if (!ent) continue;
      writeTraitField(ent.id(), attrMeta, 'guid', minted);
      indexEntityGuid(ent);
      rewriteEntityRefsForGuid(oldGuid, minted);
    }
  };
  const undoRekeys = () => {
    for (const { oldGuid, newGuid: minted } of rekeyPairs) {
      const ent = findEntityByGuid(minted);
      if (!ent) continue;
      writeTraitField(ent.id(), attrMeta, 'guid', oldGuid);
      indexEntityGuid(ent);
      rewriteEntityRefsForGuid(minted, oldGuid);
    }
  };
  applyRekeys();

  markStructureDirty();
  markUIDirty();
  // No direct scene marks here or in the closures: `affectedScenes` below moves both scenes' state tokens on the push
  // and on each undo/redo, and a direct `markSceneDirty` would pin them dirty past an undo back to saved (#1904).

  const targetLabel = targetScene ? 'base' : 'primary';
  // NOT resolveAffectedScenes (that reads the CURRENT stamp — post-mutation both
  // ids would resolve to targetScene, losing the "from" side). Both scenes are
  // affected regardless of direction; empty strings (primary) are filtered out,
  // matching resolveAffectedScenes' own "primary contributes nothing" contract.
  const affectedScenes = [fromScene, targetScene].filter(Boolean);

  _pushAction({
    label: opts?.label ?? (targetScene ? `Promote "${rootInfo.name}" → ${targetLabel}` : `Demote "${rootInfo.name}" → ${targetLabel}`),
    undo: () => {
      const target = requireMove(oldParentRef, new Map(rekeyPairs.map((p) => [p.oldGuid, p.newGuid])));
      undoRekeys();
      undoStamps(target);
      markStructureDirty(); markUIDirty();
    },
    redo: () => {
      applyStamps();
      applyRekeys();
      markStructureDirty(); markUIDirty();
    },
    // #2010: each half's `requireMove`, against the pass; then the guids the half's rekey puts on.
    check: {
      undo: (pass) => {
        requireMove(oldParentRef, new Map(rekeyPairs.map((p) => [p.oldGuid, p.newGuid])), pass);
        arrive(pass, rekeyPairs.map((p) => p.oldGuid));
      },
      redo: (pass) => {
        requireMove(newParentRef, undefined, pass);
        arrive(pass, rekeyPairs.map((p) => p.newGuid));
      },
    },
    kind: '!sceneMove',
    journalPayload: {
      entity: journalRefOf(rootRef.guid, entityId),
      from: fromScene || 'primary', to: targetScene || 'primary',
      count: ids.length, reRooted, rekeyed: rekeyPairs.length,
    },
    affectedScenes,
    // Deliberately NOT _isFileDirect — staged (plan M3) means nothing is written
    // to disk yet; Save All is what writes both files.
  });

  return { ok: true, movedIds: ids, reRooted, rekeyed: rekeyPairs };
}

/** Promote: level → base. `baseSceneGuid` must be a base already loaded in the
 *  current chain (an entity can only move to a scene that's actually resolved). */
export function promoteEntityToScene(entityId: number, baseSceneGuid: string, opts?: Omit<SceneMoveOptions, 'label'>): SceneMoveResult {
  return moveEntityToScene(entityId, baseSceneGuid, opts);
}

/** Demote: base → primary (Phase 3's "empty sourceScene = primary" convention). */
export function demoteEntityToScene(entityId: number, opts?: Omit<SceneMoveOptions, 'label'>): SceneMoveResult {
  return moveEntityToScene(entityId, '', opts);
}

// ── Reparent across scenes (#1429) ──

/** What putting `entityId` under `newParentId` means. It is the ONE decision every reparent entry point
 *  asks: the Hierarchy row drop, cut → paste, the agent `reparent-entity` op and an `apply-scene-ops`
 *  `parentId` write. An entity and its parent must belong to the same scene file. The save cannot
 *  represent anything else: a foreign child under a base prefab MEMBER is baked into that base's
 *  `added` list, and one under a base non-member is dropped from both files. So a parent from another
 *  scene is a SCENE MOVE into the parent's scene (owner ruling on #1429, option C). It is prompted, and
 *  it is carried out by `moveEntityToScene`, the same move the scene-group drops make.
 *
 *  One prefab refusal, `instance-member`: the scene-move twin of `reparentEntity`'s "unpack on move",
 *  which a scene move cannot carry. Something in the moved subtree is linked to an instance that stays
 *  behind — a member, an OWNED nested root whose outer instance is not moving, or a member held under a
 *  plain added child — or a row of an instance that IS moving lives outside the subtree (a member dragged
 *  out of it, #1437). Either way the instance would be split across two files. Frames are read by identity
 *  (`IdentityParents.frameOf`), never by live parent.
 *  A stored instance root dropped inside a base's instance is NOT refused: it becomes that instance's
 *  user-added nested instance, as it does in a same-scene reparent (#1436). */
export type ReparentPlan =
  | { kind: 'refused'; reason: ReparentRefusal | SceneMoveRefusal | PrefabEditRefusalReason | RestructureRefusal | CollapsedParentRefusal }
  | { kind: 'same-scene' }
  | { kind: 'scene-move'; from: string; to: string };

export function planReparent(entityId: number, newParentId: number, newSortOrder?: number): ReparentPlan {
  const refusal = reparentRefusal(entityId, newParentId);
  if (refusal) return { kind: 'refused', reason: refusal };
  // In prefab edit, the root does not move and nothing leaves it (#1836) — before the scene questions: that world is
  // one synthetic scene.
  const editRefusal = prefabEditRefusal({ kind: 'reparent', id: entityId, parentId: newParentId });
  if (editRefusal) return { kind: 'refused', reason: editRefusal.reason };
  // A prefab-supplied object does not move, within its instance or out of it (#1869) — before the scene questions, so a
  // member dropped on another scene's row is told the rule, not offered a move the scene-move refusal then turns down.
  // `newSortOrder`, when the caller gives the mover a place: a new one is a reorder, refused the same way under its own
  // parent.
  const ea = getTraitByName('EntityAttributes');
  const oldSort = ea ? Number((readTraitData(entityId, ea) as { sortOrder?: number } | null)?.sortOrder ?? 0) : 0;
  const reorder = newSortOrder !== undefined && newSortOrder !== oldSort;
  if (restructureRefusal({ id: entityId, parentId: newParentId, reorder })) return { kind: 'refused', reason: 'restructure' };
  // No local transform keeps the world pose under a zero-scale parent (#1848). Asked here, in the plan, so a multi-target
  // field write refuses before its first target moves, and the op names the reason instead of reading a no-op.
  if (collapsesUnder(entityId, newParentId)) return { kind: 'refused', reason: 'collapsed-parent' };
  // Un-parenting keeps the entity's own scene: a root belongs to whichever file stamps it.
  if (newParentId === 0) return { kind: 'same-scene' };
  const from = rawSourceScene(entityId);
  const to = rawSourceScene(newParentId);
  if (from === to) return { kind: 'same-scene' };
  // The same question `moveEntityToScene` asks, asked here too so a caller can refuse BEFORE its prompt.
  const moveRefusal = sceneMoveRefusal(entityId);
  if (moveRefusal) return { kind: 'refused', reason: moveRefusal };
  return { kind: 'scene-move', from, to };
}

/** Why a scene move refuses. */
export type SceneMoveRefusal = 'instance-member';

/** A move or reorder of an object a prefab supplies (#1869, `restructureRefusal`). */
export type RestructureRefusal = 'restructure';
export { RESTRUCTURE_REFUSAL_TEXT };

/** The editor's words for a refused scene move: the Hierarchy toasts this for every drop that asks. */
export const SCENE_MOVE_REFUSAL_TEXT: Record<SceneMoveRefusal | RestructureRefusal, string> = {
  'instance-member': 'This would split a prefab instance across two scene files: part of it belongs to an instance that stays behind. Move the whole instance, or unpack it first.',
  restructure: RESTRUCTURE_REFUSAL_TEXT,
};

/** Why moving `entityId`'s subtree into another scene file is refused, or null when it may move (#1757). The ONE
 *  scene-move refusal: `moveEntityToScene` asks it before it writes anything, so every move is covered however it
 *  arrives (a Hierarchy row drop, a scene-group / scene-folder / empty-area drop, cut → paste, the agent
 *  `reparent-entity`). `planReparent` and the Hierarchy's group drops ask it too, only to refuse before their
 *  prompt. The target scene does not enter into it: the instance splits whichever file the subtree goes to. */
/** What a Hierarchy drop that lands at a scene's ROOT means (a scene GROUP row, one of its folder rows, the empty
 *  area): nothing when the entity is already that scene's, a refusal, or a move. A `move` carries the entity by guid
 *  AND the world the person dropped it in, for `sceneDropTarget` after the prompt. */
export type SceneDropPlan =
  | { kind: 'same-scene' }
  | { kind: 'refused'; reason: SceneMoveRefusal | RestructureRefusal }
  | { kind: 'move'; entity: EntityRef; world: ReturnType<typeof getCurrentWorld> };

export function planSceneDrop(entityId: number, targetScene: string): SceneDropPlan {
  // Before the refusal: it ignores the target, so a member dropped on its OWN scene's group would be told it splits
  // an instance, for a drop that crosses no file.
  if (rawSourceScene(entityId) === targetScene) return { kind: 'same-scene' };
  if (restructureRefusal({ id: entityId, parentId: 0, move: true })) return { kind: 'refused', reason: 'restructure' };
  const reason = sceneMoveRefusal(entityId);
  if (reason) return { kind: 'refused', reason };
  return { kind: 'move', entity: entityRef(entityId), world: getCurrentWorld() };
}

/** The live entity a confirmed drop may still move, or null: the world was replaced while the prompt was open (a
 *  scene load or reload; the same guid may belong to another file's entity there, and the target scene may not be
 *  loaded at all), or the entity is gone. Refuse, never re-target. `moveEntityToScene` re-asks the refusal itself. */
export function sceneDropTarget(plan: Extract<SceneDropPlan, { kind: 'move' }>): number | null {
  if (plan.world !== getCurrentWorld()) return null;
  return plan.entity.resolve();
}

export function sceneMoveRefusal(entityId: number): SceneMoveRefusal | null {
  const piMeta = getTraitByName('PrefabInstance');
  return piMeta ? sceneMovePrefabRefusal(entityId, piMeta) : null;
}

/** The prefab half of `sceneMoveRefusal` (see `planReparent`'s doc for the refusal). */
function sceneMovePrefabRefusal(entityId: number, piMeta: TraitMeta): 'instance-member' | null {
  const flat = getAllEntities();
  const byId = new Map(flat.map((e) => [e.id, e]));
  const moving = new Set(subtreeIds(flat, entityId));
  // Which frame an entity is a row of is IDENTITY (I6, #1691): a member's `rootInstanceId`, an owned nested root's
  // owner — not the instance its live parent belongs to. And the check runs BOTH ways: a moving entity's frame must
  // move with it, and so must every row of a moving frame, including a member dragged OUT of the moved subtree (#1437),
  // which a subtree walk never saw — it stayed behind in the old scene file, split from its instance.
  const identity = worldIdentityParents(getCurrentWorld());
  for (const e of flat) {
    if (!e.traits.includes('PrefabInstance')) continue;
    const frame = identity.frameOf(e.id);
    if (frame) {
      if (moving.has(e.id) !== moving.has(frame)) return 'instance-member';
      continue;
    }
    // An owned nested root whose owner cannot be told: the instance its parent belongs to has to move too.
    const pd = findEntity(e.id)?.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number } | undefined;
    if (moving.has(e.id) && pd && isOwnedRoot(pd, e.id) && !moving.has(byId.get(e.id)?.parentId ?? 0)) return 'instance-member';
  }
  return null;
}

export interface ReparentResult {
  ok: boolean;
  plan: ReparentPlan;
  /** Present when the plan was a scene move: what `moveEntityToScene` did. */
  sceneMove?: SceneMoveResult;
}

/** Carry out `planReparent`'s answer. A same-scene plan is a plain `reparentEntity`, and a scene move is
 *  `moveEntityToScene` under the new parent. Each is one undo entry. This applies WITHOUT asking: the
 *  prompt belongs to the caller (the Hierarchy's modal, the agent op's `moveToScene` flag), because only
 *  the caller knows how to ask. */
export function applyReparent(entityId: number, newParentId: number, newSortOrder?: number): ReparentResult {
  const plan = planReparent(entityId, newParentId, newSortOrder);
  if (plan.kind === 'refused') return { ok: false, plan };
  if (plan.kind === 'same-scene') return { ok: reparentEntity(entityId, newParentId, newSortOrder), plan };
  const name = getAllEntities().find((e) => e.id === entityId)?.name || `Entity ${entityId}`;
  const sceneMove = moveEntityToScene(entityId, plan.to, {
    newParentId, sortOrder: newSortOrder, label: `Move "${name}" into its new parent's scene`,
  });
  return { ok: sceneMove.ok, plan, sceneMove };
}
