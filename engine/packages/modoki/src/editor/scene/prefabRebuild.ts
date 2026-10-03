/** Rebuild, refresh and rebase: re-expanding an instance from its template while carrying its overrides and nested
 *  frames across, refreshing every instance of a changed prefab, and rebasing stale frames.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandsToRoot } from '../../runtime/loaders/prefabRoot';
import { frameRepeatRefusal } from '../../runtime/loaders/frameRepeat';
import { rootReferenceRefusal } from '../../runtime/loaders/variantForm';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { relinkDetachedMembers } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, frameRootDoc, noteFrameRootDoc } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { beginWorldBoundOperation, breakUndoCoalescing } from '../undo/undoManager';
import { ensureGuid } from '../undo/entityRef';
import {
  getAllEntities, deleteEntities, readTraitData, writeTraitField, findEntity, markStructureDirty,
} from '../../runtime/core/ecs/entityUtils';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { rowPlaceholderOf, unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';
import { newGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { durableGuid, remapGuidValues, isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { sameDocumentContent } from '../../runtime/core/localIdCounter';
import { templateKeyOf, setTemplateKey } from '../../runtime/core/templateIdentity';
import type { AddedEntity, ExpansionReader, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import {
  keptMemberOrphans, mapNodeChannels, nodeChannels, instantiatePrefabIntoWorld, settleEntryRows, entryRowsOf, keepingFrames,
} from '../../runtime/loaders/loadSceneFile';
import { liveFrameAddresser } from '../../runtime/loaders/frameAddress';
import { translateLocalIds, translateCarried } from '../../runtime/loaders/memberTranslation';
import { rowAt } from '../../runtime/loaders/prefabOverrides';
import { levelDoc } from './prefabBase';
import { collectTree, localToEcsGuid, type PrefabFile } from './prefab';
import {
  getCachedPrefabSync, prefabCache, preloadNestedPrefabs, preloadNestedPrefabsForSubtree, recoverTemplateKey,
  setPrefabSource,
} from './prefabCache';
import { keepsTemplateRows } from './prefabCapture';
import { subtractFieldOverrides } from './prefabChain';
import {
  collectInstanceRoots, isLiveInstanceRoot, type KeptFrame, rebuildTeardown, type StaleFrame, staleFrames, remapFrameAddress,
} from './prefabFrames';
import { captureInstanceEntry, type InstanceEntry } from './instanceEntry';
import type { FrameEdit } from './prefabCapture';
import { freshInstanceRecord, markStale } from '../../runtime/prefab/instanceStore';
import { reprojectFromStore, reprojectsExactly } from '../instance/instanceReproject';
import { guidOfEntity, outermostStoredRoot, projectionRootOf, storedRootsUnder } from '../instance/instanceKeys';

/** `rows` with every scene node in them carrying the template key of the live entity it is — marker, else recovered,
 *  else minted once here — so `templateRowOf` can write it after that entity is gone. The guid stays: the settle's live
 *  replay respawns the node by it. */
function keySceneNodes(rows: Record<string, SceneMemberRow>): Record<string, SceneMemberRow> {
  const keyed = (nodes: AddedEntity[] | undefined): AddedEntity[] | undefined => nodes?.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    const key = n.key || (live ? templateKeyOf(findEntity(live)) || recoverTemplateKey(live) : '') || newGuid();
    const out: AddedEntity = { ...n, key, children: keyed(n.children) ?? [] };
    if (n.added) out.added = keyed(n.added);
    if (n.members) out.members = keySceneNodes(n.members);
    return out;
  });
  return Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, {
    ...r, ...(r.own ? { own: keyed(r.own) } : {}), ...(r.added ? { added: keyed(r.added) } : {}),
  }]));
}

/** The document a SAVE measures the top-level instance `rootId` (of `source`) against (#1685, I3): the one it was
 *  EXPANDED from — its frame record — never a cache that has moved on. Measured against a newer template, every row the
 *  instance was never built with read as REMOVED by the scene, and the save deleted the template's new members for good.
 *  The save cannot refuse or rebase (the world is what it is), so it captures right.
 *
 *  Nothing it writes needs translating onto `current`: every member edit goes on a member ROW, keyed by `nodeGuid`
 *  (the save's guid pass gives each member a durable guid first), and what stays in the localId channels is the root's
 *  own edits (the root's localId never renumbers) and a pre-v5 member's (no `nodeGuid`, so no translation could move it
 *  either — `translateLocalIds` keeps its number). */
export function savedFrameDoc(rootId: number, source: string, current: PrefabFile): PrefabFile {
  return levelDoc(rootId, source).doc ?? current;
}

/** The template key marker of every entity in `ids` that carries one, by durable guid (old → new through `remap`). A key
 *  is identity, the same kind as the guid and `Transient`, and a rebuild's scene-form capture carries the guid alone
 *  (#1567). The marker only: a node that reached a rebuild without one lost it earlier, and the loader's heal and
 *  every other carrier (#1426, #1427, #1430) stamp it back where it can be recovered at all. */
function templateKeysByGuid(ids: Iterable<number>, remap: ReadonlyMap<string, string>): Map<string, string> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Map<string, string>();
  if (!eaMeta) return out;
  for (const id of ids) {
    const key = templateKeyOf(findEntity(id));
    const guid = key ? durableGuid((readTraitData(id, eaMeta) as { guid?: string } | null)?.guid) : '';
    if (guid) out.set(remap.get(guid) ?? guid, key);
  }
  return out;
}

/** Put each key {@link templateKeysByGuid} read back on the live entity now holding that guid, where the respawn left it
 *  unmarked. Only fills a missing marker: a node the NEW template spawned carries its own. */
function restoreTemplateKeys(keys: ReadonlyMap<string, string>): void {
  for (const [guid, key] of keys) {
    const entity = findEntityByGuid(guid);
    if (entity && !templateKeyOf(entity)) setTemplateKey(entity, key);
  }
}

/** Carry out a rebuild's teardown (`rebuildTeardown`'s answer): what it parks and keeps is lifted to the scene root, the
 *  rest is deleted, and what the delete's frame ending detaches INSIDE a kept frame is put straight back (close-out
 *  review): a kept root that was ever moved carries an `ownerGuid` link naming the root torn down here, so
 *  `promoteOwnedRoots` promoted it to a stored root (its row link cleared, its members renamed) and `seatKeptFrames` then
 *  found no owner and dropped it. The one bare relink in the editor (`relinkPutsMarksBack.test.ts`): straight after its
 *  own delete, in the same world and call, so nothing between the frame ending and the relink can drop their marks. */
function destroyTornDown({ toDestroy, parked, kept }: Pick<ReturnType<typeof rebuildTeardown>, 'toDestroy' | 'parked' | 'kept'>): void {
  // The ids freed here are handed straight back to the respawn (koota recycles the last freed first), and the undo
  // coalescing chain is keyed by raw id: an edit on whatever takes id X next would merge into the entry of the edit on
  // the old X. A Revert or an Apply pushes an entry of its own and ends the chain; a rebuild that pushes none (an outside
  // prefab change re-imported in place, #1873 R1 / #1879) did not (#1880 F6, hub rider (1)(c)).
  breakUndoCoalescing();
  const eaMeta = getTraitByName('EntityAttributes');
  // Parked at the scene root while the teardown runs. Not a frame kept OUTSIDE the torn-down tree: nothing above it goes.
  for (const p of [...parked, ...kept.filter((k) => !k.outside)]) if (eaMeta) writeTraitField(p.id, eaMeta, 'parentId', 0);
  const keptSubtree = new Set(kept.length ? collectSubtreeIds(getAllEntities().map((e) => [e.id, e.parentId] as const), kept.map((k) => k.id)) : []);
  const keptGuids = new Set(getAllEntities().filter((e) => keptSubtree.has(e.id) && e.guid).map((e) => e.guid!));
  const detached = deleteEntities([...toDestroy]);
  if (kept.length) relinkDetachedMembers(detached.filter((d) => keptGuids.has(d.guid)));
}

