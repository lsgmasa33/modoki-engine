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

/** A reference node the load could not expand, in the shape both structure applies hand it (`AddedEntity`'s subset). */
export interface UnresolvedNode {
  prefab?: string;
  guid?: string;
  key?: string;
  name?: string;
  /** Only `EntityAttributes.sortOrder` / `isActive` are read: the placement a save states for the placeholder
   *  (`nodeSpawnPlacement`; #1897, #1901). */
  traits?: Record<string, unknown>;
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
  if (ea && e.has(ea.trait)) {
    const data = e.get(ea.trait) as Record<string, unknown>;
    const next = { ...data };
    if (entry.name && !data.name) next.name = entry.name;
    // Where the ENTRY states its root's sibling position or active flag as a root override (#1850) — as a live
    // instance's save writes them — the placeholder loads with them: pass 1 read only the entry's own traits and left
    // the trait default, so the save ordered it as sortOrder 0 and a save→reload→save moved it among its siblings.
    for (const k of PLACEHOLDER_ORDER_FIELDS) {
      const stated = rootOverrideOf(entry, k);
      if (stated.has && !hasOwn(entryAttributes(entry), k)) next[k] = stated.value;
    }
    e.set(ea.trait, next);
  }
  // `id` is the loader's per-load key (the array index), never written back.
  const { id: _loadKey, ...record } = entry;
  markUnresolved(e, source, 'entry', record);
}

const hasOwn = (o: object | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);
const entryAttributes = (record: Record<string, unknown>): Record<string, unknown> | undefined =>
  ((record.traits as Record<string, unknown> | undefined)?.EntityAttributes as Record<string, unknown> | undefined);

/** What an ENTRY record states for its root's `field` as a ROOT OVERRIDE (#1850): `overrides[<root localId>]
 *  .EntityAttributes[field]`, the root localId being the entry's own `PrefabInstance.localId`. A live instance's save
 *  writes a reordered or deactivated root there, not in the entry's traits. */
function rootOverrideOf(record: Record<string, unknown>, field: string): { has: boolean; value?: unknown } {
  const pi = (record.traits as Record<string, unknown> | undefined)?.PrefabInstance as { localId?: unknown } | undefined;
  const lid = typeof pi?.localId === 'number' ? pi.localId : 0;
  const bag = lid ? ((record.overrides as Record<string, Record<string, Record<string, unknown>>> | undefined)?.[lid]?.EntityAttributes) : undefined;
  return hasOwn(bag, field) ? { has: true, value: bag![field] } : { has: false };
}

/** Spawn the placeholder for an added reference node whose prefab does not resolve, under `parentEcsId`, carrying the
 *  node. A plain entity with the marker and NO `PrefabInstance`, like the top-level one: the structural capture finds
 *  it by the marker (`captureChild`), and no instance machinery can mistake it for an instance. Shared by the loader's
 *  expansion and the editor's rebuild, so a Revert or an Apply that respawns the instance leaves the same placeholder
 *  behind. Returns the placeholder's ECS id, or 0 when the trait is not registered. */
export function spawnUnresolvedReference(world: World, node: UnresolvedNode, parentEcsId: number): number {
  const ea = getTraitByName('EntityAttributes');
  if (!ea || !node.prefab) return 0;
  const placement = nodeSpawnPlacement(node);
  const entity = spawnEntity(
    world,
    ea.trait({ name: node.name || 'Missing Prefab', parentId: parentEcsId, ...placement, ...(node.guid ? { guid: node.guid } : {}) }),
  );
  if (node.guid) indexEntityGuid(entity, world);
  if (node.key) setTemplateKey(entity, node.key);
  markUnresolved(entity, node.prefab, 'node', node);
  return entity.id();
}

/** The `sortOrder` / `isActive` a node placeholder is SPAWNED with: what the node states in its own traits — the one
 *  channel a node placeholder reads, since it has no template and no root localId to find a root override by. A live
 *  node's save states them there when its prefab is missing (#1897) or a root override states them (#1901,
 *  `nodePlacement`), and a placeholder's save writes its live ones (`asAddedNode`). Empty when it states none, and the
 *  trait defaults stand. */
export function nodeSpawnPlacement(node: { traits?: Record<string, unknown> }): Record<string, unknown> {
  const stated = (node.traits?.EntityAttributes ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PLACEHOLDER_ORDER_FIELDS) if (hasOwn(stated, k)) out[k] = stated[k];
  return out;
}

/** The record's edit channels, the part a scene entry and a reference node or row share. */
export const channelsOf = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of CHANNELS) if (record[k] !== undefined) out[k] = record[k];
  return out;
};

