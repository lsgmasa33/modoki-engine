/** Read-source registry — the read-side mirror of the UIAction registry.
 *
 *  Where `actionRegistry` lets Managers/Systems expose named *actions* UI can
 *  call, this lets them expose named *values* UI can bind. A Manager registers a
 *  getter (e.g. 'timeSinceGameStart', 'canGoBack'); the binding resolver resolves
 *  `{name}` against store state first, then these getters. Values are read live
 *  at resolve time — no per-frame projection copies them into a store.
 *
 *  LIFECYCLE (F9): the registry is OWNER-MANAGED, NOT auto-cleared on scene/world
 *  swap. Entries here are app-lifetime by design — manager-owned read sources
 *  (TimeManager, NavigationManager) live as long as their manager, which may persist
 *  across scenes; clearing them on every world swap would strand a manager that
 *  registered once and outlives the scene. So each owner MUST unregister its own
 *  entries in its teardown — use the disposer returned by `registerReadSource`
 *  (identity-safe) or `unregisterReadSource(name)`.
 *
 *  See docs/managers-and-systems.md ("Write side & read side"). */

type ReadSourceGetter = () => unknown;

const sources = new Map<string, ReadSourceGetter>();

/** Register a named live value. A later registration of the same name replaces —
 *  warn (in dev) on collision, since two owners claiming one name silently shadow
 *  each other. Returns an IDENTITY-SAFE disposer: it removes the entry only if THIS
 *  getter is still the registered one, so if owner B overwrote owner A's name, A's
 *  disposer running later won't yank B's getter out from under it (the footgun the
 *  bare name-keyed `unregisterReadSource` has). Prefer the returned disposer. */
export function registerReadSource(name: string, getter: ReadSourceGetter): () => void {
  if (import.meta.env?.DEV && sources.has(name)) {
    console.warn(`[readSource] "${name}" already registered — overwriting (two owners sharing a name shadow each other)`);
  }
  sources.set(name, getter);
  return () => {
    // Only delete if we're still the live getter — don't clobber a later registrant.
    if (sources.get(name) === getter) sources.delete(name);
  };
}

export function unregisterReadSource(name: string): void {
  sources.delete(name);
}

/** Read a registered value, or `undefined` if no source is registered. A getter
 *  that throws is treated as `undefined` (logged) so one bad source can't break
 *  template resolution. */
export function getReadValue(name: string): unknown {
  const getter = sources.get(name);
  if (!getter) return undefined;
  try {
    return getter();
  } catch (e) {
    console.warn(`[readSource] getter "${name}" threw`, e);
    return undefined;
  }
}

export function getReadSourceNames(): string[] {
  return [...sources.keys()];
}

/** Test-only: clear all registered sources. */
export function __resetReadSourcesForTesting(): void {
  sources.clear();
}
