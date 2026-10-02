/** THE editor's override-mark writes: how an editor gesture tells the scene save that a prefab-instance field is
 *  the instance's own edit (#1709). The marks are the instance's RECORDED override list (#1914, docs/prefabs.md § I2).
 *
 *  The save keeps a member's field only when it is MARKED (the mark gate in `captureInstanceOverrides`; the marks
 *  themselves are `runtime/loaders/overrideMarks.ts`). So every editor write that changes a field on a member has to
 *  leave the mark in the state the save needs, and every undo has to put it back. #1709 found gestures that wrote raw
 *  (the UI resize/move handles, every `sortOrder` rewrite, re-adding a trait the template defines) and saved nothing,
 *  and undos that restored the value but kept the mark, so an undone edit was saved pinned at the old value. The
 *  writes go through here instead of marking at each call site.
 *
 *  ONE rule for every write since #1914 R2 (owner rulings F2, F3; Unity's): {@link recordOverridesByDiff} records each
 *  field the write left differing from the instance's base, and removes NOTHING. A deliberate edit (the Inspector, a
 *  gizmo commit, agent `setTrait`, Paste Component Values, through {@link markOverrideIfInstance}) and a write the user
 *  did not aim at a field (a sibling renumber's `sortOrder`, a UI handle drag, a re-added trait) take the same rule: a
 *  renumber records only the siblings it moved off their base, so the instance's child order is not pinned whole (hub,
 *  2026-09-28), and a value typed or dragged back onto the base keeps the record an earlier write made. A record leaves
 *  the list only by Revert, Apply, or an undo restoring the list it found.
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
import { markOverride, unmarkOverride, getOverrideMarkSet, getStoredOverrideMarks, getCarriedOverrideMarks, restoreOverrideMarks, clearOverrideMarks, ROTATION_MARKS } from '../../runtime/loaders/overrideMarks';
import { markUIDirty } from '../../runtime/core/uiDirty';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { relinkDetachedMembers, type DetachedMember } from '../../runtime/core/ecs/memberHome';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { baseTokenResolver } from '../scene/prefabTokens';
import { hasMemberToken } from '../../runtime/core/templateRefs';
import { collectComparableTraits, getOverrideValues, recordedOverrides } from '../scene/prefabInstanceOverrides';
import { instanceMovedMembers } from '../scene/prefabMembers';
import { instanceBase } from '../scene/prefabChain';
import { templatePlainNode, captureDoc } from '../scene/prefabBase';
import { valuesEqual } from '../scene/prefab';
import { makeReorderSiblingsAction, type SiblingSortChange } from './reorderSiblingsUndo';
import type { UndoAction } from './undoManager';
import { entityRef, buildGuidIndex, requireWith } from './entityRef';
import * as instanceEdits from '../instance/instanceEdits';

interface MemberPi { source?: string; localId?: number; rootInstanceId?: number }

/** The entity, when it is a prefab-instance member (the root included). */
function memberEntity(entityId: number) {
  const piMeta = getTraitByName('PrefabInstance');
  const entity = findEntity(entityId);
  if (!piMeta || !entity || !entity.has(piMeta.trait)) return null;
  return { entity, pi: entity.get(piMeta.trait) as MemberPi };
}

/** Record `field` of `traitName` after an editor write to it on a prefab-instance member: {@link recordOverridesByDiff}
 *  for that one field. The entry point for writes that name a trait by its name (the Inspector, a gizmo commit, agent
 *  `setTrait`, the collider points). Call it AFTER the write: the live value is what it diffs. */
export function markOverrideIfInstance(entityId: number, traitName: string, field: string): void {
  const meta = getTraitByName(traitName);
  if (meta) recordOverridesByDiff(entityId, meta, [field]);
}

/** The fields of `meta` on member `entityId` whose live value differs from what the instance resolves them to with
 *  no override of its own, or null when that base cannot be read (its template is not cached). A trait the template
 *  does not define here counts as differing whole (`getOverrideValues`' added-trait rule). */
