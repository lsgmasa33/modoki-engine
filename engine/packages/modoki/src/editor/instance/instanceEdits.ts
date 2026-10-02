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
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { soaSchema } from '../../runtime/core/ecs/traitSchema';
import { ROTATION_MARKS } from '../../runtime/loaders/overrideMarks';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { dropInstanceRecord, freshInstanceRecord, markStale, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import { ROOT_ROW_KEY, type InstanceRecord, type RowKey, type SceneTargetRecord } from '../../runtime/prefab/instanceRecord';
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
function placeImpl(rootId: number, world: World = getCurrentWorld()): void {
  const ea = getTraitByName('EntityAttributes'), pi = getTraitByName('PrefabInstance');
  const e = findEntity(rootId);
  if (!ea || !pi || !e || !e.has(pi.trait)) return;
  const attrs = e.get(ea.trait) as { guid?: string; name?: string; sortOrder?: number; editorFolder?: string; parentId?: number };
  const source = (e.get(pi.trait) as { source?: string }).source ?? '';
  if (!attrs.guid || !source) return;
  setInstanceRecord(world, {
    rootGuid: attrs.guid, source,
    placement: { parent: placementParent(rootId), sortOrder: attrs.sortOrder ?? 0, name: attrs.name ?? '', ...(attrs.editorFolder ? { editorFolder: attrs.editorFolder } : {}) },
    list: { rows: new Map() }, held: {},
  });
  addChild(rootId);
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
    | { kind: 'member'; rec: InstanceRecord; key: RowKey; underKeys: Set<RowKey>; nested: string[] }
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
      items.push({ kind: 'member', rec, key: t.key, underKeys: keyedSubtree(t.rootId, id), nested });
      continue;
    }
    // An instance's own root, a scene-owned node, or a plain entity: unlink from the instance it hangs in, if any.
    const at = linkAt(parentOf(id));
    items.push({ kind: 'unlink', at, rec: at ? recordForWrite(at.rootId, at.rootGuid, world) : null, guid: guidOfEntity(id), nested });
  }
  return () => {
    for (const item of items) {
      if (item.kind === 'member') {
        const { rec, key, underKeys } = item;
        const under = (k: RowKey) => underKeys.has(k) || [...underKeys].some((u) => k.startsWith(`${u}/`));
        rowOf(rec, key).removed = true;
        for (const k of [...rec.list.rows.keys()]) if (under(k) && rec.list.rows.get(k)!.own) { delete rec.list.rows.get(k)!.own; tidy(rec, k); }
      } else if (item.at && item.rec && item.guid) unlink(item.rec, item.at.key, item.guid);
      for (const g of item.nested) dropInstanceRecord(world, g);
    }
  };
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
  const oldRec = oldAt ? recordForWrite(oldAt.rootId, oldAt.rootGuid, world) : null;
  const guid = guidOfEntity(entityId);
  const roots = storedRootsUnder(entityId);
  for (const r of roots) recordForWrite(r, guidOfEntity(r), world);
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
export const fieldRecordOf = shielded('fieldRecordOf', fieldRecordOfImpl, null);
export const putFieldRecord = shielded('putFieldRecord', putFieldRecordImpl, undefined);
