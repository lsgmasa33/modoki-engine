/**
 * `instanceEdits`: THE door for every gesture that changes a prefab instance's override list (#2001 S4, #2014).
 *
 * Rules: docs/prefabs.md § High-level rules — rule 3 (only a gesture changes the list), rule 10 (one door per operation:
 * the human and the agent reach these same functions through the same writers). Design: plan § 3.3 (how live edits
 * flow), § 10.1 (S4's census) and § 10.4 (delete keeps its records).
 *
 * ── S4: DUAL WRITE ──
 * Each census writer (the review's § Census table) calls its verb here at the point it commits, so the record is written
 * beside the old marks and live state. Nothing READS the record to build or save yet; the old path still saves. A
 * structural verb is two-phase: `begin…` BEFORE the old writer mutates the tree (it reads the targets off the tree as
 * it stands), its commit AFTER, and only if the old writer went ahead. A field verb runs after the live write and BEFORE
 * the mark recorder. A verb writes only on stored records; a missing one makes it write nothing (`instanceSync.ts`:
 * since #2001 S8b nothing re-seeds a record from the capture).
 *
 * The decisions here are made from DATA where the rules make them (F2's base is the fold of the record, § 3.3); where
 * the old writer's semantics differ from a rule, or no rule answers, the comment cites which, and the I25 shadow reports
 * every case where this door's list and the old capture disagree.
 *
 * Most undo and redo steps do NOT pass through here: each keeps its records itself (#2001 S8b), writing through the door
 * or seating the exact records it holds (`instanceHistory.ts`): an Instantiate's undo is this door's delete of the root
 * it placed (#2001 S8a).
 */
import type { World } from 'koota';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import type { Entity } from 'koota';
import { findEntity, readTraitDataFull, writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { durableGuid, remapGuidValues } from '../../runtime/core/assetRefRules';
import { frameOf, keyOfLid as memberKeyOfLid } from '../../runtime/loaders/frameChain';
import { soaSchema } from '../../runtime/core/ecs/traitSchema';
import { ROTATION_MARKS } from '../../runtime/loaders/overrideMarks';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { dropInstanceRecord, storedRecord, setInstanceRecord, storedInstances } from '../../runtime/prefab/instanceStore';
import { rollBack, takeStore } from './instanceRollback';
import { ROOT_ROW_KEY, type InstanceRecord, type Placement, type RecordPart, type RowKey, type SceneTargetRecord } from '../../runtime/prefab/instanceRecord';
import { preV5NodeGuid } from '../../runtime/prefab/parseInstanceRecord';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { memberRowsIn, memberRowsToWrite } from '../../runtime/core/ecs/memberRows';
import { nestedFrameMoves } from '../scene/prefabChain';
import { valuesEqual } from '../scene/prefab';
import { collectComparableTraits } from '../scene/prefabInstanceOverrides';
import { guidOfEntity, instanceKeyMap, instanceTargetOf, outermostStoredRoot, projectionRootOf, storedRootsAbove, storedRootsUnder, type InstanceTarget } from './instanceKeys';
import { capturedRecordsOf, editorPrefabReader, recordForWrite, treeForWrite } from './instanceSync';
import { promotedRecord } from './instancePromote';
import { isSuppliedByPrefab } from '../scene/restructureRefusal';

type Bag = Record<string, unknown>;

/** The root's DEFAULT overrides (Unity U10b): `Placement`, never a `"/"` list record (§ 10.4). `parentId` is the
 *  reparent's (`setPlacement`); `guid` is identity. */
const ROOT_PLACEMENT_FIELDS = new Set(['name', 'sortOrder', 'editorFolder', 'parentId', 'guid', 'sourceScene']);
/** Identity and the live parent: never a field record on any node (`nodeRowDiff.ts`'s rule). */
const NODE_IDENTITY_FIELDS = new Set(['guid', 'parentId']);
const guidRoot = (guid: string): number => findEntityByGuid(guid)?.id() ?? 0;
const isRotation = (trait: string, f: string) => (ROTATION_MARKS as readonly string[]).includes(`${trait}.${f}`);

function rowOf(rec: InstanceRecord, key: RowKey): SceneTargetRecord {
  let row = rec.list.rows.get(key);
  if (!row) rec.list.rows.set(key, (row = {}));
  return row;
}

/** Drop what a row no longer states: an emptied trait bag, removals map, own list; the row itself when nothing is left. */
function tidy(rec: InstanceRecord, key: RowKey): void {
  const row = rec.list.rows.get(key);
  if (!row) return;
  if (row.traits) {
    for (const [t, d] of Object.entries(row.traits)) if (d !== true && d && !Object.keys(d).length) delete row.traits[t];
    if (!Object.keys(row.traits).length) delete row.traits;
  }
  if (row.traitRemovals && !Object.keys(row.traitRemovals).length) delete row.traitRemovals;
  if (row.own && !row.own.length) delete row.own;
  if (!Object.keys(row).length) rec.list.rows.delete(key);
}

const clone = <T>(v: T): T => (v && typeof v === 'object' ? structuredClone(v) : v);

function schemaDefault(meta: TraitMeta, field: string): unknown {
  const d = soaSchema(meta)?.[field];
  return typeof d === 'function' ? (d as () => unknown)() : d;
}

/** The value `key` resolves `trait.field` to with no record of this list on it — what Revert gives (§ 3.6): the fold of
 *  the record without that field. `undefined` trait: the base lacks the component (or the node). */
export function baseTrait(rec: InstanceRecord, key: RowKey, trait: string, field?: string): Bag | undefined | true {
  const row = rec.list.rows.get(key);
  let probe = rec;
  const stated = row?.traits?.[trait];
  if (stated !== undefined) {
    probe = structuredClone(rec);
    const r = probe.list.rows.get(key)!;
    if (field === undefined || stated === true) delete r.traits![trait];
    else delete (r.traits![trait] as Bag)[field];
  }
  const node = foldInstance(editorPrefabReader, probe).nodes.get(key);
  return node?.traits[trait] as Bag | true | undefined;
}

// ── Fields ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `setFields`: an editor write to `fields` of `traitName` on `entityId` has landed live. Record each field the gesture
 * made differ from its base, and keep every record already there (rule 3, F2, F3; the recorder's own rule,
 * `recordOverridesByDiff`). Rotation is one record (#1880 F5): any axis off records every rotation field written.
 * Call it AFTER the live write and BEFORE the mark recorder.
 */
/** Remove Missing on an instance member or root (#1944): its row's copy of component `name`, which this build registers
 *  no trait for, goes with it. The record holds such a component in the row (the parse keeps a root entry's extra
 *  components at `/`), and the save writes the row, not the side table the Inspector lists (#2001 S8b: before, the
 *  removed component came back on the next save). A scene-owned node's is saved from the side table, and is not here. */
function dropMissingComponentImpl(entityId: number, name: string): void {
  const t = instanceTargetOf(entityId);
  if (!t || t.kind !== 'member') return;
  const rec = recordForWrite(t.rootId, t.rootGuid);
  const row = rec?.list.rows.get(t.key);
  if (!row?.traits || !Object.hasOwn(row.traits, name)) return;
  delete row.traits[name];
}

function setFieldsImpl(entityId: number, traitName: string, fields?: readonly string[]): void {
  const meta = getTraitByName(traitName);
  if (!meta || meta.name === 'PrefabInstance' || meta.category === 'tag') return;
  const t = instanceTargetOf(entityId);
  if (!t || t.kind !== 'member') return;
  if (!findEntity(entityId)?.has(meta.trait)) return;
  const rec = recordForWrite(t.rootId, t.rootGuid);
  if (!rec) return;
  const live = collectComparableTraits(entityId, [meta])[meta.name] ?? {};
  let list = (fields ?? Object.keys(live)).filter((f) => f in live);
  if (t.key === ROOT_ROW_KEY && meta.name === 'EntityAttributes') {
    // The root's default overrides go to its placement (§ 10.4: one home each).
    for (const f of list) {
      if (f === 'name' && typeof live.name === 'string') rec.placement.name = live.name;
      else if (f === 'sortOrder' && typeof live.sortOrder === 'number') { rec.placement.sortOrder = live.sortOrder; rec.placement.orderStated = true; }
      else if (f === 'editorFolder') { if (live.editorFolder) rec.placement.editorFolder = live.editorFolder as string; else delete rec.placement.editorFolder; }
    }
    list = list.filter((f) => !ROOT_PLACEMENT_FIELDS.has(f));
  } else if (meta.name === 'EntityAttributes') {
    list = list.filter((f) => !NODE_IDENTITY_FIELDS.has(f));
  }
  if (!list.length) return;
  const row = rec.list.rows.get(t.key);
  const stated = row?.traits?.[meta.name];
  const base = baseTrait(rec, t.key, meta.name);
  const off = (f: string): boolean => {
    if (stated && stated !== true && (stated as Bag)[f] !== undefined) return true; // F3: a record stays
    if (base === undefined || base === true) return true; // the base lacks the component: an added one
    const b = f in base ? (base as Bag)[f] : schemaDefault(meta, f);
    return !valuesEqual(live[f], b);
  };
  // Rotation is ONE record (#1880 F5): any axis taken takes the whole orientation, as a mark of one axis marks the group
  // (`overrideMarks.ts` `groupOf`) and the capture writes all three.
  const rotationOff = list.some((f) => isRotation(meta.name, f) && off(f));
  const take = list.filter((f) => !isRotation(meta.name, f) && off(f));
  if (rotationOff) for (const f of Object.keys(live)) if (isRotation(meta.name, f)) take.push(f);
  if (!take.length) return;
  const r = rowOf(rec, t.key);
  const traits = (r.traits ??= {});
  const bag = (traits[meta.name] && traits[meta.name] !== true ? traits[meta.name] : (traits[meta.name] = {})) as Bag;
  for (const f of take) bag[f] = clone(live[f]);
  inWrittenOrder(r, meta.name, live);
}

/** Row `r` in the ONE key order a save writes (#1896): `trait`'s fields in the order its live value lists them (its
 *  schema's), and the row's traits in the registry's. A gesture appends what it takes, and the writer keeps the record's
 *  own order (load → save is verbatim, rule 4), so the order is set here, where a gesture lands: written in gesture
 *  order, a root moved after it was rotated saved `{rx,ry,rz,x}`, and the same edits made the other way round `{x,rx,…}`. */
function inWrittenOrder(r: SceneTargetRecord, trait: string, live: Bag): void {
  const traits = r.traits!;
  const bag = traits[trait];
  if (bag && bag !== true) {
    const out: Bag = {};
    for (const k of Object.keys(live)) if (k in bag) out[k] = bag[k];
    for (const k of Object.keys(bag)) if (!(k in out)) out[k] = bag[k];
    traits[trait] = out;
  }
  const at = new Map(getAllTraits().map((m, i) => [m.name, i] as const));
  const names = Object.keys(traits);
  const sorted = [...names].sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity));
  if (sorted.every((n, i) => n === names[i])) return;
  const byName = { ...traits };
  for (const n of names) delete traits[n];
  for (const n of sorted) traits[n] = byName[n]!;
}