/** The `EntityAttributes` fields of a placeholder that its writers take from the LIVE entity rather than the record
 *  (#1818, I21): what the Hierarchy can change on it. `name` and `guid` ride identity beside these. The editor's write
 *  gate (`editor/undo/placeholderGate.ts`) lets exactly these through, so an edit it allows is one the save keeps.
 *  The ORDER fields, `sortOrder` and `isActive`, are carried by both SCENE shapes (#1901, owner ruling: the placeholder
 *  keeps what it shows): an entry in its traits or its root override (`asSceneEntry`), a node the scene added in its own
 *  traits (`asAddedNode`). A node the TEMPLATE declares (keyed) is written by a writer that keeps none of them, and the
 *  gate asks the writer (`placeholderSavedFields`); a prefab-edit row's writer keeps less too (#1918).
 *  ⚠️ A node's live value holds while its prefab is missing: once the prefab returns, a resolving node's load reads none
 *  of its traits, and the root takes its template's value or its root override (which the placeholder cannot name). */
export const PLACEHOLDER_ORDER_FIELDS = ['sortOrder', 'isActive'] as const;
export const PLACEHOLDER_PLACEMENT_FIELDS = ['parentId', 'editorFolder', ...PLACEHOLDER_ORDER_FIELDS] as const;
type OrderField = (typeof PLACEHOLDER_ORDER_FIELDS)[number];

/** What a live placeholder's `sortOrder` / `isActive` load as when the record does not state them: the trait's
 *  defaults, which a pass-1 spawn leaves. A save writes them only when the record states them or the live value
 *  differs, so a save with no edit writes the bytes it read (#1722). */
const PLACEMENT_DEFAULTS: Readonly<Record<OrderField, unknown>> = { sortOrder: 0, isActive: true };

/** The record as a TOP-LEVEL scene entry, identity and placement from the live placeholder. An entry record is
 *  returned whole, with only those replaced; a node record (a reference node dragged to the scene root) keeps its
 *  channels and gets the minimal `PrefabInstance` a written root carries. `live.order` carries the Hierarchy's
 *  `sortOrder` and `isActive` (#1818), written in place of the record's own so the key order holds. */
export function asSceneEntry(
  kind: 'entry' | 'node', record: Record<string, unknown>, source: string,
  live: { name: string; guid?: string; placement: Record<string, unknown>; order?: Readonly<Record<OrderField, unknown>> },
): Record<string, unknown> {
  const traits: Record<string, unknown> = kind === 'entry' && record.traits && typeof record.traits === 'object'
    ? { ...(record.traits as Record<string, unknown>) }
    : { PrefabInstance: { source, rootInstanceId: live.guid ?? '' } };
  // An entry record keeps the `PrefabInstance` it was read with: the placeholder dropped its live copy, not the file's.
  const ea = { ...((traits.EntityAttributes as Record<string, unknown> | undefined) ?? {}) };
  delete ea.parentId;
  delete ea.editorFolder;
  Object.assign(ea, live.placement);
  const base: Record<string, unknown> = kind === 'entry' ? { ...record } : { prefab: source, ...channelsOf(record) };
  if (live.order) {
    for (const k of PLACEHOLDER_ORDER_FIELDS) {
      // A field the entry states as a root OVERRIDE is written back there (#1850): the placeholder loaded with it, so
      // an unedited one writes the bytes it read, and an edit lands where the prefab's return reads it — written into
      // the traits beside the override instead, the override would win again the moment the instance re-expanded.
      const stated = kind === 'entry' && !(k in ea) ? rootOverrideOf(record, k) : { has: false };
      if (stated.has) {
        // Onto what an earlier field of this loop wrote, not the record: both changed, the second undid the first (close-out review).
        if (live.order[k] !== stated.value) base.overrides = withRootOverride(record, base.overrides as Record<string, unknown>, k, live.order[k]);
        continue;
      }
      if (k in ea || live.order[k] !== PLACEMENT_DEFAULTS[k]) ea[k] = live.order[k];
    }
  }
  if (Object.keys(ea).length) traits.EntityAttributes = ea;
  else delete traits.EntityAttributes;
  return { ...base, name: live.name, traits, prefab: source, ...(live.guid ? { guid: live.guid } : {}) };
}

/** The `sortOrder` / `isActive` a save states on the entry's OWN `traits.EntityAttributes` for a LIVE instance whose
 *  prefab no longer resolves (#1895): each one the entry does not already state as a root override (`overrides`) and
 *  whose live value is not the placeholder's default. A reference NODE's twin is `nodePlacement`. A root whose value equals its template row's carries no mark and no override
 *  (the template restores it), but this instance's next load has no template: it comes back as a Missing Prefab
 *  placeholder, which loaded the default, and the save moved the entry among its siblings. Stated here, the pass-1
 *  spawn seats it, and `asSceneEntry` writes it back in place (`k in ea`), so the second save writes the first's bytes.
 *  Returned first, before `parentId` / `editorFolder`, which is the order `asSceneEntry` writes them in.
 *  ⚠️ NOT as a root override (#1850's channel), though the placeholder reads that too: a live instance's load seeds a
 *  mark for every override it applies, so once the prefab came back the reload would hold a mark the saved instance
 *  never had. A live instance's load reads only `parentId` off its root's traits, so this statement costs the prefab's
 *  return nothing: the value comes from the template row, as it did before the trash. */
