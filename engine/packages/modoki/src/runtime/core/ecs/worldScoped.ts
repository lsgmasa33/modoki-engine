/** worldScoped — module state that belongs to ONE koota world (#1315).
 *
 *  A game's module-level `let` outlives the world it describes. The old answer was a teardown
 *  (`onWorldSwap` listener, `enterWorld`) that resets a HAND-MAINTAINED list of such variables, and
 *  that list is the defect: a variable is reset only if someone remembered to add it, and a value
 *  written conditionally or captured once (`if (x === null) x = …`) silently carries the previous
 *  world's value into the next. Court's `sceneAuthoredLevelId`, Sling's field walls (#1292) and
 *  Weaveling's loaders (#1288, #1294) were all that one mechanism.
 *
 *  A `worldScoped` value is keyed BY the world instead of reset on a swap: a world that has never
 *  been written to has no entry, so it reads `init()`. There is no reset list to forget, and no
 *  window in which some other `onWorldSwap` listener runs before a reset listener and reads the
 *  old value. Old worlds drop their entry via GC — the same shape `rng.ts`, `sceneLoaded.ts`,
 *  `audioSystem.ts` and `canvas2DHost.ts` each hand-roll.
 *
 *  `world` defaults to `getCurrentWorld()`. Pass it explicitly from code that runs against a world
 *  that is not current yet (a bind step populating `SceneManager`'s next world).
 *
 *  `reset()` is for the resets that are NOT a world swap — a game's register/unregister, or a test
 *  seam that rebuilds inside one world. A world swap needs no call at all.
 *
 *  ⚠️ `init()` runs once per world, on the first `get()` there, so a mutable default (an object or
 *  array) is a fresh one per world — mutate it in place freely, it cannot leak across worlds. */

import type { World } from 'koota';
import { getCurrentWorld, peekCurrentWorld } from './worldRegistry';

export interface WorldScoped<T> {
  /** This world's value — `init()` if the world has never been written to (or was `reset`). */
  get(world?: World): T;
  /** Replace this world's value. Other worlds are untouched. */
  set(value: T, world?: World): void;
  /** Forget this world's value, so the next `get` there re-runs `init()`. With no argument it
   *  targets the current world but never CREATES one (a reset with no world is a no-op). */
  reset(world?: World): void;
}

export function worldScoped<T>(init: () => T): WorldScoped<T> {
  // A box, not the bare value: `T` may itself be `undefined`, which a bare `WeakMap.get` cannot
  // tell apart from "never written in this world".
  const slots = new WeakMap<World, { value: T }>();
  return {
    get(world = getCurrentWorld()) {
      let slot = slots.get(world);
      if (!slot) {
        slot = { value: init() };
        slots.set(world, slot);
      }
      return slot.value;
    },
    set(value, world = getCurrentWorld()) {
      slots.set(world, { value });
    },
    reset(world = peekCurrentWorld() ?? undefined) {
      // `peek`, not `get`: the plain `= null` resets this replaces never allocated a world, and a
      // teardown that creates one spends a koota slot (16-world cap) to clear nothing.
      if (world) slots.delete(world);
    },
  };
}