// ── Field gestures ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What the record states for `trait` on `entityId`'s row when an Inspector field GESTURE begins (#1914, the hub's #1922
 *  finding; `resumeGesture` in `entityActions.ts`). A number field commits on every keystroke, so retyping 200 over a
 *  base of 200 writes 2 and 20 first; F3 would keep the first keystroke's record. So each continuing write puts this
 *  back first, as the gesture puts the marks back, and a gesture leaves its start plus what its FINAL value differs in.
 *  Taken before the gesture's first write, so it states the value the gesture started from. Null: not an instance member's. */
export interface FieldRecordState { rootId: number; rootGuid: string; key: RowKey; trait: string; bag: Bag | true | undefined }

function fieldRecordOfImpl(entityId: number, traitName: string): FieldRecordState | null {
  const t = instanceTargetOf(entityId);
  if (!t || t.kind !== 'member') return null;
  const rec = recordForWrite(t.rootId, t.rootGuid);
  if (!rec) return null;
  return { rootId: t.rootId, rootGuid: t.rootGuid, key: t.key, trait: traitName, bag: clone(rec.list.rows.get(t.key)?.traits?.[traitName]) as Bag | true | undefined };
}

/** Put back a gesture's start (`fieldRecordOf`) before a continuing write records over it. */
function putFieldRecordImpl(state: FieldRecordState): void {
  const rec = recordForWrite(state.rootId, state.rootGuid);
  if (!rec) return;
  if (state.bag === undefined) {
    const row = rec.list.rows.get(state.key);
    if (row?.traits?.[state.trait] !== undefined) { delete row.traits[state.trait]; tidy(rec, state.key); }
    return;
  }
  (rowOf(rec, state.key).traits ??= {})[state.trait] = clone(state.bag) as Bag;
}

// ── Undo of a list edit (#2046 S7 step 2) ─────────────────────────────────────────────────────────────────────────────

/** One entity's row as a step found it (rule 8): the whole row its key names in its record, and the record's placement
 *  when the entity is the record's root (its name, order and folder live there, § 10.4). */
export interface RowSnap { rootGuid: string; key: RowKey; row: SceneTargetRecord | undefined; placement?: Placement }

/** The row of each of `entityIds` now, aligned with them; null for an entity that is no instance member (a plain or
 *  scene-owned node, a Missing Prefab placeholder) or whose record is missing or stale. */
function rowsOfImpl(entityIds: readonly number[]): (RowSnap | null)[] {
  return entityIds.map((id) => {
    const t = instanceTargetOf(id);
    if (!t || t.kind !== 'member') return null;
    const rec = recordForWrite(t.rootId, t.rootGuid);
    if (!rec) return null;
    return {
      rootGuid: t.rootGuid, key: t.key, row: clone(rec.list.rows.get(t.key)),
      ...(t.key === ROOT_ROW_KEY ? { placement: clone(rec.placement) } : {}),
    };
  });
}

/** {@link rowsOfImpl}, or null when an entity's record is missing ALREADY: for a step whose live write ran before it read
 *  its rows (a drag commit — the drag wrote live as it went). Before S8b a re-seed there captured the dragged values, so
 *  the before side stated the value the undo takes back (#2046 S7 close-out review F1); with no record it puts back no
 *  rows. */
function priorRowsOfImpl(entityIds: readonly number[]): (RowSnap | null)[] | null {
  const world = getCurrentWorld();
  for (const id of entityIds) {
    const t = instanceTargetOf(id);
    if (t?.kind === 'member' && !storedRecord(world, t.rootGuid)) return null;
  }
  return rowsOfImpl(entityIds);
}

/**
 * Put back each row EXACTLY as a step found it ({@link rowsOf}; rule 8 — nothing re-derived, D-8a/D-8b), then bring
 * `trait` on the live entity to what the list says, the fold of the record through the CURRENT template's every layer:
 * - `fields`: a field the row does not record shows the fold's value (owner ruling on #1800: Unity shows the current
 *   asset's value for a field the instance does not override); a recorded field keeps the value the step's write put.
 * - `'all'` (a step that put a whole component on or took it off): the component is live exactly when the fold has it,
 *   and every field it has follows the rule above. Undoing a removal of a component the template no longer gives the
 *   member leaves it off, as a reload of the restored list shows it and as Unity's undo does (this replaced #1914 R1's
 *   "comes back recorded", which was D-8b's re-derivation, `takeUnmarkedFromBase(recordAdded)`).
 * Call it AFTER the step's live writes. Returns false when a row it put has no fold to show (its prefab cannot be read:
 * the record is still exact, and the caller takes the base the marks name). THROWS when a record a row names cannot be
 * had (gone: a later step took it, as a Create Prefab does the record of an instance it swallows), so the step
 * rolls back (hub decision A) rather than leave its live write where no record states it (#2001 S8b: before,
 * the caller marked every record of the world stale; hunt seed 1294, regression #1893, reaches it).
 */
/** Can every record `snaps` name still be had (fresh)? Asked by a field or component step before its live writes, so a
 *  step whose records a later step took refuses with nothing changed (`requireRowRecords`). Pure. */
export function rowsHeld(snaps: readonly (RowSnap | null)[]): boolean {
  return snaps.every((snap) => {
    if (!snap) return true;
    const rootId = guidRoot(snap.rootGuid);
    return !!rootId && !!recordForWrite(rootId, snap.rootGuid);
  });
}

function putRowsImpl(entityIds: readonly number[], snaps: readonly (RowSnap | null)[], trait: string, fields: readonly string[] | 'all'): boolean {
  const meta = getTraitByName(trait);
  let all = true;
  entityIds.forEach((id, i) => {
    const snap = snaps[i];
    if (!snap) return;
    const rootId = guidRoot(snap.rootGuid);
    const rec = rootId ? recordForWrite(rootId, snap.rootGuid) : null;
    if (!rec) throw new Error(`the record of instance "${snap.rootGuid}" that this step's rows name cannot be had: a later step took it`);
    if (snap.row) rec.list.rows.set(snap.key, clone(snap.row)); else rec.list.rows.delete(snap.key);
    if (snap.placement) rec.placement = clone(snap.placement);
    const e = findEntity(id);
    if (!meta || !e || (fields !== 'all' && (meta.category === 'tag' || !e.has(meta.trait)))) return;
    // A record whose prefab cannot be read has no fold to show: the caller takes the base the marks name instead.
    if (!('doc' in editorPrefabReader(rec.source))) { all = false; return; }
    const node = foldInstance(editorPrefabReader, rec).nodes.get(snap.key);
    if (!node) return; // the list puts the member nowhere (removed): a structural step's own projection
    const folded = node.traits[trait];
    if (fields === 'all') {
      if (folded === undefined) { if (e.has(meta.trait)) e.remove(meta.trait); return; }
      if (!e.has(meta.trait)) e.add(meta.trait(meta.category === 'tag' ? undefined : clone(folded === true ? {} : folded) as Bag));
      if (meta.category === 'tag') return;
    }
    if (folded === undefined || folded === true) return;
    const stated = snap.row?.traits?.[trait];
    const placed = snap.key === ROOT_ROW_KEY && trait === 'EntityAttributes';
    for (const f of fields === 'all' ? Object.keys(collectComparableTraits(id, [meta])[meta.name] ?? {}) : fields) {
      if (stated === true || (stated && (stated as Bag)[f] !== undefined)) continue;
      if (placed && ROOT_PLACEMENT_FIELDS.has(f)) continue; // the placement states it, and the write put it live
      if (trait === 'EntityAttributes' && NODE_IDENTITY_FIELDS.has(f)) continue;
      const v = f in folded ? (folded as Bag)[f] : schemaDefault(meta, f);
      const live = readTraitDataFull(id, meta)?.[f];
      if (!valuesEqual(live, v)) writeTraitField(id, meta, f, clone(v));
    }
  });
  return all;
}

// ── Components ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `addComponent`: `traitName` was just added to `entityId` (with whatever values the gesture gave it). A component the
 * base lacks is recorded WHOLE, by value (§ 2.5: "writes traits[T] with every field the gesture set"; today's save takes
 * it whole, `getOverrideValues`). A component the base has records its fields as `setFields` does.
 *
 * Re-adding a component this list REMOVED clears the removal, and the re-added fields are recorded (hub ruling G1,
 * 2026-10-02): the re-add reverses the very thing the removal record IS (rule 3, G3 wording). Unity's removed+added
 * pair needs two components of one type on an object; Modoki has one trait per type, so no second component exists for
 * an "added" record to name — a structural difference rule 1 does not reach. A field record kept beside the removal
 * (G2) applies again with it.
 */
function addComponentImpl(entityId: number, traitName: string): void {
  const meta = getTraitByName(traitName);
  if (!meta || meta.name === 'PrefabInstance') return;
  const t = instanceTargetOf(entityId);
  if (!t || t.kind !== 'member') return;
  const rec = recordForWrite(t.rootId, t.rootGuid);
  if (!rec) return;
  const row = rec.list.rows.get(t.key);
  if (row?.traitRemovals?.[meta.name] === true) { delete row.traitRemovals[meta.name]; tidy(rec, t.key); }
  const base = baseTrait(rec, t.key, meta.name);
  if (base !== undefined) { if (meta.category !== 'tag') setFields(entityId, traitName); return; }
  // The base lacks it because an enclosing LAYER removed it (its template has it): putting it back is a RESTORE of
  // that removal (`traitRemovals[T]: false`, the capture's statement), then the fields the gesture left differing from
  // the restored base (F2) — not a component the instance adds.
  if (restoresLayerRemoval(rec, t.key, meta.name)) {
    (rowOf(rec, t.key).traitRemovals ??= {})[meta.name] = false;
    if (meta.category !== 'tag') setFields(entityId, traitName);
    return;
  }
  const r = rowOf(rec, t.key);
  // A tag is written as the scene file states it, an empty bag (`getOverrideValues`: `{T: {}}`), which the parser keeps.
  if (meta.category === 'tag') { (r.traits ??= {})[meta.name] = {}; inWrittenOrder(r, meta.name, {}); return; }
  const live = collectComparableTraits(entityId, [meta])[meta.name] ?? {};
  (r.traits ??= {})[meta.name] = clone(live);
  inWrittenOrder(r, meta.name, live);
}

