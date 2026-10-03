/**
 * The scene save's instance entry (#2001 S6): **save writes the list** (rule 4; design § 3.4). A top-level instance, or
 * the Missing Prefab placeholder of one, is written from its STORED record by the instance model's writer
 * (`serializeInstanceRecord`, the scene v20 form), never by diffing its live tree against a template.
 *
 * ── What is not the record's ──
 * - **Placement** (parent, sibling order, folder): scene data, like a plain entity's, read off the live root
 *   ({@link placedAsLive}).
 * - **The content of a scene-owned node** (rule 7: the user's node is the scene's, the list holds its link). Until S8
 *   deletes the old capture it is that capture's inline form of the node (`ownContentOf`), read from the live tree; a
 *   reference node the scene added carries its own record's list, from the store.
 * - **A stale record** (an op that does not maintain the list yet marks it, § 10.7): re-seeded from the capture before
 *   it is written (`treeForWrite`), as the door re-seeds it before its own write.
 *
 * ── When there is no record to write ──
 * A root with no durable guid, or a tree the capture cannot state, has none (`treeForWrite` false). The caller's legacy
 * entry — what the old save wrote for it — is then CONVERTED: parsed by the rules of its own form and written by the
 * same writer, so the file still holds one form (the format rule).
 *
 * ── What the entry consumes ──
 * Every live node the written entry states by guid is the entry's, and is not also written as an entity of its own
 * (`consumed`). A scene-owned node under the instance that the entry does NOT state — a node no record links, which is a
 * write that went round the door — is left to the caller, which writes it as a plain entity parented by guid: the load
 * links it (`buildParentLinks`), so the save never drops a user's node because a record missed it (rule 1's data-loss
 * exception). It is reported (`unstated`).
 */
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, getAllEntities } from '../../runtime/core/ecs/entityUtils';
import type { ExpansionReader, SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import { recordsOf } from '../../runtime/prefab/instanceLoad';
import { parseInstanceRecord } from '../../runtime/prefab/parseInstanceRecord';
import { freshInstanceRecord, markStale } from '../../runtime/prefab/instanceStore';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import type { InstanceEntryJson } from '../../runtime/prefab/serializeInstanceRecord';
import { ROOT_ROW_KEY, type ParsedInstance, type PrefabDoc, type PrefabReader } from '../../runtime/prefab/instanceRecord';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { durableGuid, isStoredRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { withFrameRecords } from '../scene/prefabRebuild';
import { guidOfEntity, instanceKeyMap, storedRootsUnder } from './instanceKeys';
import { editorPrefabReader, treeForWrite } from './instanceSync';
import { ownContentOf, writtenEntryOf } from './instanceReproject';

type Bag = Record<string, unknown>;

export interface SavedInstance {
  entry: InstanceEntryJson;
  /** The live entities under the root that the entry states: not written as entities of their own. */
  consumed: number[];
  /** Live scene-owned nodes directly under one of the instance's nodes that the entry does not state (see the header). */
  unstated: number[];
}

/** A legacy entry for the root and the scene version its form reads as (see the header). */
export type LegacyEntry = () => { entry: SceneEntityEntry; version: number; consumed?: readonly number[] } | null;

/** The v20 entry the save writes for stored root `rootId` (an outermost one), or null when nothing can state it.
 *  `resolved`: the root's own document as the save resolved it, when the caches no longer hold it (see `read` below). */
export function savedEntryOf(rootId: number, legacy: LegacyEntry, resolved?: { source: string; doc: unknown }): SavedInstance | null {
  const world = getCurrentWorld();
  const guid = guidOfEntity(rootId);
  // The documents: the editor's caches, then the root's own as the save resolved it, then the ones this tree's live
  // frames were EXPANDED from (#1738). A prefab that stopped resolving mid-session is in no cache, and its frame is still
  // live at this save (the snapshot the trash's own reload is taken from, #2056): its members and the nodes hung in it
  // are stated against the document they came from.
  const frames = withFrameRecords(getCachedPrefabSync as ExpansionReader, rootId);
  const read: PrefabReader = (g) => {
    const cached = editorPrefabReader(g);
    if ('doc' in cached) return cached;
    const doc = (resolved && g === resolved.source ? resolved.doc : frames(g)) as PrefabDoc | null | undefined;
    return doc ? { doc } : cached;
  };
  // A member the live tree cannot KEY (a pre-v5 document's row carries no node guid, so its `PrefabInstance` has none)
  // is one the door cannot record on: an edit of it, or a node hung under it, reached no record, and the record stayed
  // fresh. The capture states such a member by its localId and the parse keys it (`preV5NodeGuid`), so the tree is
  // re-seeded from the capture before it is written, as a stale one is: written from the fresh record, the save dropped
  // a prefab instance the user had moved under such a member.
  if (guid && freshInstanceRecord(world, guid) && hasUnkeyedMember(rootId)) {
    markStale(world, 'unkeyedMembers', [rootId, ...storedRootsUnder(rootId)].map(guidOfEntity).filter(Boolean));
  }
  const wasFresh = !!guid && !!freshInstanceRecord(world, guid);
  const rec = guid && treeForWrite(rootId, world) ? freshInstanceRecord(world, guid) : undefined;
  // The live entities the capture states: asked for the nodes it states WITHOUT a guid (see `consumedBy`).
  const captured = new Set<number>();
  let content = rec ? ownContentOf(rootId, false, captured) : null;
  let converted: ParsedInstance[] | undefined;
  if (!content) {
    // No capture through the caches: the caller's legacy entry, parsed by the rules of its own form.
    const old = legacy();
    if (old) {
      for (const id of old.consumed ?? []) captured.add(id);
      const held = new Set<string>();
      const ea = getTraitByName('EntityAttributes')!;
      for (const e of world.entities) { const g = (e.get(ea.trait) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
      const opts = { held: (g: string) => held.has(g), sceneVersion: old.version };
      converted = recordsOf(parseInstanceRecord(old.entry, read, opts), read, opts);
      content = new Map(converted.map((p) => [p.record.rootGuid, p]));
    }
  }
  let entry: InstanceEntryJson;
  if (rec) entry = writtenEntryOf(rec, rootId, content ?? new Map(), undefined, undefined, read);
  else if (converted) entry = writtenEntryOf(converted[0].record, rootId, content!, undefined, (g) => content!.get(g)?.record, read);
  else return null;
  // Only where the entry IS the capture's statement (a record re-seeded from it here, or the converted legacy entry): a
  // record the door maintained links durable guids alone, and states no unguided node.
  return { entry, ...consumedBy(rootId, entry, rec && wasFresh ? new Set() : captured) };
}

/** Is a LINKED node of the tree at `rootId` (a member, or a nested frame's) one no row key names? */
function hasUnkeyedMember(rootId: number): boolean {
  const pi = getTraitByName('PrefabInstance');
  if (!pi) return false;
  const keyed = new Set<number>();
  for (const id of [rootId, ...storedRootsUnder(rootId)]) for (const k of instanceKeyMap(id).keys()) keyed.add(k);
  const all = getAllEntities();
  const parent = new Map(all.map((e) => [e.id, e.parentId] as const));
  const under = (id: number): boolean => { for (let a = parent.get(id) ?? 0, n = 0; a && n < 1024; a = parent.get(a) ?? 0, n++) if (a === rootId) return true; return false; };
  return all.some((e) => {
    if (keyed.has(e.id) || !under(e.id)) return false;
    const h = findEntity(e.id);
    return !!h && h.has(pi.trait) && !isStoredRoot(h.get(pi.trait) as MemberPi, e.id) && !unresolvedRefOf(h as never);
  });
}

/** Which live entities under `rootId` the entry states, and which scene-owned ones it does not. Stated means named by
 *  guid where a row names a NODE: a row's pin, a node in its `own` (or whole `added`) list, that node's children, and the
 *  rows of a reference node among them. A guid inside a component's value (an entity reference a member holds to a
 *  plain child) states nothing: read as a statement, that child was written nowhere and the save lost it. */
function consumedBy(rootId: number, entry: InstanceEntryJson, unguided: ReadonlySet<number>): { consumed: number[]; unstated: number[] } {
  const stated = new Set<string>();
  const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);
  const walkNode = (n: unknown): void => {
    if (!isBag(n)) return;
    if (typeof n.guid === 'string') stated.add(n.guid);
    if (Array.isArray(n.children)) for (const c of n.children) walkNode(c);
    walkRows(n.members);
  };
  const walkRows = (members: unknown): void => {
    if (!isBag(members)) return;
    for (const row of Object.values(members)) {
      if (!isBag(row)) continue;
      if (typeof row.guid === 'string') stated.add(row.guid);
      for (const list of [row.own, row.added]) if (Array.isArray(list)) for (const n of list) walkNode(n);
    }
  };
  walkRows(entry.members);
  const all = getAllEntities();
  const kids = new Map<number, number[]>();
  for (const e of all) if (e.parentId) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e.id]);
  const byId = new Map(all.map((e) => [e.id, e] as const));
  const consumed: number[] = [], unstated: number[] = [];
  // What the documents SUPPLY — a member, a template-added node, a row's placeholder — is the instance's whether or not
  // the entry says anything about it: this tree's, and each reference node's the scene added inside it.
  const supplied = new Set<number>();
  // (A reference node's own root is not supplied: the scene added it, and it is the entry's only where the entry states it.)
  for (const id of [rootId, ...storedRootsUnder(rootId)]) for (const sup of instanceKeyMap(id).keys()) if (sup !== id) supplied.add(sup);
  // …and so is every LINKED node whose key cannot be formed (a member of a pre-v5 document, which carries no node guid):
  // the expansion supplies it on the next load whatever the entry says, so written as an entity of its own it came back
  // twice. Only a node that carries no link and no template key, or that roots a record of its own, is the scene's.
  const pi = getTraitByName('PrefabInstance');
  const suppliedByLink = (id: number): boolean => {
    const e = findEntity(id);
    if (!e) return false;
    if (templateKeyOf(e as never)) return true;
    return !!pi && e.has(pi.trait) && !isStoredRoot(e.get(pi.trait) as MemberPi, id);
  };
  // Depth first: a stated node's whole subtree is the entry's; an unstated one's is left to the caller with it.
  const visit = (id: number, owned: boolean): void => {
    for (const kid of kids.get(id) ?? []) {
      const info = byId.get(kid)!;
      // A scene-owned node with no durable guid (spawned raw; the Play snapshot mints none, #1210) is written inline with
      // NO guid, and the entry states it under the guid its load will derive: no guid of the live node's can match. It
      // is the entry's where the capture the entry was made from consumed it; written again as an entity of its own it
      // came back twice after Stop.
      const mine = supplied.has(kid) || (!!info.guid && stated.has(info.guid)) || suppliedByLink(kid) || (unguided.has(kid) && !durableGuid(info.guid));
      if (mine) consumed.push(kid);
      else if (owned) unstated.push(kid);
      visit(kid, mine);
    }
  };
  visit(rootId, true);
  return { consumed, unstated };
}

/**
 * `entry` with its placement read off the live root (see the header), and — for a root that shows no instance (a Missing
 * Prefab placeholder, `placeholder`), or whose prefab does not resolve at this save (`missing`) — what the Hierarchy can
 * change on it stated where its next load reads it (#1818, #1895):
 * - a placeholder's NAME is its live one, on the `"/"` row and the entry;
 * - `isActive` goes on the `"/"` row when the row states it (a record), else on the entry's own `EntityAttributes` when
 *   it is not the default: the pass-1 placeholder of the next load reads it there, and a live instance's load does not,
 *   so the statement costs the prefab's return nothing and makes no record.
 */
export function placedAsLive(
  entry: InstanceEntryJson,
  live: { name: string; parentGuid: string; sortOrder: number; editorFolder: string; isActive: boolean },
  state: { placeholder: boolean; missing: boolean },
): InstanceEntryJson {
  const was = (entry.traits?.EntityAttributes ?? {}) as Bag;
  // In the trait's own key order (isActive, sortOrder, parentId, …), as `serializeInstanceRecord` writes it.
  const ea: Bag = {};
  ea.sortOrder = live.sortOrder;
  if (live.parentGuid) ea.parentId = live.parentGuid;
  if (live.editorFolder) ea.editorFolder = live.editorFolder;
  if (was.sourceScene) ea.sourceScene = was.sourceScene;
  const out: InstanceEntryJson = { ...entry, traits: { ...entry.traits, EntityAttributes: ea } };
  if (!state.placeholder && !state.missing) return out;
  const members = { ...(out.members as Record<string, Bag> | undefined) };
  const row = { ...(members[ROOT_ROW_KEY] ?? {}) };
  const rowTraits = { ...(row.traits as Bag | undefined) };
  const rowEa = { ...(rowTraits.EntityAttributes as Bag | undefined) };
  if (state.placeholder) { out.name = live.name; rowEa.name = live.name; }
  if ('isActive' in rowEa) rowEa.isActive = live.isActive;
  else if (live.isActive !== true) out.traits = { ...out.traits, EntityAttributes: { isActive: live.isActive, ...ea } };
  rowTraits.EntityAttributes = rowEa;
  members[ROOT_ROW_KEY] = { ...row, traits: rowTraits };
  out.members = members as InstanceEntryJson['members'];
  return out;
}

/** The live root's placement as {@link placedAsLive} reads it. */
export function livePlacement(rootId: number, parentGuid: string): Parameters<typeof placedAsLive>[1] {
  const ea = getTraitByName('EntityAttributes');
  const attrs = (ea ? findEntity(rootId)?.get(ea.trait) : undefined) as { name?: string; sortOrder?: number; editorFolder?: string; isActive?: boolean } | undefined;
  return { name: attrs?.name ?? '', parentGuid, sortOrder: attrs?.sortOrder ?? 0, editorFolder: attrs?.editorFolder ?? '', isActive: attrs?.isActive ?? true };
}
