/**
 * Re-seed an instance record from the OLD capture (#2001 S4, #2014): `parse(captureInstanceEntry(live))`.
 *
 * Transitional, and deleted with the capture in S8. A record goes stale when an op S7 has not yet moved onto records
 * changes its instance (`markStale`, `runtime/prefab/instanceStore.ts`). Before the door writes to it, the door re-seeds
 * it here, from what today's save would write, so the door's write lands on a list that matches the live tree. A
 * re-seeded record is never COMPARED with the capture it came from (§ 10.5, review L10): the I25 shadow and the drift
 * check only judge what the door wrote on top of it.
 *
 * The entry is assembled as `serialize.ts` assembles a top-level instance entry: the captured instance half, the root's
 * guid and name, and its placement parent and folder; a Missing Prefab placeholder writes its kept record
 * (`asSceneEntry`). The outermost stored root is captured, which also states every reference node the scene added under
 * it, so each of those gets its record too (`recordsOf`).
 */
import type { World } from 'koota';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { rowPlaceholderOf, unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { asSceneEntry } from '../../runtime/loaders/unresolvedPrefabRefs';
import type { SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import { recordsOf } from '../../runtime/prefab/instanceLoad';
import { getCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { SCENE_FORMAT_VERSION } from '../../runtime/core/version';
import { parseInstanceRecord } from '../../runtime/prefab/parseInstanceRecord';
import { freshInstanceRecord, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import type { InstanceRecord, PrefabDoc, PrefabReader } from '../../runtime/prefab/instanceRecord';
import { openIdentityScope, closeIdentityScope } from '../../runtime/core/ecs/identityParents';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { captureInstanceEntry } from '../scene/instanceEntry';
import { savedFrameDoc } from '../scene/prefabRebuild';
import { soaSchema } from '../../runtime/core/ecs/traitSchema';
import { getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { guidOfEntity, instanceKeyMap, outermostStoredRoot, projectionRootOf, storedRootsUnder } from './instanceKeys';

type Bag = Record<string, unknown>;

/** The editor's `PrefabReader`: the runtime cache the load reads (it holds a parked, unflushed write, #1868), then the
 *  editor's own (a prefab this session created or wrote, which the runtime cache does not hold until a load seats it). */
export const editorPrefabReader: PrefabReader = (guid) => {
  const doc = (getCachedPrefab(guid) ?? getCachedPrefabSync(guid) ?? undefined) as PrefabDoc | undefined;
  return doc ? { doc } : { missing: true };
};

/** What the old save would write for stored root `rootId`, as a scene entry; null when it cannot be stated (no root guid,
 *  or the prefab is in no cache — the save would fall back to its frame record, which a re-seed does not attempt). */
export function capturedEntryOf(rootId: number): SceneEntityEntry | null {
  const ea = getTraitByName('EntityAttributes'), pi = getTraitByName('PrefabInstance');
  const entity = findEntity(rootId);
  if (!ea || !pi || !entity) return null;
  const attrs = entity.get(ea.trait) as { guid?: string; name?: string; parentId?: number; editorFolder?: string; sortOrder?: number; isActive?: boolean };
  const guid = durableGuid(attrs.guid);
  if (!guid) return null;
  const parent = attrs.parentId ? findEntity(attrs.parentId) : null;
  const parentGuid = parent ? durableGuid((parent.get(ea.trait) as { guid?: string }).guid) : '';
  const placement: Bag = {};
  if (parentGuid) placement.parentId = parentGuid;
  if (attrs.editorFolder) placement.editorFolder = attrs.editorFolder;
  const unresolved = unresolvedRefOf(entity);
  if (unresolved) {
    const order = { sortOrder: attrs.sortOrder ?? 0, isActive: attrs.isActive ?? true };
    return { id: 0, ...asSceneEntry(unresolved.kind, unresolved.record, unresolved.source, { name: attrs.name ?? '', guid, placement, order }) } as unknown as SceneEntityEntry;
  }
  const source = (entity.get(pi.trait) as { source?: string }).source;
  const current = source ? getCachedPrefabSync(source) : null;
  if (!source || !current) return null;
  const prefab = savedFrameDoc(rootId, source, current);
  const { entry } = captureInstanceEntry(rootId, source, prefab, guid);
  return {
    id: 0, name: attrs.name ?? '', prefab: source, guid, ...entry,
    traits: Object.keys(placement).length ? { EntityAttributes: placement } : {},
  } as unknown as SceneEntityEntry;
}

/** The records the old capture implies for the instance tree at OUTERMOST stored root `topRootId` (its own, then every
 *  reference node it states), or null when it cannot be captured. Pure: writes nothing. */
export function capturedRecordsOf(topRootId: number): InstanceRecord[] | null {
  openIdentityScope();
  try {
    const entry = capturedEntryOf(topRootId);
    if (!entry) return null;
    const held = new Set<string>();
    const ea = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) { const g = (e.get(ea.trait) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
    // The entry is what today's save would write, so it is read as a file of today's format.
    const opts = { held: (g: string) => held.has(g), sceneVersion: SCENE_FORMAT_VERSION };
    return recordsOf(parseInstanceRecord(entry, editorPrefabReader, opts), editorPrefabReader, opts).map((p) => p.record);
  } finally {
    closeIdentityScope();
  }
}

/** Re-seed the records of the instance tree that holds stored root `rootId` (its outermost owner's tree) from the old
 *  capture. Returns whether it could. */
export function reseedFromCapture(rootId: number, world: World = getCurrentWorld()): boolean {
  // The outermost PROJECTABLE root (`projectionRootOf`): a Missing Prefab placeholder's capture is its kept record, which
  // does not state a reference node the scene added that still shows under it (#2018), so that node is its own top.
  const top = projectionRootOf(rootId) || outermostStoredRoot(rootId) || rootId;
  const recs = capturedRecordsOf(top);
  if (!recs) return false;
  for (const r of recs) setInstanceRecord(world, withoutUnstatedAddedFields(r, world));
  return true;
}

/** #1829 on the re-seed (#2058, hunt seeds 8231 and 8413). The old capture writes a component the base lacks WHOLE, where
 *  a file can state it partially (an agent's file-direct write, `{Rotate3D: {speed: 2}}`) and the load marks only what it
 *  states. A record re-seeded from that capture would state the rest too, so its projection marks fields the live tree
 *  does not, and S6's save would write them. Such a field is dropped when the live node does not mark it and it holds the
 *  schema default: the fold gives an unstated field of a component the base lacks exactly that, so no value moves. A
 *  component added by a gesture is stated and marked whole (`addComponent`), so it keeps every field. */
function withoutUnstatedAddedFields(rec: InstanceRecord, world: World): InstanceRecord {
  const root = findEntityByGuid(rec.rootGuid, world);
  if (!root) return rec;
  let byKey: Map<string, number> | undefined;
  for (const [key, row] of rec.list.rows) {
    for (const [t, bag] of Object.entries(row.traits ?? {})) {
      if (!bag || bag === true || typeof bag !== 'object') continue;
      const meta = getTraitByName(t);
      const schema = meta ? soaSchema(meta) : null;
      if (!schema) continue;
      byKey ??= new Map([...instanceKeyMap(root.id())].map(([id, k]) => [k, id]));
      const id = byKey.get(key);
      const live = id === undefined ? undefined : findEntity(id);
      if (!live) continue;
      // A placeholder (a row whose prefab is missing, or a reference node's) has no marks and no base the fold can state:
      // nothing there can be told apart from a statement, so it keeps every field (#2058 review: a rotation's default
      // axes were dropped there, and came back wrong once the prefab returned).
      if (unresolvedRefOf(live as never) || rowPlaceholderOf(live as never)) continue;
      const marks = getOverrideMarkSet(live as never);
      const dflt = (f: string) => (typeof schema[f] === 'function' ? (schema[f] as () => unknown)() : schema[f]);
      const unstated = Object.keys(bag).filter((f) => f in schema && !marks?.has(`${t}.${f}`) && JSON.stringify((bag as Bag)[f]) === JSON.stringify(dflt(f)));
      if (!unstated.length || baseHas(rec, key, t)) continue;
      const kept: Bag = { ...(bag as Bag) };
      for (const f of unstated) delete kept[f];
      row.traits![t] = kept;
    }
  }
  return rec;
}

/** Whether the base (every layer below this record's own row) supplies `trait` at `key`, or cannot be read there: a key the
 *  fold does not reach (a placeholder, a frame it cannot expand) answers true, so the caller keeps the field. It holds the
 *  narrowing to #1829's scope, components the base LACKS: today no capture states an unmarked field of a component the base
 *  supplies (it writes those by their marks, and a rotation marked whole), so no reachable case turns on it (#2058 review;
 *  `instanceEditsDoor.test.ts` pins that premise). */
function baseHas(rec: InstanceRecord, key: string, trait: string): boolean {
  const probe = structuredClone(rec);
  delete probe.list.rows.get(key)!.traits![trait];
  const node = foldInstance(editorPrefabReader, probe).nodes.get(key);
  return !node || node.traits[trait] !== undefined;
}

/** Every record of the instance tree at outermost root `top` fresh: the tree re-seeded from its capture when ANY of them is
 *  missing or stale, not only the top's (#2046 S7 close-out review F2). A step taking a tree's records before it writes
 *  must not take a stale nested one (a scene-added reference node's: a reparent of a member it supplies marks only its own
 *  record; a reload's bank leaves one whose fold changed) as absent — its own write then re-seeds the whole tree, and its
 *  undo dropped that record and rebuilt the node from the post-step capture. False when the tree cannot be had. */
export function treeForWrite(top: number, world: World = getCurrentWorld()): boolean {
  const topGuid = guidOfEntity(top);
  if (!topGuid) return false;
  if ([top, ...storedRootsUnder(top)].every((id) => freshInstanceRecord(world, guidOfEntity(id)))) return true;
  if (!reseedFromCapture(top, world)) return false;
  return !!freshInstanceRecord(world, topGuid);
}

/** The fresh record for stored root `rootId` (guid `rootGuid`), re-seeding it first when it is missing or stale. Null
 *  when it cannot be had: the door then writes nothing, and the shadow has nothing to judge for it. */
export function recordForWrite(rootId: number, rootGuid: string, world: World = getCurrentWorld()): InstanceRecord | null {
  const have = freshInstanceRecord(world, rootGuid);
  if (have) return have;
  if (!reseedFromCapture(rootId, world)) return null;
  return freshInstanceRecord(world, rootGuid) ?? null;
}