function fieldsOffBase(entityId: number, meta: TraitMeta, pi: MemberPi): Set<string> | null {
  const diff = traitDiffOffBase(entityId, meta, pi);
  return diff === null ? null : new Set(Object.keys(diff ?? {}));
}

/** The member's diff of `meta` against its base (`getOverrideValues`): undefined when nothing differs, the whole trait
 *  when the base lacks it (a tag: `{}`), null when the base cannot be read. */
function traitDiffOffBase(entityId: number, meta: TraitMeta, pi: MemberPi): Record<string, unknown> | undefined | null {
  if (!pi.source || !pi.localId) return null;
  const prefab = getCachedPrefabSync(pi.source);
  if (!prefab) return null;
  const root = pi.rootInstanceId || 0;
  const current = collectComparableTraits(entityId, [meta]);
  return getOverrideValues(pi.localId, current, root ? instanceBase(root, prefab) : prefab, root ? baseTokenResolver(root) : undefined)[meta.name];
}

/** THE write-time recorder (#1914 R2, docs/prefabs.md § I2/I17): after an editor write to `fields` of `meta` (every
 *  field the entity's trait holds when omitted), record each one whose live value now differs from the instance's
 *  base, and remove NOTHING. Unity's rule (`RecordPrefabInstancePropertyModifications`: "record property modifications
 *  by comparing against the parent prefab"): a write adds the records it made differ, and a record leaves the list
 *  only by Revert, Apply or an undo, never because a value came back to the base (owner rulings F2, F3).
 *  - Typing the base's own value into an unrecorded field records nothing (F2).
 *  - A write that lands back on the base keeps an earlier record (F3): a drag back, a renumber, a re-add.
 *  A field an enclosing layer states is the instance's BASE, not its record (#1914 R1): a load does not record it, and
 *  neither does a write that leaves it at that value. A base that cannot be read records, so what the screen shows is
 *  kept. No-op off an instance, for a tag, and for a trait the entity does not have. */
export function recordOverridesByDiff(entityId: number, meta: TraitMeta, fields?: readonly string[]): void {
  // #2001 S4 (#2014): the door records the same write in the instance list FIRST — before the marks, so a stale record's
  // re-seed from the mark-based capture cannot see this edit. Every field writer reaches the door through here until S8
  // deletes the recorder and the writers call `setFields` themselves.
  instanceEdits.setFields(entityId, meta.name, fields);
  recordByDiff(entityId, meta, fields);
  // A record can land in a later event than the write it follows — a handle drag writes live on every frame and records on
  // pointer-up, after the last frame's dirty signal was consumed — so the recorder signals the editor itself. The
  // Inspector re-reads the accent (`memberOverrideKeys`) on that signal; without it the accent stayed off until the
  // selection changed (work-qa's live run on R3, finding B).
  markUIDirty();
}

function recordByDiff(entityId: number, meta: TraitMeta, fields?: readonly string[]): void {
  // A tag has no values to diff.
  if (meta.name === 'PrefabInstance' || meta.category === 'tag') return;
  const m = memberEntity(entityId);
  if (!m) { recordNodeByDiff(entityId, meta, fields); return; }
  if (!m.entity.has(meta.trait)) return;
  const off = fieldsOffBase(entityId, meta, m.pi);
  const list = fields ?? Object.keys(collectComparableTraits(entityId, [meta])[meta.name] ?? {});
  // Rotation is ONE record (#1880 F5, `ROTATION_MARKS`): any axis off its base records the orientation.
  const isRotation = (f: string) => (ROTATION_MARKS as readonly string[]).includes(`${meta.name}.${f}`);
  const rotationOff = off === null || [...off].some(isRotation);
  for (const f of list) {
    if (isRotation(f) ? rotationOff : off === null || off.has(f)) markOverride(m.entity, meta.name, f);
  }
}

/** Not a field edit on a node: identity the load re-derives (`guid`) and the live ecs parent (`parentId`). The node diff's
 *  rule (`nodeRowDiff.ts`). */
const NODE_IDENTITY_FIELDS: Record<string, readonly string[]> = { EntityAttributes: ['guid', 'parentId'] };

