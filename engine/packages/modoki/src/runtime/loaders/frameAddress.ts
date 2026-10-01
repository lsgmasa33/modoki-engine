/** A prefab FRAME's address in its scene (#1939): what a scene's copy of a missing prefab names as "live at the save"
 *  (`SceneData.embeddedPrefabFrames`, scene v19). The ONE spelling, read by the load and written by the save. The save
 *  addresses a frame from the LIVE world; the load from what the file states. They agree wherever the save states a node
 *  the way it lives — not for a node a prefab anchors AT a nested row's root, which the capture restates by guid while it
 *  lives by key (#1966, a known limit: that frame reloads a placeholder).
 *
 *  - An ANCHOR: the durable guid of a stored root the scene file states, a top-level entry's (`SceneEntityEntry.guid`) or
 *    a scene-added reference node's (`AddedEntity.guid`).
 *  - Then one component per frame below it: `/<nodeGuid>` for a nested ROW (the row's minted identity, which its root
 *    keeps as `PrefabInstance.parentNodeGuid`), and `/+<key>` for a TEMPLATE reference node (its `TemplateAddedKey`),
 *    addressed from the frame its key-derived guid derives from (`IdentityParents.derivesFrom`, #1809).
 *
 *  A frame with no address — a pre-v5 row (no nodeGuid), a stored root with no durable guid — is not listed, and its copy
 *  answers by the rows rule (`copyStandsIn`), the rule a file written before the list was. */

import type { Entity, World } from 'koota';
import { findEntityById } from '../core/ecs/world';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { worldIdentityParents } from '../core/ecs/identityParents';
import { templateKeyOf } from '../core/templateIdentity';
import { durableGuid, isOwnedRoot, isStoredRoot } from '../core/assetRefRules';

/** The frame a nested row expands, inside the frame `frame`. */
export function rowFrameAddress(frame: string | undefined, nodeGuid: string | undefined): string | undefined {
  return frame && nodeGuid ? `${frame}/${nodeGuid}` : undefined;
}

/** The frame a reference node expands: a template node (`key`) inside `frame`, else — a scene-added node, or a keyed one
 *  with no frame to address it from — at its own guid. */
export function nodeFrameAddress(frame: string | undefined, node: { key?: string; guid?: string }): string | undefined {
  if (node.key && frame) return `${frame}/+${node.key}`;
  return durableGuid(node.guid) || undefined;
}

/** The address of each live frame ROOT of `world` (a `PrefabInstance` root), `undefined` for one with none. Memoised per
 *  call: build one per save. */
export function liveFrameAddresser(world: World): (rootId: number) => string | undefined {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const parents = worldIdentityParents(world);
  const memo = new Map<number, string | undefined>();
  const at = (id: number): string | undefined => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, undefined); // a damaged chain that loops has no address
    const e = findEntityById(id, world) as Entity | undefined;
    const pi = e && piMeta && e.has(piMeta.trait)
      ? e.get(piMeta.trait) as { rootInstanceId?: number; parentLocalId?: number; parentNodeGuid?: string } : null;
    let out: string | undefined;
    if (e && pi && (isOwnedRoot(pi, id) || isStoredRoot(pi, id))) {
      if (isOwnedRoot(pi, id)) {
        // An owned nested root: its owner's frame, then the row that expanded it.
        const owner = parents.ownerOf(id);
        out = rowFrameAddress(owner ? at(owner) : undefined, pi.parentNodeGuid);
      } else {
        // A keyed root from the frame its key derives from; anything else, or a keyed root with no such frame, by its guid —
        // the load's rule (`nodeFrameAddress`; an entry is always its guid).
        const key = templateKeyOf(e);
        const frame = key ? parents.derivesFrom(id).parentId : 0;
        const guid = durableGuid(eaMeta && e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '');
        out = nodeFrameAddress(frame && frame !== id ? at(frame) : undefined, { key, guid });
      }
    }
    memo.set(id, out);
    return out;
  };
  return at;
}
