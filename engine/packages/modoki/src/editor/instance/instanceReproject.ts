/**
 * Reproject an instance from its STORED record (#2001 S7, #2046): the record is the truth, and the live entities are
 * rebuilt from it (rule 2; design § 3.2's rebuild row; § 10.1: "S7 then moves each op onto its record … and that op
 * projects from the store").
 *
 * The unit is the OUTERMOST record (F6-U (i)): a frame nested in it, and a reference node the scene added under it (a
 * record of its own, § 2.5), are rebuilt with it. The record is written by the instance model's writer
 * (`serializeInstanceRecord`, v20) and LOADED back through the rebuild's own spawn and settle (`rebuildFromEntry` with the
 * v20 version): the same path the fuzzer's P1 seam projects every record through after every op and compares with the
 * live tree (`prefabFuzz/s5Seams.ts`), so a reprojection of an unchanged fresh record changes nothing the user sees.
 *
 * ── What is not the record's ──
 * - The CONTENT of a scene-owned node (rule 7: the user's node is scene data, the list holds its link). Until S6's adapter
 *   reads it off the live tree, it is the old capture's inline form of it (`ownContentOf`), read BEFORE the rebuild.
 * - A nested record that is stale: its node is written in the capture's form, which still states its list (as P1 does).
 * - The placement marks of every stored root in the tree (the top one, and each reference node the scene added). They
 *   follow the old FORMAT, not the list (hub ruling 2026-10-02, § 10.7): a v20 root shows exactly the marks today's form
 *   of it shows. `sortOrder` is always one (F7, implied by `getOverrideMarkSet`); the name is one only while it differs
 *   from the prefab root's (the v20 writer states it always, U10b, and the load would mark it); the top root's
 *   `editorFolder` keeps the mark it had.
 */
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { openIdentityScope, closeIdentityScope } from '../../runtime/core/ecs/identityParents';
import { getOverrideMarkSet, markOverride, unmarkOverride } from '../../runtime/loaders/overrideMarks';
import { INSTANCE_MODEL_SCENE_VERSION } from '../../runtime/core/version';
import type { ExpansionReader } from '../../runtime/loaders/loadSceneFile';
import { recordsOf } from '../../runtime/prefab/instanceLoad';
import { parseInstanceRecord } from '../../runtime/prefab/parseInstanceRecord';
import { freshInstanceRecord, storedInstances } from '../../runtime/prefab/instanceStore';
import { serializeInstanceRecord, type MemberIdentity } from '../../runtime/prefab/serializeInstanceRecord';
import type { InstanceRecord, ParsedInstance, PrefabReader, SceneOwnedNode } from '../../runtime/prefab/instanceRecord';
import type { InstanceEntry } from '../scene/instanceEntry';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { keyedForRebuild, rebuildFromEntry, withFrameRecords } from '../scene/prefabRebuild';
import type { PrefabFile } from '../scene/prefab';
import { allStoredRoots, guidOfEntity, projectionRootOf, storedRootsUnder } from './instanceKeys';
import { memberRowsToWrite } from '../../runtime/core/ecs/memberRows';
import { foldInstance } from '../../runtime/prefab/foldInstance';

export { projectionRootOf };
import { capturedEntryOf, captureFormVersionOf, editorPrefabReader } from './instanceSync';

/** The identity the writer pins for record-owning root `rootId` (§ 2.7, rule 5), by key: exactly the members the old
 *  save pins (`memberRowsToWrite`), so a reprojection states no pin today's form would not. A template-added node is
 *  never pinned (its guid is derived per instance from its key; `memberRows.ts` exclusion 3): a pin on its `…/a+<key>`
 *  row matches no member on the load, which keeps the row as an orphan, and the next save writes it out (hunt seed
 *  7180). Nor is a member with a runtime guid (#1210), which is no identity to write down. */
