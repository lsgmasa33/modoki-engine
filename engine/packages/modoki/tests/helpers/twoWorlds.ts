/**
 * The two-live-Worlds fixture (#851) — one shape, reused, instead of nine hand-rolled variants.
 *
 * The class: a per-`World` cache's discriminant is unfalsifiable because no test holds two live
 * `World`s while exercising that cache's read/write path in the SAME assertion. Collapse the
 * `WeakMap<World,…>`/`Map<World,…>` to a bare module-level value and the suite stays green.
 * #828 is the same mechanism on the renderer axis, #838 on the world-swap-teardown axis; this is
 * the third, and `docs/falsifiable-tests.md` carries the bar.
 *
 * ⚠️ **Two instances is NECESSARY, NOT SUFFICIENT — the assertion has to interrogate the STALE
 * one.** `guidIndex.test.ts` already built two worlds and registered the same guid in both, then
 * asserted only that the CURRENT world resolved correctly; under a shared map the second write
 * simply overwrites and that assertion still passes. Everything here is therefore written as
 * "write to A, write to B, then read A BACK" — never "read the one you wrote last".
 *
 * ⚠️ **The helper itself must be falsifiable.** `assertIsolated` runs a built-in control that
 * fails when the two handles are the same world, so a caller that accidentally passes one world
 * twice gets a loud failure instead of a green test proving nothing.
 *
 * ⚠️ **Honest scope.** The two-live-`World`s window is NARROWER here than on #828's axis: the
 * editor runs SceneView and GameView as two permanently coexisting renderers, whereas two koota
 * `World`s coexist only transiently, during the two-world atomic scene swap. This is a COVER gap
 * first and only possibly a live defect — do not read a row count as severity.
 */
import { expect, onTestFinished } from 'vitest';
import { createWorld, type World } from 'koota';

export interface TwoWorlds {
  a: World;
  b: World;
  /** Both, for a caller that wants to iterate. */
  both: readonly [World, World];
}

/** Two independent live koota worlds. Neither is made current — a member whose API defaults to
 *  `getCurrentWorld()` should pass the world EXPLICITLY, so the test cannot accidentally be
 *  measuring `setCurrentWorld` instead of the cache's own keying.
 *
 *  ⚠️ **koota caps a process at 16 worlds**, and this fixture is used by a whole file of tests, so
 *  both worlds are destroyed via `onTestFinished` — per TEST, automatically, rather than leaving
 *  every caller to remember an `afterEach`. Measured: without this the ninth test in a file dies
 *  with `Koota: Too many worlds created`, which reads as a bug in the code under test rather
 *  than budget exhaustion in the harness. */
export function twoWorlds(): TwoWorlds {
  const a = createWorld();
  const b = createWorld();
  onTestFinished(() => {
    for (const w of [a, b]) {
      try { w.destroy(); } catch { /* already gone — a test may have destroyed it deliberately */ }
    }
  });
  return { a, b, both: [a, b] };
}

/**
 * The whole contract, in one call: write a distinguishable value into each world, then read BOTH
 * back and assert each still sees its own.
 *
 * @param write  put `value` into `world`'s slot
 * @param read   read `world`'s slot back
 * @param values two distinguishable values — they must not be equal, or the assertion is vacuous
 */
export function assertIsolated<T>(
  worlds: TwoWorlds,
  write: (world: World, value: T) => void,
  read: (world: World) => unknown,
  values: readonly [T, T],
  label = 'per-World state',
): void {
  const { a, b } = worlds;
  expect(a, `${label}: the fixture was handed ONE world twice — every isolation assertion below `
    + 'would be trivially satisfied').not.toBe(b);
  expect(values[0], `${label}: the two probe values are equal, so the assertion cannot fail`).not.toEqual(values[1]);

  write(a, values[0]);
  write(b, values[1]);

  // Read A back AFTER B was written — this ordering is the entire point. Asserting on B here
  // would pass under a shared module-level value (last write wins), which is exactly the
  // near-miss that let this class survive in guidIndex.test.ts.
  expect(read(a), `${label}: world A's value was clobbered by a write to world B — the cache is `
    + 'not keyed by World').toEqual(values[0]);
  expect(read(b), `${label}: world B lost its own value`).toEqual(values[1]);
}

/** The other half of the contract: clearing ONE world must leave the other intact. A teardown
 *  that clears a shared module-level value passes an "A is empty now" assertion just as happily. */
export function assertClearIsScoped<T>(
  worlds: TwoWorlds,
  write: (world: World, value: T) => void,
  read: (world: World) => unknown,
  clear: (world: World) => void,
  values: readonly [T, T],
  empty: unknown,
  label = 'per-World state',
): void {
  const { a, b } = worlds;
  expect(a).not.toBe(b);
  write(a, values[0]);
  write(b, values[1]);
  clear(a);
  expect(read(a), `${label}: clearing world A should empty A`).toEqual(empty);
  expect(read(b), `${label}: clearing world A ALSO cleared world B — the state is shared`).toEqual(values[1]);
}
