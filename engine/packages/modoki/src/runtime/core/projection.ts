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
import { onWorldSwap } from './ecs/world';
import { isSimRunning } from './playState';
import { registerSystem, unregisterSystem, SYSTEM_PRIORITY } from './pipeline';

/** Minimal store shape — every Zustand store satisfies this. */
export interface SubscribableStore {
  subscribe(listener: () => void): () => void;
}

/** Options for `registerProjection`. */
export interface ProjectionOptions {
  /** Hold the projection while the simulation is not running (editor Stopped / Paused).
   *
   *  DEFAULT false, because a projection normally SHOULD run while stopped — that is what
   *  makes an inspector/gizmo edit reflect immediately (see `runPipeline`, which keeps the
   *  PROJECTION tier alive precisely for that).
   *
   *  Set it when the projection mirrors *runtime* state onto *authored* entities. A stopped
   *  editor has an authored scene on screen and a save writes it back to disk, so such a
   *  projection silently rewrites the file — #124: chess's LLM download starts at scene load
   *  (managers init on load, with no run-mode gate) and drives `loadProgress` onto the
   *  authored `ProgressBarFill`/`ProgressPercent`, whose values then land in the save.
   *
   *  Why this lives HERE and not as an early `return` inside the sync function: the dirty flag
   *  belongs to the wrapper. A sync function that returns early has already had its flag
   *  cleared, so state accumulated while stopped would never project — if the store went quiet
   *  before Play (e.g. the download finished), the first frame of Play would show authored
   *  values instead of live ones. Holding here leaves `dirty` SET, so the pending state
   *  projects on the first running frame. */
  pauseWhileStopped?: boolean;
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
  opts: ProjectionOptions = {},
): void {
  // Re-registering the same name must release the previous projection's store +
  // swap subscriptions first — otherwise the old listeners leak (they keep
  // firing against an orphaned dirty flag and retain their syncFn closure).
  unsubs.get(name)?.();

  let dirty = true; // project the initial state once
  const unsubStore = store.subscribe(() => { dirty = true; });
  const unsubSwap = onWorldSwap(() => { dirty = true; });
  unsubs.set(name, () => { unsubStore(); unsubSwap(); });

  const pauseWhileStopped = opts.pauseWhileStopped === true;

  registerSystem(name, (world) => {
    if (!dirty) return;
    // Deliberately BEFORE `dirty = false` — see ProjectionOptions.pauseWhileStopped. Holding
    // the flag is the whole point: the pending state must still project once the sim runs.
    if (pauseWhileStopped && !isSimRunning()) return;
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