/** Put back the nested frames {@link rebuildTeardown} KEPT because their prefab could not be expanded (#1862), once the
 *  respawn has restored every member guid: each under the parent it hung from, by guid. The respawn recorded its row as
 *  unexpanded (#1790 ruling D) and spawned nothing there, so the kept frame IS that row's expansion now, and the row comes
 *  off the owner's `unexpanded` list — the frame record says what is live, and a save captures the kept frame from its own
 *  record (I18), as it did before the rebuild. A frame whose row the new document no longer leaves unexpanded — the row is
 *  gone (the template dropped it, a layer removed it) or was expanded after all — goes, as the teardown would have taken it:
 *  keeping it would stand it beside its replacement or outside every row. */
function seatKeptFrames(kept: readonly KeptFrame[], newRootId: number, unnamed: ReadonlySet<number>): void {
  if (!kept.length) return;
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta || !piMeta) return;
  const world = getCurrentWorld();
  const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.id]));
  const drop: number[] = [...unnamed];
  for (const k of kept) {
    if (unnamed.has(k.id)) continue;
    if (k.outside) continue; // hangs outside the entry's tree (#1437): where it is
    // A scene-added node whose anchor the new template dropped hangs from the root, as its respawn would have (the structure
    // re-anchors such a node to the root with a warning, `applyStructureCore`).
    const to = live.get(k.parentGuid) ?? (k.owned ? undefined : newRootId);
    if (to) writeTraitField(k.id, eaMeta, 'parentId', to);
    else drop.push(k.id);
  }
  // After every re-seat: ownership is read off where a root hangs.
  const identity = worldIdentityParents(world);
  for (const k of kept) {
    if (drop.includes(k.id) || !k.owned) continue;
    const pi = readTraitData(k.id, piMeta) as { parentLocalId?: number; parentNodeGuid?: string; source?: string } | null;
    const owner = identity.ownerOf(k.id);
    const ownerEntity = owner ? findEntity(owner) : undefined;
    const rec = ownerEntity ? frameRootDoc(world, ownerEntity) : undefined;
    // By the row's identity when the frame carries one: the respawned document can number its rows differently from the
    // one the frame was built in, and falling back to the old NUMBER there claimed another unexpanded row (close-out
    // review). The number only for a frame with no identity (pre-v5). Either way the row must expand this frame's prefab.
    const rows = (rec?.doc as PrefabFile | undefined)?.entities ?? [];
    const row = pi?.parentNodeGuid ? rows.find((r) => r.nodeGuid === pi.parentNodeGuid) : rowAt(rows, pi?.parentLocalId);
    // Resolved paths compared only when there IS one: a kept frame's prefab is missing, so in the dev editor its guid was
    // pruned, and two unresolvable refs read as `undefined === undefined` (close-out review 2).
    const at = pi?.source ? resolveRef(pi.source) : undefined;
    const lid = row && row.prefab && (row.prefab === pi?.source || (at !== undefined && resolveRef(row.prefab) === at)) ? row.localId : 0;
    if (!rec || !lid || !rec.unexpanded?.includes(lid)) { drop.push(k.id); continue; }
    // The respawn shows that row as its Missing Prefab placeholder (#2001 S5, ruling D), on the row's guid: the kept frame
    // takes its place, as it took the empty row's before. Found in the OWNER's tree, where the row hangs: a frame a legacy
    // move took out of it (#1437) hangs elsewhere, and its placeholder is still at the row (#1880 F7d review 4).
    const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId] as const));
    const inOwner = (id: number): boolean => {
      for (let p = parentOf.get(id), hops = 0; p && hops < 10000; p = parentOf.get(p), hops++) if (p === owner) return true;
      return false;
    };
    for (const e of getAllEntities()) {
      if (e.id === k.id) continue;
      const ph = rowPlaceholderOf(findEntity(e.id) as never);
      if (ph && (row!.nodeGuid ? ph.nodeGuid === row!.nodeGuid : ph.localId === lid) && inOwner(e.id)) drop.push(e.id);
    }
    noteFrameRootDoc(world, ownerEntity!, { ...rec, unexpanded: rec.unexpanded.filter((n) => n !== lid) });
    if (pi?.parentLocalId !== lid) writeTraitField(k.id, piMeta, 'parentLocalId', lid);
  }
  if (drop.length) deleteEntities(drop);
}

/** Whether stored root `rootId` is a scene ENTRY of its own — the rebuild unit (#1880 F6-U, hub ruling (i)): a stored
 *  root no instance encloses, which the save writes as its own entry (`serializeScene`'s `prefabRootInfo`, less what an
 *  enclosing capture consumes). Not an owned nested root, not a stored root under any instance's node, not a
 *  missing-prefab placeholder. In the prefab-edit world an entry is a ROW of the edited prefab (`buildPrefabEditScene`):
 *  a nested row's root, whose ancestors are the plain entities the edited prefab's own rows spawn as (F6f). */
export function isOutermostEntry(rootId: number): boolean {
  const piMeta = getTraitByName('PrefabInstance');
  const pi = piMeta ? readTraitData(rootId, piMeta) as { rootInstanceId?: number } | null : null;
  if (!pi || pi.rootInstanceId !== rootId) return false;
  if (unresolvedRefOf(findEntity(rootId))) return false;
  if (worldIdentityParents(getCurrentWorld()).frameOf(rootId)) return false;
  const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId] as const));
  for (let p = parentOf.get(rootId) ?? 0, hops = 0; p && hops < 10_000; p = parentOf.get(p) ?? 0, hops++) {
    if (readTraitData(p, piMeta!)) return false;
  }
  return true;
}

/** The scene entry frame `frameRoot` rebuilds through (#1880 F6-U, hub ruling (i)): itself when it is one
 *  ({@link isOutermostEntry}), else the entry enclosing it — an owned root climbs to its owner (identity, #1437), a stored
 *  root inside an instance to the frame of the member it hangs under. 0 when none is found (a damaged tree). */
export function outermostEntryOf(frameRoot: number): number {
  return entryPathOf(frameRoot).at(-1) ?? 0;
}

/** The frames from `frameRoot` up to the entry it rebuilds through ({@link outermostEntryOf}), both included — each the
 *  frame the one before it hangs in. Empty when no entry is found (a damaged tree). */
function entryPathOf(frameRoot: number): number[] {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return [];
  const identity = worldIdentityParents(getCurrentWorld());
  const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId] as const));
  const path: number[] = [];
  let cur = frameRoot;
  for (let hops = 0; cur && hops < 10_000; hops++) {
    path.push(cur);
    if (isOutermostEntry(cur)) return path;
    if (identity.frameOf(cur)) { cur = identity.ownerOf(cur); continue; }
    let frame = 0;
    for (let p = parentOf.get(cur) ?? 0, h = 0; p && h < 10_000; p = parentOf.get(p) ?? 0, h++) {
      const pi = readTraitData(p, piMeta) as { rootInstanceId?: number } | null;
      if (pi) { frame = pi.rootInstanceId || 0; break; }
    }
    cur = frame;
  }
  return [];
}

/** The prefab of the first frame — `frameRoot` itself, or one enclosing it — that a rebuild through its entry would KEEP
 *  live rather than re-expand (`rebuildTeardown`'s `unexpandable`: its prefab trashed, with no one record in the entry to expand it from,
 *  {@link withFrameRecords}), or '' when there is none. A frame inside one is left as it was by that rebuild, so a
 *  gesture that rebuilds it to change it (a Revert) would change nothing — it is refused instead (#1880 F7d close-out
 *  review 1). The entry's own root is not asked: an entry with no document is `captureEntrySide`'s null. */