/** {@link recordOverridesByDiff} for a PLAIN node a template added (#1914 R3a): it is no instance member, so its base is
 *  the template node that spawned it ({@link templatePlainNode}), compared as the save's node diff compares (a field
 *  either side omits reads as the schema default; a trait the node lacks differs whole). No-op for a node no enclosing
 *  layer states — the writer's own, written whole by the save. */
function recordNodeByDiff(entityId: number, meta: TraitMeta, fields?: readonly string[]): void {
  const e = findEntity(entityId);
  if (!e || !e.has(meta.trait)) return;
  const node = nodeDiffer(entityId, meta);
  if (!node) return;
  const { live, differs, identity } = node;
  const list = (fields ?? Object.keys(live)).filter((f) => !identity.includes(f));
  const isRotation = (f: string) => (ROTATION_MARKS as readonly string[]).includes(`${meta.name}.${f}`);
  const rotationOff = list.some(isRotation) && Object.keys(live).some((f) => isRotation(f) && differs(f));
  for (const f of list) if (isRotation(f) ? rotationOff : differs(f)) markOverride(e, meta.name, f);
}

/** The node diff {@link recordNodeByDiff} records by, for `meta` on PLAIN template node `entityId`: its live values, and
 *  whether a field differs from the template node that spawned it ({@link templatePlainNode}), compared as the save's node
 *  diff compares (a field either side omits reads as the schema default; a trait the node lacks differs whole; identity is
 *  never a field). Null when `entityId` is no such node. */
function nodeDiffer(entityId: number, meta: TraitMeta): { live: Record<string, unknown>; differs: (f: string) => boolean; identity: readonly string[] } | null {
  const tpl = templatePlainNode(entityId);
  if (!tpl) return null;
  const live = collectComparableTraits(entityId, [meta])[meta.name] ?? {};
  const raw = tpl.node.traits?.[meta.name];
  const chain = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  const resolve = baseTokenResolver(tpl.frame);
  const schema = (meta.trait as { schema?: Record<string, unknown> }).schema ?? {};
  const dflt = (f: string) => { const d = schema[f]; return typeof d === 'function' ? (d as () => unknown)() : d; };
  const identity = NODE_IDENTITY_FIELDS[meta.name] ?? [];
  const differs = (f: string): boolean => {
    if (identity.includes(f)) return false;
    if (!chain) return true;
    const a = f in live ? live[f] : dflt(f);
    const b = resolve(f in chain ? chain[f] : dflt(f));
    return a !== undefined && !valuesEqual(a, b);
  };
  return { live, differs, identity };
}

/** Which of the entity's RECORDS still differ from its base — the base {@link recordOverridesByDiff} records against (an
 *  instance member's, through the layers enclosing its frame; a plain template node's template node) — or null when that
 *  base cannot be read. A record of a trait the entity no longer has is kept (F5's unused record, not this question).
 *  Rotation is one record (`ROTATION_MARKS`): its axes differ together.
 *
 *  For Create Prefab's tag (#1932, R4-L1 finding 1): a nested frame's members keep their records, and the new document's
 *  rows now carry their values, so each record that no longer differs is the NEW prefab's statement, not the scene's.
 *  Asked AFTER the tag, so the base is the new document's. Not a reconcile: the caller removes records only at a
 *  re-scoping act (the list's owner changed), never after an edit (F3). */
