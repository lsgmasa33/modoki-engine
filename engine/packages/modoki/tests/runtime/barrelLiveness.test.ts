/** BARREL LIVENESS GUARD — `docs/architecture-layers.md` (P2 of the module-boundaries layering work).
 *
 *  The failure mode this plan exists to prevent is an **ESM circular import**. Those do NOT
 *  error: when module A is mid-evaluation and (transitively) imports B which imports A back,
 *  B sees A's not-yet-initialized bindings and gets `undefined` — silently. The symptom shows
 *  up arbitrarily far away ("X is not a function") and only under whichever module-evaluation
 *  order the bundler happened to pick.
 *
 *  Ordinary unit tests cannot see this: a unit test imports ONE module directly, so its
 *  evaluation order is the trivial one. Only loading the **barrel** (`runtime/index.ts`,
 *  ~630 exports over ~40 re-export statements) evaluates the whole graph in the order real
 *  consumers do. This test asserts that after that load, every named export is a live value.
 *
 *  Relationship to the OTHER two barrel tests:
 *   - `engine/tests/architecture/barrelSurface.test.ts` pins the NAMES (`Object.keys`) against
 *     a committed baseline. A name whose value is `undefined` still shows up as a present key,
 *     so that test cannot catch a cycle.
 *   - `barrelImportOrder.test.ts` (next to this file) re-runs this same liveness check once per
 *     module-evaluation ORDER. This file is the single-order case and the shared assertion.
 *
 *  Why `not undefined` rather than truthy: plenty of legitimate exports are falsy values
 *  (`0`, `false`, `''`). `undefined` is the specific signature of a circular-init miss.
 *
 *  MEASURED (2026-07-27, before any P3+ file move): ZERO exports are `undefined`, so there is
 *  no allowlist and none is warranted. If a future export is *intentionally* possibly-undefined
 *  (an optional config value re-exported as a `let`), that is a deliberate API decision and
 *  belongs in an explicit, commented allowlist here — not a silent loosening of the assertion.
 */

import { describe, it, expect } from 'vitest';

describe('runtime barrel liveness', () => {
  it('every named export of @modoki/engine/runtime is defined', async () => {
    // NOTE: `@modoki/engine/runtime` and the relative `../../src/runtime/index` path resolve to
    // the SAME Vite module id inside this package (verified: the `instanceGuard` duplicate
    // counter stays at 1 across both forms). The package specifier is used here because it is
    // what games/demos/the app import — this test should exercise the consumer-facing entry.
    const mod = (await import('@modoki/engine/runtime')) as Record<string, unknown>;
    const keys = Object.keys(mod);

    // Sanity floor: if the barrel ever collapses to a handful of exports, the liveness check
    // below would vacuously pass. (Exact-name drift is barrelSurface.test.ts's job.)
    expect(keys.length).toBeGreaterThan(600);

    const undefinedExports = keys.filter((k) => mod[k] === undefined).sort();
    expect(
      undefinedExports,
      'These barrel exports evaluated to `undefined`. That is the signature of an ESM circular ' +
        'import: some module in the cycle read a binding before the module that owns it finished ' +
        'evaluating. Fix the cycle (see docs/architecture-layers.md) — do NOT allowlist the name.',
    ).toEqual([]);
  });
});
