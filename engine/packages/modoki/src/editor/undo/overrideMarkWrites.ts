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
 *  The base is {@link instanceBase}, the one the Inspector highlight and the override list diff against.
 *
 *  An undo that RE-LINKS or RE-ADDS (Detach's, Remove Component's, a delete's relink of the members its frame-ending
 *  unlinked) restores values from its own snapshot, so it takes the marks with them: {@link captureMarks} with the
 *  snapshot, {@link restoreMarks} with the restore (#1794, #1800). Trusting the side store instead held only while the
 *  world the forward step ran in was still there: a rebuild between the step and its undo (Play→Stop, a prefab-edit
 *  visit, returning to the scene) re-seeds the marks from the FILE, which has none for a detached tree or a removed
 *  component, and the next save dropped the values the screen still showed. Unity keeps its overrides as data on the
 *  instance (`m_Modifications`), which its undo snapshots like any other; this is that rule for Modoki's side store. */

import { rowAt } from '../../runtime/loaders/prefabOverrides';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, writeTraitField, cloneTraitValues } from '../../runtime/core/ecs/entityUtils';
import { markOverride, unmarkOverride, getOverrideMarkSet, restoreOverrideMarks, clearOverrideMarks, ROTATION_MARKS } from '../../runtime/loaders/overrideMarks';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { relinkDetachedMembers, type DetachedMember } from '../../runtime/core/ecs/memberHome';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { baseTokenResolver } from '../scene/prefabTokens';
import { hasMemberToken } from '../../runtime/core/templateRefs';
import { collectComparableTraits, getOverrideValues, gateOnMarks } from '../scene/prefabInstanceOverrides';
import { instanceMovedMembers } from '../scene/prefabMembers';
import { instanceBase, enclosingRowOverrides } from '../scene/prefabChain';
import { makeReorderSiblingsAction, type SiblingSortChange } from './reorderSiblingsUndo';
import type { UndoAction } from './undoManager';
import { entityRef, buildGuidIndex, requireWith } from './entityRef';

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
  // Rotation is ONE mark (#1880 F5, `ROTATION_MARKS`): decided once for the group, or an axis equal to its base would
  // unmark the whole rotation another axis just marked.
  const isRotation = (f: string) => (ROTATION_MARKS as readonly string[]).includes(`${meta.name}.${f}`);
  const rotationOff = off === null || [...off].some(isRotation);
  for (const f of list) {
    const differs = isRotation(f) ? rotationOff : off === null || off.has(f);
    if (differs) markOverride(m.entity, meta.name, f);
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
  // Each sibling by guid, every one required before the first write (#1827, I19): the raw ids it held named, after a
  // world swap, whatever entities hold them now, and the renumber wrote `sortOrder` and its mark onto those.
  const refs = changes.map((c) => entityRef(c.id));
  let live = new Map<number, number>();
  const pin = () => {
    const idx = buildGuidIndex();
    live = new Map(changes.map((c, i) => [c.id, requireWith(refs[i], idx)]));
  };
  const at = (id: number) => live.get(id) ?? id;
  const restore = restorableSortOrderWrite(changes.map((c) => c.id));
  const inner = makeReorderSiblingsAction(
    changes, (id, sort) => writeTraitFieldMarked(at(id), attrMeta, 'sortOrder', sort), label,
    (id, sort) => restore(id, sort, at(id)),
  );
  return { ...inner, undo: () => { pin(); inner.undo(); }, redo: () => { pin(); inner.redo(); } };
}

/** The UNDO of a `sortOrder` rewrite on `ids`: a writer that restores the value AND the `sortOrder` mark each entity
 *  has now (call it before the rewrite). Re-reconciling on the way back would drop a stored override that happened to
 *  equal the base, and the save would lose it (#1709 close-out review). Called with the id it was built with (the
 *  key of the mark it took) and the id that entity lives at now. */
