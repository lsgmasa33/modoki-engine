/** The order entities are written to a `.scene.json`, and the order the Hierarchy panel
 *  displays — ONE rule, shared by the serializer, the panel, and a guard test over the
 *  committed scene files (QA-HIER-0002).
 *
 *  It used to be live-world iteration order, which follows runtime ECS ids. Those are
 *  reassigned by a delete+undo (the entity respawns at a new id) or a duplicate+delete, so
 *  the next save re-emitted IDENTICAL data in a different order — a contentless diff that
 *  rides into an unrelated commit because nobody reads it (the CLAUDE.md #18 hazard), and
 *  makes "git status is clean" unusable as a QA cleanup check for any case touching entity
 *  lifecycle.
 *
 *  The tiebreak is the GUID, not an ecs/runtime id: colliding sortOrders are ordinary
 *  (legacy entities all sit at 0), and an id tiebreak reintroduces exactly the churn this
 *  removes — ids are reassigned by delete+undo and duplicate+delete. Name is the last
 *  resort, for the un-guidable entity a caller's guid accessor returns '' for.
 *
 *  This is a LEAF module: no imports from the editor, no world access, no I/O. Callers
 *  supply the guid (the serializer's is a live+minted lookup; a caller with static data
 *  supplies a plain field read) and adapt their own record shape. */

/** The sibling comparator: `sortOrder`, then guid, then name. */
export function compareSiblings<T extends { sortOrder: number; name: string }>(
  guidOf: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) =>
    a.sortOrder - b.sortOrder
    || guidOf(a).localeCompare(guidOf(b))
    || a.name.localeCompare(b.name);
}

/** Flatten a set of entities into the order they are WRITTEN to a scene file: roots and
 *  siblings ordered by {@link compareSiblings}, each parent immediately followed by its
 *  own subtree, depth-first.
 *
 *  An item is a ROOT when its `parentKey` is `null`/`undefined`, or when no item in `items`
 *  has that key — a parent outside this slice (a base-owned parent, an excluded transient)
 *  makes the entity a root here, same as `buildEntityTree`.
 *
 *  Belt-and-braces: a parent cycle would strand entities out of the depth-first walk.
 *  Anything the walk did not reach is appended at the end, in original input order, rather
 *  than silently DROPPED from the result.
 *
 *  Does not mutate `items`. */
export function orderEntitiesForSave<T, K>(
  items: T[],
  adapt: (item: T) => { key: K; parentKey: K | null; sortOrder: number; name: string; guid: string },
): T[] {
  const adapted = items.map((item) => ({ item, info: adapt(item) }));
  const present = new Set(adapted.map((a) => a.info.key));
  const childrenOf = new Map<K, typeof adapted>();
  const roots: typeof adapted = [];
  for (const a of adapted) {
    const { parentKey } = a.info;
    if (parentKey !== null && parentKey !== undefined && present.has(parentKey)) {
      const list = childrenOf.get(parentKey);
      if (list) list.push(a); else childrenOf.set(parentKey, [a]);
    } else {
      roots.push(a);
    }
  }

  const bySortThenGuidThenName = compareSiblings<(typeof adapted)[number]['info']>((info) => info.guid);
  const byWrapped = (a: (typeof adapted)[number], b: (typeof adapted)[number]) =>
    bySortThenGuidThenName(a.info, b.info);

  const out: T[] = [];
  const visit = (list: typeof adapted) => {
    for (const a of [...list].sort(byWrapped)) {
      out.push(a.item);
      const kids = childrenOf.get(a.info.key);
      if (kids) visit(kids);
    }
  };
  visit(roots);

  if (out.length !== items.length) {
    const emitted = new Set(out);
    for (const item of items) if (!emitted.has(item)) out.push(item);
  }
  return out;
}
