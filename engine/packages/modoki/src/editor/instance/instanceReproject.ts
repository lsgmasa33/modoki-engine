/**
 * Reproject an instance from its STORED record (#2001 S7, #2046): the record is the truth, and the live entities are
 * rebuilt from it (rule 2; design § 3.2's rebuild row; § 10.1: "S7 then moves each op onto its record … and that op
 * projects from the store").
 *
 * The unit is the OUTERMOST record (F6-U (i)): a frame nested in it, and a reference node the scene added under it (a
 * record of its own, § 2.5), are rebuilt with it. The record is written by the instance model's writer
 * (`serializeInstanceRecord`, v20) and LOADED back through the rebuild's own spawn and settle (`rebuildFromEntry` with the
 * v20 version): the same path the fuzzer's P1 seam projects every record through after every op and compares with the
 * live tree (`prefabFuzz/s5Seams.ts`), so a reprojection of an unchanged record changes nothing the user sees.
 *
 * ── What is not the record's ──
 * - The CONTENT of a scene-owned node (rule 7: the user's node is scene data, the list holds its link). Until S6's adapter
 *   reads it off the live tree, it is the old capture's inline form of it (`ownContentOf`), read BEFORE the rebuild.
 */
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity } from '../../runtime/core/ecs/entityUtils';
import { openIdentityScope, closeIdentityScope } from '../../runtime/core/ecs/identityParents';
import { INSTANCE_MODEL_SCENE_VERSION } from '../../runtime/core/version';
import type { AddedEntity, ExpansionReader } from '../../runtime/loaders/loadSceneFile';
import { holdUnspawnedOwn, recordsOf } from '../../runtime/prefab/instanceLoad';
import { parseInstanceRecord, parseReferenceNode } from '../../runtime/prefab/parseInstanceRecord';
import { dropInstanceRecord, storedRecord, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import { serializeInstanceRecord, withHeldBack, withWrittenList, type MemberIdentity, type SupersededValue } from '../../runtime/prefab/serializeInstanceRecord';
import { ROOT_ROW_KEY, type InstanceRecord, type ParsedInstance, type PrefabReader, type RowKey, type SceneOwnedNode, type SceneTargetRecord, type TemplateHeldData } from '../../runtime/prefab/instanceRecord';
import type { InstanceEntry } from '../scene/instanceEntry';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { keyedForRebuild, rebuildFromRecord, withFrameRecords } from '../scene/prefabRebuild';
import type { PrefabFile } from '../scene/prefab';
import { expandsToRoot } from '../../runtime/loaders/prefabRoot';
import { frameRepeatRefusal } from '../../runtime/loaders/frameRepeat';
import { rootReferenceRefusal } from '../../runtime/loaders/variantForm';
import { allStoredRoots, guidOfEntity, projectionRootOf, storedRootsUnder } from './instanceKeys';
import { templateRootName } from './instanceOverrideView';
import { liveOwnContent, type OwnContent } from './instanceOwnContent';
export { templateRootName };
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

/** Does `rec` link a user's node the fold would not place (an `own` link left unused: its anchor gone from the template —
 *  an outside edit, a prefab-edit save) that the record does not HOLD? Such a node is live only until a rebuild from the
 *  record, which does not spawn it, and then nothing states it: the save would lose it (hunt seed 7541). A node the record
 *  holds (`held.heldOwn`, #2001 S8b) is not live and needs no place: the record states it, and the save writes it. */
export function linksUnplacedNode(rec: InstanceRecord): boolean {
  const held = new Set([...(rec.held.heldOwn?.values() ?? [])].flat().map((n) => n.guid));
  return foldInstance(editorPrefabReader, rec).unused.some((u) => u.part.kind === 'own' && !held.has(u.part.guid));
}

/** May the fan-out reproject the tree at outermost projectable root `top` from its records (#2046 S7.3)? Every record in
 *  it stored, and none linking a user's node a rebuild would lose: one neither live nor held, placed by the fold or not
 *  (a LIVE one's content is read off the tree before the rebuild, and the reprojection holds it, #2001 S8b). A placed
 *  one that is not live is a record the tree disagrees with — a Stop that seats back the link to a node a preview deleted
 *  (#2141), an op that unlinked and destroyed one and threw — and its content is nowhere: the rebuild spawns nothing for
 *  it, and the save writes the link alone. */
export function reprojectsExactly(top: number): boolean {
  const world = getCurrentWorld();
  for (const id of [top, ...storedRootsUnder(top)]) {
    const rec = storedRecord(world, guidOfEntity(id));
    if (!rec || linksLostNode(rec)) return false;
  }
  return true;
}

/** Does `rec` link a user's node that is neither held nor live — unused ({@link linksUnplacedNode}, less a live one), or
 *  placed with no live node to read its content off (#2141)? */
function linksLostNode(rec: InstanceRecord): boolean {
  const held = new Set([...(rec.held.heldOwn?.values() ?? [])].flat().map((n) => n.guid));
  const lost = (g: string) => !held.has(g) && !findEntityByGuid(g);
  const fold = foldInstance(editorPrefabReader, rec);
  return fold.unused.some((u) => u.part.kind === 'own' && lost(u.part.guid)) || [...fold.anchors.values()].some((ns) => ns.some((n) => lost(n.guid)));
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
 *  `recordOf`: where a nested record is read from (default: the store's). `read`: the documents the members'
 *  identity is narrowed by (default: the editor's caches). `superseded`: told, per owner, each held value the written
 *  form stated something else in place of (the serializer's report), for the save to say (rule 1's exception). */
export function writtenEntryOf(rec: InstanceRecord, rootId: number | undefined, byGuid: ReadonlyMap<string, ParsedInstance> | OwnContent,
  pinned?: ReadonlyMap<string, MemberIdentity>, recordOf: (guid: string) => InstanceRecord | undefined = storedFresh,
  read: PrefabReader = editorPrefabReader,
  superseded?: (ownerGuid: string, values: readonly SupersededValue[]) => void): ReturnType<typeof serializeInstanceRecord>['entry'] {
  // The content of a scene-owned node: the live tree's (`instanceOwnContent.ts`), or a capture's parse.
  const live = 'node' in byGuid ? byGuid as OwnContent : undefined;
  const parsed = live ? undefined : (byGuid as ReadonlyMap<string, ParsedInstance>).get(rec.rootGuid);
  const contentOf = (g: string, key: RowKey): SceneOwnedNode | undefined => (live ? live.node(g, { rootGuid: rec.rootGuid, key }) : parsed?.ownContent.get(g));
  // What a keyed node held of its own, put back on it (#2012): the record holds it under `<frame>/a+<key>`, the frame the
  // one holding `anchor` (the row that links the node's content), the deepest such.
  const keyedHeld = rec.held.keyedNodeHeld;
  const heldBack: SupersededValue[] = [];
  const keyedHeldOf = (key: string, anchor: RowKey) => {
    let best: { frame: string; held: TemplateHeldData } | undefined;
    for (const [k, held] of keyedHeld ?? []) {
      const marker = `/a+${key}`;
      if (!k.endsWith(marker)) continue;
      const frame = k.slice(0, -marker.length);
      if (frame && anchor !== frame && !anchor.startsWith(`${frame}/`)) continue;
      if (!best || frame.length > best.frame.length) best = { frame, held };
    }
    return best?.held;
  };
  const inline = (node: SceneOwnedNode, anchor: RowKey): SceneOwnedNode => {
    const children = Array.isArray(node.children) ? (node.children as SceneOwnedNode[]).map((c) => inline(c, anchor)) : node.children;
    if (typeof node.prefab !== 'string' || !node.prefab || typeof node.guid !== 'string') return { ...node, children } as SceneOwnedNode;
    const nested = recordOf(node.guid);
    // A template-KEYED reference node (a prefab-edit row's own, design § 10.4b) is a supplied node of its frame, with no
    // record of its own: its interior is the rows its owner keys `<frame>/a+<key>…`. The live read of it states that
    // interior again, against the documents now read, where a nested row they dropped reads as a node the user added —
    // and a rebuild from it brought the dropped row back, with every node under it (#2001 S8b step 5).
    if (!nested && typeof node.key === 'string' && node.key) {
      const { members: _interior, ...own } = node as SceneOwnedNode & { members?: unknown };
      const held = keyedHeldOf(node.key, anchor);
      return (held ? withHeldBack({ ...own, children }, held, heldBack) : { ...own, children }) as SceneOwnedNode;
    }
    if (!nested || (!live && !(byGuid as ReadonlyMap<string, ParsedInstance>).has(node.guid))) return { ...node, children } as SceneOwnedNode;
    const liveId = live?.idOf(node.guid) ?? allStoredRoots().find((id) => guidOfEntity(id) === node.guid);
    return withWrittenList({ ...node, children } as SceneOwnedNode, writtenEntryOf(nested, liveId, byGuid, pinned, recordOf, read, superseded), nested.placement.sortOrder);
  };
  const written = serializeInstanceRecord(rec, {
    identity: identityIn(rootId, rec, pinned?.get(rec.rootGuid), read),
    sceneOwned: (g, key) => { const n = contentOf(g, key); return n ? inline(n, key) : undefined; },
  });
  if (written.superseded.length || heldBack.length) superseded?.(rec.rootGuid, [...written.superseded, ...heldBack]);
  return written.entry;
}

/** Each held reference node in `nodes` that a rebuild spawned again (live, with no record): its record, and the records of
 *  the reference nodes inside it, parsed from the statement its owner held, against `docs`. */
function seatReturnedHeld(nodes: readonly SceneOwnedNode[], docs: ExpansionReader): void {
  const world = getCurrentWorld();
  const read: PrefabReader = (g) => { const doc = docs(g); return doc ? { doc: doc as never } : editorPrefabReader(g); };
  const held = new Set<string>();
  const ea = getTraitByName('EntityAttributes')!.trait;
  for (const e of world.entities) { const g = (e.get(ea) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
  const opts = { held: (g: string) => held.has(g), sceneVersion: INSTANCE_MODEL_SCENE_VERSION };
  for (const n of nodes) {
    if (!findEntityByGuid(n.guid as string, world) || storedRecord(world, n.guid as string)) continue;
    for (const p of recordsOf(parseReferenceNode(n as AddedEntity, read, opts), read, opts)) {
      if (findEntityByGuid(p.record.rootGuid, world) && !storedRecord(world, p.record.rootGuid)) setInstanceRecord(world, p.record);
    }
  }
}

/** The records of the owners in `owners`, parsed again from `entry` (a written v20 entry) against `docs`. */
function reparseHeld(entry: InstanceEntry, docs: ExpansionReader, owners: ReadonlySet<string>): void {
  const world = getCurrentWorld();
  const read: PrefabReader = (g) => { const doc = docs(g); return doc ? { doc: doc as never } : editorPrefabReader(g); };
  const held = new Set<string>();
  const ea = getTraitByName('EntityAttributes')!.trait;
  for (const e of world.entities) { const g = (e.get(ea) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
  const opts = { held: (g: string) => held.has(g), sceneVersion: INSTANCE_MODEL_SCENE_VERSION };
  for (const p of recordsOf(parseInstanceRecord(entry as never, read, opts), read, opts)) {
    if (!owners.has(p.record.rootGuid) || !findEntityByGuid(p.record.rootGuid, world)) continue;
    // The nodes the owner HOLDS (`held.heldOwn`: linked, anchor not projected) stay held: the entry states each as a
    // link, which the parse reads as a plain one, and `holdUnspawnedOwn` re-holds only what was live before the rebuild.
    const was = storedRecord(world, p.record.rootGuid)?.held.heldOwn;
    setInstanceRecord(world, was?.size ? { ...p.record, held: { ...p.record.held, heldOwn: was } } : p.record);
  }
}

/** Every record of the tree at `top`, with the content of each node it links that is live (`liveOwnContent`, what
 *  the save writes): read BEFORE a rebuild, for a node the rebuild does not spawn. The capture's parse cannot give it:
 *  it reads the tree against the documents now cached, where the anchor such a node hangs under is gone. */
function linkedContentOf(top: number): Pick<ParsedInstance, 'record' | 'ownContent'>[] {
  const world = getCurrentWorld();
  const live = liveOwnContent();
  const out: Pick<ParsedInstance, 'record' | 'ownContent'>[] = [];
  for (const id of [top, ...storedRootsUnder(top)]) {
    const rec = storedRecord(world, guidOfEntity(id));
    if (!rec) continue;
    const ownContent = new Map<string, SceneOwnedNode>();
    for (const [key, row] of rec.list.rows) {
      for (const { guid } of row.own ?? []) {
        const n = live.idOf(guid) ? live.node(guid, { rootGuid: rec.rootGuid, key }) : undefined;
        if (n) ownContent.set(guid, n);
      }
    }
    out.push({ record: rec, ownContent });
  }
  return out;
}

/** The rows of template-keyed reference node `node` (a prefab-edit row's own): it has no record of its own, and its rows
 *  are the rows of the record that links it, keyed `<frame>/a+<key>…` (`recordsOf`), here by the node's own keys. Undefined
 *  when no record among `records` links it. */
function keyedInterior(node: { guid?: string; key?: string }, records: readonly InstanceRecord[]): Map<RowKey, SceneTargetRecord> | undefined {
  if (!node.key) return undefined;
  for (const rec of records) {
    const anchor = [...rec.list.rows].find(([, row]) => row.own?.some((o) => o.guid === node.guid))?.[0];
    if (anchor === undefined) continue;
    const marker = `/a+${node.key}`;
    const out = new Map<RowKey, SceneTargetRecord>();
    for (const [k, row] of rec.list.rows) {
      const at = k.indexOf(marker);
      if (at < 0 || (k.length > at + marker.length && k[at + marker.length] !== '/')) continue;
      const rest = k.slice(at + marker.length);
      out.set((rest || ROOT_ROW_KEY) as RowKey, row);
    }
    return out;
  }
  return undefined;
}

/** The store's record for stored root `guid` in the current world, or undefined. */
function storedFresh(guid: string): InstanceRecord | undefined {
  return storedRecord(getCurrentWorld(), guid);
}

/** Put the stored root's placement on its live root. */
function placeRoot(rootId: number, rec: InstanceRecord): void {
  const ea = getTraitByName('EntityAttributes');
  const e = findEntity(rootId);
  if (!ea || !e) return;
  const attrs = e.get(ea.trait) as Record<string, unknown>;
  e.set(ea.trait, { ...attrs, name: rec.placement.name, sortOrder: rec.placement.sortOrder, editorFolder: rec.placement.editorFolder ?? '' });
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

/** Pin, on each record of the rebuilt tree at `top`, every member the save pins that its row does not
 *  ({@link identityOf}): a member a template change brought in (an Apply's fan-out adding a row, an outside edit putting
 *  one back). A placement pins its members and a load parses the pins the save wrote, so every other record holds them;
 *  one such member's pin was the live tree's alone, and an outside edit that later took the member out of its template
 *  dropped it, where a save + reload keeps it (rule 5; hunt seed 9457). A pin is identity, not an override (P5). An
 *  Apply's fan-out (`prefabRebuild.ts`) calls it after its reprojection, its undo covering every tree it reached. */
export function pinBuiltMembers(top: number): void {
  const world = getCurrentWorld();
  for (const id of [top, ...storedRootsUnder(top)]) {
    const g = guidOfEntity(id);
    const r = storedRecord(world, g);
    if (!r) continue;
    const missing = [...identityOf(id)].filter(([key]) => r.list.rows.get(key as RowKey)?.guid === undefined);
    if (!missing.length) continue;
    const next = structuredClone(r);
    for (const [key, pin] of missing) {
      const row = next.list.rows.get(key as RowKey);
      if (row) { row.guid = pin.guid; if (row.name === undefined && pin.name !== undefined) row.name = pin.name; }
      else next.list.rows.set(key as RowKey, { ...pin });
    }
    setInstanceRecord(world, next);
  }
}

/** `byGuid` with each node of `parts` ({@link linkedContentOf}) its parse does not hold, and an entry for each record of
 *  `parts` it has none for: with no `saved` content (every caller but an undo's) `byGuid` starts empty, and a record
 *  missing from it wrote none of the nodes it links — what the reparse then replaced the record with, so a node the user
 *  added under the instance was gone after the Refresh that converted its held legacy statement (#2001 S8b review R1). */
function withLinkedContent(byGuid: ReadonlyMap<string, ParsedInstance>, parts: readonly Pick<ParsedInstance, 'record' | 'ownContent'>[]): Map<string, ParsedInstance> {
  const out = new Map(byGuid);
  for (const { record, ownContent } of parts) {
    const p = out.get(record.rootGuid);
    out.set(record.rootGuid, p ? { ...p, ownContent: new Map([...ownContent, ...p.ownContent]) } : { record, ownContent: new Map(ownContent), warnings: [] });
  }
  return out;
}

export interface Reprojected {
  /** The outermost root's new ECS id. */
  root: number;
}

/** What a projection of the tree at outermost stored root `top` reads beyond its record (`rebuildFromRecord`'s `store`),
 *  all taken BEFORE a teardown: the tree's records, the content of every scene-owned node they link (the live tree's,
 *  `saved`'s for one an undo brings back, a record's held node), each record's present members' identity (a pin taken
 *  earlier, the live one over it, narrowed to what the record's fold builds), and a template-keyed node's rows. */
export function projectionStoreOf(top: number, saved?: ReadonlyMap<string, ParsedInstance>, pinned?: ReadonlyMap<string, MemberIdentity>): Parameters<typeof rebuildFromRecord>[4] {
  const world = getCurrentWorld();
  const ownContent = new Map<string, SceneOwnedNode>();
  for (const p of saved?.values() ?? []) for (const [g, n] of p.ownContent) ownContent.set(g, n);
  // A node a record HOLDS (its anchor not projected when it was held, `held.heldOwn`) is stated by the record itself: what
  // a projection that anchors it again spawns.
  for (const id of [top, ...storedRootsUnder(top)]) {
    for (const nodes of storedRecord(world, guidOfEntity(id))?.held.heldOwn?.values() ?? []) for (const n of nodes) if (n.guid) ownContent.set(n.guid, n);
  }
  const liveContent = liveOwnContent();
  const liveRoots = new Map<string, number>();
  for (const id of [top, ...storedRootsUnder(top)]) {
    const g = guidOfEntity(id);
    const r = storedRecord(world, g);
    if (!r) continue;
    liveRoots.set(g, id);
    for (const [key, row] of r.list.rows) {
      for (const { guid } of row.own ?? []) {
        const n = liveContent.node(guid, { rootGuid: g, key });
        if (n) ownContent.set(guid, n);
      }
    }
  }
  const identities = new Map<string, MemberIdentity>();
  for (const [g, id] of liveRoots) { const r = storedRecord(world, g); if (r) identities.set(g, identityIn(id, r, pinned?.get(g))); }
  const records = [top, ...storedRootsUnder(top)].map((id) => storedRecord(world, guidOfEntity(id))).filter((r): r is InstanceRecord => !!r);
  return {
    record: (g) => storedRecord(world, g),
    ownContent,
    identity: (r) => identities.get(r.rootGuid) ?? identityIn(undefined, r, pinned?.get(r.rootGuid)),
    interiorOf: (node) => keyedInterior(node, records),
  };
}

/**
 * Rebuild the instance tree that holds `entityId` from the store: its outermost projectable record
 * ({@link projectionRootOf}), which must be stored. Returns the
 * outermost root's new id, or null when nothing could be rebuilt (no record, its prefab not cached, or the tree
 * cannot be stated), `opts.refused` saying why. A frame nested in it is found again by its guid, which the rebuild keeps.
 * `saved`: scene-owned content read earlier ({@link ownContentOf}), for a node the record links that is not live now (an undo's); `pinned`:
 * identity read earlier ({@link identitiesOf}), for a member that is not live now.
 */
export function reprojectFromStore(entityId: number, saved?: ReadonlyMap<string, ParsedInstance>,
  pinned?: ReadonlyMap<string, MemberIdentity>,
  opts: {
    /** Filled with the ids of every entity in a frame the rebuild kept live, unexpanded (`rebuildFromEntry`'s). */
    keptOut?: Set<number>;
    /** A refresh's document for `source`, read in place of the cached one (production callers write the cache first,
     *  so the two agree there; #1880 F7d). */
    refresh?: { source: string; to: unknown };
    /** Filled, when it returns null, with why — what a caller that leaves the tree as it was says (#2001 S8b). */
    refused?: { why?: string };
  } = {}): Reprojected | null {
  const { keptOut, refresh, refused } = opts;
  const refuse = (why: string): null => { if (refused) refused.why = why; return null; };
  const top = projectionRootOf(entityId);
  const world = getCurrentWorld();
  const rec = top ? storedRecord(world, guidOfEntity(top)) : undefined;
  if (!rec) return refuse('it holds no record');
  const docs: ExpansionReader = refresh
    ? (ref) => (ref === refresh.source ? refresh.to as ReturnType<ExpansionReader> : getCachedPrefabSync(ref))
    : getCachedPrefabSync as ExpansionReader;
  const prefab = docs(rec.source) as PrefabFile | null;
  if (!prefab) return refuse(`its prefab ${rec.source} is not loaded`);
  // A document that expands to no root, or gives one key two nodes, builds nothing: `rebuildFromEntry` would leave the
  // tree standing. Not reprojected, so a caller says why (#1768, #1933 L5) rather than count a rebuild.
  const read = withFrameRecords(docs, top);
  const variant = rootReferenceRefusal(prefab);
  if (variant || !expandsToRoot(prefab, read as typeof getCachedPrefabSync)) return refuse(variant ?? 'the prefab expands to no root');
  const repeat = frameRepeatRefusal(prefab, (g) => read(g) ?? null);
  if (repeat) return refuse(repeat);
  const parts = linkedContentOf(top);
  // A legacy statement a record HELD because no frame of the documents took it (a nested frame they lacked, #1780)
  // converts once the documents now read give that frame: the record is written and parsed again, as a reload of the
  // same scene parses it, and each owner that held one takes its new record before the projection. Kept held, the save
  // wrote the old channel back after the frame had taken it.
  const heldLegacy = new Set(parts.filter((p) => p.record.held.pendingLegacy).map((p) => p.record.rootGuid));
  if (heldLegacy.size) {
    const byGuid = withLinkedContent(saved ? withSavedContent(new Map(), saved) : new Map(), parts);
    reparseHeld(writtenEntryOf(rec, top, byGuid, pinned) as unknown as InstanceEntry, docs, heldLegacy);
  }
  const from = storedRecord(world, rec.rootGuid) ?? rec;
  // The reference nodes the records HOLD (`held.heldOwn`: linked, their anchor not projected), in the written form the
  // record states them in: one whose anchor the documents now read give back is spawned by the rebuild, and its own record
  // is parsed from that statement below, as a load parses it (the rebuild that held it dropped it, as a load does).
  const heldRefs = parts.flatMap((p) => [...(storedRecord(world, p.record.rootGuid)?.held.heldOwn?.values() ?? [])].flat())
    .filter((n) => typeof n.prefab === 'string' && n.prefab && typeof n.guid === 'string' && n.guid);
  const root = rebuildFromRecord(top, from, prefab, read, projectionStoreOf(top, saved, pinned), keptOut);
  if (heldRefs.length) seatReturnedHeld(heldRefs, docs);
  // A node the records link that the rebuild did not spawn — its anchor gone from the documents now read (an Apply that
  // removed the member it hung under, hunt seed 9317) — is held on its record, and a reference node's own record goes, as
  // a load does (`instanceSync.ts`'s seat, #2001 S8b). Before, such a tree was rebuilt from the capture.
  for (const p of parts) if (!findEntityByGuid(p.record.rootGuid, world)) dropInstanceRecord(world, p.record.rootGuid);
  for (const p of parts) holdUnspawnedOwn(world, p.record.rootGuid, parts);
  const live = findEntityByGuid(rec.rootGuid)?.id() ?? root;
  placeRoot(live, from);
  return { root: live };
}
