/**
 * The CONTENT of a scene-owned node an instance's record links (#2001 S8b), read off the live tree and the store as a
 * plain entity's is: no capture of the instance. Rule 7 (docs/prefabs.md): the user's node is the scene's, and the list
 * holds only its link (`own`), as Unity's `m_AddedGameObjects` does; the save writes the node's content where the link
 * stands (`serializeInstanceRecord`'s `sceneOwned`).
 *
 * Three kinds of node, each in the inline form the scene file states it (`AddedEntity`):
 * - a PLAIN node: its components, by the scene serializer's rule (`snapshotAddedTraits`), and its children that are
 *   its content in turn;
 * - a reference node the scene added (a stored root): its identity, name and the placement its placeholder would read
 *   (`nodePlacement`). Its LIST is its own record's, which the writer puts in (`writtenEntryOf`), never stated here;
 * - a Missing Prefab placeholder of one: the node it carries (`asAddedNode`), its list likewise its record's.
 *
 * A node with no durable guid (a raw spawn's runtime one, #1210) is linked by the guid its load will derive (the
 * parse's, in sibling order under its anchor): each link no live guid answers to is paired, in order, with the anchor's
 * guid-less scene-owned children, and written under the link's guid, as the capture's parse wrote it.
 *
 * A child under a plain node that an instance SUPPLIES is that instance's, not the node's content: a member (moved
 * there, or a row of another frame hanging there), a node a template added (its key), a prefab-edit world's row. So is
 * anything the authoring view leaves out (a transient spawn).
 */
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, getAllEntities, readTraitData } from '../../runtime/core/ecs/entityUtils';
import { durableGuid, isStoredRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { asAddedNode, nodePlacement } from '../../runtime/loaders/unresolvedPrefabRefs';
import type { RowKey, SceneOwnedNode } from '../../runtime/prefab/instanceRecord';
import type { EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { childrenBySibling } from '../scene/prefab';
import { filterAuthoringVisible } from '../scene/authoringScope';
import { isPrefabEditRowGuid } from '../scene/prefabEditGuids';
import { snapshotAddedTraits } from '../scene/prefabCapture';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { recordedFieldsOf } from './instanceOverrideView';
import { instanceKeyMap } from './instanceKeys';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { storedInstance } from '../../runtime/prefab/instanceStore';

/** Reads the content of scene-owned nodes by the guid a record links them by; `at`: the record and row that link it. */
export interface OwnContent {
  node(guid: string, at?: { rootGuid: string; key: RowKey }): SceneOwnedNode | undefined;
  /** The live entity a guid names: its own, or a guid-less node's paired link (see the header). */
  idOf(guid: string): number | undefined;
  /** The content of live entity `id`, read as a linked node's is: for a node no record links (a write round the door),
   *  which a save still writes rather than drop (rule 1's data-loss exception). */
  nodeOfId(id: number): SceneOwnedNode | undefined;
}

/** Content read off the current world (see the header). One per save: the tree's shape is read once. */
export function liveOwnContent(consumed?: Set<number>): OwnContent {
  const all = filterAuthoringVisible(getAllEntities());
  const byId = new Map<number, EntityInfo>(all.map((e) => [e.id, e]));
  const childrenOf = childrenBySibling(all);
  const pi = getTraitByName('PrefabInstance')!, ea = getTraitByName('EntityAttributes')!;

  /** Is the live child an instance's (see the header), not its parent node's content? */
  const supplied = (id: number): boolean => {
    const e = findEntity(id);
    if (!e) return true;
    if (templateKeyOf(e as never) || isPrefabEditRowGuid(byId.get(id)?.guid)) return true;
    return e.has(pi.trait) && !isStoredRoot(e.get(pi.trait) as MemberPi, id) && !unresolvedRefOf(e as never);
  };

  /** Is live `id` an instance's MEMBER (not a stored root, not a Missing Prefab placeholder)? */
  const member = (id: number): boolean => {
    const e = findEntity(id);
    return !!e && e.has(pi.trait) && !isStoredRoot(e.get(pi.trait) as MemberPi, id) && !unresolvedRefOf(e as never);
  };

  /** A linked node's template key, when it carries one: the key a prefab-edit world's row `added` node holds (the edited
   *  document's), which a respawn from this content stamps back (`node.key`). Read from the content, it was lost on a
   *  reprojection, and the next save minted another (#1567 A5; the old capture route's `restoreTemplateKeys`). */
  const keyOf = (e: NonNullable<ReturnType<typeof findEntity>>): { key?: string } => { const k = templateKeyOf(e as never); return k ? { key: k } : {}; };

  const nodeOf = (id: number): SceneOwnedNode | undefined => {
    const e = findEntity(id);
    const info = byId.get(id);
    if (!e || !info) return undefined;
    consumed?.add(id);
    const name = info.name || '';
    const guid = durableGuid(info.guid);
    const unresolved = unresolvedRefOf(e as never);
    if (unresolved) {
      const live = readTraitData(id, ea) as { sortOrder?: number; isActive?: boolean } | null;
      return asAddedNode(unresolved.kind, unresolved.record, unresolved.source, {
        name, parentLocalId: 0, identity: { guid },
        order: { sortOrder: live?.sortOrder ?? 0, isActive: live?.isActive ?? true },
      }) as unknown as SceneOwnedNode;
    }
    if (e.has(pi.trait)) {
      const source = (e.get(pi.trait) as { source?: string }).source;
      if (!source) return undefined;
      // What its placeholder reads if the prefab is gone by the next load: each root field the record states, and every
      // one once the prefab no longer resolves (`nodePlacement`).
      const stated: Record<string, true> = {};
      for (const k of recordedFieldsOf(id) ?? []) if (k.startsWith('EntityAttributes.')) stated[k.slice('EntityAttributes.'.length)] = true;
      const placement = nodePlacement(!!getCachedPrefabSync(source), stated, readTraitData(id, ea) as Record<string, unknown> | undefined);
      return {
        parentLocalId: 0, guid, ...keyOf(e), name, traits: Object.keys(placement).length ? { EntityAttributes: placement } : {}, children: [],
        prefab: source,
      } as unknown as SceneOwnedNode;
    }
    const { bag } = snapshotAddedTraits(id);
    const children: SceneOwnedNode[] = [];
    for (const c of childrenOf.get(id) ?? []) {
      if (supplied(c.id)) continue;
      const n = nodeOf(c.id);
      if (n) children.push(n);
    }
    return { parentLocalId: 0, guid, ...keyOf(e), name, traits: bag, children } as unknown as SceneOwnedNode;
  };

  /** Each link a guid-less node was paired with, by the link's guid. */
  const paired = new Map<string, number>();
  const idOf = (guid: string): number | undefined => findEntityByGuid(guid)?.id() ?? paired.get(guid);
  /** A link no live guid answers to, paired with the guid-less node it stands for (see the header). */
  const unguided = (guid: string, at: { rootGuid: string; key: RowKey }): number | undefined => {
    const root = idOf(at.rootGuid);
    const links = root !== undefined ? storedInstance(getCurrentWorld(), at.rootGuid)?.record.list.rows.get(at.key)?.own : undefined;
    if (root === undefined || !links) return undefined;
    let anchor: number | undefined;
    for (const [id, k] of instanceKeyMap(root)) if (k === at.key) { anchor = id; break; }
    if (anchor === undefined) return undefined;
    const waiting = links.filter((l) => idOf(l.guid) === undefined || paired.has(l.guid));
    const nodes = (childrenOf.get(anchor) ?? []).filter((c) => !durableGuid(c.guid) && !supplied(c.id));
    const i = waiting.findIndex((l) => l.guid === guid);
    return i >= 0 && waiting.length === nodes.length ? nodes[i]!.id : undefined;
  };

  return {
    idOf,
    nodeOfId: (id) => (byId.has(id) ? nodeOf(id) : undefined),
    node: (guid, at) => {
      const id = guid ? findEntityByGuid(guid)?.id() : undefined;
      // An instance's member is never a user's node, whatever guid it carries now (an undo reading a side in which the
      // node an Apply promoted into the template was still the user's, hunt seed 3066): no content of it is read.
      if (id !== undefined && byId.has(id)) return member(id) ? undefined : nodeOf(id);
      const raw = at && guid ? paired.get(guid) ?? unguided(guid, at) : undefined;
      if (raw !== undefined) paired.set(guid, raw);
      const n = raw !== undefined ? nodeOf(raw) : undefined;
      return n ? { ...n, guid } as SceneOwnedNode : undefined;
    },
  };
}
