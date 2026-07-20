/** canvas2DRouting — resolve which Canvas2D a Renderable2D entity belongs to.
 *
 *  A Renderable2D renders into its NEAREST Canvas2D ancestor (walking up the
 *  EntityAttributes.parentId chain). Both the runtime PixiJS layer (Scene2D)
 *  and the editor's SceneView overlay route the same way so the editor preview
 *  matches what ships. Scene2D keeps a per-frame cache layer on top of this for
 *  the hot render path; the editor calls it directly.
 *
 *  Pure + allocation-light (one Set guard against malformed cyclic parents). */

/** Walk up `entityId`'s parent chain to the nearest entity in `canvasIds`.
 *  Returns that Canvas2D entity id, or null if the entity has no Canvas2D
 *  ancestor. An entity that is itself a Canvas2D resolves to itself.
 *
 *  Optional `visited` is an out-param the caller may pass to collect, in walk
 *  order, every NON-canvas entity stepped through (i.e. the resolved canvas
 *  itself is excluded — it returns early). Scene2D uses this to cache the whole
 *  walked path → resolved canvas in one shot, so siblings sharing intermediate
 *  ancestors short-circuit. The walk is cycle-guarded, so `visited` lists each
 *  cyclic member at most once even on a malformed parent chain. */
export function findCanvasAncestor(
  entityId: number,
  parentOf: Map<number, number>,
  canvasIds: Set<number>,
  visited?: number[],
): number | null {
  let current = entityId;
  const seen = new Set<number>(); // guard against cyclic/self-referential parents
  while (current > 0 && !seen.has(current)) {
    if (canvasIds.has(current)) return current;
    seen.add(current);
    visited?.push(current);
    current = parentOf.get(current) || 0;
  }
  return null;
}