export function identityOf(rootId: number): MemberIdentity {
  const out = new Map<string, { guid: string; name?: string }>();
  const ea = getTraitByName('EntityAttributes');
  for (const [id, key] of memberRowsToWrite(rootId)) {
    // The live name beside the guid, for a readable file: what the old row writer stated (`captureInstanceMembers`).
    const name = ea ? (findEntity(id)?.get(ea.trait) as { name?: string } | undefined)?.name : undefined;
    out.set(key, { guid: guidOfEntity(id), ...(name ? { name } : {}) });
  }
  return out;
}

/** May the fan-out reproject the tree at outermost projectable root `top` from its records (#2046 S7.3)? Every record in
 *  it fresh, and none HOLDING a user's node the fold would not place: an `own` link left unused (its node's anchor gone
 *  from the template — an outside edit, a prefab-edit save). The old settle keeps such a row whole as an R2 orphan, user
 *  node included, and the save writes it back; the projection does not spawn it, so the save would lose it (hunt seed
 *  7541; the fold side is #2036's, an S6 entry criterion). Such a tree is rebuilt from the capture until then. */
export function reprojectsExactly(top: number): boolean {
  const world = getCurrentWorld();
  for (const id of [top, ...storedRootsUnder(top)]) {
    const rec = freshInstanceRecord(world, guidOfEntity(id));
    if (!rec) return false;
    if (foldInstance(editorPrefabReader, rec).unused.some((u) => u.part.kind === 'own')) return false;
  }
  return true;
}

/** {@link identityOf}, narrowed to the members the record's fold builds (#2046 S7.3): a reprojection runs over a live tree
 *  still in the OTHER shape — an Apply's undo, a template that lost a member — and a pin for a member the fold no longer
 *  has matches nothing on the load, which keeps it as an orphan row (R2) the next save writes out. */
function identityIn(rootId: number | undefined, rec: InstanceRecord, pinned?: MemberIdentity, read: PrefabReader = editorPrefabReader): MemberIdentity {
  const built = foldInstance(read, rec).nodes;
  const out = new Map<string, { guid: string; name?: string }>();
  // A pin taken earlier first, the live one over it: a member an undo brings back is not live (#2046 S7.4).
  for (const [key, pin] of pinned ?? []) if (built.has(key as never)) out.set(key, pin);
  if (rootId !== undefined) for (const [key, pin] of identityOf(rootId)) if (built.has(key as never)) out.set(key, pin);
  return out;
}

/** The identity of every live record-owning root among `rootGuids`, by root guid ({@link identityOf}): what a step that
 *  removes members holds, so its undo's reprojection pins them as they were (#2046 S7.4). */
export function identitiesOf(rootGuids: Iterable<string>): Map<string, MemberIdentity> {
  const out = new Map<string, MemberIdentity>();
  for (const g of rootGuids) { const id = findEntityByGuid(g)?.id(); if (id) out.set(g, identityOf(id)); }
  return out;
}

/** The capture's parse of the instance tree at outermost root `top`, by root guid: what each record's scene-owned content
 *  is written from (see the header). Null when the tree cannot be captured. */
