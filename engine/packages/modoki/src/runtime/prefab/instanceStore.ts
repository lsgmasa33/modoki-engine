/**
 * `InstanceStore`: the per-world map from a stored instance root's guid to its `InstanceRecord` (#2001 S4, #2014).
 *
 * Rule 2 (docs/prefabs.md § High-level rules): an instance IS its prefab plus its list. This store holds the list.
 * Design: docs/plans/prefab-instance-model.md § 3.2 (the load row) and § 10.1 (S4: store + shadow).
 *
 * ── What reads it ──
 * Since #2001 S5-S7 the store IS the instance: the loader parses every stored owner into it, every gesture writes its
 * record through the door (`editor/instance/instanceEdits.ts`), the save writes the list (`serializeInstanceRecord`), and
 * a rebuild projects from it. Every op keeps its records (#2001 S8b): one that cannot refuses before it changes anything,
 * and one that throws part-way rolls the store back (`editor/instance/instanceRollback.ts`). There is no stale record:
 * the mark that once said "this op changed the record without the door" went with the last op that set it (#2001 S8b).
 *
 * Keyed per world (`WeakMap<World, …>`), like the loader's other per-world state (`identityParents.ts`): a prefab-edit
 * world and the scene world under it are separate stores, and a dropped world takes its store with it.
 */
import type { World } from 'koota';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { isStoredRoot, mapStringValues } from '../core/assetRefRules';
import { templateKeyOf } from '../core/templateIdentity';
import { unresolvedRefOf } from '../core/unresolvedPrefabRef';
import { onGuidRemap } from '../core/ecs/guidRemap';
import type { InstanceRecord } from './instanceRecord';

/** One stored instance. */
export interface StoredInstance {
  record: InstanceRecord;
}

const byWorld = new WeakMap<World, Map<string, StoredInstance>>();

function storeOf(world: World): Map<string, StoredInstance> {
  let s = byWorld.get(world);
  if (!s) byWorld.set(world, (s = new Map()));
  return s;
}

/** Put `rec` in `world`'s store under its root guid. A record with no root guid is not stored. */
export function setInstanceRecord(world: World, rec: InstanceRecord): void {
  if (!rec.rootGuid) return;
  storeOf(world).set(rec.rootGuid, { record: rec });
}

export function storedInstance(world: World, rootGuid: string): StoredInstance | undefined {
  return byWorld.get(world)?.get(rootGuid);
}

/** The record for `rootGuid`, or undefined when there is none. */
export function storedRecord(world: World, rootGuid: string): InstanceRecord | undefined {
  return byWorld.get(world)?.get(rootGuid)?.record;
}

export function dropInstanceRecord(world: World, rootGuid: string): void {
  byWorld.get(world)?.delete(rootGuid);
}

/** Put `world`'s store back to exactly `entries` dropping every record not in it: a rollback's restore
 *  (`editor/instance/instanceRollback.ts`, #2001 S8b). */
export function replaceStoredInstances(world: World, entries: ReadonlyMap<string, StoredInstance>): void {
  const s = storeOf(world);
  s.clear();
  for (const [g, v] of entries) s.set(g, v);
}

/** Every stored instance of `world`. */
export function storedInstances(world: World): ReadonlyMap<string, StoredInstance> {
  return storeOf(world);
}

/** Every guid record `rec` names — a row's values, pins, links and parent, its placement parent — renamed by `remap`, in
 *  place; not its own root guid (the store keys by it: the caller re-keys). Also a load's, for the records it parses
 *  from a file whose guids the load renamed before the parse (`renameParsedRecords`). */
export function renameInRecord(rec: InstanceRecord, remap: ReadonlyMap<string, string>): void {
  const named = (v: unknown) => mapStringValues(v, (str) => remap.get(str) ?? str);
  for (const [k, row] of rec.list.rows) {
    const next = named(row);
    if (next !== row) rec.list.rows.set(k, next as typeof row);
  }
  rec.placement.parent = remap.get(rec.placement.parent) ?? rec.placement.parent;
}

/** The guids of `world`'s live stored roots, the owners a record is kept for: a root no prefab row expanded (a scene
 *  entry, or a reference node the scene added) and a Missing Prefab placeholder of one. A template-added reference
 *  node's root is not one: its template supplies it, and its members key in the enclosing frame's record. */
export function liveStoredRootGuids(world: World): string[] {
  const ea = getTraitByName('EntityAttributes')?.trait, pi = getTraitByName('PrefabInstance')?.trait;
  if (!ea) return [];
  const out: string[] = [];
  for (const e of world.entities) {
    const guid = (e.get(ea) as { guid?: string } | undefined)?.guid;
    if (!guid || templateKeyOf(e)) continue;
    const p = pi && e.has(pi) ? e.get(pi) as Parameters<typeof isStoredRoot>[0] : undefined;
    if (p ? isStoredRoot(p, e.id()) : unresolvedRefOf(e)) out.push(guid);
  }
  return out;
}

// A rename (`applyGuidRemap`) re-points every live ref to a renamed entity; a record naming one — a field value referring
// to the node, a pin, a link, a placement parent, its own root guid — follows it the same way, so it still states what it
// did (#2001 S8b). Before, it was marked stale (#2046 S7 close-out review), and re-seeded from the capture: Create
// Prefab's renames reach refs in OTHER trees.
onGuidRemap('instanceStore', (remap, world) => {
  const s = storeOf(world);
  // Re-keyed all at once: a remap that swaps two guids swaps their records rather than dropping one.
  const moved: StoredInstance[] = [];
  for (const [g, entry] of [...s]) {
    renameInRecord(entry.record, remap);
    const to = remap.get(g);
    if (to === undefined) continue;
    entry.record.rootGuid = to;
    s.delete(g);
    moved.push(entry);
  }
  for (const entry of moved) s.set(entry.record.rootGuid, entry);
});
