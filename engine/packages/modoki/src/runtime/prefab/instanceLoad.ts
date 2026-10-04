/**
 * The load's half of the `InstanceStore` (#2001 S4, #2014): every stored owner a scene file states — each top-level
 * instance entry, and each reference node the scene added at any depth of its own content — parsed into the world's
 * store, beside the old expansion (design § 3.2, the load row; § 10.1).
 *
 * The parse reads the documents through `reader`, the runtime prefab cache the load seated. It never reads the scene's
 * `embeddedPrefabs` copies: rule 9 has no copy, so an instance whose prefab is missing is a placeholder with its list
 * kept, whatever today's expansion does with the copy (owner ruling B, § 5.4).
 */
import type { World } from 'koota';
import type { AddedEntity, SceneEntityEntry } from '../loaders/loadSceneFile';
import { getCachedPrefab } from '../loaders/meshTemplateCache';
import type { InstanceRecord, ParsedInstance, PrefabDoc, PrefabReader, RowKey, SceneOwnedNode } from './instanceRecord';
import { keyedNodeFrame, keylessNodeKey, parseInstanceRecord, parseReferenceNode, type ParseOptions } from './parseInstanceRecord';
import { ROOT_ROW_KEY } from './instanceRecord';
import { foldInstance } from './foldInstance';
import { serializeInstanceRecord, withWrittenList } from './serializeInstanceRecord';
import { dropInstanceRecord, renameInRecord, setInstanceRecord, storedInstance } from './instanceStore';
import { adoptBankedRecords, type RecordBank } from './recordBank';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { findEntityById, findEntityByGuid } from '../core/ecs/world';
import { instanceRowKeysIn } from '../core/ecs/memberRows';
import { isStoredRoot, type MemberPi } from '../core/assetRefRules';
import { templateKeyOf } from '../core/templateIdentity';
import { isPrefabEditRowGuid } from '../core/prefabEditRoot';
import { unresolvedRefOf } from '../core/unresolvedPrefabRef';

/** The runtime cache as a `PrefabReader`. A document the cache does not hold is `missing`. */
export const cachedPrefabReader: PrefabReader = (guid) => {
  const doc = getCachedPrefab(guid) as PrefabDoc | undefined;
  return doc ? { doc } : { missing: true };
};

/** Whether a scene entry is a stored instance root, as the load's entry loop decides it (`loadSceneFile`): a `prefab`
 *  ref, or a baked `PrefabInstance` whose `rootInstanceId` names the entry itself (or nothing). */
export function isInstanceEntry(entry: SceneEntityEntry): boolean {
  const pi = entry.traits?.PrefabInstance as Record<string, unknown> | undefined;
  const source = (entry.prefab as string | undefined) ?? (pi?.source as string | undefined);
  if (!source) return false;
  if (!pi || entry.prefab) return true;
  const root = pi.rootInstanceId as number | string | undefined;
  const guid = (entry.traits?.EntityAttributes as Record<string, unknown> | undefined)?.guid as string | undefined;
  return typeof root === 'string' ? root === '' || (!!guid && root === guid) : root === 0 || root === undefined || root === entry.id;
}

/** Every record one parsed owner implies: its own, then each scene reference node its scene-owned content holds, at any
 *  depth (a nested instance the scene added is its own `InstanceRecord`, linked by guid, § 2.5). */
