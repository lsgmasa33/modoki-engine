/** World Registry — manages the active koota World and notifies subscribers on swap.
 *
 *  During steady state there is exactly one world (the "main" world). During scene
 *  loading the SceneManager creates a transient "next" world, populates it in
 *  isolation, then calls setCurrentWorld() to atomically promote it. All consumers
 *  read from getCurrentWorld() — they should not capture the result at module load
 *  time, only inside callbacks/functions, so swaps take effect immediately.
 *
 *  Each world has its own entity index (number → Entity) stored in a WeakMap, so
 *  disposing a world automatically disposes its index via GC. */

import { createWorld, type World } from 'koota';

let _currentWorld: World | null = null;

type SwapListener = (newWorld: World, oldWorld: World) => void;
const listeners = new Set<SwapListener>();

// Per-world entity index. WeakMap so old worlds GC cleanly.
const entityIndices = new WeakMap<World, Map<number, any>>();
// Per-world guid→entity index, symmetric to the asset manifest's guidToEntry map.
// Maintained by registerEntity/unregisterEntity/indexEntityGuid in world.ts; this is
// what makes guid a first-class O(1) entity identity (not an O(n) world scan).
const guidIndices = new WeakMap<World, Map<string, any>>();

/** Get the active main world. Creates one lazily on first call. */
export function getCurrentWorld(): World {
  if (!_currentWorld) {
    _currentWorld = createWorld();
    entityIndices.set(_currentWorld, new Map());
    guidIndices.set(_currentWorld, new Map());
  }
  return _currentWorld;
}

/** Peek at the active world WITHOUT lazily creating one (null if none set yet).
 *  Use in hot paths / guards that must not accidentally allocate a world — e.g. the
 *  lifecycle-journaling guard in registerEntity, which otherwise spuriously spawns a
 *  world (and can blow koota's 16-world cap in fresh-module tests). */
export function peekCurrentWorld(): World | null {
  return _currentWorld;
}

/** Promote a world to be the active main world. Fires onWorldSwap listeners. */
export function setCurrentWorld(next: World): void {
  const old = getCurrentWorld();
  if (next === old) return;
  if (!entityIndices.has(next)) {
    entityIndices.set(next, new Map());
  }
  if (!guidIndices.has(next)) {
    guidIndices.set(next, new Map());
  }
  _currentWorld = next;
  for (const fn of listeners) fn(next, old);
}

/** Subscribe to world-swap events. Returns an unsubscribe function. */
export function onWorldSwap(fn: SwapListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Get the entity index for a given world (creates if missing). */
export function getEntityIndex(world: World): Map<number, any> {
  let idx = entityIndices.get(world);
  if (!idx) {
    idx = new Map();
    entityIndices.set(world, idx);
  }
  return idx;
}

/** Get the guid→entity index for a given world (creates if missing). */
export function getGuidIndex(world: World): Map<string, any> {
  let idx = guidIndices.get(world);
  if (!idx) {
    idx = new Map();
    guidIndices.set(world, idx);
  }
  return idx;
}
