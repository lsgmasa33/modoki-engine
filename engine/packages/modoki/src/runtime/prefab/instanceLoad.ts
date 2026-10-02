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
import type { ParsedInstance, PrefabDoc, PrefabReader, SceneOwnedNode } from './instanceRecord';
import { parseInstanceRecord, parseReferenceNode, type ParseOptions } from './parseInstanceRecord';
import { markStale, setInstanceRecord, storedInstance } from './instanceStore';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { findEntityById, findEntityByGuid } from '../core/ecs/world';
import { instanceRowKeysIn } from '../core/ecs/memberRows';
import { isStoredRoot, type MemberPi } from '../core/assetRefRules';
import { templateKeyOf } from '../core/templateIdentity';
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
      for (const p of recordsOf(parseReferenceNode(node as AddedEntity, read, opts), read, opts)) out.push(p);
      return;
    }
    for (const c of (node.children ?? []) as SceneOwnedNode[]) walk(c);
  };
  for (const node of parsed.ownContent.values()) walk(node);
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
 *  user added, which no key names, or one in no record — leaves that tree's records stale, as before: the door re-seeds
 *  them from the capture, which states the link. A parentId naming nothing is the loader's (today's placement, warned). */
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
  const keysIn = (owner: number) => keysOf.get(owner) ?? keysOf.set(owner, instanceRowKeysIn(owner, world)).get(owner)!;
  // Marked once, after the walk: a mark scans the world (#2028 close-out review). `all`: some link could not be built.
  let all = false;
  const enclosing = new Set<string>();
  try {
    for (const e of entities) {
      if (isInstanceEntry(e)) continue;
      const ref = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.parentId;
      const parent = ref === undefined || ref === 0 || ref === '' ? '' : (opts.parentGuid?.(ref) ?? (typeof ref === 'string' ? ref : ''));
      if (!parent || plain.has(parent)) continue;
      const at = findEntityByGuid(parent, world)?.id();
      const child = guidOf(e);
      if (at === undefined || !child) continue;
      let linked = 0;
      for (let a = at, n = 0; a && n < 1024; a = parentOf(a), n++) {
        if (!ownsRecord(a)) continue;
        if (linked) {
          // An enclosing record restates the node the link went into (a scene-added reference node owns a record inside
          // its instance's, § 2.5): it is re-seeded before it is read, as #2037's copy stales every enclosing record.
          enclosing.add(rootGuidOf(a));
          continue;
        }
        const key = keysIn(a).get(at);
        if (key === undefined) continue;
        const st = storedInstance(world, rootGuidOf(a));
        if (!st || st.stale) break;
        const rows = new Map(st.record.list.rows);
        const row = rows.get(key) ?? {};
        if (!(row.own ?? []).some((o) => o.guid === child)) rows.set(key, { ...row, own: [...(row.own ?? []), { guid: child }] });
        setInstanceRecord(world, { ...st.record, list: { ...st.record.list, rows } });
        linked = a;
      }
      // Not linked: every record is re-seeded from the capture before it is read, as before S5 (review F3: marking the
      // nearest owner alone left an enclosing record fresh without the link).
      if (!linked) all = true;
    }
  } catch (err) {
    // A throw part-way leaves later links unbuilt: nothing is read fresh then.
    markStale(world, 'sceneParentLink');
    throw err;
  }
  if (all) markStale(world, 'sceneParentLink');
  else if (enclosing.size) markStale(world, 'sceneParentLink', [...enclosing]);
}

/** {@link fillInstanceStore} for the load path, one owner at a time: an owner the parser throws on is reported and left
 *  unstored, never fails the load (the store is a shadow until S5). The report names the entry, for a parser defect. */
export function fillInstanceStoreReporting(world: World, data: { entities?: SceneEntityEntry[]; embeddedPrefabs?: unknown; version?: unknown }): void {
  let opts: ParseOptions;
  try { opts = sceneParseOptions(data); } catch (err) { console.error(`[instanceStore] could not read the scene's instance options (#2001 S4): ${(err as Error)?.message ?? err}`); return; }
  for (const entry of Array.isArray(data.entities) ? data.entities : []) {
    try {
      if (!isInstanceEntry(entry)) continue;
      for (const p of recordsOf(parseInstanceRecord(entry, cachedPrefabReader, opts), cachedPrefabReader, opts)) setInstanceRecord(world, p.record);
    } catch (err) {
      console.error(`[instanceStore] could not parse the instance record of "${entry.name ?? entry.guid}" (#2001 S4): ${(err as Error)?.message ?? err}`);
    }
  }
  try { buildParentLinks(world, data, opts); } catch (err) { console.error(`[instanceStore] could not build the scene's parent links (#2028): ${(err as Error)?.message ?? err}`); }
}
