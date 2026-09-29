/** The parent-link rule over ANY hierarchy — the live world's and a scene FILE's (#1825).
 *
 *  `reparentRefusal` (hierarchy.ts) asks it of the live world, for the editor's reparent and the device's direct
 *  `parentId` write; the file-direct scene-mutate `setTrait` asks it of the entries in a scene file, which has no live
 *  world to ask. One rule, two graphs: the file path used to store `EntityAttributes.parentId` with no check at all, so
 *  a self-parent, a cycle or a resource parent reached the file and only `validateSceneData`'s warnings noticed.
 *
 *  Import-free on purpose: sceneMutate.ts runs identically in Node (the backend route) and the browser, and must not
 *  pull the ECS in to reach this. */

export type ReparentRefusal = 'self-parent' | 'cycle' | 'resource';

/** A hierarchy the rule can walk. `K` is whatever names a node — a live id, or a file entry. */
export interface ParentGraph<K> {
  /** The node's parent, or null at the root (or when its parent names nothing, which ends the walk). */
  parentOf(node: K): K | null;
  /** Is the node a resource (a world singleton: Time, Input, a game config)? */
  isResource(node: K): boolean;
  /** How many nodes there are — bounds the walk, so an ALREADY cyclic graph still terminates. */
  size: number;
}

/** Why making `parent` the parent of `child` is illegal, or null when it is fine. `parent` null is the root, always
 *  legal. A resource neither goes under a node nor holds one — but only a NEW link is judged, so a reorder under the
 *  parent the node already has passes, and a resource a file did parent can still be moved out to the root. */
export function parentLinkRefusal<K>(graph: ParentGraph<K>, child: K, parent: K | null): ReparentRefusal | null {
  if (parent === null) return null;
  if (child === parent) return 'self-parent';
  if (parent !== graph.parentOf(child) && (graph.isResource(child) || graph.isResource(parent))) return 'resource';
  let hops = 0;
  for (let cur = graph.parentOf(parent); cur !== null && hops++ <= graph.size; cur = graph.parentOf(cur)) {
    if (cur === child) return 'cycle';
  }
  return null;
}