function restorableSortOrderWrite(ids: readonly number[]): (id: number, sort: number, liveId?: number) => void {
  const attrMeta = getTraitByName('EntityAttributes');
  const was = new Map(ids.map((id) => [id, markStateOf(id, 'EntityAttributes', ['sortOrder'])]));
  return (id, sort, liveId = id) => {
    if (!attrMeta) return;
    writeTraitField(liveId, attrMeta, 'sortOrder', sort);
    const state = was.get(id);
    if (state) putMarkState(liveId, 'EntityAttributes', state);
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
  const meta = getTraitByName(traitName);
  if (meta) takeUnmarkedFromBase(entityId, [meta], Object.keys(state));
}

/** An entity's override marks as plain data, taken WITH an undo snapshot: its whole set, or only `trait`'s keys when
 *  the step touches one trait. Survives any world rebuild, since it holds no entity. */
export interface MarkCapture { trait?: string; keys: string[] }
export function captureMarks(entityId: number, trait?: string): MarkCapture {
  const e = findEntity(entityId);
  const all = e ? [...(getOverrideMarkSet(e) ?? [])] : [];
  return trait ? { trait, keys: all.filter((k) => k.startsWith(`${trait}.`)) } : { keys: all };
}
/** Put a {@link captureMarks} back: the marks in its scope become exactly the captured ones, and the fields they leave
 *  unmarked take the CURRENT template's values ({@link takeUnmarkedFromBase}). */
export function restoreMarks(entityId: number, capture: MarkCapture): void {
  const e = findEntity(entityId);
  if (!e) return;
  if (!capture.trait) clearOverrideMarks(e);
  else for (const k of [...(getOverrideMarkSet(e) ?? [])]) if (k.startsWith(`${capture.trait}.`)) unmarkOverride(e, capture.trait, k.slice(capture.trait.length + 1));
  restoreOverrideMarks(e, capture.keys);
  const meta = capture.trait ? getTraitByName(capture.trait) : undefined;
  if (!capture.trait || meta) takeUnmarkedFromBase(entityId, meta ? [meta] : undefined);
}

/** After an undo puts a member's marks back, bring every UNMARKED field in scope (`traits`, every trait the entity has
 *  when omitted; only `fields` when given) to the value its instance resolves it to NOW: the CURRENT template, through
 *  the layers enclosing the instance ({@link instanceBase}, token refs resolved as the save compares them). Owner
 *  ruling on #1800 (2026-09-30): Unity always shows the current asset's value for a field the instance does not
 *  override.
 *
 *  Why an undo needs it: its snapshot holds the values of the world it was taken in. After a SAVED prefab edit in
 *  between (leaving prefab edit, an outside edit, an Apply from another instance), those are the OLD template's values
 *  wherever the instance never overrode a field, and restoring them verbatim showed them in the editor and in Play until
 *  a reload, while the save, which keeps only marked fields, wrote nothing and the reload showed the new ones.
 *
 *  Which fields: exactly the ones the SAVE would drop, so the live world is what a save→reload gives. The value diff
 *  (`getOverrideValues`), then the save's own mark gate (`gateOnMarks`): an added trait, a moved member's Transform and a
 *  marked field all stay as restored. A field an enclosing layer states is left marked, as a load leaves it (I2). `EntityAttributes.editorFolder` stays too: the save writes a root's folder outside
 *  the overrides. No-op off an instance, and when the template is not cached (what the screen shows is kept). */
export function takeUnmarkedFromBase(entityId: number, traits?: readonly TraitMeta[], fields?: readonly string[]): void {
  const m = memberEntity(entityId);
  const { source, localId, rootInstanceId: root } = m?.pi ?? {};
  if (!m || !source || !localId || !root) return;
  const prefab = getCachedPrefabSync(source);
  if (!prefab) return;
  const base = instanceBase(root, prefab);
  const baseEntity = rowAt(base, localId);
  if (!baseEntity) return;
  const resolve = baseTokenResolver(root);
  const metas = (traits ?? getAllTraits()).filter((t) => t.category !== 'tag' && m.entity.has(t.trait));
  const diffs = getOverrideValues(localId, collectComparableTraits(entityId, metas), base, resolve);
  const kept: typeof diffs = {};
  for (const [t, fs] of Object.entries(diffs)) kept[t] = { ...fs };
  gateOnMarks(kept, getOverrideMarkSet(m.entity), baseEntity, () => instanceMovedMembers(root, prefab)(entityId, !!diffs['Transform']));
  for (const [traitName, fs] of Object.entries(diffs)) {
    const meta = getTraitByName(traitName);
    const baseData = baseEntity.traits[traitName] as Record<string, unknown>;
    const schema = (meta?.trait as { schema?: Record<string, unknown> } | undefined)?.schema;
    for (const f of Object.keys(fs)) {
      if (!meta || (kept[traitName] && f in kept[traitName]) || (fields && !fields.includes(f))) continue;
      if (traitName === 'EntityAttributes' && f === 'editorFolder') continue;
      // The value `getOverrideValues` compared against: a field absent from the base is the trait's schema default.
      const value = resolve(f in baseData ? baseData[f] : schema?.[f]);
      // A member token that still names nothing is unreadable here, not a value: an undo that re-links a tree one entry
      // at a time (Detach's, Create Prefab's) restores the root before any member is linked, so its tokens cannot resolve
      // yet, and writing one put the raw `@member:` string into a live ref (#1800 close-out review). What is restored stays.
      if (hasMemberToken(value)) continue;
      writeTraitField(entityId, meta, f, cloneTraitValues({ v: value }).v);
    }
  }
  // A field the layers enclosing the instance STATE arrives override-marked on a load (docs/prefabs.md I2), so the
  // reload marks it: a restore that left it unmarked differed from the reload by that mark alone.
  const stated = enclosingRowOverrides(root)?.[localId];
  for (const meta of metas) {
    const fs = stated?.[meta.name];
    if (!fs || typeof fs !== 'object') continue;
    for (const f of Object.keys(fs)) if (!fields || fields.includes(f)) markOverride(m.entity, meta.name, f);
  }
}

/** Record each detached member's marks on it, right after the frame-ending that detached it (`endFrames`, or a
 *  delete): the members outside the ended tree keep their marks in the side store only until a rebuild. By live guid,
 *  through every rename a promotion made (a → b → c). (`memberHome` is L0 and cannot read the L3 store, so the record is
 *  made here.)
 *  ⚠️ A member that no longer resolves records NOTHING, not an empty set: a multi-select delete can destroy a member an
 *  earlier target's frame-ending detached, and its own snapshot's respawn restores its marks. An empty record made the
 *  relink below wipe them again, and the next save dropped its overrides (#1794 close-out review). */
export function recordDetachedMarks(detached: DetachedMember[]): DetachedMember[] {
  const renamed = new Map(detached.flatMap((d) => d.renamed ?? []));
  for (const d of detached) {
    let g = d.guid;
    for (let hops = 0; renamed.has(g) && hops < renamed.size; hops++) g = renamed.get(g)!;
    const e = findEntityByGuid(g) ?? findEntityByGuid(d.guid);
    d.marks = e ? [...(getOverrideMarkSet(e) ?? [])] : undefined;
  }
  return detached;
}

/** THE relink of detached members for an editor undo: {@link relinkDetachedMembers}, then each member's recorded
 *  marks back ({@link recordDetachedMarks}); a member with no record keeps the marks it has.
 *  No {@link takeUnmarkedFromBase} here: it runs before the undo's own relinks and rebase have settled the frame, so the
 *  caller runs it after them (the delete's undo does, over its respawned and relinked nodes). */
export function relinkDetachedMembersMarked(detached: readonly DetachedMember[]): void {
  relinkDetachedMembers(detached);
  for (const d of detached) {
    const e = d.marks ? findEntityByGuid(d.guid) : undefined;
    if (e) { clearOverrideMarks(e); restoreOverrideMarks(e, d.marks!); }
  }
}
