/**
 * The override VIEW: which fields an instance's override list records on a live node, read from the record (#2001 S8).
 *
 * Rule 2: the list is the truth, and the live entities are its projection. So "is this field an override of this
 * instance?" is a question about the list, answered here from the record, where it used to be answered by a per-entity
 * mark store that every writer had to keep in step (`overrideMarks.ts`, deleted in S8b). Design: plan § 4 ("a 40-line
 * view"), § 3.6 (who reads the fold).
 *
 * The view is what a projection of the record states (and the root's placement as `instanceReproject.ts` `placeRoot`
 * states it); before S8b the projection also marked exactly this set (`markRecords`), so the two agreed by construction:
 * - a member's row: every field its `traits` records (a tag as `Trait.`), the field a REGISTERED component persists only
 *   (`fieldFate`; a record of an unknown field is unused, never shown as an override);
 * - rotation is one record (#1880 F5): one axis stated states the group;
 * - the stored root (`"/"`): its placement's DEFAULT overrides (§ 10.4, Unity U10b): the name, when it is not the
 *   template root's; the folder, when it states one; the sibling order always for a scene root (F7, `recordsRootOrder`)
 *   and for a row of the prefab being edited where its row states it (`orderStated`).
 *
 * `null` when the node is in no instance, or its record is missing: nothing is recorded on it.
 */
import type { Entity, World } from 'koota';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { fieldFate } from '../../runtime/loaders/overrideFate';
import { ROTATION_MARKS, recordsRootOrder } from '../../runtime/loaders/overrideMarks';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { PREFAB_EDIT_ROOT_GUID } from '../../runtime/core/prefabEditRoot';
import { getCachedPrefabSync } from '../scene/prefabCache';
import type { PrefabFile } from '../scene/prefab';
import { storedRecord } from '../../runtime/prefab/instanceStore';
import { ROOT_ROW_KEY, type RecordTraits } from '../../runtime/prefab/instanceRecord';
import { instanceTargetOf } from './instanceKeys';

/** `"Trait.field"` keys `traits` records (a tag as `"Trait."`), rotation as one group. */
export function recordedKeys(traits: RecordTraits | undefined): Set<string> {
  const out = new Set<string>();
  for (const [name, data] of Object.entries(traits ?? {})) {
    const meta = getTraitByName(name);
    if (!meta) continue;
    if (meta.category === 'tag') { if (data) out.add(`${name}.`); continue; }
    if (!data || typeof data !== 'object') continue;
    for (const field of Object.keys(data)) {
      // Identity and the live parent are never an override (`recordedOverrides`; `instanceEdits` NODE_IDENTITY_FIELDS).
      if (name === 'EntityAttributes' && (field === 'guid' || field === 'parentId')) continue;
      if (fieldFate(meta, field) !== 'applies') continue;
      const key = `${name}.${field}`;
      if ((ROTATION_MARKS as readonly string[]).includes(key)) for (const r of ROTATION_MARKS) out.add(r);
      else out.add(key);
    }
  }
  return out;
}

/** The `"Trait.field"` overrides the list records on live node `entityId` (see the header), or null. */
export function recordedFieldsOf(entityId: number, world: World = getCurrentWorld()): Set<string> | null {
  const t = instanceTargetOf(entityId);
  if (!t || t.kind !== 'member') return null;
  const rec = storedRecord(world, t.rootGuid);
  if (!rec) return null;
  const out = recordedKeys(rec.list.rows.get(t.key)?.traits);
  if (t.key !== ROOT_ROW_KEY) return out;
  if (rec.placement.name !== templateRootName(rec.source)) out.add('EntityAttributes.name');
  if (rec.placement.editorFolder) out.add('EntityAttributes.editorFolder');
  const e = findEntity(entityId);
  if (e && (recordsRootOrder(e as never) || (rec.placement.orderStated && inPrefabEdit(entityId)))) out.add('EntityAttributes.sortOrder');
  return out;
}

/** Is `entityId` under the prefab editor's root? There a stored root is a row of the document being edited, and records its
 *  order where the row states it (`Placement.orderStated`); `recordsRootOrder` is the scene's rule, and stops there. */
function inPrefabEdit(entityId: number): boolean {
  const ea = getTraitByName('EntityAttributes');
  if (!ea) return false;
  for (let id = entityId, hops = 0; id && hops < 10000; hops++) {
    const a = findEntity(id)?.get(ea.trait) as { guid?: string; parentId?: number } | undefined;
    if (!a) return false;
    if (a.guid === PREFAB_EDIT_ROOT_GUID) return true;
    id = a.parentId ?? 0;
  }
  return false;
}

/** The name document `source`'s root states, or undefined. */
export function templateRootName(source: string): string | undefined {
  const doc = getCachedPrefabSync(source) as PrefabFile | null;
  const root = doc ? rowAt(doc.entities, doc.rootLocalId ?? 1) : undefined;
  const name = (root?.traits.EntityAttributes as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/** The `"Trait.field"` keys a reader takes as live `entity`'s record (`recordedOverrides`' `markSet`): the view, or —
 *  inside a capture ({@link withCaptureKeys}) — the keys that capture took. Undefined in no instance. */
export function overrideKeysOf(entity: Entity): ReadonlySet<string> | undefined {
  return captureKeys?.get(entity.id()) ?? recordedFieldsOf(entity.id()) ?? undefined;
}

/** The keys Create Prefab's capture reads (`serializePrefab`), taken from the view once, before the create rewrites the
 *  tree: while it writes the new template, the subtree's members are keyed against that template, which their records do
 *  not name yet, so the view of them reads nothing. What the capture adds for itself ({@link addCaptureKey}: a field a
 *  layer outside the tree gives, the order a scene-added node records before it becomes a template's copy) lives in the
 *  same set and goes with it. */
let captureKeys: Map<number, Set<string>> | null = null;
export function withCaptureKeys<T>(rootId: number, fn: () => T): T {
  if (captureKeys) return fn();
  const taken = new Map<number, Set<string>>();
  for (const id of collectSubtreeIds(getAllEntities().map((e) => [e.id, e.parentId] as const), [rootId])) {
    const keys = recordedFieldsOf(id);
    if (keys) taken.set(id, new Set(keys));
  }
  captureKeys = taken;
  try { return fn(); } finally { captureKeys = null; }
}

/** Add `key` (rotation as one group) to what the running capture reads as live `entityId`'s record. No-op outside one. */
export function addCaptureKey(entityId: number, key: string): void {
  if (!captureKeys) return;
  let set = captureKeys.get(entityId);
  if (!set) { set = new Set(recordedFieldsOf(entityId) ?? []); captureKeys.set(entityId, set); }
  for (const k of (ROTATION_MARKS as readonly string[]).includes(key) ? ROTATION_MARKS : [key]) set.add(k);
}
