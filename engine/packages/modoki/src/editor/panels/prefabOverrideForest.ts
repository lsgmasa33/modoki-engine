/** Nest the Apply/Revert dialog's flat override-entity list into a forest by ECS
 *  parent, so a child entity (e.g. a mesh under "Island") renders indented under
 *  its parent instead of as a flat sibling. The dialog previously sorted entities
 *  by localId and rendered them all at one indent level, ignoring parentage. */

export interface ForestNode<T> {
  node: T;
  depth: number;
  children: ForestNode<T>[];
}

/** Build a forest from a flat list using each item's `parentEcsId`.
 *
 *  - An item whose parent is present in the list nests under it.
 *  - An item whose parent is absent (its real parent has no overrides, so there's
 *    nothing to group under) becomes a root.
 *  - Sibling order follows input order (the caller pre-sorts by localId).
 *  - Defensive against self-parenting and parent cycles: every input item appears
 *    in the output exactly once — an override row is NEVER silently dropped. */
export function buildOverrideForest<T extends { ecsId: number; parentEcsId: number }>(
  entities: T[],
): ForestNode<T>[] {
  const byId = new Map<number, T>();
  for (const e of entities) byId.set(e.ecsId, e);

  const childrenOf = new Map<number, T[]>();
  const roots: T[] = [];
  for (const e of entities) {
    const hasParent = e.parentEcsId !== e.ecsId && byId.has(e.parentEcsId);
    if (hasParent) {
      const arr = childrenOf.get(e.parentEcsId) ?? [];
      arr.push(e);
      childrenOf.set(e.parentEcsId, arr);
    } else {
      roots.push(e);
    }
  }

  const visited = new Set<number>();
  const build = (e: T, depth: number): ForestNode<T> => {
    visited.add(e.ecsId);
    const kids = (childrenOf.get(e.ecsId) ?? []).filter((c) => !visited.has(c.ecsId));
    return { node: e, depth, children: kids.map((c) => build(c, depth + 1)) };
  };

  const forest = roots.map((r) => build(r, 0));
  // Safety net: anything unreachable (a parent cycle) still surfaces as a root.
  for (const e of entities) {
    if (!visited.has(e.ecsId)) forest.push(build(e, 0));
  }
  return forest;
}