/** Whether `trait` on `key` is missing from the base only because a layer removed it: a restore statement would give
 *  it back. */
function restoresLayerRemoval(rec: InstanceRecord, key: RowKey, trait: string): boolean {
  const probe = structuredClone(rec);
  const row = probe.list.rows.get(key) ?? (probe.list.rows.set(key, {}), probe.list.rows.get(key)!);
  if (row.traits) delete row.traits[trait];
  (row.traitRemovals ??= {})[trait] = false;
  return foldInstance(editorPrefabReader, probe).nodes.get(key)?.traits[trait] !== undefined;
}

/** `removeComponent`, phase 1: call BEFORE `traitName` comes off `entityIds`. Returns the commit, to run once the old
 *  writer removed it. */
function beginRemoveComponentImpl(entityIds: readonly number[], traitName: string): () => void {
  const meta = getTraitByName(traitName);
  if (!meta || meta.name === 'PrefabInstance') return () => {};
  // What each target's commit does, decided now (before the component comes off): data, applied in one pass below.
  const items: Array<{ rec: InstanceRecord; key: RowKey; restored: boolean; added: boolean }> = [];
  for (const id of entityIds) {
    const t = instanceTargetOf(id);
    if (!t || t.kind !== 'member') continue;
    const rec = recordForWrite(t.rootId, t.rootGuid);
    if (!rec) continue;
    const restored = rec.list.rows.get(t.key)?.traitRemovals?.[meta.name] === false;
    items.push({ rec, key: t.key, restored, added: !restored && baseTrait(rec, t.key, meta.name) === undefined });
  }
  return () => {
    for (const { rec, key, restored, added } of items) {
      const r = rowOf(rec, key);
      if (restored) {
        // A component this list RESTORED (a layer's removal put back): removing it reverses that restore, so the restore
        // and its field records go (G3, as for an added component); the layer's removal stands again.
        delete r.traitRemovals![meta.name];
        if (r.traits) delete r.traits[meta.name];
      } else if (added) {
        // A component this list ADDED goes with its record: the gesture deletes the very thing the record IS (rule 3 as
        // reworded by the hub, 2026-10-02, G3; Unity drops the m_AddedComponents entry).
        if (r.traits) delete r.traits[meta.name];
      } else {
        // One the base has becomes a removal (§ 2.5), and its field records STAY (hub ruling G2, 2026-10-02): inert while
        // the removal stands, not unused (their target is in the prefab), and a Revert of the removal brings the
        // component back as it was, edits included — rule 3's "reverting the deletion brings it back as it was".
        (r.traitRemovals ??= {})[meta.name] = true;
      }
      tidy(rec, key);
    }
  };
}

// ── Children ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `own` link an entity needs if it hangs at `parentId`: the keyed node of an instance it would be added under. */
function linkAt(parentId: number): { rootId: number; rootGuid: string; key: RowKey } | null {
  if (!parentId) return null;
  const t = instanceTargetOf(parentId);
  return t && t.kind === 'member' ? { rootId: t.rootId, rootGuid: t.rootGuid, key: t.key } : null;
}

function unlink(rec: InstanceRecord, key: RowKey, guid: string): void {
  const row = rec.list.rows.get(key);
  if (!row?.own) return;
  row.own = row.own.filter((o) => o.guid !== guid);
  tidy(rec, key);
}

/** A stored root's placement parent as the parser states it: `''` for a reference node inside an instance (its link
 *  places it, `parseReferenceNode`), else its ECS parent's guid. */
function placementParent(rootId: number): string {
  const ea = getTraitByName('EntityAttributes')!;
  const parentId = (findEntity(rootId)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0;
  if (!parentId) return '';
  return outermostStoredRoot(parentId) ? '' : guidOfEntity(parentId);
}

/**
 * `place`: a new instance root `rootId` was just spawned (a prefab drop or an agent instantiate). Its record is minted
 * here with an empty list and its placement (§ 3.2, the placement row: "an empty list"); when it lands under a keyed node
 * of another instance, that node's `own` links it (§ 2.5; review § Census: "a prefab drop on a member appends to the
 * anchor's own").
 */
function placeImpl(rootId: number, opts: { sortOrder?: number } = {}, world: World = getCurrentWorld()): void {
  const ea = getTraitByName('EntityAttributes'), pi = getTraitByName('PrefabInstance');
  const e = findEntity(rootId);
  if (!ea || !pi || !e || !e.has(pi.trait)) return;
  const attrs = e.get(ea.trait) as { guid?: string; name?: string; sortOrder?: number; editorFolder?: string; parentId?: number };
  const source = (e.get(pi.trait) as { source?: string }).source ?? '';
  if (!attrs.guid || !source) return;
  // #1947: last among its siblings, as Unity appends a placed instance — not its template root's own order, which ties
  // with every sibling at it (usually 0) and sorted by its fresh guid. A redo puts back the order it recorded (`opts`,
  // #1941's rule), not a new end. Written live without a mark: the placement below states it (§ 10.4: one home each).
  const sortOrder = opts.sortOrder ?? endOrderUnder(attrs.parentId ?? 0, rootId);
  if (attrs.sortOrder !== sortOrder) writeTraitField(rootId, ea, 'sortOrder', sortOrder);
  // Its members' identity pinned as they are (§ 3.2: "identity pins = the current guids"), as the first save writes them:
  // a pin is kept verbatim once the template drops its member (rule 5), and an unpinned record lost it (hunt seed 8268).
  const rows = new Map<RowKey, SceneTargetRecord>();
  for (const [id, key] of memberRowsToWrite(rootId)) {
    const m = findEntity(id)?.get(ea.trait) as { guid?: string; name?: string } | undefined;
    if (m?.guid) rows.set(key as RowKey, { guid: m.guid, ...(m.name !== undefined ? { name: m.name } : {}) });
  }
  setInstanceRecord(world, {
    rootGuid: attrs.guid, source,
    placement: { parent: placementParent(rootId), sortOrder, name: attrs.name ?? '', ...(attrs.editorFolder ? { editorFolder: attrs.editorFolder } : {}) },
    list: { rows }, held: {},
  });
  addChild(rootId);
}

/** One past the highest order among the children of `parentId` other than `selfId`; 0 for none. */
function endOrderUnder(parentId: number, selfId: number): number {
  const ea = getTraitByName('EntityAttributes')!;
  let max = -1;
  for (const e of getCurrentWorld().query(ea.trait)) {
    if (e.id() === selfId) continue;
    const a = e.get(ea.trait) as { parentId?: number; sortOrder?: number };
    if ((a.parentId ?? 0) === parentId && typeof a.sortOrder === 'number' && a.sortOrder > max) max = a.sortOrder;
  }
  return max + 1;
}

/** `addChild`: entity `childId` (a new plain node, a copy, or a stored root) now hangs at its live parent. When that
 *  parent is a keyed node of an instance, its `own` links the child (§ 2.5). Under a scene-owned node it is content. */
function addChildImpl(childId: number, world: World = getCurrentWorld()): void {
  const ea = getTraitByName('EntityAttributes')!;
  const parentId = (findEntity(childId)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0;
  const at = linkAt(parentId);
  const guid = guidOfEntity(childId);
  if (!at || !guid) return;
  const rec = recordForWrite(at.rootId, at.rootGuid, world);
  if (!rec) return;
  const row = rowOf(rec, at.key);
  if (!(row.own ??= []).some((o) => o.guid === guid)) row.own.push({ guid });
}

// ── Delete ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `removeMember` and friends, phase 1: call BEFORE `entityIds` are deleted (the targets are read off the live tree).
 * Per top-most deleted entity:
 * - a supplied member (or template-added node): `removed: true` on its row. The records on and under it STAY (rule 3,
 *   § 10.4). The user's children under it are scene content, deleted with it (rule 3, hub refinement 2026-10-02), so
 *   their `own` links and the records of any instance among them go.
 * - an instance's own root: the instance's record goes, with every instance under it; a reference node's link goes from
 *   the instance that held it.
 * - a scene-owned node: its `own` link goes (§ 2.5: "the plain delete plus removing its own ref"), with the records of
 *   any instance under it.
 */
function beginDeleteImpl(entityIds: readonly number[], world: World = getCurrentWorld()): () => void {
  // No instance type registered (a bare world): there is no record to edit, and nothing to report.
  const ea = getTraitByName('EntityAttributes');
  if (!ea || !getTraitByName('PrefabInstance')) return NOOP;
  const parentOf = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
  const set = new Set(entityIds);
  const top = entityIds.filter((id) => { for (let p = parentOf(id), n = 0; p && n < 1024; p = parentOf(p), n++) if (set.has(p)) return false; return true; });
  // What each top's commit does, read now (before the delete): data, applied in one pass below.
  type Item =
    | { kind: 'member'; rec: InstanceRecord; key: RowKey; underKeys: Set<RowKey>; gone: Set<string>; nested: string[]; pins: Map<RowKey, { guid: string; name?: string }> }
    | { kind: 'unlink'; at: ReturnType<typeof linkAt>; rec: InstanceRecord | null; guid: string; nested: string[] };
  const items: Item[] = [];
  for (const id of top) {
    const t: InstanceTarget | null = instanceTargetOf(id);
    const nested = storedRootsUnder(id).map(guidOfEntity);
    if (t?.kind === 'member' && t.key !== ROOT_ROW_KEY) {
      const rec = recordForWrite(t.rootId, t.rootGuid, world);
      if (!rec) continue;
      // Member keys are FLAT within a frame (§ 2.1): the member's descendants are found in the live tree, before the
      // delete, as every keyed node of its instance under it; a frame they open keys its rows under their own key.
      const underKeys = keyedSubtree(t.rootId, id);
      // The identity of each member that goes (rule 5, § 10.4 "a pin is never derived away while its member is gone"):
      // while a member is live the save states its pin from the live tree (§ 2.7), so the record need not hold it. Once
      // it is deleted the record is the pin's only home (#2001 S6: the save writes the list), and a Revert of the
      // removal must bring the member back under the guid it had.
      const pins = new Map<RowKey, { guid: string; name?: string }>();
      for (const [mid, k] of memberRowsToWrite(t.rootId, world)) {
        if (!underKeys.has(k)) continue;
        const name = (findEntity(mid)?.get(ea.trait) as { name?: string } | undefined)?.name;
        pins.set(k, { guid: guidOfEntity(mid), ...(name ? { name } : {}) });
      }
      items.push({ kind: 'member', rec, key: t.key, underKeys, gone: liveGuidsUnder(id), nested, pins });
      continue;
    }
    // An instance's own root, a scene-owned node, or a plain entity: unlink from the instance it hangs in, if any.
    const at = linkAt(parentOf(id));
    items.push({ kind: 'unlink', at, rec: at ? recordForWrite(at.rootId, at.rootGuid, world) : null, guid: guidOfEntity(id), nested });
  }
  return () => {
    for (const item of items) {
      if (item.kind === 'member') {
        const { rec, key, underKeys, gone } = item;
        const under = (k: RowKey) => underKeys.has(k) || [...underKeys].some((u) => k.startsWith(`${u}/`));
        rowOf(rec, key).removed = true;
        for (const [k, pin] of item.pins) {
          const row = rowOf(rec, k);
          if (row.guid === undefined) { row.guid = pin.guid; if (row.name === undefined && pin.name !== undefined) row.name = pin.name; }
        }
        // Only the links of the nodes that go WITH it: a link the record holds for a node that is not live (its anchor
        // dropped from the template, kept as an R2 orphan) names nothing this delete removed (I23; hunt seed 178).
        for (const k of [...rec.list.rows.keys()]) {
          const row = rec.list.rows.get(k)!;
          if (!under(k) || !row.own) continue;
          const kept = row.own.filter((o) => !gone.has(o.guid));
          if (kept.length) row.own = kept;
          else delete row.own;
          tidy(rec, k);
        }
      } else if (item.at && item.rec && item.guid) unlink(item.rec, item.at.key, item.guid);
      for (const g of item.nested) dropInstanceRecord(world, g);
    }
  };
}

// ── Detach ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a Detach's commit reads of the unpack it follows: whatever it did that a record cannot state. */
export interface DetachOutcome { orphans: readonly unknown[]; placeholders?: readonly unknown[] }

/**
 * `beginDetach`, phase 1: call BEFORE instance root `rootId` is unpacked (#2001 S8b). A Detach is Unity's Unpack
 * Completely (`detachPrefabInstance`, U17): it strips every link in the instance's identity subtree, the nested frames and
 * the instances the scene added under it included, so the record of every stored root in it goes. Its nodes stay where
 * they stand as plain content under the same guids, so a link naming the root (an enclosing instance's `own`, for a
 * reference node the scene added) still names it. A stored root the unpack leaves an instance keeps its record, placed
 * where it now hangs.
 *
 * The commit returns true when the records are exact. A missing nested row's placeholder becomes a stored root with the
 * record it carries (#2099). An unpack the records cannot state returns WHY instead, and the caller takes the unpack back
 * out and rolls the store back (`detachPrefabInstance`, hub decision A) — a throw here would roll the store back under a
 * tree still unpacked: a placeholder whose record cannot be stated (it names another root, or one the unpack reported is
 * not among the tree's stored roots), or a frame the unpack ended that held a member moved out of the tree (`orphans`,
 * promoted or unlinked where it stands: the caller refuses that before it unpacks, owner ruling 2026-10-04). Null, with
 * nothing changed, when the tree's records cannot be had; the caller then refuses.
 */
function beginDetachImpl(rootId: number, world: World = getCurrentWorld()): ((out: DetachOutcome) => true | string) | null {
  const top = outermostStoredRoot(rootId);
  if (!top || !treeForWrite(top, world)) return null;
  const before = storedRootsUnder(rootId).map(guidOfEntity).filter(Boolean);
  return (out) => {
    if (out.orphans.length) return `the unpack ended a frame holding ${out.orphans.length} member(s) moved out of it`;
    for (const g of before) {
      const id = findEntityByGuid(g, world)?.id();
      const rec = id !== undefined && storedRootsUnder(id).includes(id) ? storedRecord(world, g) : undefined;
      if (!rec) { dropInstanceRecord(world, g); continue; }
      rec.placement.parent = placementParent(id!);
    }
    // Every stored root the unpack leaves without a record is a Missing Prefab placeholder: a ROW placeholder the unpack
    // turned into a reference placeholder (#2099, holding the records its row held, `detachedRowRecord`), or a template
    // reference node of a missing prefab whose frame the unpack made an entry (#2102; the re-seed from the capture used
    // to state it). Its records are what a save writes of it (`asSceneEntry`: the record it carries, with its live identity
    // and placement) read back as a load reads them. Any other is a stored root no record states: the Detach is refused.
    const made: InstanceRecord[] = [];
    let placeholders = 0;
    for (const id of storedRootsUnder(rootId)) {
      const g = guidOfEntity(id);
      if (!g || storedRecord(world, g)) continue;
      if (!unresolvedRefOf(findEntity(id) as never)) return `the unpack left ${g} a stored root that carries no record`;
      const recs = capturedRecordsOf(id);
      if (!recs?.length || recs[0]!.rootGuid !== g) return `the reference placeholder ${g} carries a record that names another root (${recs?.[0]?.rootGuid ?? 'none'})`;
      made.push(...recs);
      placeholders++;
    }
    if (placeholders < (out.placeholders?.length ?? 0)) return `the unpack left ${out.placeholders!.length} reference placeholder(s), and ${placeholders} of them could be recorded`;
    for (const r of made) setInstanceRecord(world, r);
    return true;
  };
}

// ── Create Prefab ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The live nodes that hang directly under a keyed node of instance `rootId` without being keyed themselves (the scene's
 *  own content, a reference node the scene added), as the `own` links of their anchors' rows, in sibling order (as the
 *  save writes them). */
