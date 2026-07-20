/** Pure helpers for Hierarchy multi-select — extracted from Hierarchy.tsx so the
 *  visible-order flattening and range computation can be unit-tested without a
 *  rendered tree. */

/** Minimal tree-node shape the flatten needs (a subset of EntityInfo). */
export interface FlattenNode {
  id: number;
  children?: FlattenNode[];
}

/** Flatten a hierarchy into the order rows are actually rendered (depth-first),
 *  skipping the children of any collapsed node. This is the order Shift-range
 *  selection operates in — what the user sees top-to-bottom. */
export function flattenVisibleIds(nodes: FlattenNode[], collapsed: Set<number>): number[] {
  const order: number[] = [];
  const walk = (list: FlattenNode[]) => {
    for (const n of list) {
      order.push(n.id);
      if (n.children?.length && !collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(nodes);
  return order;
}

/** Inclusive range of items between `anchor` and `target` in visible order
 *  (either direction). Generic over the item type so both the Hierarchy
 *  (entity ids) and the Assets panel (file paths) share one implementation.
 *  Returns null when either item isn't present, so the caller can fall back to a
 *  plain single-select. */
export function rangeBetween<T>(order: T[], anchor: T, target: T): T[] | null {
  const a = order.indexOf(anchor);
  const b = order.indexOf(target);
  if (a === -1 || b === -1) return null;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1);
}