export function keptEnclosingSource(frameRoot: number): string {
  const path = entryPathOf(frameRoot);
  const piMeta = getTraitByName('PrefabInstance');
  if (path.length < 2 || !piMeta) return '';
  const read = withFrameRecords(getCachedPrefabSync as ExpansionReader, path.at(-1)!) as typeof getCachedPrefabSync;
  // The frame itself too: its own prefab trashed after a gesture, the gesture's undo would leave it as it is (close-out
  // re-review 2).
  for (const f of path.slice(0, -1)) {
    const source = (readTraitData(f, piMeta)?.source as string) || '';
    const doc = source ? read(source) : undefined;
    if (!doc || !expandsToRoot(doc, read)) return source;
  }
  return '';
}

/** The document scene entry `outer` (of `source`) is loaded from: the editor's copy of its prefab, or — the prefab gone
 *  (a trash) with the frame kept live (#1862, #1738) — the document it was built from, its own record. What the entry
 *  holds needs no document here: a frame inside it whose prefab cannot be read is KEPT by the teardown, as the old
 *  per-frame rebuild kept it (`rebuildTeardown`'s `unexpandable`), so every prefab the load does not find is one no
 *  rebuild could have expanded (every caller warms the entry first, {@link preloadRebuildEntry}). */
function entryDocOf(outer: number, source: string): PrefabFile | undefined {
  const cached = getCachedPrefabSync(source);
  if (cached) return cached;
  const handle = findEntity(outer);
  const rec = handle ? frameRootDoc(getCurrentWorld(), handle) : undefined;
  return rec && rec.source === source ? rec.doc as PrefabFile : undefined;
}

/** `base`, and — for a prefab it cannot read (a trash, #1862) — the document the live frames of that prefab inside entry
 *  `outer` were built from, their own record (#1880 F7d). What {@link entryDocOf} is for an entry's root, for the frames
 *  inside: a frame of a trashed prefab is re-expanded from its record, as a reload with the prefab restored expands it,
 *  so a stale frame INSIDE it is rebuilt too — kept whole (`rebuildTeardown`'s `unexpandable`), the stale frame was
 *  never re-expanded (hunt seed 1042: a Q frame under a trashed P frame inside O kept Q's old values, and was counted).
 *
 *  Only where it changes nothing else the load would expand: every live record of that prefab in the entry states the
 *  same document (two that differ leave no one document), and the entry holds no row of it the world has UNEXPANDED and
 *  no placeholder of it — the load would expand those too, where a no-op rebuild must leave them as they are (ruling R,
 *  #1849; the fuzz's respawn identity) — nor any row of it that no live frame of it expands: a row a refreshed document
 *  ADDS, at any depth, which a reload with the prefab trashed leaves unexpanded (ruling D, #1790; close-out review 3).
 *  Otherwise its frames stay kept, as before. The entry is its live subtree: a frame moved out of it (#1437) lends no
 *  record. */
type RowRef = { localId?: number; nodeGuid?: string; prefab?: string };
type TemplateRows = { entities?: readonly RowRef[] };

export function withFrameRecords(base: ExpansionReader, outer: number): ExpansionReader {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return base;
  const world = getCurrentWorld();
  const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
  const records = new Map<string, PrefabFile | null>();
  const blocked = new Set<string>();
  const block = (ref: string | undefined) => { if (ref) { blocked.add(ref); const at = resolveRef(ref); if (at) blocked.add(at); } };
  for (const id of collectSubtreeIds(links, [outer])) {
    const handle = findEntity(id);
    // A missing nested row's placeholder too (#2001 S5, ruling D): no document stands behind it.
    const placeholder = unresolvedRefOf(handle) ?? rowPlaceholderOf(handle as never);
    if (placeholder) { block(placeholder.source); continue; }
    const pi = readTraitData(id, piMeta) as { source?: string; rootInstanceId?: number } | null;
    if (!pi?.source || pi.rootInstanceId !== id || !handle) continue;
    const rec = frameRootDoc(world, handle);
    if (!rec || rec.source !== pi.source) continue;
    const doc = rec.doc as PrefabFile;
    for (const lid of rec.unexpanded ?? []) block(rowAt(doc.entities ?? [], lid)?.prefab);
    if (base(pi.source)) continue;
    const had = records.get(pi.source);
    if (had === undefined) records.set(pi.source, doc);
    else if (had && had !== doc && !sameDocumentContent(had, doc)) records.set(pi.source, null);
  }
  if (records.size) {
    // Every row a trashed prefab's record would expand must be one a live frame of it expands now: the documents the load
    // reads (`base`, or the record) name each row, and a live owned root names the row of its owner it expands.
    const identity = worldIdentityParents(world);
    const inside = collectSubtreeIds(links, [outer]);
    const backed = new Set<string>();
    const frames: [number, string, TemplateRows | undefined][] = [];
    for (const id of inside) {
      const pi = readTraitData(id, piMeta) as (MemberPi & { source?: string; parentNodeGuid?: string; parentLocalId?: number }) | null;
      if (!pi?.source || pi.rootInstanceId !== id) continue;
      const handle = findEntity(id);
      const rec = handle ? frameRootDoc(world, handle) : undefined;
      frames.push([id, pi.source, rec && rec.source === pi.source ? rec.doc as TemplateRows : undefined]);
      if (!isOwnedRoot(pi, id)) continue;
      const owner = identity.ownerOf(id);
      if (pi.parentNodeGuid) backed.add(`${owner}|${pi.parentNodeGuid}`);
      if (pi.parentLocalId) backed.add(`${owner}|#${pi.parentLocalId}`);
    }
    const readAny = (ref: string) => base(ref) ?? records.get(ref) ?? undefined;
    // A row is matched by its identity, and by its number only where it has none (pre-v5): a renumbered document can put
    // a NEW row on the number an old one had (close-out re-review 3).
    const sameRow = (r: RowRef, other: RowRef) => (r.nodeGuid ? r.nodeGuid === other.nodeGuid : !other.nodeGuid && r.localId === other.localId);
    const unbacked = (doc: ReturnType<ExpansionReader>, owner: number, built: TemplateRows | undefined, depth: number): void => {
      if (!doc || depth > 32) return;
      for (const r of (doc.entities ?? []) as RowRef[]) {
        if (!r.prefab) continue;
        if (owner && (r.nodeGuid ? backed.has(`${owner}|${r.nodeGuid}`) : backed.has(`${owner}|#${r.localId ?? 0}`))) continue;
        // A row the frame was BUILT with is not new: the instance removed it, or holds it unexpanded (blocked above), or
        // moved its frame out of the entry — the load expands it as the frame had it (close-out re-review 4).
        if ((built?.entities ?? []).some((b) => sameRow(r, b))) continue;
        block(r.prefab);
        unbacked(readAny(r.prefab), 0, undefined, depth + 1);
      }
    };
    for (const [id, source, built] of frames) unbacked(readAny(source), id, built, 0);
  }
  for (const ref of [...records.keys()]) if (blocked.has(ref) || blocked.has(resolveRef(ref) ?? '')) records.delete(ref);
  return records.size ? (ref) => base(ref) ?? records.get(ref) ?? undefined : base;
}

/** Warm every prefab a rebuild of `frameRoot` reads (#1880 F7a). The rebuild is the load of its outermost scene entry
 *  ({@link outermostEntryOf}), which expands every frame in that entry — not only the frames inside `frameRoot` — so the
 *  warm is the entry's live tree, and the frame's own where it hangs outside it (an owned frame moved out, #1437). Awaited
 *  by every caller before its synchronous rebuild. */
