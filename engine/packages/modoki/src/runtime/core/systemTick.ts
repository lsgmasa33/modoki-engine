/** System-tick flag — lets an L0 module (`ecs/world.ts`) know whether the current call stack
 *  is inside a running system, without importing `pipeline.ts` (that would be an import cycle:
 *  `pipeline.ts` doesn't import `world.ts` today, but `world.ts` needing pipeline state back
 *  would create exactly the kind of edge the layer/cycle guard exists to catch). A dependency-
 *  free module-level boolean is the whole mechanism.
 *
 *  Consumer: `spawnEntity` (ecs/world.ts) tags a spawn made while this is true as `Transient` —
 *  see that file for why. Set by `runPipeline` (pipeline.ts) around its system loop. */

let inTick = false;

/** Mark the start of a system-pipeline tick. Pair with `endSystemTick()` in a `finally`. */
export function beginSystemTick(): void {
  inTick = true;
}

/** Mark the end of a system-pipeline tick. Always call from a `finally` so a throwing system
 *  can't leave the flag stuck on. */
export function endSystemTick(): void {
  inTick = false;
}

/** True while a registered system's `fn(world)` is executing (or one call deeper in its
 *  synchronous call stack). False for load-time spawns (scene load, GLB import, harness) and
 *  for anything that resumes in an async continuation started by a system — see the comment at
 *  the `spawnEntity` call site for why that gap is deliberate. */
export function inSystemTick(): boolean {
  return inTick;
}
