/** paintOrder — the single ordering source shared by the runtime PixiJS layer
 *  (Scene2D) and the editor SceneView, so both stack 2D/UI content identically.
 *
 *  Paint order is a depth-first walk of the entity hierarchy in `sortOrder`
 *  (lower = earlier). The first-visited entity is painted first (furthest back);
 *  the last-visited sits on top. Hit-testing is the reverse of this order.
 *
 *  This deliberately mirrors the runtime UI tree, which already sorts DOM
 *  siblings by `sortOrder` (see runtime/ui/uiTreeStore.ts). Explicit `zIndex`
 *  is layered on top as an optional CSS/Pixi override — it never replaces this
 *  baseline order, matching the "hierarchy first, z-index as escape hatch" model.
 *
 *  Pure + allocation-light; one `seen` set guards against malformed cyclic
 *  parents. Equal `sortOrder` siblings keep their insertion (query) order, since
 *  Array.prototype.sort is stable. */
export function computePaintOrder(
  sortOrderOf: Map<number, number>,
  parentOf: Map<number, number>,
  /** Optional per-entity "Order in Layer" (Renderable2D.orderInLayer). When given, the
   *  final order is re-ranked PRIMARILY by orderInLayer (higher = on top), with the
   *  hierarchy DFS index as the tiebreak — so an explicit layer order overrides tree
   *  position while entities sharing a layer keep their hierarchy stacking. */
  orderInLayerOf?: Map<number, number>,
): Map<number, number> {
  // Group children by parent (0 = root), preserving insertion order for ties.
  const childrenOf = new Map<number, number[]>();
  for (const id of sortOrderOf.keys()) {
    const p = parentOf.get(id) || 0;
    let arr = childrenOf.get(p);
    if (!arr) { arr = []; childrenOf.set(p, arr); }
    arr.push(id);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => (sortOrderOf.get(a) ?? 0) - (sortOrderOf.get(b) ?? 0));
  }

  const order = new Map<number, number>();
  const seen = new Set<number>();
  let next = 0;
  const visit = (id: number) => {
    if (seen.has(id)) return; // cyclic-parent guard
    seen.add(id);
    order.set(id, next++);
    const kids = childrenOf.get(id);
    if (kids) for (const k of kids) visit(k);
  };
  for (const r of childrenOf.get(0) || []) visit(r);
  // Orphans (parent points at a missing entity) — append in sortOrder so they
  // still get a stable, defined index rather than colliding at 0.
  for (const id of sortOrderOf.keys()) if (!order.has(id)) order.set(id, next++);

  // Re-rank by explicit Order-in-Layer (primary) with the hierarchy DFS index as the
  // stable tiebreak. Entities all sharing orderInLayer 0 keep the pure-hierarchy order,
  // so this is backward compatible when no orderInLayer is set.
  if (orderInLayerOf) {
    const ids = [...order.keys()];
    ids.sort((a, b) => ((orderInLayerOf.get(a) ?? 0) - (orderInLayerOf.get(b) ?? 0)) || ((order.get(a) ?? 0) - (order.get(b) ?? 0)));
    const ranked = new Map<number, number>();
    ids.forEach((id, i) => ranked.set(id, i));
    return ranked;
  }
  return order;
}