export async function preloadRebuildEntry(frameRoot: number): Promise<void> {
  const outer = outermostEntryOf(frameRoot);
  if (outer && outer !== frameRoot) await preloadNestedPrefabsForSubtree(outer);
  await preloadNestedPrefabsForSubtree(frameRoot);
}

/** Entry `outer` (of `source`, guid `outerGuid`) as a rebuild loads it: the save's own statement ({@link captureInstanceEntry})
 *  with `edit` made in it and every reference node against its own record (`againstRecords`). In the prefab-edit world
 *  the entry is a ROW, and the rows the load keeps for it (R2) go back into the TEMPLATE through the edit save's row
 *  writer (`captureRowChannels` → `templateRowOf`), which states a node by its template KEY: so each scene node in its
 *  member rows carries the key of the live entity it is, read now, while it is live (`keySceneNodes`; #1541/#1542, #1567)
 *  — gated as that writer gates the re-emit (`keepsTemplateRows`). The rest stays in the rows form: a payload's refs are
 *  live guids, which the load resolves as it did at the open (`editWorldRefs` turned the file's tokens into them). */
function captureRebuildEntry(
  outer: number, source: string, from: PrefabFile, outerGuid: string,
  edit: { frames?: ReadonlyMap<number, FrameEdit>; dropParents?: ReadonlySet<number> } = {},
): InstanceEntry {
  const { entry } = captureInstanceEntry(outer, source, from, outerGuid, { ...edit, againstRecords: true });
  return keepsTemplateRows(outer, outerGuid) ? keyEntryRows(entry) : entry;
}

/** `entry` as the rebuild of `outer` (guid `outerGuid`) loads it in the prefab-edit world: its nodes carry the template
 *  keys their live entities are marked with ({@link keyEntryRows}), where the edit save keeps template rows; else as it
 *  is. For a reprojection from the store (#2046 S7), whose scene-owned content is read off the capture. */
export function keyedForRebuild<E extends InstanceEntry>(outer: number, outerGuid: string, entry: E): E {
  return keepsTemplateRows(outer, outerGuid) ? keyEntryRows(entry) as E : entry;
}

/** `entry` with every member-row set in it keyed ({@link keySceneNodes}): its own, and each reference node's, at any depth
 *  (a template reference node inside a row keeps its orphan rows under its own root, `keepTemplateNodeOrphans`). And every
 *  other node in it carries the template key its live entity is marked with (#1880 F7d): a node the rebuild respawns
 *  that was NOT in its teardown — one a Revert took out, put back by its undo from the side captured before — has no
 *  marker to carry over (`templateKeysByGuid`), so the next template save minted it a new key. The old per-frame rebuild
 *  carried these in `structure.templateKeys`. Only a marker the node already has: nothing is minted here. */
function keyEntryRows(entry: InstanceEntry): InstanceEntry {
  const liveKey = (n: AddedEntity): string => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    return live ? templateKeyOf(findEntity(live)) || recoverTemplateKey(live) : '';
  };
  const walk = (list: AddedEntity[]): AddedEntity[] => list.map((n) => {
    const { members, ...rest } = n;
    const out = mapNodeChannels(rest as AddedEntity, walk);
    const key = out.key || liveKey(n);
    const keyed = key && key !== out.key ? { ...out, key } : out;
    return members ? { ...keyed, members: keySceneNodes(members) } : keyed;
  });
  const asNode = mapNodeChannels({ added: entry.added, nestedStructure: entry.nestedStructure } as AddedEntity, walk);
  return {
    ...entry,
    ...(entry.added ? { added: asNode.added } : {}),
    ...(entry.nestedStructure ? { nestedStructure: asNode.nestedStructure } : {}),
    ...(entry.members ? { members: keySceneNodes(entry.members) } : {}),
  };
}

/** One frame a rebuild is asked for, and what the caller edits of its statement ({@link FrameEdit}). */
interface RebuildTarget { root: number; edit?: FrameEdit }

/** Rebuild the scene entry around each of `targets` ONCE, by loading its entry with the targets' edits in it (#1880 F6-U):
 *  every frame inside is re-expanded from the editor's current documents, as a reload does, so a frame another
 *  target in the same entry names is rebuilt by the same load. Returns the targets it covered (by their id at the call),
 *  less any it left inside a frame it kept live or skipped for a document that expands to no root (`said`: each warned
 *  about here, so a caller does not warn about them again),
 *  and the new id each root has after (by guid; 0 when it has none to be found by). */
function rebuildTargetsByEntry(
  targets: readonly RebuildTarget[], remap: ReadonlyMap<string, string> = new Map(), dropParents?: ReadonlySet<number>,
  /** A refresh of `source` from `from` to `to`: every frame of that source in the entry is expanded from `to` (#1880
   *  F7d), and an outer entry of it is captured against `from` where it has no record of its own — the documents
   *  `refreshInstances` was handed, not the cache's. */
  refresh?: { source: string; from: PrefabFile; to: PrefabFile },
  /** Edits to frames that are not targets but lie inside a target's entry, by frame root id: made in that entry's load
   *  when it runs (an Apply into an ENCLOSING prefab takes the fields out of the nested frame they came from, #1914). */
  frameEdits: ReadonlyMap<number, FrameEdit> = new Map(),
): Map<number, number> & { said: number } {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const done = new Map<number, number>();
  if (!piMeta || !eaMeta) return Object.assign(done, { said: 0 });
  let said = 0;
  const keptLive = new Set<number>();
  const groups = new Map<number, RebuildTarget[]>();
  for (const t of targets) {
    const outer = outermostEntryOf(t.root);
    if (!outer) continue;
    const list = groups.get(outer);
    if (list) list.push(t); else groups.set(outer, [t]);
  }
  const world = getCurrentWorld();
  const guidOfId = (id: number) => durableGuid((readTraitData(id, eaMeta) as { guid?: string } | null)?.guid);
  const base: ExpansionReader = refresh
    ? (ref) => (ref === refresh.source ? refresh.to : getCachedPrefabSync(ref))
    : getCachedPrefabSync as ExpansionReader;
  for (const [outer, group] of groups) {
    const source = (readTraitData(outer, piMeta)?.source as string) || '';
    const handle = findEntity(outer);
    const rec = handle ? frameRootDoc(world, handle) : undefined;
    const refreshed = refresh?.source === source ? refresh : undefined;
    const now = refreshed?.to ?? entryDocOf(outer, source);
    const read = withFrameRecords(base, outer);
    const baseline = rec && rec.source === source ? rec.doc as PrefabFile : refreshed?.from ?? now;
    if (!now || !baseline) continue;
    // Not counted as rebuilt: `rebuildFromEntry` would leave the entry standing, and say so.
    if (!expandsToRoot(now, read as typeof getCachedPrefabSync) || frameRepeatRefusal(now, (g) => read(g) ?? null)) {
      console.warn(`[Prefab] rebuild of ${source} skipped: the prefab expands to no root, or gives one key two nodes (#1933 L5)`);
      said += group.length;
      continue;
    }
    const guids = new Map(group.map((t) => [t.root, guidOfId(t.root)] as const));
    const frames = new Map(group.filter((t) => t.edit).map((t) => [t.root, t.edit!] as const));
    for (const [frame, e] of frameEdits) if (!frames.has(frame) && outermostEntryOf(frame) === outer) frames.set(frame, e);
    const entry = captureRebuildEntry(outer, source, baseline, guidOfId(outer), { frames, dropParents });
    const newOuter = rebuildFromEntry(outer, source, now, entry, remap, baseline, read, keptLive);
    for (const t of group) {
      // Inside a frame the load could not expand and kept live: left as it was, so not rebuilt.
      if (t.root !== outer && keptLive.has(t.root)) continue;
      const g = guids.get(t.root)!;
      done.set(t.root, t.root === outer ? newOuter : (g ? findEntityByGuid(remap.get(g) ?? g)?.id() ?? 0 : 0));
    }
  }
  const inKept = targets.filter((t) => keptLive.has(t.root) && !done.has(t.root)).length;
  if (inKept) {
    console.warn(`[Prefab] ${inKept} instance frame(s) left as they were: each lies inside a frame whose prefab could not be expanded (trashed, with no one document its live frames agree on), which the rebuild keeps live (#1862) — restore that prefab, or reload the scene`);
  }
  return Object.assign(done, { said: said + inKept });
}