export function recordsOf(parsed: ParsedInstance, read: PrefabReader, opts: ParseOptions): ParsedInstance[] {
  const out: ParsedInstance[] = [parsed];
  const walk = (node: SceneOwnedNode): void => {
    if (typeof node.prefab === 'string' && node.prefab && typeof node.guid === 'string') {
      const frame = keyedNodeFrame(node);
      const nested = parseReferenceNode(node as AddedEntity, read, opts);
      if (frame === undefined) {
        for (const p of recordsOf(nested, read, opts)) out.push(p);
        return;
      }
      // A reference node carrying a template KEY (a prefab-edit world's row states its document's nodes so) is a supplied
      // node of its enclosing frame, never a record of its own (design § 10.4b, hub 2026-10-02): what it states is this
      // owner's, on rows reaching into it (`<frame>/a+<key>…`, the key space the door writes it in). The template writer
      // puts them back on the node (`instanceTemplateRow.ts`).
      const at = `${frame === ROOT_ROW_KEY ? '' : frame}/a+${(node as { key: string }).key}`;
      for (const [k, row] of nested.record.list.rows) {
        const key = (k === ROOT_ROW_KEY ? at : `${at}${k}`) as RowKey;
        if (!parsed.record.list.rows.has(key)) parsed.record.list.rows.set(key, row);
      }
      for (const [g, n] of nested.ownContent) if (!parsed.ownContent.has(g)) parsed.ownContent.set(g, n);
      // What the node held of its own (a value no reader takes, a legacy channel no frame took): its owner holds it, as
      // it holds its rows, and the writer puts it back on the node (#2012).
      const { unparsed, pendingLegacy } = nested.record.held;
      if (unparsed || pendingLegacy) (parsed.record.held.keyedNodeHeld ??= new Map()).set(at as RowKey, { ...(unparsed ? { unparsed } : {}), ...(pendingLegacy ? { pendingLegacy } : {}) });
      for (const n of nested.ownContent.values()) walk(n);
      return;
    }
    for (const c of (node.children ?? []) as SceneOwnedNode[]) walk(c);
  };
  for (const node of [...parsed.ownContent.values()]) walk(node);
  return out;
}

/** The parse options a scene file implies: numeric (pre-v12) parent ids resolved through the file's own ids, the guids
 *  its entities hold (#1882), and whether it carried copies (§ 5.4). */
export function sceneParseOptions(data: { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown; version?: unknown }): ParseOptions {
  const guidById = new Map<unknown, string>();
  const held = new Set<string>();
  for (const e of data.entities ?? []) {
    const g = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.guid ?? e.guid;
    if (typeof g === 'string' && g) { guidById.set(e.id, g); held.add(g); }
  }
  // The FILE's own version, never a default (hub ruling 2026-10-02): from v20 the parser reads an entry differently, so
  // a guess misreads one side or the other. A scene without one is not parsed (the load path reports it).
  if (typeof data.version !== 'number') throw new Error(`the scene states no numeric version (${JSON.stringify(data.version)})`);
  return {
    parentGuid: (ref) => (typeof ref === 'string' ? ref : guidById.get(ref) ?? ''),
    held: (g) => held.has(g),
    sceneHadCopies: !!data.embeddedPrefabs,
    sceneVersion: data.version,
  };
}

/** Parse every stored owner of scene file `data` into `world`'s store. Returns the parsed owners, for a caller (a test)
 *  that wants the warnings. Later owners with the same root guid replace earlier ones, as a chain's later scene wins. */
export function fillInstanceStore(
  world: World, data: { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown; version?: unknown }, read: PrefabReader = cachedPrefabReader,
): ParsedInstance[] {
  const opts = sceneParseOptions(data);
  const out: ParsedInstance[] = [];
  for (const entry of data.entities ?? []) {
    if (!isInstanceEntry(entry)) continue;
    for (const p of recordsOf(parseInstanceRecord(entry, read, opts), read, opts)) {
      setInstanceRecord(world, p.record);
      out.push(p);
    }
  }
  buildParentLinks(world, data, opts);
  return out;
}