export function recordsOffBase(entityId: number): Set<string> | null {
  const e = findEntity(entityId);
  const records = e ? getStoredOverrideMarks(e) : undefined;
  const out = new Set<string>();
  if (!e || !records?.size) return out;
  const m = memberEntity(entityId);
  const byTrait = new Map<string, string[]>();
  for (const k of records) { const i = k.indexOf('.'); const t = k.slice(0, i); byTrait.set(t, [...(byTrait.get(t) ?? []), k.slice(i + 1)]); }
  for (const [traitName, fields] of byTrait) {
    const meta = getTraitByName(traitName);
    if (!meta || !e.has(meta.trait)) { for (const f of fields) out.add(`${traitName}.${f}`); continue; }
    if (meta.category === 'tag') {
      // A tag's record is off while the base lacks the tag (the save writes it as an added component).
      const tpl = m ? null : templatePlainNode(entityId);
      if (!m && !tpl) return null;
      const lacks = m ? traitDiffOffBase(entityId, meta, m.pi) : tpl!.node.traits?.[traitName] === undefined ? {} : undefined;
      if (lacks === null) return null;
      if (lacks !== undefined) for (const f of fields) out.add(`${traitName}.${f}`);
      continue;
    }
    let off: (f: string) => boolean;
    if (m) {
      const set = fieldsOffBase(entityId, meta, m.pi);
      if (!set) return null;
      off = (f) => set.has(f);
    } else {
      const node = nodeDiffer(entityId, meta);
      if (!node) return null;
      off = node.differs;
    }
    const rotationOff = [...ROTATION_MARKS].some((k) => k.startsWith(`${traitName}.`) && off(k.slice(traitName.length + 1)));
    for (const f of fields) {
      const isRotation = (ROTATION_MARKS as readonly string[]).includes(`${traitName}.${f}`);
      if (isRotation ? rotationOff : off(f)) out.add(`${traitName}.${f}`);
    }
  }
  return out;
}

/** Write one field, then record it by {@link recordOverridesByDiff}. THE write for a field an editor gesture changes
 *  without the user aiming at it: every `sortOrder` rewrite (reorder, renumber, reparent, duplicate, paste, scene move)
 *  goes through this. */
export function writeTraitFieldMarked(entityId: number, meta: TraitMeta, field: string, value: unknown): void {
  writeTraitField(entityId, meta, field, value);
  recordOverridesByDiff(entityId, meta, [field]);
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
  const set = e ? getCarriedOverrideMarks(e) : undefined;
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
  const all = e ? [...(getCarriedOverrideMarks(e) ?? [])] : [];
  return trait ? { trait, keys: all.filter((k) => k.startsWith(`${trait}.`)) } : { keys: all };
}
/** Put a {@link captureMarks} back: the marks in its scope become exactly the captured ones, and the fields they leave
 *  unmarked take the CURRENT template's values ({@link takeUnmarkedFromBase}). A trait the current template no longer
 *  gives the member is the instance's own now, an added component, so its fields are recorded (`recordAdded`). */