export function placementForMissing(
  overrides: Record<string, Record<string, Record<string, unknown>>> | undefined,
  rootLocalId: number,
  live: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const stated = overrides?.[rootLocalId]?.EntityAttributes;
  for (const k of PLACEHOLDER_ORDER_FIELDS) {
    if (hasOwn(stated, k) || live?.[k] === undefined || live[k] === PLACEMENT_DEFAULTS[k]) continue;
    out[k] = live[k];
  }
  return out;
}

/** `current` (the entry's `overrides` as written so far) with the root's `EntityAttributes[field]` set to `value`, copied
 *  along the path it changes. */
function withRootOverride(record: Record<string, unknown>, current: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const lid = ((record.traits as Record<string, unknown>).PrefabInstance as { localId: number }).localId;
  const overrides = current as Record<string, Record<string, Record<string, unknown>>>;
  return { ...overrides, [lid]: { ...overrides[lid], EntityAttributes: { ...overrides[lid]!.EntityAttributes, [field]: value } } };
}

/** The `sortOrder` / `isActive` a LIVE scene reference node's save states in its own `traits.EntityAttributes`, for the
 *  placeholder its next load spawns if the prefab is gone by then (`nodeSpawnPlacement`). A field whose live value is
 *  the placeholder's default is never stated: the spawn leaves the default. Otherwise:
 *   - the prefab is MISSING at this save (#1897: a trash mid-session, #1862's kept frame): every one, since the next
 *     load has no template to take them from;
 *   - it RESOLVES (#1901, the cold-load route): each one a ROOT OVERRIDE states (`rootOverride`, the captured
 *     `overrides[<root localId>].EntityAttributes`). The override is what a node placeholder cannot read, so a prefab
 *     deleted outside the editor loaded the reordered node at 0. A resolving node's load reads none of its traits, so
 *     the statement costs the live instance nothing, and the override still applies once the prefab returns. The
 *     parity of #1850, where an entry placeholder reads its root override itself. A value the TEMPLATE gives is not
 *     stated while the prefab resolves, for either shape: see docs/prefabs.md I21. */
export function nodePlacement(
  resolves: boolean, rootOverride: Record<string, unknown> | undefined, live: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PLACEHOLDER_ORDER_FIELDS) {
    if (live?.[k] === undefined || live[k] === PLACEMENT_DEFAULTS[k]) continue;
    if (resolves && !hasOwn(rootOverride, k)) continue;
    out[k] = live[k];
  }
  return out;
}

/** The record as an ADDED reference node under `parentLocalId`, identity (guid, or key) and name from the live
 *  placeholder. A node record is returned whole with those replaced; an entry record (a top-level placeholder dragged
 *  under a member) keeps its channels. `live.order` is the placeholder's `sortOrder` / `isActive` (#1901): written into
 *  the node's own traits, where the reload's spawn reads them (`nodeSpawnPlacement`), so a placeholder that lands inside
 *  an instance by ANY route reloads where and as it was shown. A field is written when the record states it or the live
 *  value is not the default, so a save with no edit writes the bytes it read (#1722). */
export function asAddedNode(
  kind: 'entry' | 'node', record: Record<string, unknown>, source: string,
  live: { name: string; parentLocalId: number; identity: Record<string, unknown>; order: Readonly<Record<OrderField, unknown>> },
): Record<string, unknown> {
  const base: Record<string, unknown> = kind === 'node' ? { ...record } : { traits: {}, children: [], ...channelsOf(record) };
  // In the order `captureNestedRef` writes a reference node, so a save with no edit writes the bytes it read (#1722):
  // the node's own record came from that writer, and deleting its identity then re-spreading it moved `guid` to the end.
  const { parentLocalId: _p, guid: _g, key: _k, name: _n, traits, children, prefab: _s, ...channels } = base;
  const nodeTraits = { ...((traits as Record<string, unknown> | undefined) ?? {}) };
  const ea = { ...((nodeTraits.EntityAttributes as Record<string, unknown> | undefined) ?? {}) };
  for (const k of PLACEHOLDER_ORDER_FIELDS) {
    if (k in ea || live.order[k] !== PLACEMENT_DEFAULTS[k]) ea[k] = live.order[k];
  }
  if (Object.keys(ea).length) nodeTraits.EntityAttributes = ea;
  else delete nodeTraits.EntityAttributes;
  return {
    parentLocalId: live.parentLocalId, ...live.identity, name: live.name, traits: nodeTraits, children: children ?? [],
    prefab: source, ...channels,
  };
}
