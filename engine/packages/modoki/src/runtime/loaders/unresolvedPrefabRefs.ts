/** A prefab reference the load cannot expand keeps its record through every save (#1699).
 *
 *  A reference whose prefab does not resolve (deleted, renamed without its sidecar, or not pulled yet) cannot be
 *  expanded, so the world holds no members for it and no capture can recover its edits. Unity keeps such an instance's
 *  `PrefabInstance` data in the scene untouched while the asset is missing (`PrefabInstanceStatus.MissingAsset`), and
 *  the edits come back with the asset. The rule here is the same:
 *
 *  **The reference leaves a PLACEHOLDER carrying its identity, the record the file held for it rides on the placeholder
 *  (`UnresolvedPrefabRef`, `runtime/core/unresolvedPrefabRef.ts`), and every writer that meets the placeholder writes
 *  that record back verbatim.** Only identity and placement come from the live placeholder: its guid, its name, its
 *  parent and its folder, because those are what the Hierarchy can change. The name is the live one on purpose: a
 *  rename of a missing instance is kept, the way a rename of any instance is.
 *
 *  Three kinds of reference, one rule:
 *   - a TOP-LEVEL scene entry: the loader's pass-1 placeholder stays (`keepUnresolvedEntry`);
 *   - an ADDED reference node: `spawnUnresolvedReference`, shared by the loader and the editor's rebuild;
 *   - a template's reference ROW inside an instance: no placeholder, since the frame is the template's. The scene's
 *     edits to that frame ride member rows, and `rowBackedTest` counts a row naming the unexpandable row as unbacked,
 *     so the orphan store keeps it. In PREFAB EDIT the row is a top-level entry of the edit world, so it takes the
 *     first path, and that save writes the row from its baseline (`serializePrefabEditWorld`).
 *
 *  The writers: `serializeScene` (an entry), `captureNestedRef` (a node), the prefab-edit save (a row). A placeholder
 *  moved from one kind of place to the other (dragged to the scene root, or under a member) is written in the shape of
 *  where it now is: `asSceneEntry` / `asAddedNode` carry the channels both shapes share. */

import type { World } from 'koota';
import { spawnEntity, indexEntityGuid, findEntityById } from '../core/ecs/world';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { setTemplateKey } from '../core/templateIdentity';
import { markUnresolved } from '../core/unresolvedPrefabRef';

/** The edit channels a scene entry and an added reference node both carry: the record's substance. */
const CHANNELS = ['overrides', 'added', 'removed', 'removedTraits', 'moved', 'nestedOverrides', 'nestedStructure', 'members'] as const;

/** A reference node the load could not expand, in the shape both expansion twins share (`AddedEntity`'s subset). */
export interface UnresolvedNode {
  prefab?: string;
  guid?: string;
  key?: string;
  name?: string;
}

/** The loader's top-level skip: the pass-1 placeholder at `placeholderId` stays, named as the entry names it, and
 *  carries the entry. Only the REF form (`entry.prefab`): a trait-form root without one is a flattened carrier (the
 *  base-scene carry's snapshots), whose placeholder already IS the whole entity. */
export function keepUnresolvedEntry(world: World, placeholderId: number, source: string, entry: { prefab?: string; name?: string; id?: unknown }): void {
  if (!entry.prefab) return;
  const e = findEntityById(placeholderId, world) as Parameters<typeof markUnresolved>[0] & { get(t: unknown): unknown; remove(t: unknown): void };
  if (!e) return;
  // NOT an instance any more: pass 1 gave it the entry's `PrefabInstance`, and with it every piece of instance
  // machinery (the Apply fan-out, the override list, a rebuild) would treat it as a live instance of the prefab the
  // moment that prefab resolves, capture it empty and destroy the record (close-out review). The marker holds the source.
  const pi = getTraitByName('PrefabInstance');
  if (pi && e.has(pi.trait)) e.remove(pi.trait);
  const ea = getTraitByName('EntityAttributes');
  if (ea && entry.name && e.has(ea.trait)) {
    const data = e.get(ea.trait) as Record<string, unknown>;
    if (!data.name) e.set(ea.trait, { ...data, name: entry.name });
  }
  // `id` is the loader's per-load key (the array index), never written back.
  const { id: _loadKey, ...record } = entry;
  markUnresolved(e, source, 'entry', record);
}

