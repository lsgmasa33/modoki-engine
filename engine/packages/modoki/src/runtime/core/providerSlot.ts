/** A named seam an L2 subsystem calls into, that L3 composition installs an implementation for
 *  at init (P7 C8+). Lets a subsystem look up something composition owns — an asset cache
 *  lookup, a resolver — WITHOUT importing the L3 module directly (which would violate the
 *  layer contract and risk a genuine cycle).
 *
 *  Each provider-owning L3 module self-registers at module-evaluation time (bottom of the
 *  file: `mySlot.provide({ ... })`). `loaders/registerProviders.ts` imports every
 *  provider-owning loader for side effect, and `runtime/index.ts` imports it once — so any
 *  consumer that goes through the barrel (games, app, editor, `createTestWorld`) is wired.
 *
 *  Per the owner's D5 decision (docs/architecture-layers.md "## Settled decisions"):
 *  calling `get()` before `provide()` warns ONCE and returns `null` — it does NOT throw. This
 *  keeps headless unit tests (that deep-import one L2 module without going through
 *  `runtime/index.ts`) and DCE'd playable-ad builds working without a crash; a wiring bug is
 *  visible in the console, not fatal. Every caller already handles a null/undefined result.
 *
 *  One slot per TYPE flowing through it, owned by whichever L2 folder owns that type — never
 *  one god registry (it would satisfy the linter while re-creating the import hairball behind
 *  a single name). */

export interface ProviderSlot<T extends object> {
  /** Install the implementation. Called once, at the provider module's evaluation time. */
  provide(impl: T): void;
  /** Look up the implementation. Warns once and returns `null` if never provided. */
  get(): T | null;
  /** Test-only: clear the installed implementation and the warn-once flag. */
  reset(): void;
  isProvided(): boolean;
}

export function createProviderSlot<T extends object>(name: string): ProviderSlot<T> {
  let impl: T | null = null;
  let warned = false;
  return {
    provide(newImpl: T) {
      impl = newImpl;
    },
    get() {
      if (!impl && !warned) {
        warned = true;
        console.warn(`[providerSlot] "${name}" was read before anything provided it — returning null. `
          + 'This is expected in a headless test that deep-imports a module without going through '
          + 'runtime/index.ts, or a build that stripped the provider. If this is a real app/editor '
          + 'path, a provider registration is missing.');
      }
      return impl;
    },
    reset() {
      impl = null;
      warned = false;
    },
    isProvided() {
      return impl !== null;
    },
  };
}