export function restoreMarks(entityId: number, capture: MarkCapture): void {
  const e = findEntity(entityId);
  if (!e) return;
  if (!capture.trait) clearOverrideMarks(e);
  else for (const k of [...(getStoredOverrideMarks(e) ?? [])]) if (k.startsWith(`${capture.trait}.`)) unmarkOverride(e, capture.trait, k.slice(capture.trait.length + 1));
  restoreOverrideMarks(e, capture.keys);
  const meta = capture.trait ? getTraitByName(capture.trait) : undefined;
  if (!capture.trait || meta) takeUnmarkedFromBase(entityId, meta ? [meta] : undefined, undefined, true);
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
 *  (`getOverrideValues`), less what the save writes (`recordedOverrides`): an added trait, a moved member's Transform and
 *  a recorded field all stay as restored. `EntityAttributes.editorFolder` stays too: the save writes a root's folder outside
 *  the overrides. No-op off an instance, and when neither the cache nor the frame's record holds the template. */
export function takeUnmarkedFromBase(
  entityId: number, traits?: readonly TraitMeta[], fields?: readonly string[],
  /** Record every field of a trait the base does not have (#1914 R1): an undo snapshot taken while a layer gave the
   *  member that trait holds its fields unrecorded, and once the layer has dropped it the save writes the trait whole as
   *  an added component, which a reload records. The live marks must be what that reload gives. */
  recordAdded = false,
): void {
  const m = memberEntity(entityId);
  if (!m) { takeUnmarkedNodeFromBase(entityId, traits, fields); return; }
  const { source, localId, rootInstanceId: root } = m.pi;
  if (!source || !localId || !root) return;
  // A frame whose prefab is missing answers by the document it was built from, its record (`captureDoc`, #1738): for one a
  // scene's copy restored, that copy (#1939; Unity's scene backup, `MergedAsMissingWithSceneBackup`). Read from the cache
  // alone, a missing prefab's frame kept an undo's restored value against a template that had changed since, and the next
  // rebuild or reload showed the template's.
  const prefab = captureDoc(root, source);
  if (!prefab) return;
  const base = instanceBase(root, prefab);
  const baseEntity = rowAt(base, localId);
  if (!baseEntity) return;
  const resolve = baseTokenResolver(root);
  const metas = (traits ?? getAllTraits()).filter((t) => t.category !== 'tag' && m.entity.has(t.trait));
  const current = collectComparableTraits(entityId, metas);
  const diffs = getOverrideValues(localId, current, base, resolve);
  const kept = recordedOverrides(diffs, getOverrideMarkSet(m.entity), baseEntity, () => instanceMovedMembers(root, prefab)(entityId, !!diffs['Transform']), current);
  if (recordAdded) {
    for (const [traitName, fs] of Object.entries(diffs)) {
      if (baseEntity.traits[traitName] === undefined) for (const f of Object.keys(fs)) markOverride(m.entity, traitName, f);
    }
  }
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
}

/** {@link takeUnmarkedFromBase} for a PLAIN node a template added (no `PrefabInstance`, so not a member; #1932, hunt seed
 *  1224): its base is the template node that spawned it ({@link templatePlainNode}), and the save writes only the fields
 *  it RECORDED (`nodeRowDiff`'s `recordedOf`), so an unrecorded field restored from an undo snapshot taken before a saved
 *  prefab edit showed the OLD template's value until a reload. Its fields take the CURRENT template node's, compared as
 *  {@link recordNodeByDiff} compares (a field either side omits reads as the schema default; identity is not a field). A
 *  trait the template node does not have stays as restored: the save writes it as the node's own. No-op for a node no
 *  enclosing layer states (the writer's own, written whole). */
function takeUnmarkedNodeFromBase(entityId: number, traits?: readonly TraitMeta[], fields?: readonly string[]): void {
  const e = findEntity(entityId);
  const tpl = e ? templatePlainNode(entityId) : null;
  if (!e || !tpl) return;
  const marks = getOverrideMarkSet(e);
  const resolve = baseTokenResolver(tpl.frame);
  const metas = (traits ?? getAllTraits()).filter((t) => t.category !== 'tag' && t.name !== 'PrefabInstance' && e.has(t.trait));
  for (const meta of metas) {
    const raw = tpl.node.traits?.[meta.name];
    if (!raw || typeof raw !== 'object') continue;
    const chain = raw as Record<string, unknown>;
    const live = collectComparableTraits(entityId, [meta])[meta.name] ?? {};
    const schema = (meta.trait as { schema?: Record<string, unknown> }).schema ?? {};
    const dflt = (f: string) => { const d = schema[f]; return typeof d === 'function' ? (d as () => unknown)() : d; };
    const identity = NODE_IDENTITY_FIELDS[meta.name] ?? [];
    for (const f of new Set([...Object.keys(live), ...Object.keys(chain)])) {
      if (identity.includes(f) || marks?.has(`${meta.name}.${f}`) || (fields && !fields.includes(f))) continue;
      if (meta.name === 'EntityAttributes' && f === 'editorFolder') continue;
      if (!(f in schema)) continue;
      const value = resolve(f in chain ? chain[f] : dflt(f));
      if (value === undefined || hasMemberToken(value)) continue;
      const now = f in live ? live[f] : dflt(f);
      if (!valuesEqual(now, value)) writeTraitField(entityId, meta, f, cloneTraitValues({ v: value }).v);
    }
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
    // The STORED set, exactly: this runs after the frame-ending, which has just made the member a scene root it will not be
    // once the undo relinks it, so the carried set (less the order that role records) dropped a deliberate order the
    // member stored in its owned role (#1914 close-out re-review). Nothing writes a mark between the frame-ending and here.
    d.marks = e ? [...(getStoredOverrideMarks(e) ?? [])] : undefined;
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