/** Spawn the placeholder for an added reference node whose prefab does not resolve, under `parentEcsId`, carrying the
 *  node. A plain entity with the marker and NO `PrefabInstance`, like the top-level one: the structural capture finds
 *  it by the marker (`captureChild`), and no instance machinery can mistake it for an instance. Shared by the loader's
 *  expansion and the editor's rebuild, so a Revert or an Apply that respawns the instance leaves the same placeholder
 *  behind. Returns the placeholder's ECS id, or 0 when the trait is not registered. */
export function spawnUnresolvedReference(world: World, node: UnresolvedNode, parentEcsId: number): number {
  const ea = getTraitByName('EntityAttributes');
  if (!ea || !node.prefab) return 0;
  const entity = spawnEntity(
    world,
    ea.trait({ name: node.name || 'Missing Prefab', parentId: parentEcsId, ...(node.guid ? { guid: node.guid } : {}) }),
  );
  if (node.guid) indexEntityGuid(entity, world);
  if (node.key) setTemplateKey(entity, node.key);
  markUnresolved(entity, node.prefab, 'node', node);
  return entity.id();
}

/** The record's edit channels, the part a scene entry and a reference node or row share. */
export const channelsOf = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of CHANNELS) if (record[k] !== undefined) out[k] = record[k];
  return out;
};

/** The record as a TOP-LEVEL scene entry, identity and placement from the live placeholder. An entry record is
 *  returned whole, with only those replaced; a node record (a reference node dragged to the scene root) keeps its
 *  channels and gets the minimal `PrefabInstance` a written root carries. */
export function asSceneEntry(
  kind: 'entry' | 'node', record: Record<string, unknown>, source: string,
  live: { name: string; guid?: string; placement: Record<string, unknown> },
): Record<string, unknown> {
  const traits: Record<string, unknown> = kind === 'entry' && record.traits && typeof record.traits === 'object'
    ? { ...(record.traits as Record<string, unknown>) }
    : { PrefabInstance: { source, rootInstanceId: live.guid ?? '' } };
  // An entry record keeps the `PrefabInstance` it was read with: the placeholder dropped its live copy, not the file's.
  const ea = { ...((traits.EntityAttributes as Record<string, unknown> | undefined) ?? {}) };
  delete ea.parentId;
  delete ea.editorFolder;
  Object.assign(ea, live.placement);
  if (Object.keys(ea).length) traits.EntityAttributes = ea;
  else delete traits.EntityAttributes;
  const base = kind === 'entry' ? { ...record } : { prefab: source, ...channelsOf(record) };
  return { ...base, name: live.name, traits, prefab: source, ...(live.guid ? { guid: live.guid } : {}) };
}

/** The record as an ADDED reference node under `parentLocalId`, identity (guid, or key) and name from the live
 *  placeholder. A node record is returned whole with those replaced; an entry record (a top-level placeholder dragged
 *  under a member) keeps its channels. */
export function asAddedNode(
  kind: 'entry' | 'node', record: Record<string, unknown>, source: string,
  live: { name: string; parentLocalId: number; identity: Record<string, unknown> },
): Record<string, unknown> {
  const base: Record<string, unknown> = kind === 'node' ? { ...record } : { traits: {}, children: [], ...channelsOf(record) };
  // In the order `captureNestedRef` writes a reference node, so a save with no edit writes the bytes it read (#1722):
  // the node's own record came from that writer, and deleting its identity then re-spreading it moved `guid` to the end.
  const { parentLocalId: _p, guid: _g, key: _k, name: _n, traits, children, prefab: _s, ...channels } = base;
  return {
    parentLocalId: live.parentLocalId, ...live.identity, name: live.name, traits: traits ?? {}, children: children ?? [],
    prefab: source, ...channels,
  };
}