/** A frame's statement as a rebuild through its outermost entry keeps it (#1880 F6-U), for a step that rebuilds it again
 *  later — a Revert and its undo, an Apply's undo sides: the entry's root by durable guid (ids do not survive the
 *  rebuilds in between), its source, the document the entry was captured against, and the entry. */
export interface EntrySide { outerGuid: string; source: string; from: PrefabFile; entry: InstanceEntry }

/** The entry `frameRoot` rebuilds through ({@link outermostEntryOf}), stated as the save states it with `edit` made in it —
 *  every reference node against its own record ({@link captureRebuildEntry}). null where the frame has no such entry, or
 *  no document to state it against (its own record, else the editor's copy): nothing can rebuild it then.
 *
 *  The entry's root is found again by durable guid, so one that has none (never saved, or on a runtime guid, #1210) is
 *  given one here, as `ensureGuid` gives any entity an undo step names (#1880 F7c) — the rebuild carries it over, and
 *  the next save writes it. */
export function captureEntrySide(
  frameRoot: number, edit: { frames?: ReadonlyMap<number, FrameEdit>; dropParents?: ReadonlySet<number> } = {},
): EntrySide | null {
  const outer = outermostEntryOf(frameRoot);
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!outer || !piMeta || !eaMeta) return null;
  const source = (readTraitData(outer, piMeta)?.source as string) || '';
  const handle = findEntity(outer);
  const rec = handle ? frameRootDoc(getCurrentWorld(), handle) : undefined;
  const from = rec && rec.source === source ? rec.doc as PrefabFile : getCachedPrefabSync(source);
  if (!from) return null;
  const outerGuid = ensureGuid(outer);
  if (!outerGuid) return null; // no EntityAttributes: nothing can hold a guid
  // …and the frame's own, which the caller finds it again by after the rebuild: a runtime guid is not written into the
  // entry (a member row pins only a durable one), so the rebuilt frame derived a new one and the caller fell back to the
  // entry's root (#1880 F7d close-out review 2). Minted, the entry pins it.
  if (frameRoot !== outer) ensureGuid(frameRoot);
  return { outerGuid, source, from, entry: captureRebuildEntry(outer, source, from, outerGuid, edit) };
}

/** Rebuild `side`'s entry by loading it onto the current documents. Returns the new id of the frame named `frameGuid`
 *  (the entry's own root when it names none, or when that frame is not found after), 0 when the entry's root is not
 *  live — nothing is rebuilt then. A frame inside a frame the load keeps live is left as it was: every caller asks
 *  {@link keptEnclosingSource} first. */
export function rebuildEntrySide(side: EntrySide, frameGuid = ''): number {
  const outer = findEntityByGuid(side.outerGuid)?.id() ?? 0;
  if (!outer) return 0;
  const read = withFrameRecords(getCachedPrefabSync as ExpansionReader, outer);
  const newOuter = rebuildFromEntry(outer, side.source, getCachedPrefabSync(side.source) ?? side.from, side.entry, new Map(), side.from, read);
  return (frameGuid && frameGuid !== side.outerGuid ? findEntityByGuid(frameGuid)?.id() : 0) || newOuter;
}

/** #1880 F6: rebuild the scene entry rooted at `rootInstanceId` (of `source`) by LOADING `entry` — the save's own
 *  statement of it (`captureInstanceEntry`) — onto `prefab`, through the loader's spawner and post-pass
 *  (`settleEntryRows`). A rebuild is then the load of what a save writes: nothing folds a capture into a fresh
 *  expansion by hand, so nothing can fold it differently from a reload.
 *
 *  Only the live-world machinery no document holds is the rebuild's own, and it is the old rebuild's, unchanged: the
 *  teardown and what it parks and keeps (`rebuildTeardown`: a member of another instance moved in, #1437/#1484; a frame
 *  whose prefab cannot be expanded, #1862), the root's durable guid, `Transient` and scene ownership, and each torn-down
 *  node's template key (#1567). `remap`: old → new member guid (#1437). */
