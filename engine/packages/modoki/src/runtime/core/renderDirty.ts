/** The "something changed, re-check everything" signal — extracted out of `ecs/entityUtils.ts`
 *  for the same reason `uiDirty.ts` was extracted out of `ui/uiTreeStore.ts`: a plain global
 *  pub/sub is not an ECS-owned concept, and `entityUtils.ts` wires `setStructureCallback` into
 *  `world.ts` as a MODULE-LOAD side effect — importing it just to reach `fireDirtyListeners`
 *  drags that wiring into anything that imports this, including L3 loader modules that tests
 *  mock `world.ts` around (measured: `assetManifest.ts` importing `entityUtils.ts` broke every
 *  test that `vi.mock`s `world.ts` without stubbing `setStructureCallback`).
 *
 *  `entityUtils.ts` re-exports both functions unchanged, so every existing caller keeps working. */

const _dirtyListeners: Set<() => void> = new Set();

/** Register a dirty listener. Returns an unsubscribe function. */
export function addDirtyListener(fn: () => void): () => void {
  _dirtyListeners.add(fn);
  return () => { _dirtyListeners.delete(fn); };
}

/** Fire ALL registered dirty listeners (NOT UI-specific — it just notifies every subscriber,
 *  one of which is uiTreeStore.markUIDirty). Use after a direct trait write that bypasses
 *  writeTraitField (e.g. a bulk `entity.set` from a gizmo drag), so the Inspector, the 3D/2D
 *  render loops and other subscribers refresh. writeTraitField already calls this internally.
 *
 *  Isolated per-listener (close-out review): this now sits on the asset delete/re-import path
 *  (`assetManifest.ts`/`assetInvalidation.ts`), which — like `emitAssetInvalidated`'s own
 *  listener loop — must not let one throwing subscriber abort a caller mid-eviction, or a
 *  half-pruned manifest / half-evicted cache is the result. Mirrors that loop's isolation. */
export function fireDirtyListeners() {
  for (const fn of _dirtyListeners) {
    try { fn(); } catch (e) { console.warn('[renderDirty] a dirty listener threw:', e); }
  }
}
