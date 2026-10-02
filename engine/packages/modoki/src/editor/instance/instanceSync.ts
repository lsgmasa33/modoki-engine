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
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
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
import { outermostStoredRoot } from './instanceKeys';

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
  const top = outermostStoredRoot(rootId) || rootId;
  const recs = capturedRecordsOf(top);
  if (!recs) return false;
  for (const r of recs) setInstanceRecord(world, r);
  return true;
}

/** The fresh record for stored root `rootId` (guid `rootGuid`), re-seeding it first when it is missing or stale. Null
 *  when it cannot be had: the door then writes nothing, and the shadow has nothing to judge for it. */
export function recordForWrite(rootId: number, rootGuid: string, world: World = getCurrentWorld()): InstanceRecord | null {
  const have = freshInstanceRecord(world, rootGuid);
  if (have) return have;
  if (!reseedFromCapture(rootId, world)) return null;
  return freshInstanceRecord(world, rootGuid) ?? null;
}