export function rebuildFromEntry(
  rootInstanceId: number, source: string, prefab: PrefabFile, entry: InstanceEntry, remap: ReadonlyMap<string, string> = new Map(),
  /** The document `entry` was captured against, when it is not `prefab`. Its rows are keyed by identity and need nothing,
   *  but its localId channels do: the root's own edits, a pre-v5 member's, and — unlike a saved scene's, whose guid pass
   *  gives every member a durable guid first — a member still on a RUNTIME guid, which no row may name. They are
   *  translated by nodeGuid (`translateLocalIds`), so a template re-save that renumbers its rows hands no edit to the
   *  member that inherited the number (#1468 Phase 4). */
  from: PrefabFile = prefab,
  /** The documents every frame inside is expanded from: the editor's cache, or — a refresh — the cache with the
   *  refreshed prefab read as the document the caller handed ({@link rebuildTargetsByEntry}). */
  read: ExpansionReader = getCachedPrefabSync as ExpansionReader,
  /** Filled with every entity the rebuild left as it was inside a frame it KEPT live (`rebuildTeardown`'s `unexpandable`,
   *  #1862): nothing in there was re-expanded, so a caller must not count a target in it as rebuilt. */
  keptOut?: Set<number>,
  /** The scene format `entry` is stated in: the current one (a capture), or the instance model's v20 (a record the store
   *  holds, serialized by `serializeInstanceRecord` — `reprojectFromStore`, #2001 S5). */
  sceneVersion?: number,
): number {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return rootInstanceId;
  // The variant form (#2042) is named first: it expands to no root either, but that would not say why.
  const variant = rootReferenceRefusal(prefab);
  if (variant || !expandsToRoot(prefab, read as typeof getCachedPrefabSync)) {
    console.warn(`[Prefab] rebuild of ${source} skipped: ${variant ?? 'the prefab expands to no root'}`);
    return rootInstanceId;
  }
  // A key the expansion would give two nodes (#1933 L5, close-out review #1): left as it was, as one that expands to no
  // root is — re-expanded, both nodes derive one guid and the next save turns one into the other. The next load refuses it.
  const repeat = frameRepeatRefusal(prefab, (g) => read(g) ?? null);
  if (repeat) {
    console.warn(`[Prefab] rebuild of ${source} skipped: ${repeat}`);
    return rootInstanceId;
  }
  if (remap.size) entry = remapGuidValues(entry, remap) as InstanceEntry;
  const lidOf = from !== prefab ? translateLocalIds(from, prefab) : null;
  if (lidOf) entry = translateEntryLocalIds(entry, lidOf);
  const oldRootEa = readTraitData(rootInstanceId, eaMeta);
  const parentId = (oldRootEa?.parentId as number) ?? 0;
  const wasTransient = !!findEntity(rootInstanceId)?.has(Transient);

  // The frame's own address, read before the teardown as the keep reads its nodes': the respawn addresses every frame it
  // expands from this one, so a kept node and its statement meet at the same address (#1939).
  const rootAddress = liveFrameAddresser(getCurrentWorld())(rootInstanceId);
  const rootFrame = rootAddress ? remapFrameAddress(rootAddress, remap) : undefined;
  const { toDestroy, parked, kept } = rebuildTeardown(rootInstanceId, remap, read as typeof getCachedPrefabSync);
  const carriedKeys = templateKeysByGuid(toDestroy, remap);
  destroyTornDown({ toDestroy, parked, kept });
  // A kept reference node IS that node's live expansion: the spawner meets it by its frame address and spawns nothing —
  // a scene-added node the entry states, and a TEMPLATE node a document states by key alone (#1939: matched by guid, a kept
  // template node was respawned as a placeholder beside itself and then dropped as unnamed). The settle below reads the
  // whole entry, so R2 keeps a node in its row as a load would.
  const keptNodes = new Map(kept.filter((k) => !k.owned && k.address).map((k) => [k.address!, k] as const));
  const namedNodes = new Set<string>();
  // A kept node whose statement the new document re-points to another prefab goes before that prefab spawns in its place,
  // so the spawn derives the guids it held, as a reload does (#1948 S1).
  const released = new Set<number>();
  const release = (address: string) => {
    const k = keptNodes.get(address);
    if (k && !released.has(k.id)) { released.add(k.id); deleteEntities([k.id]); }
  };
  const spawnRead = keptNodes.size ? keepingFrames(read, new Map([...keptNodes].map(([a, k]) => [a, k.source!])), namedNodes, release) : read;

  // The load's spawn of a scene entry (`onInstantiatePrefab`), from the editor's cache.
  const world = getCurrentWorld();
  const newRootId = instantiatePrefabIntoWorld(
    world, prefab, parentId, undefined, source, entry.overrides,
    { added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits, moved: entry.moved, members: entry.members },
    undefined, entry.nestedOverrides, entry.nestedStructure,
    // A captured entry is the current format's statement (the default version); its root keeps the guid it had.
    { read: spawnRead, frame: rootFrame, ...(durableGuid(oldRootEa?.guid as string) ? { rootGuid: oldRootEa!.guid as string } : {}), ...(sceneVersion !== undefined ? { sceneVersion } : {}) },
  );
  markStructureDirty();
  markUIDirty();
  if (durableGuid(oldRootEa?.guid as string)) writeTraitField(newRootId, eaMeta, 'guid', oldRootEa!.guid as string);
  if (wasTransient) findEntity(newRootId)?.add(Transient);
  setPrefabSource(newRootId, prefab);
  // Keys first: a scene node carries its guid from the spawn, and a keyed node derives through its key.
  restoreTemplateKeys(carriedKeys);
  // …and the load's post-pass for this one entry: its rows' pins, R2's kept store, the reference nodes' rows, the derive.
  const settled = entryRowsOf(newRootId, source, entry);
  settleEntryRows(world, [settled], { pinned: new Set(), read: read as typeof getCachedPrefabSync, ...(sceneVersion !== undefined ? { fromSceneVersion: sceneVersion } : {}) });
  restoreTemplateKeys(carriedKeys);
  // A kept reference node the entry states under a row the new template no longer backs is in that row now (R2, B′), as
  // a load leaves it: it goes with its member rather than being re-seated at the root.
  const orphaned = orphanedNodeGuids(settled);

  const sourceScene = (oldRootEa?.sourceScene as string) || '';
  if (sourceScene) {
    const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
    const stamped = new Set(collectSubtreeIds(links, [newRootId]));
    const rebuilt = worldIdentityParents(world);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of getAllEntities()) {
        if (stamped.has(e.id) || !rebuilt.moved(e.id) || !stamped.has(rebuilt.parentOf(e.id))) continue;
        for (const id of collectSubtreeIds(links, [e.id])) stamped.add(id);
        grew = true;
      }
    }
    for (const id of stamped) writeTraitField(id, eaMeta, 'sourceScene', sourceScene);
  }
  const after = parked.length ? worldIdentityParents(world) : null;
  for (const p of parked) {
    const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.id]));
    const back = live.get(p.parentGuid);
    const templateParent = after!.parentOf(p.id);
    const to = back ?? (templateParent && templateParent !== p.id ? templateParent : undefined);
    if (to) writeTraitField(p.id, eaMeta, 'parentId', to);
    else console.warn(`[Prefab] rebuild: the parent ${p.parentGuid} of a member moved in here is gone, and so is its template parent; it stays at the scene root`);
  }
  seatKeptFrames(kept.filter((k) => !released.has(k.id)), newRootId, new Set([...keptNodes].filter(([g, k]) => !released.has(k.id) && (!namedNodes.has(g) || orphaned.has(g))).map(([, k]) => k.id)));
  if (keptOut && kept.length) {
    const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
    // Not a released frame: its id is recycled into the very spawn that replaced it (#1948 close-out review).
    for (const id of collectSubtreeIds(links, kept.filter((k) => !released.has(k.id) && findEntity(k.id)).map((k) => k.id))) keptOut.add(id);
  }
  return newRootId;
}

/** `entry` with its localId channels put through `lid` ({@link translateCarried}); its rows are keyed by identity. */
function translateEntryLocalIds(entry: InstanceEntry, lid: (n: number) => number): InstanceEntry {
  const { overrides, structure } = translateCarried(lid, entry.overrides ?? {}, {
    added: entry.added, removed: entry.removed, removedTraits: entry.removedTraits, moved: entry.moved,
  });
  const out: InstanceEntry = { ...entry };
  if (entry.overrides) out.overrides = overrides;
  if (entry.added) out.added = structure.added;
  if (entry.removed) out.removed = structure.removed;
  if (entry.removedTraits) out.removedTraits = structure.removedTraits;
  if (entry.moved) out.moved = structure.moved;
  return out;
}

/** Every node guid the kept-orphan store (R2) now holds for the stored roots `rows` settled — the entry's own root and
 *  each reference node it states — at any depth inside a kept row. Compared with the kept nodes' frame ADDRESSES (#1939):
 *  a node the store holds is stated by guid, and a guid-stated node's address IS its guid (`nodeFrameAddress`). */
function orphanedNodeGuids(rows: ReturnType<typeof entryRowsOf>): Set<string> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Set<string>();
  const walk = (list: readonly AddedEntity[] | undefined): void => {
    for (const n of list ?? []) { if (n.guid) out.add(n.guid); for (const inner of nodeChannels(n)) walk(inner); }
  };
  const rootGuid = eaMeta ? durableGuid((readTraitData(rows.root, eaMeta) as { guid?: string } | null)?.guid) : '';
  for (const guid of [rootGuid, ...rows.referenceRows.map(([g]) => g)]) {
    for (const row of Object.values(guid ? keptMemberOrphans(guid) ?? {} : {})) walk([...(row.added ?? []), ...(row.own ?? [])]);
  }
  return out;
}

/** Rebuild the frame `rootInstanceId` to `side` — its outermost entry as captured earlier ({@link captureEntrySide}) — by
 *  loading that entry onto the editor's CURRENT documents (#1665, #1880 F6d): what a Revert's undo and redo, and an Apply
 *  undo's base instance, put back. The template can have changed since the side was captured (a prefab-edit save, an
 *  Apply from another instance); the entry's rows are keyed by identity, and the loader resolves them against the current
 *  documents as a reload of an older save does (I4).
 *
 *  A frame nested in it that was built from other rows than the cache's is not refused (#1493's refusal, #1880 F7d): the
 *  side states every frame as it stood, and the load expands it from the current documents, as a reload does.
 *
 *  Returns the frame's new id, or null, rebuilding nothing, when the entry's root is not live — or when the frame lies
 *  inside a frame the load would keep live ({@link keptEnclosingSource}): left as it was, it would not be put back to
 *  `side` (#1880 F7d close-out review 1). */
export function rebuildFrameFromSide(rootInstanceId: number, side: EntrySide): number | null {
  if (keptEnclosingSource(rootInstanceId)) return null;
  const eaMeta = getTraitByName('EntityAttributes');
  const guid = eaMeta ? ((readTraitData(rootInstanceId, eaMeta) as { guid?: string } | null)?.guid ?? '') : '';
  return rebuildEntrySide(side, guid) || null;
}

