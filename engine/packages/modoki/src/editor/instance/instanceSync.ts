/**
 * The door's read of the records it writes (#2001 S4, S8b), and what is left of the OLD capture's reading.
 *
 * - **The write gates** (`recordForWrite`, `treeForWrite`): a step writes only on FRESH records. A missing or stale one is
 *   refused, never re-seeded: S8b deleted the re-seed from the capture (`parse(captureInstanceEntry(live))`), so every
 *   op keeps its records exact or refuses (§ 10.7), and a stale mark that is left can only be cleared by a reload.
 * - **The capture's records** (`capturedRecordsOf`): what the old save would write for a tree, parsed. Pure; asked by the
 *   shadow and the tests, never seated.
 * - **A placeholder's re-expansion** (`seatLoadedEntry`): the records a load of its entry implies.
 */
import type { World } from 'koota';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { durableGuid, isStoredRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { asSceneEntry } from '../../runtime/loaders/unresolvedPrefabRefs';
import type { SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import { holdUnspawnedOwn, recordsOf } from '../../runtime/prefab/instanceLoad';
import { getCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { CAPTURE_FORM_SCENE_VERSION } from '../../runtime/core/version';
import { parseInstanceRecord } from '../../runtime/prefab/parseInstanceRecord';
import { dropInstanceRecord, storedRecord, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import type { InstanceRecord, ParsedInstance, PrefabDoc, PrefabReader } from '../../runtime/prefab/instanceRecord';
import { openIdentityScope, closeIdentityScope } from '../../runtime/core/ecs/identityParents';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { captureInstanceEntry } from '../scene/instanceEntry';
import { savedFrameDoc } from '../scene/prefabRebuild';
import { withMissingComponents } from '../../runtime/core/ecs/missingComponents';
import { guidOfEntity, instanceKeyMap, storedRootsUnder } from './instanceKeys';
import { templateKeyOf } from '../../runtime/core/templateIdentity';

type Bag = Record<string, unknown>;

/** The editor's `PrefabReader`: the runtime cache the load reads (it holds a parked, unflushed write, #1868), then the
 *  editor's own (a prefab this session created or wrote, which the runtime cache does not hold until a load seats it). */
export const editorPrefabReader: PrefabReader = (guid) => {
  const doc = (getCachedPrefab(guid) ?? getCachedPrefabSync(guid) ?? undefined) as PrefabDoc | undefined;
  return doc ? { doc } : { missing: true };
};

/** The scene version {@link capturedEntryOf}'s entry for `rootId` reads as: a Missing Prefab placeholder's kept record
 *  is in the form of the file it was read from (`UnresolvedPrefabRef.version`); anything captured is in the capture's. */
export function captureFormVersionOf(rootId: number): number {
  return unresolvedRefOf(findEntity(rootId))?.version ?? CAPTURE_FORM_SCENE_VERSION;
}

/** What the old save would write for stored root `rootId`, as a scene entry; null when it cannot be stated (no root guid,
 *  or the prefab is in no cache — the save would fall back to its frame record, which this does not attempt). */
/** `consumed`: filled with every live entity the capture states (`captureInstanceEntry`'s), for a caller that asks. */
export function capturedEntryOf(rootId: number, consumed?: Set<number>): SceneEntityEntry | null {
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
  const { entry, consumedEcsIds } = captureInstanceEntry(rootId, source, prefab);
  if (consumed) for (const id of consumedEcsIds) consumed.add(id);
  // A component this build registers no trait for, kept for the root verbatim (#1933 N1b): the old save writes it on the
  // entry's `traits`, where the parse reads the root's extra components from. Left out, a re-seeded record lost it, and
  // the save that writes the record (S6) with it.
  const traits = withMissingComponents(Object.keys(placement).length ? { EntityAttributes: placement } : {}, guid, rootId);
  return { id: 0, name: attrs.name ?? '', prefab: source, guid, ...entry, traits } as unknown as SceneEntityEntry;
}

/** The records the old capture implies for the instance tree at OUTERMOST stored root `topRootId` (its own, then every
 *  reference node it states), or null when it cannot be captured. Pure: writes nothing. */
export function capturedRecordsOf(topRootId: number): InstanceRecord[] | null {
  return capturedPartsOf(topRootId)?.map((p) => p.record) ?? null;
}

/** {@link capturedRecordsOf}, with each record's scene-owned content as the parse read it. */
function capturedPartsOf(topRootId: number): ParsedInstance[] | null {
  openIdentityScope();
  try {
    const entry = capturedEntryOf(topRootId);
    if (!entry) return null;
    const held = new Set<string>();
    const ea = getTraitByName('EntityAttributes')!;
    for (const e of getCurrentWorld().entities) { const g = (e.get(ea.trait) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
    // The entry is in the old capture's form, so it is read as a file of that form's version.
    const opts = { held: (g: string) => held.has(g), sceneVersion: captureFormVersionOf(topRootId) };
    return recordsOf(parseInstanceRecord(entry, editorPrefabReader, opts), editorPrefabReader, opts);
  } finally {
    closeIdentityScope();
  }
}

/** Seat the records a load of scene entry `entry` implies, for the instance that load just spawned from it: a Missing
 *  Prefab placeholder's entry re-expanded when its prefab returned (#2001 S8b, `prefabReimport.ts`). They are what a reload
 *  of the scene parses (`fillInstanceStoreReporting`), read by the rules of the file the entry came from (`sceneVersion`).
 *  `was`: the placeholder's record, whose links to the user's nodes hung on it since (§ 10.4b) are carried onto the
 *  instance's, as each such node now hangs under it. */
export function seatLoadedEntry(entry: SceneEntityEntry, sceneVersion: number, was: InstanceRecord | undefined, world: World = getCurrentWorld()): void {
  openIdentityScope();
  let parts: ParsedInstance[];
  try {
    const held = new Set<string>();
    const ea = getTraitByName('EntityAttributes')!;
    for (const e of world.entities) { const g = (e.get(ea.trait) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
    const opts = { held: (g: string) => held.has(g), sceneVersion };
    parts = recordsOf(parseInstanceRecord(entry, editorPrefabReader, opts), editorPrefabReader, opts);
  } finally {
    closeIdentityScope();
  }
  const linked = new Set<string>();
  for (const p of parts) for (const row of p.record.list.rows.values()) {
    for (const l of row.own ?? []) linked.add(l.guid);
    if (row.guid !== undefined) linked.add(row.guid);
  }
  for (const { record: r } of parts) {
    if (was && r.rootGuid === was.rootGuid) keepLiveLinks(r, was, linked, world);
    setInstanceRecord(world, r);
  }
  // As the load: a reference node it did not spawn keeps its statement in its owner's row, never a record of its own.
  for (const p of parts) if (!findEntityByGuid(p.record.rootGuid, world)) dropInstanceRecord(world, p.record.rootGuid);
  for (const p of parts) holdUnspawnedOwn(world, p.record.rootGuid, parts);
}

/** The links the record `seatLoadedEntry` replaces held (`was`) on a node that still hangs, live, right under that row's
 *  node, which no record of the seated tree states (`linked`: linked, or pinned as a member), carried onto `rec` (#2001
 *  S8b). The placeholder's entry is the record it was loaded with, so it states none of the user's nodes hung on it
 *  since, and the save, which writes what the record links, then wrote them as entities of their own. A node the tree now
 *  keys is not carried: it is no longer the scene's. */
function keepLiveLinks(rec: InstanceRecord, was: InstanceRecord, linked: ReadonlySet<string>, world: World): void {
  const root = findEntityByGuid(rec.rootGuid, world)?.id();
  if (root === undefined) return;
  const keyed = instanceKeyMap(root);
  const idOfKey = new Map([...keyed].map(([id, k]) => [k, id]));
  const ea = getTraitByName('EntityAttributes')!, pi = getTraitByName('PrefabInstance');
  for (const [key, row] of was.list.rows) {
    const anchor = idOfKey.get(key);
    if (anchor === undefined) continue;
    for (const { guid } of row.own ?? []) {
      if (linked.has(guid)) continue;
      const node = findEntityByGuid(guid, world);
      // Still the scene's: not a node the instance keys or a template supplies now (an Apply promotes a node into the
      // prefab under the guid it had, #1660).
      if (!node || keyed.has(node.id()) || templateKeyOf(node as never)) continue;
      // …nor a node whose own link says a document supplies it (a member or a nested frame root, not a stored root).
      const link = pi && node.has(pi.trait) ? node.get(pi.trait) as MemberPi : undefined;
      if (link && !isStoredRoot(link, node.id()) && !unresolvedRefOf(node as never)) continue;
      if ((node.get(ea.trait) as { parentId?: number } | undefined)?.parentId !== anchor) continue;
      const to = rec.list.rows.get(key) ?? {};
      rec.list.rows.set(key, { ...to, own: [...(to.own ?? []), { guid }] });
    }
  }
}

/** Every record of the instance tree at outermost root `top` stored, not only the top's (#2046 S7 close-out review F2): a
 *  step taking a tree's records before it writes must not take a missing nested one as absent. False when any is
 *  missing: there is no re-seed from the capture any more (#2001 S8b), so the caller refuses. */
export function treeForWrite(top: number, world: World = getCurrentWorld()): boolean {
  const topGuid = guidOfEntity(top);
  if (!topGuid) return false;
  return [top, ...storedRootsUnder(top)].every((id) => storedRecord(world, guidOfEntity(id)));
}

/** The record for stored root `rootId` (guid `rootGuid`), or null when it is missing: the door then writes
 *  nothing (there is no re-seed from the capture any more, #2001 S8b). `rootId` is kept for the callers' shape. */
export function recordForWrite(_rootId: number, rootGuid: string, world: World = getCurrentWorld()): InstanceRecord | null {
  return storedRecord(world, rootGuid) ?? null;
}
