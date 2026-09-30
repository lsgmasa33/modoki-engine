/** The template keys a prefab door's CAPTURE stamps on the live tree, and taking them back off (#1884).
 *
 *  A template-form capture keys each scene-added node it writes as a template's added node (`addedNodeIdentity`, stamped
 *  so the next write of the same node writes the same key). Create Prefab's serialize and Apply's promotion both run one
 *  BEFORE their commit. A step that then lands nothing — its write fails or conflicts, or it refuses after the capture —
 *  and a step that is undone leave the node plain again, and must leave it unkeyed: a key on a plain node is one the save
 *  drops, so live and reloaded disagree, and a later capture reads it as the node's identity. Unity: an object that is
 *  no prefab's refers to none. The rule and its doors: docs/prefabs.md § "A door's pre-commit capture stamps come off
 *  when it lands nothing". */

import { templateKeyOf, TemplateAddedKey } from '../../runtime/core/templateIdentity';
import { getAllEntities, findEntity, captureEntityIdentity, readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { entityRef } from '../undo/entityRef';
import { collectTree } from './prefab';

/** The nodes of the tree that carry no template key — what a door takes before its capture keys any. */
export function unkeyedNodes(rootEcsId: number): Set<number> {
  const out = new Set<number>();
  for (const info of collectTree(rootEcsId, getAllEntities())) if (!templateKeyOf(findEntity(info.id))) out.add(info.id);
  return out;
}

/** The undo of the keys a capture put on: of `unkeyed`, the nodes that carry one now. Addressed by the guid each holds
 *  NOW — after Create's tag has stamped the member guids, the one each holds when its `undoKept` runs (before the rename
 *  is reversed), as `clearLinkedMarks`. */
export function stripCreatedKeys(unkeyed: ReadonlySet<number>): () => void {
  const refs = [...unkeyed].filter((id) => templateKeyOf(findEntity(id))).map((id) => entityRef(id));
  return () => {
    for (const ref of refs) {
      const id = ref.resolve();
      const e = id == null ? undefined : findEntity(id);
      if (e?.has(TemplateAddedKey)) e.remove(TemplateAddedKey);
    }
  };
}

/** Taken just before a door's capture.
 *  - `ids()`: those unkeyed nodes as they are now, in the world the snapshot was taken in (none after a switch). By their
 *    durable guid: a rebuild in place during the write (a rebase of a nested prefab, an adopt) respawns a node with the
 *    same guid and puts its template key back on the new entity by guid (`restoreTemplateKeys`), so a handle check lost
 *    it and left the key (the #1884 rider review). A node with no durable guid is found only while it is the same entity.
 *    A step that LINKED the tree meanwhile (another Create Prefab of it, landed during this one's write) re-derived the
 *    members' guids with its tag, so the snapshot no longer names them and leaves the keys that document declares.
 *  - `drop()`: take off the keys the capture put on them, for an exit that lands nothing.
 *  - `keyed()`: the keys they carry now, by guid. */
export function snapshotUnkeyed(rootEcsId: number): { ids: () => Set<number>; drop: () => void; keyed: () => Map<string, string> } {
  const world = getCurrentWorld();
  const eaMeta = getTraitByName('EntityAttributes');
  const guidOf = (id: number) => (eaMeta ? durableGuid((readTraitData(id, eaMeta) as { guid?: string } | null)?.guid) : '');
  const before = [...unkeyedNodes(rootEcsId)].map((id) => ({ id, guid: guidOf(id), same: captureEntityIdentity(id) }));
  const ids = () => {
    const out = new Set<number>();
    if (getCurrentWorld() !== world) return out;
    for (const n of before) {
      const id = n.guid ? findEntityByGuid(n.guid)?.id() : n.same() ? n.id : undefined;
      if (id != null) out.add(id);
    }
    return out;
  };
  /** The key each of those nodes carries now, by its durable guid: taken right after the capture, it is what the capture
   *  put on, which a redo seats again after a drop took it off. */
  const keyed = () => {
    const out = new Map<string, string>();
    for (const id of ids()) {
      const key = templateKeyOf(findEntity(id));
      const guid = key ? guidOf(id) : '';
      if (guid) out.set(guid, key);
    }
    return out;
  };
  return { ids, drop: () => stripCreatedKeys(ids())(), keyed };
}

