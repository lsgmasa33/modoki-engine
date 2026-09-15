/** Collect entity subtrees by ECS parent link — one walk shared by the editor's `deleteEntities` and the
 *  runtime loader's structural removal (#1247).
 *
 *  Dependency-free on purpose: the loader is world-parameterized (it runs against SceneManager's staging
 *  world, never the current one), so it cannot go through `getAllEntities`; and suites that mock
 *  `entityUtils` wholesale still get the real walk through the loader.
 *
 *  Only sound while every live `parentId` names its LIVE parent or is 0. Both prefab instantiators spawn their
 *  rows parentless and remap in a second pass for exactly this reason: a prefab file's raw localId sitting in a
 *  live parentId would name whichever entity holds that number. A DANGLING parentId breaks it the same way —
 *  `destroyEntity` does not cascade, so a child whose parent was destroyed alone keeps the dead id, and a
 *  later entity that reclaims that index (koota recycles last-in-first-out) takes it into its subtree. */

/** Every id in the subtrees rooted at `rootIds` (inclusive), each once, depth-first. Within one root's walk a
 *  parent precedes its children; a root that is also a descendant of a LATER root keeps its first place.
 *  `links` is `[id, parentId]` per live entity; a parentId of 0 or less is no parent. A root with
 *  no entry in `links` is still returned. A visited set makes a parent cycle terminate. */
export function collectSubtreeIds(
  links: Iterable<readonly [id: number, parentId: number]>,
  rootIds: Iterable<number>,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [id, parentId] of links) {
    if (!(parentId > 0)) continue;
    let arr = childrenByParent.get(parentId);
    if (!arr) { arr = []; childrenByParent.set(parentId, arr); }
    arr.push(id);
  }
  const out: number[] = [];
  const visited = new Set<number>();
  for (const rootId of rootIds) {
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      out.push(id);
      const children = childrenByParent.get(id);
      if (children) stack.push(...children);
    }
  }
  return out;
}