/** A plain scene entity a file parents INTO an instance by its `parentId` (a file-direct agent write, a hand edit) hangs
 *  there live, and today's save writes it as that node's `own` link, but no one owner's parse sees a sibling entity. Hub
 *  ruling (2026-10-02, design § 10.7): the LOADER builds the link, scene-wide, as a load-time conversion — the guid the
 *  file names is keyed through the live instance (`instanceRowKeysIn`, rule 5's guid → key), and the link goes on that
 *  key's row of the nearest record whose keys hold it (#2028, hunt seed 1061). A parent the walk cannot name — a node the
 *  user added, which no key names, or one in no record — links nothing, and the records stay as parsed (#2001 S8b): the
 *  save writes a node in no record as a plain entity under its parent (`serialize.ts`, warned), the form this file held
 *  it in. Before S8b such a load left every record stale, to be re-seeded from the capture; no corpus load reaches it.
 *  A parentId naming nothing is the loader's (today's placement, warned). */
function buildParentLinks(world: World, data: { entities?: SceneEntityEntry[] }, opts: ParseOptions): void {
  const entities = Array.isArray(data.entities) ? data.entities : [];
  const guidOf = (e: SceneEntityEntry): string => {
    const g = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.guid ?? e.guid;
    return typeof g === 'string' ? g : '';
  };
  const plain = new Set(entities.filter((e) => !isInstanceEntry(e)).map(guidOf).filter(Boolean));
  const ea = getTraitByName('EntityAttributes')?.trait;
  const pi = getTraitByName('PrefabInstance')?.trait;
  if (!ea || !pi) return;
  const parentOf = (id: number): number => ((findEntityById(id, world)?.get(ea) as { parentId?: number } | undefined)?.parentId ?? 0);
  const ownsRecord = (id: number): boolean => {
    const e = findEntityById(id, world);
    if (!e || templateKeyOf(e as never)) return false;
    return e.has(pi) ? isStoredRoot(e.get(pi) as MemberPi, id) : !!unresolvedRefOf(e as never);
  };
  const rootGuidOf = (id: number): string => ((findEntityById(id, world)?.get(ea) as { guid?: string } | undefined)?.guid ?? '');
  // One key walk per owner, not per linked entity (#2028 review F3: a walk is a world scan).
  const keysOf = new Map<number, Map<number, string>>();
  const keysIn = (owner: number) => keysOf.get(owner) ?? keysOf.set(owner, instanceRowKeysIn(owner, world, true)).get(owner)!;
  for (const e of entities) {
    if (isInstanceEntry(e)) continue;
    const ref = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.parentId;
    const parent = ref === undefined || ref === 0 || ref === '' ? '' : (opts.parentGuid?.(ref) ?? (typeof ref === 'string' ? ref : ''));
    if (!parent || plain.has(parent)) continue;
    const at = findEntityByGuid(parent, world)?.id();
    const child = guidOf(e);
    // A prefab-edit world's own row hung under a nested row (#1484) is the edited document's, never that instance's
    // content (`liveOwnContent` reads it as supplied): linked, a rebuild of the instance respawned it beside the row
    // its teardown parks and puts back.
    if (at === undefined || !child || isPrefabEditRowGuid(child)) continue;
    for (let a = at, n = 0; a && n < 1024; a = parentOf(a), n++) {
      if (!ownsRecord(a)) continue;
      const key = keysIn(a).get(at);
      if (key === undefined) continue;
      const st = storedInstance(world, rootGuidOf(a));
      if (!st) break;
      const rows = new Map(st.record.list.rows);
      const row = rows.get(key) ?? {};
      if (!(row.own ?? []).some((o) => o.guid === child)) rows.set(key, { ...row, own: [...(row.own ?? []), { guid: child }] });
      setInstanceRecord(world, { ...st.record, list: { ...st.record.list, rows } });
      // The nearest record whose keys hold the parent states the link, alone: an enclosing record states the node the
      // link went into as that node's own record (a scene-added reference node owns one inside its instance's, § 2.5),
      // which the save reads for it (`writtenEntryOf`), so it holds nothing of the link to restate (#2001 S8b).
      break;
    }
  }
}

