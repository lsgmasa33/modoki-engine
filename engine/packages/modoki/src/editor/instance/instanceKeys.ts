/**
 * Live entity → the instance record it belongs to and the `RowKey` that names it (#2001 S4, #2014).
 *
 * The keys are the fold's (design § 2.1): `"/"` for the stored root; a member by its row key (`memberRowKeysIn`); a
 * template-added node by its frame plus `/a+<key>`. A SCENE-OWNED node (one the user added) has no key: it is scene
 * content, linked into the list by the `own` of the keyed node it hangs under, its ANCHOR (rule 7; § 2.5).
 *
 * The owning instance is the nearest STORED root up the ECS tree whose keys hold the entity, else whose subtree holds
 * it (a scene-owned node). A reference node the scene added is a stored root of its own, so its members key into its
 * own record, never the outer one's (§ 2.5).
 */
import type { Entity } from 'koota';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { instanceRowKeysIn } from '../../runtime/core/ecs/memberRows';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { isStoredRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import type { RowKey } from '../../runtime/prefab/instanceRecord';

function handles() {
  const world = getCurrentWorld();
  const ea = getTraitByName('EntityAttributes')!.trait;
  const pi = getTraitByName('PrefabInstance')!.trait;
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const parentOf = (id: number): number => ((byId.get(id)?.get(ea) as { parentId?: number } | undefined)?.parentId ?? 0);
  const piOf = (id: number): MemberPi => {
    const e = byId.get(id);
    return e && e.has(pi) ? (e.get(pi) as MemberPi) : null;
  };
  const guidOf = (id: number): string => ((byId.get(id)?.get(ea) as { guid?: string } | undefined)?.guid ?? '');
  return { world, byId, parentOf, piOf, guidOf };
}

/** A stored root that OWNS a record: a top-level instance or a reference node the scene added — or the Missing Prefab
 *  placeholder of one, which carries no PrefabInstance but keeps its record (rule 9). A stored root that carries a
 *  template key is a template-added REFERENCE node — a supplied node of its enclosing frame (`…/a+<key>`), whose list
 *  is its prefab's template data, never a scene record of its own (§ 2.1, § 2.4 item 4). */
function ownsRecord(pi: MemberPi, id: number, e: Entity | undefined): boolean {
  return (pi ? isStoredRoot(pi, id) : !!unresolvedRefOf(e as never)) && !templateKeyOf(e as never);
}

/** Every keyed node of the instance rooted at record-owning root `rootId` — `instanceRowKeysIn`, in the runtime since the
 *  load asks it too (#2038). */
export function instanceKeyMap(rootId: number): Map<number, RowKey> {
  return instanceRowKeysIn(rootId, getCurrentWorld());
}

/** Where an entity sits relative to the instance records:
 *  - `member`: a supplied node (root, member or template-added node) of stored root `rootId`, named `key`;
 *  - `owned`: a scene-owned node inside that instance; `anchorKey` is the keyed node its top-most scene-owned ancestor
 *    (or itself) hangs under, and `linkId` that top-most node, whose guid the anchor's `own` lists. */
export type InstanceTarget =
  | { kind: 'member'; rootId: number; rootGuid: string; key: RowKey }
  | { kind: 'owned'; rootId: number; rootGuid: string; anchorKey: RowKey; linkId: number };

/** The instance target of `entityId`, or null when it is in no instance. */
export function instanceTargetOf(entityId: number): InstanceTarget | null {
  const { byId, parentOf, piOf, guidOf } = handles();
  if (!byId.has(entityId)) return null;
  for (let a = entityId, n = 0; a && n < 1024; a = parentOf(a), n++) {
    if (!ownsRecord(piOf(a), a, byId.get(a))) continue;
    const keys = instanceKeyMap(a);
    const key = keys.get(entityId);
    if (key !== undefined) return { kind: 'member', rootId: a, rootGuid: guidOf(a), key };
    // Scene-owned under `a`: climb to the node that hangs directly under a keyed node.
    let link = entityId;
    while (parentOf(link) && !keys.has(parentOf(link))) link = parentOf(link);
    const anchor = parentOf(link);
    if (!keys.has(anchor)) return null;
    return { kind: 'owned', rootId: a, rootGuid: guidOf(a), anchorKey: keys.get(anchor)!, linkId: link };
  }
  return null;
}

/** The OUTERMOST stored root above (or at) `entityId`: the root the save writes as a top-level entry, and so the one a
 *  re-seed captures (`serialize.ts`: a stored root under an instance is captured by its owner). 0 when none. */
export function outermostStoredRoot(entityId: number): number {
  const { byId, parentOf, piOf } = handles();
  let found = 0;
  for (let a = entityId, n = 0; a && n < 1024; a = parentOf(a), n++) if (ownsRecord(piOf(a), a, byId.get(a))) found = a;
  return found;
}

/** Every record-owning stored root above (or at) `entityId`, nearest first. A scene-added reference node owns a record
 *  of its own inside its enclosing instance's (§ 2.5), so the record a node under it belongs to is the NEAREST of these,
 *  not the outermost (#2037). */
export function storedRootsAbove(entityId: number): number[] {
  const { byId, parentOf, piOf } = handles();
  const out: number[] = [];
  for (let a = entityId, n = 0; a && n < 1024; a = parentOf(a), n++) if (ownsRecord(piOf(a), a, byId.get(a))) out.push(a);
  return out;
}

/** Every record-owning stored root inside the subtree at `entityId`, itself included. */
export function storedRootsUnder(entityId: number): number[] {
  const { byId, parentOf, piOf } = handles();
  const out: number[] = [];
  for (const id of byId.keys()) {
    if (!ownsRecord(piOf(id), id, byId.get(id))) continue;
    for (let a = id, n = 0; a && n < 1024; a = parentOf(a), n++) if (a === entityId) { out.push(id); break; }
  }
  return out;
}

/** The root a reprojection of the tree holding `entityId` rebuilds: the OUTERMOST stored root above it (F6-U (i)) that is
 *  no Missing Prefab placeholder and lies under none. A reference node the scene added at a placeholder's root still shows
 *  there (#2018) with a record of its own; the placeholder above it has nothing to project (rule 9), so the node is the
 *  unit. 0 when `entityId` is in no instance that can be projected. */
export function projectionRootOf(entityId: number): number {
  let unit = 0;
  const { byId } = handles();
  for (const id of storedRootsAbove(entityId)) {
    const e = byId.get(id);
    if (!e || unresolvedRefOf(e as never)) break;
    unit = id;
  }
  return unit;
}

export function guidOfEntity(id: number): string {
  return handles().guidOf(id);
}

/** Every record-owning stored root of the current world (see `ownsRecord`). */
export function allStoredRoots(): number[] {
  const { byId, piOf } = handles();
  return [...byId.keys()].filter((id) => ownsRecord(piOf(id), id, byId.get(id)));
}
