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
import { markStale, setInstanceRecord } from './instanceStore';

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
  markParentLinked(world, data, opts);
  return out;
}

/** A plain scene entity a file parents INTO an instance by its `parentId` (a file-direct agent write, a hand edit) hangs
 *  there live, and today's save writes it as that node's `own` link, but no one owner's parse sees a sibling entity, so
 *  the record lacks the link. Until it is built at load (open with the hub, #2014), the records are marked stale: the
 *  door re-seeds them from the capture, which states the link, before it writes. */
function markParentLinked(world: World, data: { entities?: SceneEntityEntry[] }, opts: ParseOptions): void {
  const entities = Array.isArray(data.entities) ? data.entities : [];
  const plain = new Set<string>();
  for (const e of entities) {
    if (isInstanceEntry(e)) continue;
    const g = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.guid ?? e.guid;
    if (typeof g === 'string' && g) plain.add(g);
  }
  for (const e of entities) {
    if (isInstanceEntry(e)) continue;
    const ref = (e.traits?.EntityAttributes as Record<string, unknown> | undefined)?.parentId;
    const parent = ref === undefined || ref === 0 || ref === '' ? '' : (opts.parentGuid?.(ref) ?? (typeof ref === 'string' ? ref : ''));
    if (parent && !plain.has(parent)) { markStale(world, 'sceneParentLink'); return; }
  }
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
  try { markParentLinked(world, data, opts); } catch (err) { console.error(`[instanceStore] could not check the scene's parent links (#2001 S4): ${(err as Error)?.message ?? err}`); }
}
