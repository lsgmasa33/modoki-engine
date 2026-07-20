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
import { getPlayState, onPlayStateChange } from './playState';
import { onWorldSwap } from '../ecs/world';

export interface PhysicsWorldRegistry<S> {
  /** The live per-World state map. Keyed by koota World; a regular Map so it can be iterated + freed. */
  readonly worlds: Map<World, S>;
  /** Free one world's WASM + drop it from the map (scene teardown / test afterEach / early-out). */
  dispose(world: World): void;
  /** Free ALL worlds' WASM (called on Play→Stop so the next Play rebuilds fresh). */
  disposeAll(): void;
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
  onPlayStateChange(() => { if (getPlayState() === 'stopped') disposeAll(); });
  // Each scene load creates a NEW koota world and destroys the old one; setCurrentWorld fires
  // this synchronously with the old world still alive, so free its Rapier state here —
  // otherwise a shipped game (which never Stops) leaks a Rapier world per scene swap.
  onWorldSwap((_next, old) => dispose(old));

  return { worlds, dispose, disposeAll };
}