function ownLinksOf(rootId: number, world: World): Map<RowKey, { guid: string }[]> {
  const ea = getTraitByName('EntityAttributes')!;
  const keys = instanceKeyMap(rootId);
  const links = new Map<RowKey, { guid: string; order: number }[]>();
  for (const e of world.entities) {
    if (keys.has(e.id())) continue;
    const a = e.get(ea.trait) as { parentId?: number; sortOrder?: number; guid?: string } | undefined;
    const anchor = a?.parentId ? keys.get(a.parentId) : undefined;
    if (anchor === undefined || !a?.guid) continue;
    const list = links.get(anchor) ?? [];
    list.push({ guid: a.guid, order: a.sortOrder ?? 0 });
    links.set(anchor, list);
  }
  const out = new Map<RowKey, { guid: string }[]>();
  for (const [anchor, list] of links) {
    list.sort((x, y) => x.order - y.order || (x.guid < y.guid ? -1 : x.guid > y.guid ? 1 : 0));
    out.set(anchor, list.map(({ guid }) => ({ guid })));
  }
  return out;
}

/** One unused record's identity, to match it across two folds. */
const unusedId = (u: { key: RowKey; part: RecordPart }): string => `${u.key}\u0000${JSON.stringify(u.part)}`;

/** Copy into `rows` what `prior` states that its own fold leaves unused, and every row of a node its fold does not build
 *  (a dropped member's, its pin included). Returns the carried records' identities. */
function carryUnused(prior: InstanceRecord, rows: Map<RowKey, SceneTargetRecord>): Set<string> {
  const out = new Set<string>();
  const fold = foldInstance(editorPrefabReader, prior);
  for (const [key, row] of prior.list.rows) {
    if (fold.nodes.has(key)) continue;
    rows.set(key, clone(row));
  }
  for (const u of fold.unused) {
    out.add(unusedId(u));
    if (!fold.nodes.has(u.key)) continue; // carried whole above
    const from = prior.list.rows.get(u.key);
    if (!from) continue;
    const to = rows.get(u.key) ?? {};
    rows.set(u.key, to);
    const part = u.part;
    if (part.kind === 'field') {
      const bag = from.traits?.[part.trait];
      if (!bag || bag === true) continue;
      const traits = (to.traits ??= {});
      const into = (traits[part.trait] && traits[part.trait] !== true ? traits[part.trait] : (traits[part.trait] = {})) as Bag;
      into[part.field] = clone((bag as Bag)[part.field]);
    } else if (part.kind === 'trait') {
      const v = from.traits?.[part.trait];
      if (v !== undefined) (to.traits ??= {})[part.trait] = clone(v);
    } else if (part.kind === 'traitRemoval') {
      const v = from.traitRemovals?.[part.trait];
      if (v !== undefined) (to.traitRemovals ??= {})[part.trait] = v;
    } else if (part.kind === 'removed') {
      if (from.removed !== undefined) to.removed = from.removed;
    } else if (part.kind === 'own') {
      if (!(to.own ??= []).some((o) => o.guid === part.guid)) to.own.push({ guid: part.guid });
    } else if (part.kind === 'parent') {
      if (from.parent !== undefined) to.parent = from.parent;
    }
  }
  return out;
}

/**
 * `beginCreatePrefab`, phase 1: call BEFORE the tree at `rootId` is tagged as an instance of the prefab just written from
 * it (#2001 S8b; Unity's `SaveAsPrefabAssetAndConnect`). The document was written from the tree, so the instance it
 * becomes starts with an empty modification list: its record states the members' identity as they stand (§ 3.2, as
 * `place` pins a fresh instance) and links the scene's own nodes the document does not hold where they hang (`own`),
 * nothing else. The instances the tree held are rows of the new document now, so their records go; one the tag leaves a
 * stored root keeps its record, placed where it hangs. An enclosing instance's link to the root still names it.
 *
 * The commit is called once the tag has run (`linked`: the tree is an instance of the new prefab; `renamed`: the guids
 * its stamp renamed, which a swallowed instance's record followed) and returns true when the records are exact. A tag
 * that landed nothing changed no record and needs none, so that is true too. Otherwise it changes nothing and says why
 * the new record cannot state the tree (it does not fold to the tree's keyed nodes exactly: a placeholder, a row the fold
 * leaves unused), and the caller takes the tag back out and refuses: nothing is marked stale. Null, with nothing changed,
 * when the records of the trees it touches cannot be had; the caller then refuses before it tags.
 */
