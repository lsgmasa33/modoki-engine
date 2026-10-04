/** THE editor's override writes: how an editor gesture records that a prefab-instance field is the instance's own edit
 *  (#1709), in the instance's override list, its record (#2001; docs/prefabs.md § I2). Until #2001 S8b a per-entity mark
 *  store (`runtime/loaders/overrideMarks.ts`) said it too, and every write and undo here kept it in step; the record is
 *  now the only statement, read through the view (`instanceOverrideView.ts`).
 *
 *  ONE rule for every write since #1914 R2 (owner rulings F2, F3; Unity's): {@link recordOverridesByDiff} records each
 *  field the write left differing from the instance's base (`instanceEdits.setFields`), and removes NOTHING. A deliberate
 *  edit (the Inspector, a gizmo commit, agent `setTrait`, Paste Component Values, through {@link markOverrideIfInstance})
 *  and a write the user did not aim at a field (a sibling renumber's `sortOrder`, a UI handle drag, a re-added trait)
 *  take the same rule. A record leaves the list only by Revert, Apply, or an undo restoring the list it found.
 *
 *  An undo puts the rows its step found back (`putFieldRows`, `instanceEdits.putRows`), and a field the record leaves
 *  unrecorded takes the CURRENT template's value ({@link takeUnmarkedFromBase}, #1800). */

import { rowAt } from '../../runtime/loaders/prefabOverrides';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, writeTraitField, cloneTraitValues } from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/core/uiDirty';
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
import { refsCheck } from './stepCheck';
import * as instanceEdits from '../instance/instanceEdits';
import { UndoRefusedError } from './undoFailure';
import { overrideKeysOf } from '../instance/instanceOverrideView';

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
  // The door records the write in the instance list (#2001 S4, #2014; the marks it also wrote went in S8b).
  instanceEdits.setFields(entityId, meta.name, fields);
  // A record can land in a later event than the write it follows — a handle drag writes live on every frame and records on
  // pointer-up, after the last frame's dirty signal was consumed — so the recorder signals the editor itself. The
  // Inspector re-reads the accent (`memberOverrideKeys`) on that signal; without it the accent stayed off until the
  // selection changed (work-qa's live run on R3, finding B).
  markUIDirty();
}

/** {@link writeTraitFieldMarked} without the door (#2001 S8b): for a write whose record its op states itself afterwards —
 *  a fresh copy's order, which the copy's seat (`seatCopy`, `afterCopy`) takes from the live copy once it is spawned.
 *  Through the door, the write asked for the copy's record before the seat and re-seeded its tree from the capture, which
 *  the seat then replaced (the hunt tally's commonest re-seed). */
export function writeTraitFieldMarkedBeforeSeat(entityId: number, meta: TraitMeta, field: string, value: unknown): void {
  writeTraitField(entityId, meta, field, value);
  markUIDirty();
}

/** Write one field, then record it by {@link recordOverridesByDiff}. THE write for a field an editor gesture changes
 *  without the user aiming at it: every `sortOrder` rewrite (reorder, renumber, reparent, duplicate, paste, scene move)
 *  goes through this. */
export function writeTraitFieldMarked(entityId: number, meta: TraitMeta, field: string, value: unknown): void {
  writeTraitField(entityId, meta, field, value);
  recordOverridesByDiff(entityId, meta, [field]);
}

/** The Hierarchy's sibling renumber as one undo step, built (but not applied: call `redo()` once, then push it) with
 *  the rows it must put back. Forward, each `sortOrder` is written and recorded by value ({@link writeTraitFieldMarked}):
 *  recording every renumbered sibling would pin the instance's whole child order against the template. Back, each
 *  sibling gets its old value written raw, then its old row (`putFieldRows`), taken HERE, before the renumber runs: a
 *  row taken after it would hold the records the renumber added, and the undo would pin the old order (#1709). Lives
 *  here, not in the panel, so the ordering is testable. */
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
  const inner = makeReorderSiblingsAction(
    changes, (id, sort) => writeTraitFieldMarked(at(id), attrMeta, 'sortOrder', sort), label,
    (id, sort) => writeTraitField(at(id), attrMeta, 'sortOrder', sort),
  );
  // #2001 S8b: each sibling's row (an instance root's placement) as the renumber found it, put back by the undo after its
  // raw writes; and as the first redo (the forward) left it, put back by every later redo. Before, the undo marked every
  // record stale and the re-seed read the restored order back off the live tree.
  const ids = () => changes.map((c) => at(c.id));
  const before = instanceEdits.rowsOf(changes.map((c) => c.id));
  let after: (instanceEdits.RowSnap | null)[] | null = null;
  return {
    ...inner,
    undo: () => { requireRowRecords(before); pin(); inner.undo(); putFieldRows(ids(), before, 'EntityAttributes', ['sortOrder']); },
    redo: () => {
      requireRowRecords(after);
      pin();
      inner.redo();
      if (after) putFieldRows(ids(), after, 'EntityAttributes', ['sortOrder']);
      else after = instanceEdits.rowsOf(ids());
    },
    // #2010: `pin`'s refs, askable before a batch runs. The renumber changes no entity's presence.
    check: refsCheck(() => refs),
  };
}

