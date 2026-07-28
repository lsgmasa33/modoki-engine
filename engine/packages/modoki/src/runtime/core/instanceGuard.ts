/** Cross-cutting singleton-duplication guard (OTA Phase 4,
 *  docs/ota-subgame-modules.md §5 — "the single highest-value guard"). Every route
 *  to two copies of this runtime running side-by-side — botched Rollup externalization
 *  in a sub-game build, a stale `sharedRegistry.ts` key, a future Vite `resolve.dedupe`
 *  regression — produces the SAME symptom: two separate ECS world registries, two trait
 *  registries, silently out of sync with each other in ways that "don't look like their
 *  cause" (a mesh spawned via one copy never renders in a scene managed by the other, a
 *  registered trait resolves as unknown on the other side, …).
 *
 *  This module increments a counter on `globalThis` every time IT is evaluated. Under
 *  correct deduplication there is exactly one module instance, so this file runs exactly
 *  once and the counter reads 1 forever. If dedup ever fails, a SECOND copy of this same
 *  source runs its own top-level code and sees the counter already at 1 — a live,
 *  self-diagnosing signal, independent of whatever else went wrong.
 *
 *  Always logs loudly (`console.error`) — this is a diagnostic, not a crash: a duplicated
 *  runtime is a serious bug to fix, but it is exactly the wrong moment to ALSO throw and
 *  take down an otherwise-working app. Imported for its side effect as the very first
 *  line of `runtime/index.ts`. */

export {}; // force module mode so `declare global` below is legal

declare global {
  // eslint-disable-next-line no-var
  var __MODOKI_RUNTIME_INSTANCES__: number | undefined;
}

const count = (globalThis.__MODOKI_RUNTIME_INSTANCES__ ?? 0) + 1;
globalThis.__MODOKI_RUNTIME_INSTANCES__ = count;

if (count > 1) {
  console.error(
    `[@modoki/engine/runtime] DUPLICATE RUNTIME INSTANCE DETECTED (#${count}). ` +
    'Two separate copies of this module are running side by side — this splits the ECS ' +
    'world/trait registries into two out-of-sync halves and WILL produce confusing bugs ' +
    '(a spawned entity invisible to the "other" world, a registered trait resolving as ' +
    'unknown, …) that do not look like their real cause. Likely culprits: a sub-game ' +
    'bundle that bundled its own copy instead of externalizing to the shared registry ' +
    '(see sharedRegistry.ts / subgameBuild.ts), a stale shared-registry key, or a Vite ' +
    '`resolve.dedupe` regression. See docs/ota-subgame-modules.md §5.',
  );
}