function beginCreatePrefabImpl(rootId: number, world: World = getCurrentWorld()): ((linked: boolean, renamed?: ReadonlyMap<string, string>) => true | string) | null {
  if (!getTraitByName('EntityAttributes') || !getTraitByName('PrefabInstance')) return null;
  for (const r of [outermostStoredRoot(rootId), ...storedRootsUnder(rootId)]) {
    if (r && outermostStoredRoot(r) === r && !treeForWrite(r, world)) return null;
  }
  // Every record of a node in the tree, not only of its stored roots now: the prefab's serialize has already keyed the
  // scene-added reference nodes it writes as the new document's nodes, so they read as template-added before the tag.
  const store = storedInstances(world);
  const before = [...liveGuidsUnder(rootId)].filter((g) => store.has(g));
  const rootGuid = guidOfEntity(rootId);
  // The root's own record, if it is an instance already: a re-tag to the SAME prefab (a Replace of its own prefab) keeps
  // what that record states the new document cannot (below).
  const was = rootGuid ? storedRecord(world, rootGuid) : undefined;
  const prior = was ? clone(was) : undefined;
  // …and every record the tag swallows, as it stands: the pins of the members their prefabs dropped stay in the scene.
  const swallowedRecords = new Map(before.filter((g) => g !== rootGuid).map((g) => [g, clone(storedRecord(world, g))] as const));
  return (linked, renamed = new Map()) => {
    // A swallowed instance's root the tag's stamp renamed: its record follows the rename (`instanceStore`'s listener).
    const swallowed = [...new Set(before.flatMap((g) => [g, renamed.get(g) ?? g]))];
    if (!linked) return true;
    const ea = getTraitByName('EntityAttributes')!, pi = getTraitByName('PrefabInstance')!;
    const e = findEntity(rootId);
    if (!rootGuid || !e?.has(pi.trait) || !storedRootsUnder(rootId).includes(rootId)) return 'the tree it linked is not an instance root';
    const source = (e.get(pi.trait) as { source?: string }).source ?? '';
    const attrs = e.get(ea.trait) as { name?: string; sortOrder?: number; editorFolder?: string; sourceScene?: string };
    const rows = new Map<RowKey, SceneTargetRecord>();
    // Every keyed node's identity as it stands (§ 2.7, rule 5), the root's (its placement) and a plain template-added
    // node's (its guid is derived from its key, `identityOf`) excepted: the tag's stamp derives only what a load derives
    // the same way, and a node inside a frame a template-added reference node opens keeps the guid it had.
    const unrooted: InstanceRecord = { rootGuid: '', source, placement: { parent: '', sortOrder: 0, name: '' }, list: { rows: new Map() }, held: {} };
    const shape = foldInstance(editorPrefabReader, unrooted).nodes;
    for (const [id, key] of instanceKeyMap(rootId)) {
      const node = shape.get(key);
      if (key === ROOT_ROW_KEY || (node?.template && !node.opens)) continue;
      const m = findEntity(id)?.get(ea.trait) as { guid?: string; name?: string } | undefined;
      if (m?.guid) rows.set(key, { guid: m.guid, ...(m.name !== undefined ? { name: m.name } : {}) });
    }
    for (const [anchor, own] of ownLinksOf(rootId, world)) {
      const row = rows.get(anchor) ?? {};
      row.own = own;
      rows.set(anchor, row);
    }
    // A Replace of the instance's OWN prefab is no unpack (#1814): the instance stays connected, and what its record
    // states that the document written from the live tree cannot hold stays with it — a row of a member the prefab
    // dropped (R2), a record the fold leaves unused, the data the parse could not interpret. An unpack (a new prefab)
    // drops them, as Unity drops an unpacked instance's unused overrides.
    const carried = prior && prior.source === source ? carryUnused(prior, rows) : new Set<string>();
    // A swallowed instance is a nested frame of the new prefab now, and the document took what its record stated (#1790:
    // an unused override is baked into the template), but not the identity of a member its prefab dropped (R2): a pin is
    // the scene's (#1293), so it moves into this record under the key that frame has here.
    const keysNow = instanceKeyMap(rootId);
    for (const [g, sw] of swallowedRecords) {
      if (!sw) continue;
      const id = findEntityByGuid(renamed.get(g) ?? g, world)?.id();
      const at = id !== undefined ? keysNow.get(id) : undefined;
      if (!at || at === ROOT_ROW_KEY) continue;
      const built = foldInstance(editorPrefabReader, sw).nodes;
      for (const [k, row] of sw.list.rows) {
        if (built.has(k) || row.guid === undefined) continue;
        rows.set(`${at}${k}` as RowKey, { guid: row.guid, ...(row.name !== undefined ? { name: row.name } : {}) });
      }
    }
    const rec: InstanceRecord = {
      rootGuid, source,
      placement: {
        parent: placementParent(rootId), sortOrder: attrs.sortOrder ?? 0, name: attrs.name ?? '',
        ...(attrs.editorFolder ? { editorFolder: attrs.editorFolder } : {}), ...(attrs.sourceScene ? { sourceScene: attrs.sourceScene } : {}),
      },
      list: { rows }, held: prior && prior.source === source ? clone(prior.held) : {},
    };
    // Checked: the list folds to exactly the tree's keyed nodes, with nothing it states left unused but what it carried.
    const folded = foldInstance(editorPrefabReader, rec);
    const keyed = new Set(instanceKeyMap(rootId).values());
    if (folded.placeholders.size || folded.unused.some((u) => !carried.has(unusedId(u))) || folded.nodes.size !== keyed.size || [...folded.nodes.keys()].some((k) => !keyed.has(k))) return 'its new instance record does not state the tree it was made from';
    for (const g of swallowed) {
      if (g === rootGuid) continue;
      const id = findEntityByGuid(g, world)?.id();
      const kept = id !== undefined && storedRootsUnder(id).includes(id) ? storedRecord(world, g) : undefined;
      if (!kept) { dropInstanceRecord(world, g); continue; }
      kept.placement.parent = placementParent(id!);
    }
    setInstanceRecord(world, rec);
    return true;
  };
}

/** The guid of every live entity in the subtree at `entityId`, itself included: what a delete of it takes. */
function liveGuidsUnder(entityId: number): Set<string> {
  const ea = getTraitByName('EntityAttributes')!;
  const all = getCurrentWorld().entities as Iterable<Entity>;
  const parent = new Map<number, number>();
  const guid = new Map<number, string>();
  for (const e of all) {
    const a = e.get(ea.trait) as { parentId?: number; guid?: string } | undefined;
    parent.set(e.id(), a?.parentId ?? 0);
    if (a?.guid) guid.set(e.id(), a.guid);
  }
  const out = new Set<string>();
  for (const [id, g] of guid) for (let a = id, n = 0; a && n < 1024; a = parent.get(a) ?? 0, n++) if (a === entityId) { out.add(g); break; }
  return out;
}

/** The keys of every keyed node of the instance at `rootId` (`instanceKeyMap`) inside the live subtree at `entityId`,
 *  itself included. */
function keyedSubtree(rootId: number, entityId: number): Set<RowKey> {
  const ea = getTraitByName('EntityAttributes')!;
  const parentOf = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
  const out = new Set<RowKey>();
  for (const [id, k] of instanceKeyMap(rootId)) {
    for (let a = id, n = 0; a && n < 1024; a = parentOf(a), n++) if (a === entityId) { out.add(k); break; }
  }
  return out;
}

