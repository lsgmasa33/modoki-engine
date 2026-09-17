/** The "something changed, re-check everything" signal — extracted out of `ecs/entityUtils.ts`
 *  for the same reason `uiDirty.ts` was extracted out of `ui/uiTreeStore.ts`: a plain global
 *  pub/sub is not an ECS-owned concept, and `entityUtils.ts` wires `setStructureCallback` into
 *  `world.ts` as a MODULE-LOAD side effect — importing it just to reach `fireDirtyListeners`
 *  drags that wiring into anything that imports this, including L3 loader modules that tests
 *  mock `world.ts` around (measured: `assetManifest.ts` importing `entityUtils.ts` broke every
 *  test that `vi.mock`s `world.ts` without stubbing `setStructureCallback`).
 *
 *  `entityUtils.ts` re-exports both functions unchanged, so every existing caller keeps working. */

import { notifyListeners } from './notifyListeners';

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
 *  ⚠️ **An async REFILL owes this call too, and that is the half that keeps being forgotten.**
 *  A re-import has two edges. The eviction edge announces itself through `emitAssetInvalidated`,
 *  which ends by calling this — the viewport empties at once. The refill edge lands whenever the
 *  bytes finish fetching and parsing, and the rebuild only happens on a frame that RUNS: every
 *  idle-gated surface holds a ~1 s frame-countdown grace, so a refill slower than that redraws
 *  nothing, and the asset is evicted and never comes back. It reads as data loss, not staleness.
 *  Measured twice at 10 s+ on `games/space-console` (QA-ASSET-0008), and again on
 *  `games/alien-animal` for the stopped GameView (#1363): after the evict the scene held 0 meshes
 *  and the surface submitted 0 frames indefinitely, while the refilled model sat in the cache
 *  unused — one forced render brought it straight back.
 *
 *  ⚠️ **Do not answer that with a private notify channel.** The model caches did exactly that
 *  (`modelLoadNotify.ts`, deleted in #1363): a dedicated `onModelTemplatesLoaded` event that
 *  SceneView subscribed to and nothing else ever did, so the fix covered one render-on-demand
 *  surface of two and its own docblock claimed the GameView "needs none of this" — false two
 *  months before it was written, since the GameView's idle gate landed first. Every other async
 *  refill in `meshTemplateCache` (`fetchEnvironment`'s success path, the material refetch) already
 *  calls this, which is why none of them had the bug. Call this; every surface is a subscriber.
 *
 *  This is the 3D instance of the rule #1141 already set for the stopped 2D renderer — the wake
 *  belongs in the WRITER, not the call site, so a cache's one store function covers every writer at
 *  once. `docs/rendering.md` § the two-tier 2D gate owns that rule and now names both cases; it also
 *  lists the caches that deliberately need NO wake (`spriteAnimCache`, `animationClipCache`,
 *  `timelineCache` — they feed systems that do not run while stopped). Read it before concluding a
 *  cache is missing one.
 *
 *  ⚠️ **What a fire actually costs, since this asks every refill to make one.** Four of the five
 *  subscribers are pure flag sets (`Scene3D`, `Scene2D`, `SceneView`, `canvas2DDirty`). The fifth is
 *  NOT: `uiTreeStore` subscribes `markUIDirty`, which sets its flag **and** calls `notifyEditorDirty`,
 *  a synchronous fan-out to every `onEditorDirty` subscriber (the Inspector, UIResizeOverlay). So a
 *  scene load with N models re-runs those editor callbacks N times, from inside the GLB parse. That
 *  is not new — the evict edge and every `writeTraitField` already do it, and `notifyListeners`
 *  isolates a throwing subscriber — but "it is only a flag" is true of the other four only, and is
 *  the wrong thing to reason from if a refill ever fires this at per-frame rates.
 *
 *  Isolated per-listener (close-out review): this now sits on the asset delete/re-import path
 *  (`assetManifest.ts`/`assetInvalidation.ts`), which — like `emitAssetInvalidated`'s own
 *  listener loop — must not let one throwing subscriber abort a caller mid-eviction, or a
 *  half-pruned manifest / half-evicted cache is the result. Mirrors that loop's isolation. */
export function fireDirtyListeners() {
  notifyListeners(_dirtyListeners, 'renderDirty', []);
}