/** Rebuild each instance frame in `rootIds` onto `newPrefab` — the refresh a prefab write gives every instance of it —
 *  carrying each one's own edits (stated against its record, else `oldPrefab`) across. Returns how many were rebuilt. */
function refreshInstancesUnmarked(
  source: string,
  rootIds: number[],
  oldPrefab: PrefabFile,
  newPrefab: PrefabFile,
  /** Old → new member guid (#1437): what the rebuild consumes by guid follows it. */
  remap: ReadonlyMap<string, string> = new Map(),
  /** The instance(s) an Apply copied `fields` (`localId.Trait.field`, `oldPrefab`'s numbering) FROM (#1469):
   *  they are subtracted from its capture, or their marks would carry them over as overrides. Several for a U14 Apply
   *  that wrote nested frames' own edits into their prefab (#1693). */
  /** Each named by the frame root's durable guid, taken when the Apply was planned — an id taken then can be dead or
   *  recycled by the time a later write refreshes (#1880 F6). `rootId` only where the root had no durable guid. */
  appliedFrom?: { rootId: number; rootGuid?: string; fields: ReadonlySet<string> } | readonly { rootId: number; rootGuid?: string; fields: ReadonlySet<string> }[],
): number {
  if (rootIds.length === 0) return 0;
  const eaMeta = getTraitByName('EntityAttributes');
  const appliedList = Array.isArray(appliedFrom) ? appliedFrom : appliedFrom ? [appliedFrom] : [];
  // #2046 S7.3 (rule 7, § 3.2's fan-out row): a tree whose outermost projectable record is fresh is reprojected from that
  // record onto the documents now cached — its own list, unused records kept. Not a tree an Apply copies FROM: its
  // records lose the applied fields (U15), which the capture's subtraction below still computes. Not a rebuild that
  // carries guids (`remap`, #1437): its rows are matched by what the capture reads. The rest are rebuilt from the
  // capture, and their records are left stale (`refreshInstances`).
  const world = getCurrentWorld();
  const applyingTops = new Set(appliedList.map((a) => {
    const id = a.rootGuid ? findEntityByGuid(a.rootGuid)?.id() ?? 0 : a.rootId;
    return id ? guidOfEntity(projectionRootOf(id) || id) : '';
  }).filter(Boolean));
  const reproject = new Map<string, number>();
  const captured: number[] = [];
  for (const root of rootIds) {
    const top = projectionRootOf(root);
    const topGuid = top ? guidOfEntity(top) : '';
    if (!remap.size && topGuid && !applyingTops.has(topGuid) && freshInstanceRecord(world, topGuid) && reprojectsExactly(top)) reproject.set(topGuid, top);
    else captured.push(root);
  }
  let reprojected = 0;
  for (const [topGuid, top] of reproject) {
    const live = findEntityByGuid(topGuid)?.id();
    if (live === top && reprojectFromStore(top)) reprojected += 1;
    else captured.push(...rootIds.filter((r) => projectionRootOf(r) === top));
  }
  const targets: RebuildTarget[] = [];
  for (const root of captured) {
    // ⚠️ Checked by GUID, not id — an id-only check is worse than none here. See `isLiveInstanceRoot`. A root listed
    // dead (an id `collectInstanceRoots` collected before an earlier teardown) has nothing to rebuild.
    const guid = eaMeta ? ((readTraitData(root, eaMeta)?.guid as string) || '') : '';
    if (!isLiveInstanceRoot(root, guid)) continue;
    const liveGuid = durableGuid(guid);
    const from = appliedList.find((a) => (a.rootGuid ? a.rootGuid === liveGuid : a.rootId === root));
    // Every applied field leaves the source (#1469, U15): U13 reverted the enclosing overrides that could shadow one.
    targets.push({ root, ...(from ? { edit: { overrides: (o) => subtractFieldOverrides(o, from.fields) } } : {}) });
  }
  // An applied-from frame that is not itself refreshed — a nested frame whose edit an Apply wrote into an ENCLOSING
  // prefab (#1658 ruling (a), U14) — lies inside a target's entry, and its fields leave it in that entry's load: an Apply
  // takes the record off (#1914, docs/prefabs.md § I2), where before its capture dropped them for equalling the row now.
  const frameEdits = new Map<number, FrameEdit>();
  for (const a of appliedList) {
    const id = a.rootGuid ? findEntityByGuid(a.rootGuid)?.id() ?? 0 : a.rootId;
    if (id && !targets.some((t) => t.root === id)) frameEdits.set(id, { overrides: (o) => subtractFieldOverrides(o, a.fields) });
  }
  // The scene entries the capture path rebuilds: their records are left stale (`refreshInstances`).
  entryGuidsOf(targets.map((t) => t.root), capturedEntries);
  // A frame is rebuilt as the LOAD of its outermost scene entry (#1880 F6-U, hub ruling (i)): every target in one entry by
  // the same load, each with the Apply's subtraction made in its own statement, every frame against its own record
  // (`againstRecords`) and every frame of `source` expanded from `newPrefab`. So a target holding a frame built from
  // other rows than the cache's (#1493) comes out as a reload builds it, and is not refused (#1880 F7d, close-out F2:
  // refused while a sibling target in its entry was not, it was rebuilt by that sibling's load all the same, under a
  // "not refreshing" warning and uncounted). What it does not rebuild — an entry with no document to load it from — is
  // said, and not counted.
  const done = targets.length ? rebuildTargetsByEntry(targets, remap, undefined, { source, from: oldPrefab, to: newPrefab }, frameEdits) : { size: 0, said: 0 };
  if (done.size + done.said < targets.length) {
    console.warn(`[Prefab] not refreshing ${targets.length - done.size - done.said} instance(s) of "${source}": no scene entry holding them could be loaded — reload its scene to update it`);
  }
  // Reports what was REBUILT, not what was listed.
  console.log(`[Prefab] Refreshed ${done.size + reprojected} instance(s) of "${source}"`);
  return done.size + reprojected;
}

/** The entries the current `refreshInstances` call rebuilt from the capture (outermost stored root guids). */
let capturedEntries = new Set<string>();

/** Rebuild every live instance FRAME — a stored root, or an owned nested root (#1493) — whose own record says
 *  it was expanded from a document other than the editor's cached copy of its source (#1483). A root carried
 *  FLAT across a hot reload — a kept base scene's, or a `Persistent` one's — never sees the prefab change that
 *  caused the reload, and neither does any frame nested inside it; everything else was just re-expanded from
 *  disk, compares equal, and is left alone. This is the refresh an Apply gives every instance, run from the
 *  document each frame was really expanded from. Returns how many were rebuilt.
 *
 *  Each is rebuilt as the load of its scene entry (#1880 F6-U), which states every frame in it against its own
 *  record — so a stale frame nested in another is rebuilt with it, on its own rows, as a reload would. If the world is replaced
 *  while the nested prefabs load, nothing is rebuilt — the ids were collected in the world that is gone, and
 *  the new world's load recorded its own documents. */
export async function rebaseStaleInstances(
  /** Only frames of these refs (a prefab write rebuilds what IT changed, not every other prefab's stale frames). */
  opts: { sources?: ReadonlySet<string> } = {},
): Promise<number> {
  const world = getCurrentWorld();
  const stale = staleFrames(opts);
  for (const s of stale) {
    await preloadNestedPrefabs(s.to);
    // …and the entry it rebuilds through (#1880 F6-U): that load reads every frame in it.
    await preloadRebuildEntry(s.root);
  }
  if (getCurrentWorld() !== world) return 0;
  return rebuildStaleFrames(stale);
}

