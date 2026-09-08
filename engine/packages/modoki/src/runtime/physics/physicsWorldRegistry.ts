/** physicsWorldRegistry — the shared per-koota-World state registry + WASM lifecycle for the
 *  2D and 3D physics systems. Each system keeps a `Map<World, State>` (a regular Map, NOT a
 *  WeakMap, so every Rapier world can be `free()`d explicitly) and must free that WASM on the
 *  SAME four paths: scene swap (`onWorldSwap` — shipped games never Stop), Play→Stop
 *  (`onPlayStateChange` stopped), the system's zero-body early-out, and an explicit dispose
 *  (tests). That bookkeeping is entirely dimension-agnostic, so it lives here once.
 *
 *  A physics reconciler calls `createPhysicsWorldRegistry(freeState)` at module load, passing a
 *  callback that frees the WASM handles it retains (Rapier world + event queue). The factory
 *  owns the Map and registers the Stop/swap hooks; the system uses the returned `worlds` map
 *  directly and re-exports `dispose`/`disposeAll` for tests + the early-out. */

import type { World } from 'koota';
import { getPlayState, onPlayStateChange } from '../core/playState';
import { onWorldSwap } from '../core/ecs/world';

export interface PhysicsWorldRegistry<S> {
  /** The live per-World state map. Keyed by koota World; a regular Map so it can be iterated + freed. */
  readonly worlds: Map<World, S>;
  /** Free one world's WASM + drop it from the map (scene teardown / test afterEach / early-out). */
  dispose(world: World): void;
  /** Free ALL worlds' WASM (called on Play→Stop so the next Play rebuilds fresh). */
  disposeAll(): void;
  /** Free everything AND unregister this registry's global Stop/world-swap hooks.
   *
   *  Production never calls this — the two registries are module-load singletons and are meant to
   *  live for the process. It exists because the factory otherwise has NO teardown at all, so
   *  every extra call leaks two listeners onto module-global sets that keep firing afterwards.
   *  That is invisible in production (two calls, ever) and not invisible in a test file that
   *  builds a registry per case: the survivors run `disposeAll()` on dead registries at the next
   *  `setPlayState('stopped')` or world swap. Added in the #851 close-out review. */
  disposeRegistry(): void;
}

/** Build a physics world registry. `freeState(state)` must release every WASM handle the state
 *  retains (typically `state.eventQueue.free()` + `state.world.free()`). The Stop + world-swap
 *  hooks are registered once here (module-load side effect in the caller). */
export function createPhysicsWorldRegistry<S>(freeState: (state: S) => void): PhysicsWorldRegistry<S> {
  const worlds = new Map<World, S>();

  const dispose = (world: World): void => {
    const st = worlds.get(world);
    if (!st) return;
    freeState(st);
    worlds.delete(world);
  };
  const disposeAll = (): void => {
    for (const st of worlds.values()) freeState(st);
    worlds.clear();
  };

  // On Stop, discard every sim so the next Play rebuilds from the reverted authored transforms.
  const offPlayState = onPlayStateChange(() => { if (getPlayState() === 'stopped') disposeAll(); });
  // Each scene load creates a NEW koota world and destroys the old one; setCurrentWorld fires
  // this synchronously with the old world still alive, so free its Rapier state here —
  // otherwise a shipped game (which never Stops) leaks a Rapier world per scene swap.
  const offWorldSwap = onWorldSwap((_next, old) => dispose(old));
  // Both unsubscribes were previously DISCARDED. Keeping them costs nothing and is what makes
  // `disposeRegistry` possible — see its doc comment for why that matters.
  const disposeRegistry = (): void => { disposeAll(); offPlayState(); offWorldSwap(); };

  return { worlds, dispose, disposeAll, disposeRegistry };
}