/** A template-added node of a document from before #1937's mint carries no key, and its live node nothing that says it
 *  is the template's: no `PrefabInstance`, no template key, the guid its template states. The door reads it as the
 *  scene's own content, which no record links, so an edit or delete of it reached no record. The old capture stated such
 *  a node as the scene's own, on its anchor's row, and cut the template's (`removed` on its `a+<guid>` row); the load
 *  does the same to the record it parses (a load-time conversion, as `buildParentLinks`; #2001 S8b), so the door links
 *  it and a save writes what the capture wrote. A node under one it converts goes with it, as its content. Only a plain
 *  node that is live: a keyless reference node opens a frame of its own, and none is in the corpus. */
function ownKeylessTemplateNodes(world: World, rec: InstanceRecord, read: PrefabReader): void {
  if (!statesKeylessNode(read, rec.source, new Set())) return;
  const fold = foldInstance(read, rec);
  const converted = new Set<RowKey>();
  for (const [key, n] of fold.nodes) {
    if (!n.template || n.templateKey !== undefined || !n.parent || !('key' in n.parent)) continue;
    if (converted.has(n.parent.key)) { converted.add(key); continue; }
    const guid = keylessNodeKey(n.template);
    if (n.template.prefab || !guid || !findEntityByGuid(guid, world)) continue;
    const rows = rec.list.rows;
    rows.set(key, { ...rows.get(key), removed: true });
    const anchor = rows.get(n.parent.key) ?? {};
    if (!(anchor.own ?? []).some((o) => o.guid === guid)) rows.set(n.parent.key, { ...anchor, own: [...(anchor.own ?? []), { guid }] });
    converted.add(key);
  }
}

/** Does document `source`, or one its rows or added nodes reference, state a template-added node with no key? */
const keylessIn = new WeakMap<object, boolean>();
function statesKeylessNode(read: PrefabReader, source: string, seen: Set<string>): boolean {
  if (seen.has(source)) return false;
  seen.add(source);
  const got = read(source);
  const doc = 'doc' in got ? got.doc as PrefabDoc | undefined : undefined;
  if (!doc) return false;
  const memo = keylessIn.get(doc);
  if (memo !== undefined) return memo;
  const refs: string[] = [];
  const walk = (nodes: unknown): boolean => Array.isArray(nodes) && nodes.some((n: AddedEntity) => {
    if (typeof n.prefab === 'string' && n.prefab) refs.push(n.prefab);
    return !(typeof n.key === 'string' && n.key) || walk(n.children);
  });
  const own = (doc.entities ?? []).some((e) => {
    if (typeof e.prefab === 'string' && e.prefab) refs.push(e.prefab);
    return walk((e as { added?: unknown }).added);
  });
  const out = own || refs.some((r) => statesKeylessNode(read, r, seen));
  keylessIn.set(doc, out);
  return out;
}

/** {@link fillInstanceStore} for the load path, one owner at a time: an owner the parser throws on is reported and left
 *  unstored, never fails the load (the store is a shadow until S5). The report names the entry, for a parser defect. */
