/** Extra store-hook registry for the default game UI layer.
 *
 *  A game registers a React hook via `addStoreHook()` so its store-derived
 *  fields become available to UI bindings (the host's `DefaultGameUILayer`
 *  calls every registered hook and merges the results into `storeState`).
 *
 *  This lives in the ENGINE (not the app) so game code — including external
 *  projects that can't reach into the editor's `app/` folder — registers its
 *  hooks through the public `@modoki/engine/runtime` API:
 *
 *      import { addStoreHook } from '@modoki/engine/runtime';
 *
 *  Each hook MUST be shallow-stable (e.g. return `useShallow(selector)`) so the
 *  assembled `storeState` keeps referential equality between renders when no
 *  bound field changed.
 *
 *  Rules of Hooks: the number of hooks called per render must stay constant.
 *  Mutating the registry bumps a version so the consuming layer can remount
 *  with the new fixed hook count — `subscribeHooksVersion` / `getHooksVersion`
 *  back a `useSyncExternalStore` on the host side.
 *
 *  LIFECYCLE (F9): APP-LIFETIME, NOT scene-scoped — do NOT auto-clear on world swap.
 *  Games register their hook ONCE in `setup.ts` (e.g. chess, llm-test) with no paired
 *  `removeStoreHook`, expecting it to persist for the whole session; resetting on a
 *  scene swap would silently drop them on the first scene change and never re-add them.
 *  Owners that DO have a teardown (e.g. a per-scene manager) must call `removeStoreHook`
 *  themselves — removal is by hook identity, so it only drops that owner's own hook. */

export type StoreHook = () => Record<string, unknown>;

const _hooks: StoreHook[] = [];
let _hooksVersion = 0;
const _versionListeners = new Set<() => void>();

function notifyVersionListeners() {
  for (const fn of _versionListeners) fn();
}

export function addStoreHook(hook: StoreHook) {
  _hooks.push(hook);
  _hooksVersion++;
  notifyVersionListeners();
}

export function removeStoreHook(hook: StoreHook) {
  const i = _hooks.indexOf(hook);
  if (i >= 0) {
    _hooks.splice(i, 1);
    _hooksVersion++;
    notifyVersionListeners();
  }
}

/** Live registry array — the host UI layer calls each hook per render. */
export function getStoreHooks(): readonly StoreHook[] {
  return _hooks;
}

export function subscribeHooksVersion(cb: () => void): () => void {
  _versionListeners.add(cb);
  return () => {
    _versionListeners.delete(cb);
  };
}

export function getHooksVersion(): number {
  return _hooksVersion;
}
