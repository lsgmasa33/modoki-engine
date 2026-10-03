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
 * structural verb is two-phase: `begin…` BEFORE the old writer mutates the tree (it reads the targets and re-seeds a
 * stale record from the capture, which must not see the edit), its commit AFTER, and only if the old writer went ahead.
 * A field verb runs after the live write and BEFORE the mark recorder: the old capture is mark-based, so a re-seed then
 * still cannot see the edit (`instanceSync.ts`).
 *
 * The decisions here are made from DATA where the rules make them (F2's base is the fold of the record, § 3.3); where
 * the old writer's semantics differ from a rule, or no rule answers, the comment cites which, and the I25 shadow reports
 * every case where this door's list and the old capture disagree.
 *
 * Undo and redo do NOT pass through here (S7 moves them): the undo manager marks the store stale instead.
 */
import type { World } from 'koota';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import type { Entity } from 'koota';
import { findEntity, readTraitDataFull, writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { remapGuidValues } from '../../runtime/core/assetRefRules';
import { soaSchema } from '../../runtime/core/ecs/traitSchema';
import { ROTATION_MARKS } from '../../runtime/loaders/overrideMarks';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { dropInstanceRecord, freshInstanceRecord, markStale, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import { ROOT_ROW_KEY, type InstanceRecord, type Placement, type RowKey, type SceneTargetRecord } from '../../runtime/prefab/instanceRecord';
import { preV5NodeGuid } from '../../runtime/prefab/parseInstanceRecord';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { memberRowsIn, memberRowsToWrite } from '../../runtime/core/ecs/memberRows';
import { nestedFrameMoves } from '../scene/prefabChain';
import { valuesEqual } from '../scene/prefab';
import { collectComparableTraits } from '../scene/prefabInstanceOverrides';
import { guidOfEntity, instanceKeyMap, instanceTargetOf, outermostStoredRoot, storedRootsAbove, storedRootsUnder, type InstanceTarget } from './instanceKeys';
import { editorPrefabReader, recordForWrite } from './instanceSync';

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
      else if (f === 'sortOrder' && typeof live.sortOrder === 'number') rec.placement.sortOrder = live.sortOrder;
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
}

// ── Field gestures ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What the record states for `trait` on `entityId`'s row when an Inspector field GESTURE begins (#1914, the hub's #1922
 *  finding; `resumeGesture` in `entityActions.ts`). A number field commits on every keystroke, so retyping 200 over a
 *  base of 200 writes 2 and 20 first; F3 would keep the first keystroke's record. So each continuing write puts this
 *  back first, as the gesture puts the marks back, and a gesture leaves its start plus what its FINAL value differs in.
 *  Taken before the gesture's first write, so a re-seed here cannot see it. Null: not an instance member's. */
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

/** The row of each of `entityIds` now, aligned with them (a stale record is re-seeded first); null for an entity that
 *  is no instance member (a plain or scene-owned node, a Missing Prefab placeholder). */
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

/** {@link rowsOfImpl}, or null when an entity's record is not fresh ALREADY: for a step whose live write ran before it read
 *  its rows (a drag commit — the drag wrote live as it went). A re-seed there captures the dragged values, so the before
 *  side would state the value the undo takes back (#2046 S7 close-out review F1); such a step does not maintain the
 *  records (`putFieldRows` with no rows marks them stale). */
function priorRowsOfImpl(entityIds: readonly number[]): (RowSnap | null)[] | null {
  const world = getCurrentWorld();
  for (const id of entityIds) {
    const t = instanceTargetOf(id);
    if (t?.kind === 'member' && !freshInstanceRecord(world, t.rootGuid)) return null;
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
 * Call it AFTER the step's live writes. Returns false when a row could not be put (its record cannot be had) or has no
 * fold to show (its prefab cannot be read): the caller's step did not maintain the records.
 */
function putRowsImpl(entityIds: readonly number[], snaps: readonly (RowSnap | null)[], trait: string, fields: readonly string[] | 'all'): boolean {
  const meta = getTraitByName(trait);
  let all = true;
  entityIds.forEach((id, i) => {
    const snap = snaps[i];
    if (!snap) return;
    const rootId = guidRoot(snap.rootGuid);
    const rec = rootId ? recordForWrite(rootId, snap.rootGuid) : null;
    if (!rec) { all = false; return; }
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
  if (meta.category === 'tag') { (r.traits ??= {})[meta.name] = {}; return; }
  const live = collectComparableTraits(entityId, [meta])[meta.name] ?? {};
  (r.traits ??= {})[meta.name] = clone(live);
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

/** Phase 1 of an op that adds children under instance nodes: re-seed, BEFORE the spawn, the records the new children
 *  will be linked into (the capture must not see them). */
function beginAddChildImpl(parentId: number): void {
  const at = linkAt(parentId);
  if (at) recordForWrite(at.rootId, at.rootGuid);
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
  const ea = getTraitByName('EntityAttributes')!;
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
 * - the keep-world Transform of a moved stored root (`markCompensatedTransform`, review R4) is a `"/"` record of each
 *   field the compensation changed, as the old writer marks it.
 * A supplied member moved by a reparent (the strip/promote branch, which unpacks it) is not a list edit this door
 * knows: those records are marked stale, for S7.
 */
function beginReparentImpl(entityId: number, world: World = getCurrentWorld()): (moved: { compensated?: { old: Bag; next: Bag }; detaching?: boolean }) => void {
  const ea = getTraitByName('EntityAttributes')!;
  const parentOf = (id: number) => ((findEntity(id)?.get(ea.trait) as { parentId?: number } | undefined)?.parentId ?? 0);
  const self = instanceTargetOf(entityId);
  if (self?.kind === 'member' && self.key !== ROOT_ROW_KEY) {
    return () => markStale(world, 'reparent of a supplied member', [self.rootGuid]);
  }
  const oldAt = linkAt(parentOf(entityId));
  const guid = guidOfEntity(entityId);
  const roots = storedRootsUnder(entityId);
  // The moved roots' records first: a stale one re-seeds its whole tree from the capture (`reseedFromCapture`), which
  // REPLACES the old parent's record object, so an `oldRec` taken before it was an orphan the unlink below edited, and
  // the stored record kept the link (I25; a load that leaves a nested stored root stale — a trash's or Stop's — then a
  // reparent, #2056 review, hunt seed 5104).
  for (const r of roots) recordForWrite(r, guidOfEntity(r), world);
  const oldRec = oldAt ? recordForWrite(oldAt.rootId, oldAt.rootGuid, world) : null;
  return ({ compensated, detaching }) => {
    if (detaching) {
      // The move cut links (#1447: members unpacked, an owned nested root promoted): a Detach-like change S7 moves onto
      // records. Every record it may have touched is marked stale, including the moved node's new instance.
      const touched = [oldAt?.rootGuid, linkAt(parentOf(entityId))?.rootGuid, ...roots.map(guidOfEntity)].filter((g): g is string => !!g);
      const top = outermostStoredRoot(entityId);
      if (top) touched.push(guidOfEntity(top));
      markStale(world, 'detach', touched);
      return;
    }
    if (oldAt && oldRec && guid) unlink(oldRec, oldAt.key, guid);
    const newAt = linkAt(parentOf(entityId));
    if (newAt && guid) {
      const rec = recordForWrite(newAt.rootId, newAt.rootGuid, world);
      if (rec) { const row = rowOf(rec, newAt.key); if (!(row.own ??= []).some((o) => o.guid === guid)) row.own.push({ guid }); }
    }
    for (const r of roots) {
      const rec = freshInstanceRecord(world, guidOfEntity(r));
      if (!rec) continue;
      rec.placement.parent = placementParent(r);
      const attrs = findEntity(r)?.get(ea.trait) as { sortOrder?: number; editorFolder?: string } | undefined;
      if (typeof attrs?.sortOrder === 'number') rec.placement.sortOrder = attrs.sortOrder;
      if (attrs?.editorFolder) rec.placement.editorFolder = attrs.editorFolder; else delete rec.placement.editorFolder;
    }
    if (compensated) {
      const rec = freshInstanceRecord(world, guid);
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

// ── Stale ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Re-seed, BEFORE a gesture mutates them, the records of the instances `entityIds` belong to — for a verb whose commit
 *  runs after a mutation the old capture would see (an added component is captured whole, by value, marked or not). */
function prepareImpl(entityIds: readonly number[]): void {
  for (const id of entityIds) {
    const t = instanceTargetOf(id);
    if (t) recordForWrite(t.rootId, t.rootGuid);
  }
}

/** A copy (Duplicate, Paste) of `copyId` has just been spawned. A plain subtree is one added child (`addChild`). A copy
 *  that holds an instance, or that stayed linked as a member (#1756's link rules), is an instance copy, which S7 moves onto
 *  records (§ 3.2, the duplicate/paste row): every enclosing record is marked stale (#2037) and the copies' records are
 *  seeded when first needed. Call `beginAddChild(parent)` before the spawn. */
function afterCopyImpl(copyId: number, world: World = getCurrentWorld()): void {
  const t = instanceTargetOf(copyId);
  if (storedRootsUnder(copyId).length || t?.kind === 'member') {
    // The enclosing records (if any) go stale, and the instances the copy holds are named unrecorded: a plain copy
    // holding instances outside every instance has no enclosing record, but its roots are new all the same. EVERY
    // enclosing record, nearest first, not the outermost alone: a copy under a scene-added reference node nested in an
    // instance changes the NODE's record, which stayed fresh and was compared without the copy's link (#2037).
    markStale(world, 'duplicateInstance', storedRootsAbove(copyId).map(guidOfEntity));
    return;
  }
  addChild(copyId, world);
}

// ── Copy, on records (#2046 S7.4, D-8c; § 3.2's duplicate/paste row) ─────────────────────────────────────────────────

/** Is `held` empty: nothing the parse could not interpret, no kept node? */
function heldIsEmpty(held: object | undefined): boolean {
  return Object.values(held ?? {}).every((v) => v == null || (v instanceof Map ? v.size === 0 : typeof v === 'object' && !Object.keys(v as object).length));
}

/**
 * The records a copy of the subtree at `entityId` carries, read BEFORE the copy: every record-owning stored root at or
 * under it, fresh, by root guid. Null when a copy could not restate one exactly, and the copy keeps `afterCopy`'s stale
 * path: a MEMBER copied (#1756's link rules decide what it becomes), a root with no record, held data (a kept orphan, a
 * value the parse could not interpret), or a record not every part of which the fold uses (an R2 orphan names a guid the
 * source keeps).
 */
function copyRecordsOfImpl(entityId: number, world: World = getCurrentWorld()): Map<string, InstanceRecord> | null {
  const t = instanceTargetOf(entityId);
  if (t?.kind === 'member' && t.key !== ROOT_ROW_KEY) return null;
  const out = new Map<string, InstanceRecord>();
  for (const r of storedRootsUnder(entityId)) {
    const g = guidOfEntity(r);
    const rec = g ? recordForWrite(r, g, world) : null;
    if (!rec || !heldIsEmpty(rec.held) || foldInstance(editorPrefabReader, rec).unused.length) return null;
    out.set(g, clone(rec));
  }
  return out;
}

/**
 * Seat `records` ({@link copyRecordsOf}'s) for the copy just spawned at `copyId`, then link it where it hangs (`addChild`):
 * each record under its copy's root guid (`remap`: a source guid → the copy's, the copy plan's), its `own` links and its
 * identity pins remapped the same way, and its placement the live copy's. False, with the enclosing records marked stale as `afterCopy` marks them, when a
 * copied root is not live.
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
    const unmapped = [...src.list.rows.values()].some((row) => row.own?.some((o) => !remap.has(o.guid)) || (row.guid !== undefined && !row.removed && !remap.has(row.guid)));
    if (!to || !id || !attrs || unmapped) {
      markStale(world, 'duplicateInstance', storedRootsAbove(copyId).map(guidOfEntity));
      return false;
    }
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
    seated.push(rec);
  }
  // Every instance the copy holds is one of the seated: a node the copy plan made a root of its own has no record here.
  const seatedGuids = new Set(seated.map((r) => r.rootGuid));
  if (storedRootsUnder(copyId).some((r) => !seatedGuids.has(guidOfEntity(r)))) {
    markStale(world, 'duplicateInstance', storedRootsAbove(copyId).map(guidOfEntity));
    return false;
  }
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
  // The whole tree's records fresh first (a re-seed states every record of it), then the frame's own.
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
        if (field === 'editorFolder' && rec.placement.editorFolder !== undefined) { delete rec.placement.editorFolder; hit = true; }
      } else if (key) hit = dropField(rec, key, trait!, field!);
    }
    if (!hit) unmatched.push(k);
  }
  return { touched: [...touched], top, unmatched };
}

// ── The shield ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The door is a SHADOW at S4: it must never fail, or change, the gesture it records — the old path still saves. A
 *  throw (a parser or fold defect on some record) is reported and leaves the records stale, so the next write re-seeds
 *  them from the capture and nothing judges what this one half-wrote. A verb's returned commit is shielded the same way. */
function shielded<A extends unknown[], R>(name: string, fn: (...args: A) => R, fallback: R): (...args: A) => R {
  const report = (err: unknown): void => {
    console.error(`[instanceEdits] ${name} threw; the records are marked stale (#2001 S4: the door never fails a gesture): ${(err as Error)?.message ?? err}`);
    try { markStale(getCurrentWorld(), 'doorError'); } catch { /* the report is all that is left */ }
  };
  return (...args: A): R => {
    let out: R;
    try { out = fn(...args); } catch (err) { report(err); return fallback; }
    if (typeof out !== 'function') return out;
    const commit = out as unknown as (...b: unknown[]) => unknown;
    return ((...b: unknown[]) => { try { return commit(...b); } catch (err) { report(err); return undefined; } }) as unknown as R;
  };
}

const NOOP = (): void => {};
export const setFields = shielded('setFields', setFieldsImpl, undefined);
export const addComponent = shielded('addComponent', addComponentImpl, undefined);
export const beginRemoveComponent = shielded('beginRemoveComponent', beginRemoveComponentImpl, NOOP);
export const place = shielded('place', placeImpl, undefined);
export const addChild = shielded('addChild', addChildImpl, undefined);
export const beginAddChild = shielded('beginAddChild', beginAddChildImpl, undefined);
export const beginDelete = shielded('beginDelete', beginDeleteImpl, NOOP);
export const beginReparent = shielded('beginReparent', beginReparentImpl, NOOP);
export const prepare = shielded('prepare', prepareImpl, undefined);
export const afterCopy = shielded('afterCopy', afterCopyImpl, undefined);
export const copyRecordsOf = shielded('copyRecordsOf', copyRecordsOfImpl, null);
export const seatCopy = shielded('seatCopy', seatCopyImpl, false);
export const fieldRecordOf = shielded('fieldRecordOf', fieldRecordOfImpl, null);
export const putFieldRecord = shielded('putFieldRecord', putFieldRecordImpl, undefined);
export const rowsOf = shielded('rowsOf', rowsOfImpl, null);
export const priorRowsOf = shielded('priorRowsOf', priorRowsOfImpl, null);
export const putRows = shielded('putRows', putRowsImpl, false);