export function fillInstanceStoreReporting(
  world: World, data: { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown; version?: unknown }, bank?: RecordBank,
  /** Every guid the load renamed in the world before this parse (the scene v18 keyed-guid upgrade, #1809; a pin a
   *  derivation collided with): the file still names the old ones, and a record states the world as the load left it,
   *  as the store's own rename listener keeps an existing record (#2001 S8b). Old → final. */
  renamed: ReadonlyMap<string, string> = new Map(),
  /** The durable guid the load gave an entry's live root. A legacy entry that states none (pre-#1268) is recorded under
   *  it, as its first save and reload would record it: the store keys an instance by its root's guid, and a record
   *  keyed by none answered to no entity and was dropped below, leaving a tree the save must refuse (#2001 S8b). */
  rootGuidOf?: (entry: SceneEntityEntry) => string | undefined,
): void {
  let opts: ParseOptions;
  try { opts = sceneParseOptions(data); } catch (err) { console.error(`[instanceStore] could not read the scene's instance options (#2001 S4): ${(err as Error)?.message ?? err}`); return; }
  if (renamed.size) {
    const parentGuid = opts.parentGuid;
    opts = { ...opts, parentGuid: (ref) => { const g = parentGuid?.(ref) ?? ''; return renamed.get(g) ?? g; } };
  }
  const seeded: string[] = [];
  const partsOf = new Map<string, readonly ParsedInstance[]>();
  for (const entry of Array.isArray(data.entities) ? data.entities : []) {
    try {
      if (!isInstanceEntry(entry)) continue;
      const derived = !entry.guid ? rootGuidOf?.(entry) : undefined;
      const owner = derived ? { ...entry, guid: derived } : entry;
      const parts = recordsOf(parseInstanceRecord(owner, cachedPrefabReader, opts), cachedPrefabReader, opts);
      if (renamed.size) for (const p of parts) { renameInRecord(p.record, renamed); p.record.rootGuid = renamed.get(p.record.rootGuid) ?? p.record.rootGuid; }
      for (const p of parts) ownKeylessTemplateNodes(world, p.record, cachedPrefabReader);
      for (const p of parts) { setInstanceRecord(world, p.record); seeded.push(p.record.rootGuid); partsOf.set(p.record.rootGuid, parts); }
      // #2046 S7.6: a world the editor reloads from its own text takes back the exact lists it held (`recordBank.ts`).
      if (bank) adoptBankedRecords(world, bank, owner, parts.map((p) => p.record.rootGuid), cachedPrefabReader);
    } catch (err) {
      console.error(`[instanceStore] could not parse the instance record of "${entry.name ?? entry.guid}" (#2001 S4): ${(err as Error)?.message ?? err}`);
    }
  }
  try { buildParentLinks(world, data, opts); } catch (err) { console.error(`[instanceStore] could not build the scene's parent links (#2028): ${(err as Error)?.message ?? err}`); }
  // A record is a live stored root's (or a shown placeholder's). An inline reference node the load did not spawn — one
  // linked on a row whose member the template no longer has, HELD with that row — has no entity: its statement stays in
  // its owner's kept row, which is what the save writes it from, and a record of its own in the store would outlive its
  // owner's delete and answer for whatever later took its guid.
  for (const g of seeded) if (!findEntityByGuid(g, world)) dropInstanceRecord(world, g);
  for (const g of seeded) holdUnspawnedOwn(world, g, partsOf.get(g) ?? []);
  for (const g of new Set(seeded)) warnGoneRows(world, g);
}

/** R2 (#1468), said from the record (#2001 S8b): the rows of `rootGuid`'s list that name a member no document in its chain
 *  still declares — not one the instance or a layer under it removed (the document still has it), nor one under a frame
 *  whose prefab cannot be read (a placeholder: nothing can say it is gone), nor one a live member answers to — named, once per instance, by the name the
 *  row keeps, the one place it can still come from. The record keeps them and the save writes them back. */
function warnGoneRows(world: World, rootGuid: string): void {
  const rec = storedInstance(world, rootGuid)?.record;
  const root = findEntityByGuid(rootGuid, world);
  if (!rec || !root) return;
  const fold = foldInstance(cachedPrefabReader, rec);
  // …and never a row a LIVE member answers to (#2001 S6, #2125): the expansion that just ran produced it there.
  const live = new Set(instanceRowKeysIn(root.id(), world, true).values());
  const under = (key: string, frame: string): boolean => frame === ROOT_ROW_KEY || key === frame || key.startsWith(`${frame}/`);
  const removedAt = (key: string): boolean => [...rec.list.rows].some(([k, row]) => row.removed === true && under(key, k));
  const lost = [...rec.list.rows].filter(([key]) => key !== ROOT_ROW_KEY && !fold.nodes.has(key) && !live.has(key) && !fold.transit?.has(key)
    && !fold.innerRemoved?.has(key) && ![...fold.placeholders.keys()].some((f) => under(key, f)) && !removedAt(key));
  if (!lost.length) return;
  const named = lost.slice(0, 5).map(([k, r]) => `"${r.name || '?'}" (${k})`).join(', ');
  console.warn(`[loadSceneFile] ${lost.length} member row${lost.length === 1 ? '' : 's'} in instance ${rootGuid} name no node the template still declares: ${named}${lost.length > 5 ? `, +${lost.length - 5} more` : ''} — kept, in case the template edit is undone`);
}