/** {@link rebaseStaleInstances} with no wait when it needs none (#1820): a frame re-linked or respawned from a record — a
 *  Paste of a copy taken before its template changed, Create Prefab's undo — is brought onto the current template
 *  before the caller's step returns, when every prefab its rebuild reads is already cached (as it is right after an
 *  in-session Apply, Replace or prefab-edit save). An async step is a window a world switch can land in (#1833), so the
 *  async rebase runs only when a prefab has to be fetched, and it holds the world until it lands. True when it found a
 *  stale frame to rebuild (Create Prefab's undo remembers it: its redo cannot re-link a tree the rebase changed). */
export function rebaseStaleInstancesSoon(opts: { sources?: ReadonlySet<string> } = {}): boolean {
  const stale = staleFrames(opts);
  if (!stale.length) return false;
  const cached = (src: string) => prefabCache.has(src);
  const docCached = (doc: PrefabFile, seen = new Set<string>()): boolean => doc.entities.every((e) => {
    if (!e.prefab || seen.has(e.prefab)) return true;
    seen.add(e.prefab);
    const child = prefabCache.get(e.prefab);
    return !!child && docCached(child, seen);
  });
  const pi = getTraitByName('PrefabInstance')!;
  const subtreeCached = (root: number) => collectTree(root, getAllEntities())
    .every((e) => !e.traits.includes('PrefabInstance') || cached(readTraitData(e.id, pi)?.source as string));
  if (stale.every((s) => docCached(s.to) && subtreeCached(outermostEntryOf(s.root) || s.root))) { rebuildStaleFrames(stale); return true; }
  const release = beginWorldBoundOperation();
  void rebaseStaleInstances(opts)
    .catch((e) => console.error('[Prefab] rebasing a re-linked instance onto its current prefab failed:', e))
    .finally(release);
  return true;
}

/** Rebuild `stale` onto the documents it names, every nested prefab those read already cached. */
/** {@link rebuildStaleFramesUnmarked}, marking the instance store stale when it rebuilt anything — or threw part-way,
 *  having perhaps rebuilt some (#2001 S4: a rebase does not maintain the list yet; `instanceStore.ts`). */
export function rebuildStaleFrames(stale: StaleFrame[]): number {
  let n: { rebuilt: number; captured: ReadonlySet<string> };
  try { n = rebuildStaleFramesUnmarked(stale); } catch (err) { markStale(getCurrentWorld(), 'rebase'); throw err; }
  // A tree reprojected from its record kept its list (#2046 S7.3): only the entries rebuilt from the capture leave theirs.
  markEntriesStale(n.captured, 'rebase');
  return n.rebuilt;
}

/** Every stored root of the scene entry holding each of `roots`, by guid, as it stands NOW: the records a capture
 *  rebuild of those entries leaves behind (#2046 S7.3) — a root the rebuild turns into a row (a promotion) included. */
function entryGuidsOf(roots: Iterable<number>, into: Set<string>): Set<string> {
  for (const r of roots) {
    const e = outermostStoredRoot(r) || r;
    for (const id of [e, ...storedRootsUnder(e)]) into.add(guidOfEntity(id));
  }
  return into;
}

/** Mark stale the records `entryGuids` names, and those of every stored root now under each (a root the rebuild made). */
function markEntriesStale(entryGuids: ReadonlySet<string>, by: string): void {
  if (!entryGuids.size) return;
  const world = getCurrentWorld();
  for (const g of entryGuids) {
    const id = findEntityByGuid(g)?.id();
    markStale(world, by, [g, ...(id ? storedRootsUnder(id).map(guidOfEntity) : [])]);
  }
}

function rebuildStaleFramesUnmarked(stale: StaleFrame[]): { rebuilt: number; captured: ReadonlySet<string> } {
  const pi = getTraitByName('PrefabInstance')!;
  const world = getCurrentWorld();
  // RE-CHECK: a frame is rebuilt only while its id is still a root of the same source holding the very document
  // collected — so a frame some rebuild since respawned (current now), or an id freed by one and handed straight back to
  // a respawn, is left alone. (Rebuilt under a recycled id, another source's frame was rebuilt as this one: #1493
  // review 2.) ⚠️ TRACED, NOT DRIVEN: nothing rebuilds between the collection and here in any caller.
  const pending = [...stale];
  const liveRoot = (s: (typeof pending)[number]): number => {
    const e = findEntity(s.root);
    if (!e) return 0;
    const d = readTraitData(e.id(), pi) as { source?: string; rootInstanceId?: number } | null;
    return d?.source === s.source && d.rootInstanceId === e.id() && frameRootDoc(world, e)?.doc === s.from ? e.id() : 0;
  };
  // Every stale frame in one entry by the same load (#1880 F6-U), which states each against its own record (`from`) and
  // expands each from the cache (`to`), counted by frame — so no order among them is needed, and a stale frame inside
  // another is not refused (#1880 F7d). An entry with no document to load it from is left, and said.
  const live = pending.filter((s) => liveRoot(s));
  // #2046 S7.3 (rule 7, § 3.2's fan-out row): a tree whose outermost projectable record is fresh is reprojected from that
  // record onto the documents now cached — its own list, unused records kept, nothing read off the live tree. Each tree
  // once, however many of its frames are stale. A tree with no fresh record (or one the store cannot state) is rebuilt
  // from the capture as before.
  const trees = new Map<number, StaleFrame[]>();
  const fromCapture: StaleFrame[] = [];
  for (const s of live) {
    const top = projectionRootOf(s.root);
    if (top && freshInstanceRecord(world, guidOfEntity(top)) && reprojectsExactly(top)) trees.set(top, [...(trees.get(top) ?? []), s]);
    else fromCapture.push(s);
  }
  let reprojected = 0;
  for (const [top, frames] of trees) {
    if (reprojectFromStore(top)) reprojected += frames.length;
    else fromCapture.push(...frames);
  }
  const captured = entryGuidsOf(fromCapture.map((s) => s.root), new Set());
  const done = rebuildTargetsByEntry(fromCapture.map((s) => ({ root: s.root })));
  if (done.size + done.said < fromCapture.length) {
    console.warn(`[Prefab] not rebasing ${fromCapture.length - done.size - done.said} stale instance frame(s): no scene entry holding them could be loaded — reload its scene to update it`);
  }
  return { rebuilt: reprojected + done.size, captured: done.size ? captured : new Set() };
}

/** Re-derive every BASE scene's live instance of `source` from `fromPrefab` to `toPrefab` — the
 *  refresh a prefab save runs, restricted to base-owned roots (#1431). For an undo/redo that swaps
 *  the prefab back and restores only the PRIMARY: a base loaded with it is CARRIED live, so its
 *  instances would stay built from the prefab being undone, and a dirty base would then be saved
 *  against the restored one (a member the apply removed reads as a `removed` nobody authored).
 *  `exceptGuid` names an instance the caller rebuilds itself. */
export function refreshBaseInstances(source: string, fromPrefab: PrefabFile, toPrefab: PrefabFile, exceptGuid = ''): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return;
  const roots = collectInstanceRoots(source).filter((id) => {
    const ea = readTraitData(id, eaMeta);
    return !!ea?.sourceScene && !(exceptGuid && ea.guid === exceptGuid);
  });
  refreshInstances(source, roots, fromPrefab, toPrefab);
}

/** {@link refreshInstancesUnmarked}, marking stale every record of the scene entries it rebuilt from the capture (the
 *  capture re-derives them, #2001 S4), and every record when it throws part-way. A tree it reprojected from its record
 *  kept its list (#2046 S7.3). */
export const refreshInstances: typeof refreshInstancesUnmarked = (...args) => {
  const outer = capturedEntries;
  capturedEntries = new Set();
  try {
    const n = refreshInstancesUnmarked(...args);
    markEntriesStale(capturedEntries, 'apply');
    return n;
  } catch (err) {
    markStale(getCurrentWorld(), 'apply');
    throw err;
  } finally {
    capturedEntries = outer;
  }
};