// ── Reparent ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `setPlacement` and the `own` relinks of a reparent, phase 1: call BEFORE `entityId` moves. The commit, after the move:
 * - its old instance link (if it hung under a keyed node) goes, and its new one is added: a node that leaves or joins an
 *   instance, or moves between anchors, is a link change (§ 2.5), never a member move (U7 refuses those);
 * - every stored root at or under it takes its new placement parent and order;
 * - the keep-world Transform of a moved stored root (review R4) is a `"/"` record of each field the compensation changed.
 * In prefab edit the edited prefab's OWN node under a nested instance (a row of the document being edited, which hands
 * it to that frame as a template layer) carries a template key, so `instanceTargetOf` reads it as a member; moving it
 * is a template edit the prefab-edit save writes, and no record states it (#1869: it moves, as Unity's Prefab Mode has
 * it). A member the prefab SUPPLIES is never moved by a reparent (the plan refuses it as a restructure): one that gets
 * here THROWS before anything is written to the records, and the door rolls the move back (#2001 S8b).
 */
function beginReparentImpl(entityId: number, world: World = getCurrentWorld()): (moved: { compensated?: { old: Bag; next: Bag } }) => void {
  const ea = getTraitByName('EntityAttributes')!;
  const parentOf = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
  const self = instanceTargetOf(entityId);
  const oldAt = linkAt(parentOf(entityId));
  const guid = guidOfEntity(entityId);
  const roots = storedRootsUnder(entityId);
  const oldRec = oldAt ? recordForWrite(oldAt.rootId, oldAt.rootGuid, world) : null;
  if (self?.kind === 'member' && self.key !== ROOT_ROW_KEY && isSuppliedByPrefab(entityId)) {
    throw new Error(`a reparent reached supplied member "${guid}" of instance "${self.rootGuid}", which the plan refuses as a restructure: its records cannot follow the move`);
  }
  return ({ compensated }) => {
    if (oldAt && oldRec && guid) unlink(oldRec, oldAt.key, guid);
    const newAt = linkAt(parentOf(entityId));
    if (newAt && guid) {
      const rec = recordForWrite(newAt.rootId, newAt.rootGuid, world);
      if (rec) { const row = rowOf(rec, newAt.key); if (!(row.own ??= []).some((o) => o.guid === guid)) row.own.push({ guid }); }
    }
    for (const r of roots) {
      const rec = storedRecord(world, guidOfEntity(r));
      if (!rec) continue;
      rec.placement.parent = placementParent(r);
      const attrs = findEntity(r)?.get(ea.trait) as { sortOrder?: number; editorFolder?: string } | undefined;
      if (typeof attrs?.sortOrder === 'number') rec.placement.sortOrder = attrs.sortOrder;
      if (attrs?.editorFolder) rec.placement.editorFolder = attrs.editorFolder; else delete rec.placement.editorFolder;
    }
    if (compensated) {
      const rec = storedRecord(world, guid);
      if (rec) {
        const changed = Object.entries(compensated.next)
          .filter(([f, v]) => typeof v === 'number' && Math.abs(v - Number(compensated.old[f] ?? 0)) > 1e-6).map(([f]) => f);
        // Rotation is one record (#1880 F5), as the mark of one axis marks the group.
        if (changed.some((f) => isRotation('Transform', f))) for (const f of ['rx', 'ry', 'rz']) if (!changed.includes(f)) changed.push(f);
        const tf = getTraitByName('Transform');
        const live = tf ? collectComparableTraits(guidRoot(guid), [tf]).Transform ?? {} : {};
        const bag = ((rowOf(rec, ROOT_ROW_KEY).traits ??= {}).Transform ??= {}) as Bag;
        for (const f of changed) if (f in live) bag[f] = live[f];
        tidy(rec, ROOT_ROW_KEY);
      }
    }
  };
}

// ── Apply (U15), on records (#2001 S8b; § 3.2's Apply row) ──────────────────────────────────────────────────────────

/** One frame an Apply copied fields FROM: its root, and the applied keys in its own prefab's numbering
 *  (`localId.Trait.field`, or `+trait.localId.Tag` for a tag) — `refreshInstances`' `appliedFrom`. */
export interface AppliedFrom {
  rootId: number;
  rootGuid?: string;
  fields: ReadonlySet<string>;
}

/**
 * The statements an Apply wrote into the documents leave the records that state them (U15: the value is the prefab's
 * now, as Unity's Apply leaves no override behind). Each applied key names a member of its frame by local id; its
 * statement is the field in that member's row of the record that keys it. True when every key was named and the
 * records holding them are written; false, with NOTHING written, when one cannot be: a key that changes structure (an
 * added node, a removal), a frame or member not live, or a node no record of the
 * tree at `top` keys. The caller then rebuilds the tree from the capture, as before. A stored root's own order and name
 * are its placement, never a row's statement: an Apply of them leaves the record as it is.
 */
function subtractAppliedImpl(top: number, applied: readonly AppliedFrom[], world: World = getCurrentWorld()): boolean {
  const pi = getTraitByName('PrefabInstance');
  if (!pi) return false;
  const edited = new Map<string, InstanceRecord>();
  const recOf = (g: string): InstanceRecord | null => {
    const have = edited.get(g);
    if (have) return have;
    const fresh = storedRecord(world, g);
    if (!fresh) return null;
    const rec = clone(fresh);
    edited.set(g, rec);
    return rec;
  };
  // Each frame's members by local id: a member links its frame root (`rootInstanceId`), the root itself included.
  const byLid = new Map<number, Map<number, number>>();
  const memberOf = (frame: number, lid: number): number | undefined => {
    let m = byLid.get(frame);
    if (!m) {
      m = new Map();
      for (const e of world.query(pi.trait)) {
        const d = e.get(pi.trait) as { rootInstanceId?: number; localId?: number } | undefined;
        if (d?.rootInstanceId === frame && typeof d.localId === 'number') m.set(d.localId, e.id());
      }
      byLid.set(frame, m);
    }
    return m.get(lid);
  };
  for (const a of applied) {
    const frame = a.rootGuid ? findEntityByGuid(a.rootGuid, world)?.id() : a.rootId;
    if (!frame) return false;
    for (const key of a.fields) {
      const tag = key.startsWith('+trait.');
      if (!tag && /^[+-]/.test(key)) return false;
      const [lid, trait, field] = (tag ? key.slice('+trait.'.length) : key).split('.');
      if (!trait || (!tag && !field)) return false;
      const id = memberOf(frame, Number(lid));
      const t = id !== undefined ? instanceTargetOf(id) : null;
      if (t?.kind !== 'member' || projectionRootOf(t.rootId) !== top) return false;
      const rec = recOf(t.rootGuid);
      if (!rec) return false;
      const traits = rec.list.rows.get(t.key)?.traits;
      // Nothing stated there: nothing leaves, as the capture's subtraction skips a field it does not hold.
      if (!traits || traits[trait] === undefined) continue;
      const bag = traits[trait];
      if (tag || bag === true || !bag) delete traits[trait];
      else delete (bag as Record<string, unknown>)[field!];
      tidy(rec, t.key);
    }
  }
  for (const rec of edited.values()) setInstanceRecord(world, rec);
  return true;
}

/**
 * An Apply's promotion of the user's added nodes into the applying frame's OWN document (U15's structural half, on
 * records; #2001 S8b): `insertAddedSubtree` wrote each node of the subtrees at `tops` as a new row of `doc` — a plain
 * node as a plain row (`rows`: its live guid → the row's localId), a reference node (a scene-added instance) as a nested
 * row carrying that instance's whole list, baked (`refRows`). So the nodes are the template's now. The record of the tree
 * the frame lies in stops linking them (`own`), and pins each new member to the guid it had (rule 5: the save writes a
 * row for every member, so its identity stays, as `carryPromotedGuids` gives it back to the live member). A reference
 * node's members keep theirs too, under its new row's key, read from its live members and from its record's pins of
 * members the template no longer has; its record goes, its list being the row's,
 * and so do the records of the instances the scene added inside it: the row's `added` carries them and the user's nodes
 * there as template nodes, whose guids derive (refs follow them, `carryPromotedGuids`). Their values are the template's:
 * nothing restates them. A top written on an ENCLOSING prefab's row instead (#1715; neither map names it) is a
 * template-keyed node there, whose guid every instance derives and no row pins (`carryPromotedGuids` moves its refs to
 * the derived one): its link goes and nothing else is stated (hunt seed 9409). It is plain all through: the plan refuses
 * to write a node that is or holds an instance on an enclosing row (`addedNodeRefusal`). `doc` is null when the Apply
 * wrote no row of the frame's own document. Returns the write, to run once the Apply's files are in; null, with nothing
 * written, when one cannot be stated: the frame's record missing, a top not linked on that record, a node with no
 * durable guid, a row the document does not hold, or a reference node whose records hold what its row does not carry
 * (held data other than a held node, a link to a node neither live nor held, a missing record inside it). The Apply asks
 * first (`canPromoteAdded`) and refuses, before it writes a file, when it is null (#2001 S8b).
 */
function promoteAddedImpl(
  frameRootId: number, tops: readonly number[], rows: ReadonlyMap<string, number>, refRows: ReadonlyMap<string, number>,
  doc: { entities?: readonly { localId?: number; nodeGuid?: string }[]; rootLocalId?: number } | null, source: string,
  world: World = getCurrentWorld(),
): (() => void) | null {
  const frame = instanceTargetOf(frameRootId);
  if (frame?.kind !== 'member') return null;
  const fresh = storedRecord(world, frame.rootGuid);
  if (!fresh) return null;
  const rec = clone(fresh);
  const f = doc ? frameOf(frame.key === ROOT_ROW_KEY ? '' : frame.key, doc as never, source) : null;
  const ea = getTraitByName('EntityAttributes')!;
  const parentOf = (id: number) => (findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0;
  for (const id of tops) {
    const g = guidOfEntity(id);
    if (!g) return null;
    // A reference node owns a record of its own: its link is on the member it hangs under. A plain one is found by the
    // record's link itself: in the prefab editor the node also carries the template key its save will write
    // (`TemplateAddedKey`), which `instanceTargetOf` reads as a member's, while the record links it as the scene's.
    const stored = storedRootsUnder(id).includes(id);
    const t = stored ? instanceTargetOf(parentOf(id)) : null;
    const anchorKey = stored ? (t?.kind === 'member' && t.rootGuid === frame.rootGuid ? t.key : undefined)
      : [...rec.list.rows].find(([, r]) => r.own?.some((o) => o.guid === g))?.[0];
    if (anchorKey === undefined) return null;
    const row = rec.list.rows.get(anchorKey);
    if (!row?.own?.some((o) => o.guid === g)) return null;
    row.own = row.own.filter((o) => o.guid !== g);
    tidy(rec, anchorKey);
  }
  const isUnder = (e: number, top: number): boolean => { for (let a = parentOf(e), n = 0; a && n < 1024; a = parentOf(a), n++) if (a === top) return true; return false; };
  const nameOf = (id: number) => (findEntity(id)?.get(ea.trait) as { name?: string } | undefined)?.name;
  const pin = (key: RowKey, guid: string, name?: string): boolean => {
    if (!durableGuid(guid)) return false;
    const row = rowOf(rec, key);
    row.guid = guid;
    if (name) row.name = name;
    return true;
  };
  const newKey = (lid: number): RowKey | null => {
    if (!f) return null;
    const key = memberKeyOfLid(f, lid);
    return key && key !== f.prefix && key !== ROOT_ROW_KEY ? key : null;
  };
  for (const [guid, lid] of rows) {
    const key = newKey(lid);
    if (!key || !pin(key, guid, nameOf(findEntityByGuid(guid, world)?.id() ?? 0))) return null;
  }
  const dropped: string[] = [];
  for (const [guid, lid] of refRows) {
    const key = newKey(lid);
    const id = findEntityByGuid(guid, world)?.id();
    const own = storedRecord(world, guid);
    if (!key || !id || !own) return null;
    // Its own nodes, and every instance the scene added inside it, become the row's template content (`insertAddedSubtree`
    // recaptures them as its `added`), so they leave the records with it — each record fresh, holding nothing the row
    // cannot carry, and linking only live nodes. Found in the store by parent walk: that capture has keyed each instance
    // inside as a template node of the row already, so `storedRootsUnder` no longer counts it.
    const inside = [...storedInstances(world).keys()].filter((g) => g !== guid && isUnder(findEntityByGuid(g, world)?.id() ?? 0, id));
    for (const g of [guid, ...inside]) {
      const r = storedRecord(world, g);
      if (!r) return null;
      // A node held under an anchor that is not projected (`heldOwn`) is baked into the row with the rest (#1802, owner
      // ruling D: in template form, `insertAddedSubtree`), so it leaves the records with them, link and all.
      if (!heldIsEmpty(r.held)) return null;
      const held = heldOwnGuids(r);
      for (const row of r.list.rows.values()) for (const o of row.own ?? []) if (typeof o.guid !== 'string' || (!findEntityByGuid(o.guid, world) && !held.has(o.guid))) return null;
    }
    if (storedRootsUnder(id).some((r) => r !== id && !inside.includes(guidOfEntity(r)))) return null;
    if (!pin(key, guid, nameOf(id))) return null;
    const under = (k: RowKey): RowKey => (k === ROOT_ROW_KEY ? key : (`${key}${k}` as RowKey));
    for (const [k, r] of own.list.rows) if (k !== ROOT_ROW_KEY && r.guid !== undefined && !r.removed && !pin(under(k), r.guid, r.name)) return null;
    for (const [m, k] of memberRowsToWrite(id, world)) if (k !== ROOT_ROW_KEY && !pin(under(k as RowKey), guidOfEntity(m), nameOf(m))) return null;
    dropped.push(guid, ...inside);
  }
  return () => {
    setInstanceRecord(world, rec);
    for (const g of dropped) dropInstanceRecord(world, g);
  };
}

// ── Copy, on records (#2046 S7.4, D-8c; § 3.2's duplicate/paste row) ─────────────────────────────────────────────────

/** Is `held` empty: nothing the parse could not interpret, no kept node? A node held under an anchor that is not
 *  projected (`heldOwn`) is not counted: it is the user's, stated in the written form, and a copy carries it
 *  (`seatCopy`, under the identities the copy plan mints for it). */
function heldIsEmpty(held: InstanceRecord['held'] | undefined): boolean {
  const { heldOwn: _own, ...rest } = held ?? {};
  return Object.values(rest).every((v) => v == null || (v instanceof Map ? v.size === 0 : typeof v === 'object' && !Object.keys(v as object).length));
}

/** The guids of the nodes `rec` holds (`held.heldOwn`), the ones its links name. */
function heldOwnGuids(rec: InstanceRecord): Set<string> {
  return new Set([...(rec.held.heldOwn?.values() ?? [])].flat().map((n) => n.guid).filter((g): g is string => typeof g === 'string' && !!g));
}

/**
 * The records a copy of the subtree at `entityId` carries, read BEFORE the copy: every record-owning stored root at or
 * under it, fresh, by root guid. A copy of PART of an instance (a member, #1756's link rules) also carries, for each
 * outermost nested frame in it, the record that frame has as an instance of its own (`promotedRecord`, #2001 S8b): the
 * copy plan makes it one. Null when a copy could not restate one exactly, and the copy is refused (#2001 S8b):
 * a root with no record, held data (a kept orphan, a value the parse could not interpret), a record with a link the fold
 * does not place (it names a guid the source keeps), or a frame `promotedRecord` cannot state.
 */
function copyRecordsOfImpl(entityId: number, world: World = getCurrentWorld()): Map<string, InstanceRecord> | null {
  const t = instanceTargetOf(entityId);
  const out = new Map<string, InstanceRecord>();
  if (t?.kind === 'member' && t.key !== ROOT_ROW_KEY) {
    const rec = recordForWrite(t.rootId, t.rootGuid, world);
    if (!rec || !heldIsEmpty(rec.held)) return null;
    const folded = foldInstance(editorPrefabReader, rec);
    const keys = instanceKeyMap(t.rootId);
    const ea = getTraitByName('EntityAttributes')!;
    const parentOf = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
    const opensFrame = (id: number) => { const k = keys.get(id); return k !== undefined && !!folded.nodes.get(k)?.opens; };
    // The nodes a frame's own documents supply, keyed relative to it (`promotedRecord`'s members).
    const ownOf = new Map<number, Set<RowKey>>();
    const ownMembers = (id: number): Set<RowKey> => {
      let s = ownOf.get(id);
      if (!s) {
        const source = folded.nodes.get(keys.get(id)!)!.frame.source;
        const empty: InstanceRecord = { rootGuid: '', source, placement: { parent: '', sortOrder: 0, name: '' }, list: { rows: new Map() }, held: {} };
        ownOf.set(id, (s = new Set(foldInstance(editorPrefabReader, empty).nodes.keys())));
      }
      return s;
    };
    // The frame roots in the copied subtree the copy makes instances of their own: the copied node's, and each one no
    // copied frame above it holds as its documents' own node. A frame root a layer OUTSIDE the copied frame added (an
    // outer template's reference node anchored on one of its members) is plain content of that frame, so the copy plan
    // makes it a root of its own too (hunt seed 9451); one the copied frame's own documents nest stays nested in it.
    const promotedInCopy = (id: number): boolean => {
      if (id === entityId) return true;
      const k = keys.get(id)!;
      for (let a = parentOf(id), n = 0; a && n < 1024; a = parentOf(a), n++) {
        if (opensFrame(a)) { const ak = keys.get(a)!; if (k.startsWith(`${ak}/`) && ownMembers(a).has(k.slice(ak.length))) return false; }
        if (a === entityId) return true;
      }
      return false;
    };
    for (const id of keys.keys()) {
      if (!opensFrame(id) || !promotedInCopy(id)) continue;
      const promoted = promotedRecord(rec, keys.get(id)!, world);
      if (!promoted) return null;
      out.set(promoted.rootGuid, promoted);
    }
  }
  for (const r of storedRootsUnder(entityId)) {
    const g = guidOfEntity(r);
    const rec = g ? recordForWrite(r, g, world) : null;
    // An unused part that names no node (a removal or an override of what the template no longer has, a legacy statement
    // into a frame that does not resolve) is the source's list, copied as it stands: only a link names a node of the
    // source's (#2001 S8b). A link naming a node the record holds is carried with that node. The held data rides too:
    // the copy holds its own nodes, pins and refs under the copy plan's guids (`copyGuidMap`, `seatCopy`).
    const held = rec ? heldOwnGuids(rec) : new Set<string>();
    if (!rec || foldInstance(editorPrefabReader, rec).unused.some((u) => u.part.kind === 'own' && !held.has(u.part.guid))) return null;
    out.set(g, clone(rec));
  }
  return out;
}

/**
 * Seat `records` ({@link copyRecordsOf}'s) for the copy just spawned at `copyId`, then link it where it hangs (`addChild`):
 * each record under its copy's root guid (`remap`: a source guid → the copy's, the copy plan's), its `own` links and its
 * identity pins remapped the same way, and its placement the live copy's. False, with nothing seated, when a copied root
 * is not live, a link or pin names a node the copy does not hold, or the copy holds an instance no record states: the
 * caller takes the copy back out and refuses it (#2001 S8b).
 */
function seatCopyImpl(records: ReadonlyMap<string, InstanceRecord>, remap: ReadonlyMap<string, string>, copyId: number, world: World = getCurrentWorld()): boolean {
  const ea = getTraitByName('EntityAttributes')!;
  const seated: InstanceRecord[] = [];
  for (const [g, src] of records) {
    const to = remap.get(g);
    const id = to ? findEntityByGuid(to, world)?.id() : undefined;
    const attrs = id ? findEntity(id)?.get(ea.trait) as { name?: string; sortOrder?: number; editorFolder?: string; sourceScene?: string } | undefined : undefined;
    // A link, or a pin, naming a node the copy does not hold would be a second claimant of the source's node.
    // Not the pin of a member the source REMOVED (kept in its record since #2001 S6): the copy holds no such node, so
    // nothing of the copy's can claim it; that pin is left behind below.
    const unmapped = [...src.list.rows.values()].some((row) => row.own?.some((o) => !remap.has(o.guid)) || (row.guid !== undefined && !row.removed && !remap.has(row.guid)))
      || [...heldOwnGuids(src)].some((h) => !remap.has(h));
    if (!to || !id || !attrs || unmapped) return false;
    const rec = clone(src);
    rec.rootGuid = to;
    // The live copy's placement: its parent, its fresh order, the scene it was pasted into (`adoptParentScene`).
    rec.placement = {
      ...rec.placement, parent: placementParent(id), sortOrder: attrs.sortOrder ?? 0, name: attrs.name ?? rec.placement.name,
      ...(attrs.editorFolder ? { editorFolder: attrs.editorFolder } : {}), ...(attrs.sourceScene ? { sourceScene: attrs.sourceScene } : {}),
    };
    if (!attrs.editorFolder) delete rec.placement.editorFolder;
    if (!attrs.sourceScene) delete rec.placement.sourceScene;
    for (const [k, row] of [...rec.list.rows]) {
      // The pin follows the copy (rule 5: a pin is identity, kept verbatim even once the template drops its member).
      // A removed member's pin is the SOURCE's member's identity: the copy never held that node, so it carries the removal
      // alone, and a Revert brings the member back under the identity the copy derives for it.
      if (row.guid !== undefined) {
        const to = remap.get(row.guid);
        if (to) row.guid = to;
        else { delete row.guid; delete row.name; }
      }
      // A value naming a node the copy holds follows the copy, as the copy's live values do (`copySnapshot`, #1338); a
      // stated node guid (identity, a legacy field record) is the copy plan's to give, which derives it (hunt seed 8148).
      if (row.traits) {
        row.traits = remapGuidValues(row.traits, remap) as typeof row.traits;
        const ea = row.traits.EntityAttributes;
        if (ea && ea !== true) for (const f of NODE_IDENTITY_FIELDS) delete (ea as Bag)[f];
      }
      if (row.parent !== undefined) row.parent = remap.get(row.parent) ?? row.parent;
      if (row.own) row.own = row.own.map((o) => ({ ...o, guid: remap.get(o.guid) ?? o.guid }));
      tidy(rec, k);
    }
    // The nodes the record holds: the copy's own, every identity in them the copy plan's fresh one, and a value naming
    // a node the copy holds following the copy, as a live node's values do.
    if (rec.held.heldOwn) rec.held.heldOwn = new Map([...rec.held.heldOwn].map(([k, nodes]) => [k, nodes.map((n) => remapGuidValues(n, remap) as typeof n)]));
    // So do the statements the record holds verbatim (a promoted frame's, `promotedRecord`): a pin or a ref in them.
    if (rec.held.pendingLegacy) rec.held.pendingLegacy = remapGuidValues(rec.held.pendingLegacy, remap) as typeof rec.held.pendingLegacy;
    // And what no reader took, and what a template-keyed node held of its own: copied verbatim, a guid in them named the
    // SOURCE's node, a second claimant of it once saved (#1293; #2001 S8b review G3).
    if (rec.held.unparsed) rec.held.unparsed = remapGuidValues(rec.held.unparsed, remap) as typeof rec.held.unparsed;
    if (rec.held.keyedNodeHeld) rec.held.keyedNodeHeld = new Map([...rec.held.keyedNodeHeld].map(([k, h]) => [k, remapGuidValues(h, remap) as typeof h]));
    seated.push(rec);
  }
  // Every instance the copy holds is one of the seated: a node the copy plan made a root of its own has no record here.
  const seatedGuids = new Set(seated.map((r) => r.rootGuid));
  if (storedRootsUnder(copyId).some((r) => !seatedGuids.has(guidOfEntity(r)))) return false;
  for (const rec of seated) setInstanceRecord(world, rec);
  addChild(copyId, world);
  return true;
}

// ── Revert ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a Revert needs of the frame it reverts in: the document its keys' localIds are read against. */
export interface RevertFrame {
  /** The frame root the keys are stated against (an instance root, or an owned nested frame's root). */
  frameRoot: number;
  /** That frame's document, and its guid. */
  doc: { entities: ReadonlyArray<{ localId: number; nodeGuid?: string; traits?: Record<string, unknown> }>; rootLocalId?: number };
  source: string;
}

/** A Revert's record edits, decided: the records they touched, by root guid, and the live root of the tree to
 *  reproject. Null when no key named a record. */
export interface RevertEdit {
  /** Every record the Revert changed or dropped, by root guid. */
  touched: string[];
  /** The outermost live root of the instance tree. */
  top: number;
  /** What the Revert takes out, for the caller to report: the keys that named no record. */
  unmatched: string[];
}

/**
 * `revert`: take the selected keys' records OFF the list (§ 3.2's Revert row; Unity: Revert is one of the three acts
 * that take a record off, rule 3). Each key names one record of the frame's owning record:
 * - `<lid>.<T>.<f>`: the field record (rotation is one record, #1880 F5); on the instance root, `name`, `sortOrder` and
 *   `editorFolder` are its placement (§ 10.4), which goes back to the prefab root's;
 * - `+trait.<lid>.<T>`: the added component (or the restore of a layer's removal), whole;
 * - `-trait.<lid>.<T>`: the component removal; the field records kept beside it apply again (G2);
 * - `-removed.<lid>`: the member removal; the records on and under it apply again (rule 3: "reverting the deletion
 *   brings it back as it was", § 10.4);
 * - `~moved.<lid>` / `~moved.<chain>:<lid>`: the legacy move (`parent`);
 * - `+added.<guid>`: the link of a node the scene added — the node itself is scene content and goes with it (a plain
 *   delete, § 3.2), with the records of any instance inside it.
 * The value a reverted record leaves is the FOLD's without it (§ 3.6): the enclosing rows' (#1492), and a returned
 * member as every layer states it (#1730). A key that names no record of this list reverts nothing: it is the
 * enclosing prefab's own statement, or not this instance's.
 *
 * Mutates the store only; the caller reprojects (`reprojectFromStore`). Keys are in localId form against `frame.doc`.
 */
export function revert(frame: RevertFrame, keys: ReadonlySet<string>, world: World = getCurrentWorld()): RevertEdit | null {
  const ft = instanceTargetOf(frame.frameRoot);
  if (!ft || ft.kind !== 'member') return null;
  const top = storedRootsAbove(frame.frameRoot).filter((id) => !unresolvedRefOf(findEntity(id) as never)).at(-1) ?? ft.rootId;
  // The whole tree's records fresh first (the top's gate), then the frame's own.
  if (!recordForWrite(top, guidOfEntity(top), world)) return null;
  const rec = recordForWrite(ft.rootId, ft.rootGuid, world);
  if (!rec) return null;
  const rootLid = frame.doc.rootLocalId ?? 1;
  const prefix = ft.key === ROOT_ROW_KEY ? '' : ft.key;
  const keys2 = instanceKeyMap(ft.rootId);
  const liveByLid = new Map<number, number>([[rootLid, frame.frameRoot]]);
  for (const [id, row] of memberRowsIn(ft.rootId)) if (row.frameRoot === frame.frameRoot && row.rowLocalId) liveByLid.set(row.rowLocalId, id);
  /** The row key of member `lid` of the frame: its live key, else the key its row's identity gives (§ 2.1). The frame
   *  root's own lid is the frame's key. */
  const keyOfLid = (lid: number): RowKey | null => {
    const live = liveByLid.get(lid);
    const liveKey = live !== undefined ? keys2.get(live) : undefined;
    if (liveKey !== undefined) return liveKey;
    // Not live, or a member of a pre-v5 document, which no live key names: its row's identity, as the parser derives it
    // (§ 10.4b, `preV5NodeGuid`).
    const row = rowAt(frame.doc.entities, lid);
    if (!row) return null;
    return `${prefix}/${row.nodeGuid || preV5NodeGuid(frame.source, lid)}`;
  };
  const touched = new Set<string>([ft.rootGuid]);
  const unmatched: string[] = [];
  const nested = keys.size && [...keys].some((k) => k.startsWith('~moved.') && k.includes(':')) ? nestedFrameMoves(frame.frameRoot) : [];
  const ea = getTraitByName('EntityAttributes')!;
  const parentOfId = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
  const templateRoot = rowAt(frame.doc.entities, rootLid)?.traits?.EntityAttributes as Bag | undefined;

  const dropField = (r: InstanceRecord, key: RowKey, trait: string, field: string): boolean => {
    const row = r.list.rows.get(key);
    const bag = row?.traits?.[trait];
    if (bag === undefined) return false;
    if (bag === true) { delete row!.traits![trait]; tidy(r, key); return true; }
    const fields = isRotation(trait, field) ? (ROTATION_MARKS as readonly string[]).map((m) => m.split('.')[1]!) : [field];
    if (!fields.some((f) => (bag as Bag)[f] !== undefined)) return false;
    // A component the base lacks is stated whole (an added one, § 2.5): its reverted field takes the schema default the
    // fold fills in, and the last one taken takes the component with it, as the old Revert's reduced capture did.
    for (const f of fields) delete (bag as Bag)[f];
    tidy(r, key);
    return true;
  };

  for (const k of keys) {
    let hit = false;
    if (k.startsWith('+added.')) {
      const guid = k.slice('+added.'.length);
      const id = findEntityByGuid(guid)?.id() ?? 0;
      const at = id ? linkAt(parentOfId(id)) : null;
      const owner = at ? recordForWrite(at.rootId, at.rootGuid, world) : null;
      if (at && owner && owner.list.rows.get(at.key)?.own?.some((o) => o.guid === guid)) {
        unlink(owner, at.key, guid);
        touched.add(at.rootGuid);
        for (const r of storedRootsUnder(id)) { const g = guidOfEntity(r); touched.add(g); dropInstanceRecord(world, g); }
        hit = true;
      }
    } else if (k.startsWith('-removed.')) {
      const key = keyOfLid(Number(k.slice('-removed.'.length)));
      const row = key ? rec.list.rows.get(key) : undefined;
      if (row?.removed === true) { delete row.removed; tidy(rec, key!); hit = true; }
    } else if (k.startsWith('-trait.') || k.startsWith('+trait.')) {
      const [kind, lidStr, trait] = k.split('.');
      const key = keyOfLid(Number(lidStr));
      const row = key ? rec.list.rows.get(key) : undefined;
      if (row && trait) {
        if (kind === '-trait' && row.traitRemovals?.[trait] === true) { delete row.traitRemovals[trait]; hit = true; }
        if (kind === '+trait') {
          if (row.traits?.[trait] !== undefined) { delete row.traits[trait]; hit = true; }
          if (row.traitRemovals?.[trait] === false) { delete row.traitRemovals[trait]; hit = true; }
        }
        tidy(rec, key!);
      }
    } else if (k.startsWith('~moved.')) {
      const rest = k.slice('~moved.'.length);
      let target: { r: InstanceRecord; key: RowKey } | null = null;
      if (rest.includes(':')) {
        const m = nested.find((n) => n.key === k);
        const t = m ? instanceTargetOf(m.memberEcs) : null;
        const r = t?.kind === 'member' ? recordForWrite(t.rootId, t.rootGuid, world) : null;
        if (t?.kind === 'member' && r) { target = { r, key: t.key }; touched.add(t.rootGuid); }
      } else {
        const key = keyOfLid(Number(rest));
        if (key) target = { r: rec, key };
      }
      const row = target?.r.list.rows.get(target.key);
      if (row?.parent !== undefined) { delete row.parent; tidy(target!.r, target!.key); hit = true; }
    } else {
      const [lidStr, trait, field] = k.split('.');
      const lid = Number(lidStr);
      const key = trait && field !== undefined ? keyOfLid(lid) : null;
      if (key === ROOT_ROW_KEY && trait === 'EntityAttributes' && ROOT_PLACEMENT_FIELDS.has(field!)) {
        // The root's default overrides (§ 10.4): its placement goes back to the prefab root's.
        if (field === 'name' && typeof templateRoot?.name === 'string' && rec.placement.name !== templateRoot.name) { rec.placement.name = templateRoot.name; hit = true; }
        if (field === 'sortOrder' && typeof templateRoot?.sortOrder === 'number' && rec.placement.sortOrder !== templateRoot.sortOrder) { rec.placement.sortOrder = templateRoot.sortOrder; hit = true; }
        if (field === 'sortOrder' && rec.placement.orderStated) { delete rec.placement.orderStated; hit = true; }
        if (field === 'editorFolder' && rec.placement.editorFolder !== undefined) { delete rec.placement.editorFolder; hit = true; }
      } else if (key) hit = dropField(rec, key, trait!, field!);
    }
    if (!hit) unmatched.push(k);
  }
  return { touched: [...touched], top, unmatched };
}

// ── The shield ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The trees a verb writes in place, from its first argument (an entity id, or several), for a rollback's take; undefined
 *  (every record) when it names none. A verb that writes another tree too — a reparent's destination, a copy's enclosing
 *  records — takes the whole store (`wholeStore`). */
function treesOf(first: unknown): readonly number[] | undefined {
  if (typeof first === 'number') return [first];
  if (Array.isArray(first) && first.every((x) => typeof x === 'number')) return first as number[];
  return undefined;
}

/** A throw inside the door (a parser or fold defect on some record) FAILS the gesture, rolled back (#2001 S8b, hub
 *  decision A, `instanceRollback.ts`): every record as it stood when the verb began, each tree rebuilt from them, and
 *  the throw propagates, so the gesture lands nothing and pushes no undo entry. A verb's returned commit rolls back to
 *  the same point: the live write between the two is the gesture's, and goes with it. Before (S4, when the door was a
 *  shadow), the door never failed a gesture: the throw left the records stale, re-seeded from the capture at the next
 *  write, and the save wrote whatever the half-applied tree held. */
function shielded<A extends unknown[], R>(name: string, fn: (...args: A) => R, wholeStore = false): (...args: A) => R {
  return (...args: A): R => {
    const taken = takeStore(wholeStore ? undefined : treesOf(args[0]));
    let out: R;
    try { out = fn(...args); } catch (err) { rollBack(taken, `the instance door's ${name}`, err); throw err; }
    if (typeof out !== 'function') return out;
    const commit = out as unknown as (...b: unknown[]) => unknown;
    return ((...b: unknown[]) => { try { return commit(...b); } catch (err) { rollBack(taken, `the instance door's ${name}`, err); throw err; } }) as unknown as R;
  };
}

const NOOP = (): void => {};
export const setFields = shielded('setFields', setFieldsImpl);
export const dropMissingComponent = shielded('dropMissingComponent', dropMissingComponentImpl);
export const addComponent = shielded('addComponent', addComponentImpl);
export const beginRemoveComponent = shielded('beginRemoveComponent', beginRemoveComponentImpl);
export const place = shielded('place', placeImpl);
export const addChild = shielded('addChild', addChildImpl);
export const beginDelete = shielded('beginDelete', beginDeleteImpl);
export const beginReparent = shielded('beginReparent', beginReparentImpl, true);
export const beginDetach = shielded('beginDetach', beginDetachImpl);
export const beginCreatePrefab = shielded('beginCreatePrefab', beginCreatePrefabImpl);
export const copyRecordsOf = shielded('copyRecordsOf', copyRecordsOfImpl);
export const seatCopy = shielded('seatCopy', seatCopyImpl, true);
export const fieldRecordOf = shielded('fieldRecordOf', fieldRecordOfImpl);
export const putFieldRecord = shielded('putFieldRecord', putFieldRecordImpl);
export const rowsOf = shielded('rowsOf', rowsOfImpl);
export const priorRowsOf = shielded('priorRowsOf', priorRowsOfImpl);
export const putRows = shielded('putRows', putRowsImpl);
export const subtractApplied = shielded('subtractApplied', subtractAppliedImpl);
/** `promoteAdded`'s check alone: could the records follow this promotion? Asked before the Apply writes a file. */
export const canPromoteAdded = (...args: Parameters<typeof promoteAddedImpl>): boolean => !!promoteAddedImpl(...args);
export const promoteAdded = shielded('promoteAdded', (...args: Parameters<typeof promoteAddedImpl>): boolean => {
  const commit = promoteAddedImpl(...args);
  commit?.();
  return !!commit;
});