/** The scene-owned nodes record `rootGuid` links that the load did not spawn — linked on a row the projection does not
 *  place (a member the template no longer has, one under a frame whose prefab is gone) — held on the record with their
 *  content as the file states it (`held.heldOwn`, #2001 S8b): the record is then their only home, and the save writes
 *  them from it. Before, the content stayed in the kept legacy stores and only the old capture wrote it back. A node
 *  that spawns again is read live, and is no longer held: kept held, the save wrote it from the record after the user
 *  deleted it, and a reload brought it back (#2001 S8b review R2). */
export function holdUnspawnedOwn(world: World, rootGuid: string, parts: readonly Pick<ParsedInstance, 'record' | 'ownContent'>[]): void {
  let st = storedInstance(world, rootGuid);
  if (!st) return;
  const was = st.record.held.heldOwn;
  if (was && [...was.values()].some((nodes) => nodes.some((n) => typeof n.guid === 'string' && findEntityByGuid(n.guid, world)))) {
    const kept = new Map<RowKey, SceneOwnedNode[]>();
    for (const [key, nodes] of was) {
      const still = nodes.filter((n) => !(typeof n.guid === 'string' && findEntityByGuid(n.guid, world)));
      if (still.length) kept.set(key, still);
    }
    const { heldOwn: _gone, ...rest } = st.record.held;
    setInstanceRecord(world, { ...st.record, held: kept.size ? { ...rest, heldOwn: kept } : rest });
    st = storedInstance(world, rootGuid)!;
  }
  const content = new Map<string, SceneOwnedNode>();
  for (const p of parts) for (const [g, n] of p.ownContent) if (!content.has(g)) content.set(g, n);
  if (!content.size) return;
  const recordOf = new Map(parts.map((p) => [p.record.rootGuid, p.record]));
  // In the written form: a reference node's list as its own record states it (`withWrittenList`), at any depth.
  const written = (node: SceneOwnedNode, seen: Set<string>): SceneOwnedNode => {
    const children = Array.isArray(node.children) ? (node.children as SceneOwnedNode[]).map((c) => written(c, seen)) : node.children;
    const guid = typeof node.guid === 'string' ? node.guid : '';
    const rec = typeof node.prefab === 'string' && node.prefab && guid && !seen.has(guid) ? recordOf.get(guid) : undefined;
    if (!rec) return { ...node, children } as SceneOwnedNode;
    const inner = new Set(seen).add(guid);
    const { entry } = serializeInstanceRecord(rec, { identity: new Map(), sceneOwned: (g) => { const n = content.get(g); return n ? written(n, inner) : undefined; } });
    return withWrittenList({ ...node, children } as SceneOwnedNode, entry, rec.placement.sortOrder);
  };
  let heldOwn: Map<RowKey, SceneOwnedNode[]> | undefined;
  for (const [key, row] of st.record.list.rows) {
    for (const { guid } of row.own ?? []) {
      const node = content.get(guid);
      if (!node || findEntityByGuid(guid, world)) continue;
      if (st.record.held.heldOwn?.get(key)?.some((n) => n.guid === guid)) continue;
      heldOwn ??= new Map([...(st.record.held.heldOwn ?? [])].map(([k, v]) => [k, [...v]]));
      heldOwn.set(key, [...(heldOwn.get(key) ?? []), written(node, new Set([rootGuid]))]);
    }
  }
  if (heldOwn) setInstanceRecord(world, { ...st.record, held: { ...st.record.held, heldOwn } });
}