export function ownContentOf(top: number, keyed = true, consumed?: Set<number>): Map<string, ParsedInstance> | null {
  openIdentityScope();
  try {
    const raw = capturedEntryOf(top, consumed);
    if (!raw) return null;
    // A node's template key travels with its content (the edit world's rows state nodes by key, #1567): one an undo
    // brings back was not in the rebuild's teardown, so nothing else carries its key over. Not for the SAVE (`keyed`
    // false, `instanceSave.ts`): a file states a scene's node by its guid, as the capture wrote it.
    const captured = keyed ? keyedForRebuild(top, raw.guid ?? '', raw as never) as typeof raw : raw;
    const held = new Set<string>();
    const ea = getTraitByName('EntityAttributes')!.trait;
    for (const e of getCurrentWorld().entities) { const g = (e.get(ea) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
    const opts = { held: (g: string) => held.has(g), sceneVersion: captureFormVersionOf(top) };
    const all = recordsOf(parseInstanceRecord(captured, editorPrefabReader, opts), editorPrefabReader, opts);
    return new Map(all.map((p) => [p.record.rootGuid, p]));
  } finally {
    closeIdentityScope();
  }
}

/** `rec` written as a v20 entry (§ 2.2). `rootId`: its live root, for the members' identity (none: a record whose root is
 *  not live); `byGuid`: the capture's parse of the tree ({@link ownContentOf}), for the scene-owned content. A scene-added
 *  reference node in that content carries its own record's list (and order) from the store, not the capture's —
 *  `recordOf`: where a nested record is read from (default: the store's fresh one). `read`: the documents the members'
 *  identity is narrowed by (default: the editor's caches). */
export function writtenEntryOf(rec: InstanceRecord, rootId: number | undefined, byGuid: ReadonlyMap<string, ParsedInstance>,
  pinned?: ReadonlyMap<string, MemberIdentity>, recordOf: (guid: string) => InstanceRecord | undefined = storedFresh,
  read: PrefabReader = editorPrefabReader): ReturnType<typeof serializeInstanceRecord>['entry'] {
  const parsed = byGuid.get(rec.rootGuid);
  const inline = (node: SceneOwnedNode): SceneOwnedNode => {
    const children = Array.isArray(node.children) ? (node.children as SceneOwnedNode[]).map(inline) : node.children;
    if (typeof node.prefab !== 'string' || !node.prefab || typeof node.guid !== 'string') return { ...node, children } as SceneOwnedNode;
    const nested = recordOf(node.guid);
    if (!nested || !byGuid.has(node.guid)) return { ...node, children } as SceneOwnedNode;
    const liveId = allStoredRoots().find((id) => guidOfEntity(id) === node.guid);
    const entry = writtenEntryOf(nested, liveId, byGuid, pinned, recordOf, read) as Record<string, unknown>;
    // The row channels the old form stated the node's list in, replaced by its record's written rows.
    const { overrides: _o, added: _a, removed: _r, removedTraits: _rt, moved: _m, templateMoved: _tm, nestedOverrides: _no, nestedStructure: _ns, members: _mb, ...kept } = node as unknown as Record<string, unknown>;
    const rows = Object.fromEntries(Object.entries(entry).filter(([k]) => !['name', 'traits', 'prefab', 'guid'].includes(k)));
    // The node's order is its record's placement (the old form stated it in the `overrides` replaced above). A node has
    // no entry `traits.EntityAttributes` the parser reads it from (that is the entry's v20 home), so it goes where the
    // parser reads a node's order first: its "/" row (`parseInstanceRecord`'s placement). Its parent is the anchor that
    // links it; its name is the template root's (a node's own name is not one, #2028).
    const members = { ...(rows.members as Record<string, Record<string, unknown>> | undefined) };
    const rootRow = { ...members['/'] };
    const rootTraits = { ...(rootRow.traits as Record<string, unknown> | undefined) };
    rootTraits.EntityAttributes = { ...(rootTraits.EntityAttributes as Record<string, unknown> | undefined), sortOrder: nested.placement.sortOrder };
    members['/'] = { ...rootRow, traits: rootTraits };
    return { ...kept, children, ...rows, members } as unknown as SceneOwnedNode;
  };
  return serializeInstanceRecord(rec, {
    identity: identityIn(rootId, rec, pinned?.get(rec.rootGuid), read),
    sceneOwned: (g) => { const n = parsed?.ownContent.get(g); return n ? inline(n) : undefined; },
  }).entry;
}

/** The store's fresh record for stored root `guid` in the current world, or undefined (none, or stale). */
function storedFresh(guid: string): InstanceRecord | undefined {
  const st = storedInstances(getCurrentWorld()).get(guid);
  return st && !st.stale ? st.record : undefined;
}

/** The name document `source`'s root states, or undefined. */
export function templateRootName(source: string): string | undefined {
  const doc = getCachedPrefabSync(source) as PrefabFile | null;
  const root = doc ? rowAt(doc.entities, doc.rootLocalId ?? 1) : undefined;
  const name = (root?.traits.EntityAttributes as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/** Put the stored root's placement on its live root, with the marks today's form shows (see the header). */
function placeRoot(rootId: number, rec: InstanceRecord, folderMarked: boolean): void {
  const ea = getTraitByName('EntityAttributes');
  const e = findEntity(rootId);
  if (!ea || !e) return;
  const attrs = e.get(ea.trait) as Record<string, unknown>;
  e.set(ea.trait, { ...attrs, name: rec.placement.name, sortOrder: rec.placement.sortOrder, editorFolder: rec.placement.editorFolder ?? '' });
  if (rec.placement.name !== templateRootName(rec.source)) markOverride(e, 'EntityAttributes', 'name');
  else unmarkOverride(e, 'EntityAttributes', 'name');
  if (folderMarked) markOverride(e, 'EntityAttributes', 'editorFolder');
  else unmarkOverride(e, 'EntityAttributes', 'editorFolder');
}

/** `live`'s content, with `saved`'s for a node no live parse states: a node an undo brings back is not live yet. */
function withSavedContent(live: ReadonlyMap<string, ParsedInstance>, saved: ReadonlyMap<string, ParsedInstance>): Map<string, ParsedInstance> {
  const out = new Map(saved);
  for (const [g, p] of live) {
    const was = saved.get(g);
    out.set(g, was ? { ...p, ownContent: new Map([...was.ownContent, ...p.ownContent]) } : p);
  }
  return out;
}

export interface Reprojected {
  /** The outermost root's new ECS id. */
  root: number;
}

/**
 * Rebuild the instance tree that holds `entityId` from the store: its outermost projectable record
 * ({@link projectionRootOf}), which must be fresh. Returns the
 * outermost root's new id, or null when nothing could be rebuilt (no fresh record, its prefab not cached, or the tree
 * cannot be stated). A frame nested in it is found again by its guid, which the rebuild keeps. `saved`: scene-owned
 * content read earlier ({@link ownContentOf}), for a node the record links that is not live now (an undo's); `pinned`:
 * identity read earlier ({@link identitiesOf}), for a member that is not live now.
 */
export function reprojectFromStore(entityId: number, saved?: ReadonlyMap<string, ParsedInstance>,
  pinned?: ReadonlyMap<string, MemberIdentity>): Reprojected | null {
  const top = projectionRootOf(entityId);
  const world = getCurrentWorld();
  const rec = top ? freshInstanceRecord(world, guidOfEntity(top)) : undefined;
  if (!rec) return null;
  const prefab = getCachedPrefabSync(rec.source) as PrefabFile | null;
  if (!prefab) return null;
  const now = ownContentOf(top);
  if (!now) return null;
  const byGuid = saved ? withSavedContent(now, saved) : now;
  const entry = writtenEntryOf(rec, top, byGuid, pinned) as unknown as InstanceEntry;
  const folderMarked = !!(findEntity(top) && getOverrideMarkSet(findEntity(top)!)?.has('EntityAttributes.editorFolder'));
  const read = withFrameRecords(getCachedPrefabSync as ExpansionReader, top);
  const root = rebuildFromEntry(top, rec.source, prefab, entry, new Map(), prefab, read, undefined, INSTANCE_MODEL_SCENE_VERSION);
  const live = findEntityByGuid(rec.rootGuid)?.id() ?? root;
  placeRoot(live, rec, folderMarked);
  // Every other stored root of the tree (a reference node the scene added) takes the same name-mark rule; its value is
  // its record's `"/"` row's, which the fold applied.
  for (const id of storedRootsUnder(live)) {
    if (id === live) continue;
    const nested = freshInstanceRecord(world, guidOfEntity(id));
    const e = findEntity(id);
    if (!nested || !e) continue;
    if (nested.placement.name !== templateRootName(nested.source)) markOverride(e, 'EntityAttributes', 'name');
    else unmarkOverride(e, 'EntityAttributes', 'name');
  }
  return { root: live };
}
