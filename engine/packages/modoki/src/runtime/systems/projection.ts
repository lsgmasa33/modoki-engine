/** registerProjection — a store→ECS sync that runs only when the store changes,
 *  instead of polling every frame. Generalizes uiTreeProjection's dirty-flag
 *  pattern over any Zustand store.
 *
 *  A projection mirrors reactive state (a store) into ECS entities. The naive
 *  form is a System that re-reads the store every frame and diffs; this instead
 *  subscribes to the store and marks a dirty flag, so the sync runs at most once
 *  per frame and only when something actually changed (or the scene swapped).
 *
 *  USE THIS only for *pure* store→ECS mirrors whose target entities exist as
 *  soon as the scene is loaded. For sync that needs a genuine per-frame tick —
 *  e.g. detecting an async DOM/canvas (re)mount, or sampling FPS — use
 *  `registerSystem` directly; that work isn't store-driven and the dirty flag
 *  would starve it. (See chessBoardSystem: it stays a System because it must
 *  re-attach a click handler whenever the PixiJS canvas remounts. Likewise a
 *  readback that reads ECS and writes a store — e.g. gameStatsSystem — can't use
 *  this helper: there's no store to subscribe to on the source side.) */

import type { World } from 'koota';
import { onWorldSwap } from '../ecs/world';
import { registerSystem, unregisterSystem, SYSTEM_PRIORITY } from './pipeline';

/** Minimal store shape — every Zustand store satisfies this. */
export interface SubscribableStore {
  subscribe(listener: () => void): () => void;
}

const unsubs = new Map<string, () => void>();

/** Register a projection. Runs `syncFn` at PROJECTION priority on the first frame
 *  after the store changes or the scene swaps (the syncFn should resolve its
 *  target entities lazily — they exist by the first post-swap frame). */
export function registerProjection(
  name: string,
  store: SubscribableStore,
  syncFn: (world: World) => void,
  priority: number = SYSTEM_PRIORITY.PROJECTION,
): void {
  // Re-registering the same name must release the previous projection's store +
  // swap subscriptions first — otherwise the old listeners leak (they keep
  // firing against an orphaned dirty flag and retain their syncFn closure).
  unsubs.get(name)?.();

  let dirty = true; // project the initial state once
  const unsubStore = store.subscribe(() => { dirty = true; });
  const unsubSwap = onWorldSwap(() => { dirty = true; });
  unsubs.set(name, () => { unsubStore(); unsubSwap(); });

  registerSystem(name, (world) => {
    if (!dirty) return;
    dirty = false;
    syncFn(world);
  }, priority);
}

/** Unregister a projection — drops its system and its store/swap subscriptions. */
export function unregisterProjection(name: string): void {
  const u = unsubs.get(name);
  if (u) { u(); unsubs.delete(name); }
  unregisterSystem(name);
}