/** Put back the rows a field step found or left (#2046 S7.2; rule 8: undo and redo restore the EXACT list, never a
 *  re-derived one — D-8a, D-8b) after its live writes. Where a row cannot be shown from its record (a frame whose prefab
 *  is missing, whose record the row is still put back into), or the step found no record to take its rows from,
 *  its fields take the base the marks name (`takeUnmarkedFromBase`, which reads such a frame's built document, #1939 rule
 *  2), as before S7. A record the rows name that cannot be had any more throws, and the step rolls back (`putRows`).
 *  Nothing is marked stale (#2001 S8b): before, every record of the world was. */
/** Refuse a field or component step's undo or redo BEFORE its live writes when a record its rows name cannot be had any
 *  more (#2001 S8b): a later step took it (a Create Prefab takes the record of an instance it swallows into its new one,
 *  whose record then states the node), so putting the rows back could not keep the records exact. Before, the step wrote
 *  live and marked every record stale. Call it after the step's refs are required, before its first write. */
export function requireRowRecords(rows: readonly (instanceEdits.RowSnap | null)[] | null | undefined): void {
  if (!rows || instanceEdits.rowsHeld(rows)) return;
  throw new UndoRefusedError(
    'The prefab instance this step edited is no longer stated by the records it put back (a later step, such as a Create Prefab, took it into another instance), so nothing was changed.',
    'its prefab instance was taken into another one since',
  );
}

export function putFieldRows(ids: readonly number[], rows: readonly (instanceEdits.RowSnap | null)[] | null, trait: string, fields: readonly string[]): void {
  if (rows && instanceEdits.putRows(ids, rows, trait, fields)) return;
  const meta = getTraitByName(trait);
  if (meta) for (const id of ids) takeUnmarkedFromBase(id, [meta], [...fields]);
}

/**
 * A field edit a gesture wrote LIVE, committed as one undo step (the collider points' drag, #1941 site 3): `after` is
 * set now and recorded; the undo and redo put back each side's value, marks and rows (#2046 S7.2, rule 8), recomputing
 * nothing. Returned, not pushed: the caller pushes it. `setLive` writes the value raw (the drag's own writer).
 */
export function makeLiveFieldEditAction<T>(
  entityId: number, trait: string, field: string, setLive: (id: number, value: T) => void, before: T, after: T, label: string,
): UndoAction {
  // From the record as it stood before the commit, or none: the gesture already wrote live, so rows read now would state
  // its value (#2046 S7 close-out review F1). Without them (no record) the step puts back the live values and marks only.
  const oldRows = instanceEdits.priorRowsOf([entityId]);
  setLive(entityId, after);
  markOverrideIfInstance(entityId, trait, field);
  const newRows = oldRows && instanceEdits.rowsOf([entityId]);
  const ref = entityRef(entityId);
  const put = (value: T, rows: typeof oldRows) => {
    // `require` (I19): a target that is gone, or a placeholder now, refuses rather than reading as done.
    const id = ref.require();
    requireRowRecords(rows);
    setLive(id, value);
    putFieldRows([id], rows, trait, [field]);
  };
  return { label, undo: () => put(before, oldRows), redo: () => put(after, newRows) };
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
  // No record, nothing known: which fields are the instance's own is the record's to say, so none is taken from the base.
  const recorded = overrideKeysOf(m.entity);
  if (!recorded) return;
  const kept = recordedOverrides(diffs, recorded, baseEntity, () => instanceMovedMembers(root, prefab)(entityId, !!diffs['Transform']), current);
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

/** Not a field edit on a node: identity the load re-derives (`guid`) and the live ecs parent (`parentId`). The node diff's
 *  rule (`nodeRowDiff.ts`). */
const NODE_IDENTITY_FIELDS: Record<string, readonly string[]> = { EntityAttributes: ['guid', 'parentId'] };

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
  const marks = overrideKeysOf(e);
  if (!marks) return; // no record: nothing known, nothing taken (as `takeUnmarkedFromBase`)
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
