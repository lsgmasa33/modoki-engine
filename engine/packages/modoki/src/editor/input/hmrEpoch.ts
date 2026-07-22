/** hmrEpoch — a counter that ticks on every hot update, so `[]`-deps registration
 *  effects can be made to re-run under Fast Refresh.
 *
 *  THE PROBLEM IT SOLVES (measured, not inferred). Editing a panel hot-reloads its module
 *  and re-renders the component, but React Fast Refresh does NOT re-run a `useEffect` with
 *  `[]` deps. Probes across one HMR cycle of Hierarchy.tsx:
 *      module re-evaluated  3 -> 4      component re-rendered  2 -> 4
 *      []-deps effect re-ran 2 -> 2   <-- never
 *  So a panel that registers keymap bindings from a `[]` effect keeps its ORIGINAL
 *  bindings forever: adding a binding, or changing a `keys`/`when`, silently does nothing
 *  until a manual reload. (Handler BODIES do update — those are reached through a ref that
 *  every render refreshes — which is why this looks like it works most of the time.)
 *
 *  Keying such an effect on this epoch makes it re-run on the next hot update, which
 *  re-registers against the live registry. The registry itself survives, because
 *  keymap.ts/focusScope.ts/dispatcher.ts force a full reload when THEY change.
 *
 *  WHERE IT TICKS: anywhere there is a Vite hot context — which includes the PACKAGED
 *  editor, since that spawns a real dev server and loads its origin (electron/devServer.ts:
 *  "the packaged app == the dev app"). That is deliberate: a DMG user editing game code
 *  needs this exactly as much as a repo developer does. In a shipped GAME build there is no
 *  hot context, so the epoch is a frozen 0, `subscribe` never fires, and `[epoch]` is
 *  byte-for-byte equivalent to `[]` — no extra renders. Kept OUT of keymap.ts on purpose: that
 *  module is documented as pure (no DOM, no React) so it unit-tests by direct calls. */

import { useSyncExternalStore } from 'react';

let epoch = 0;
const listeners = new Set<() => void>();

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    epoch += 1;
    for (const l of listeners) l();
  });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

const getSnapshot = (): number => epoch;

/** Current HMR epoch. Use as an effect dep to make a `[]`-style registration effect
 *  re-run after a hot update. Constant 0 outside `vite` dev. */
export function useHmrEpoch(): number {
  // Same value on the server/prerender path — there is no HMR there either.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Non-React read, for tests and for non-component registrars. */
export function hmrEpoch(): number { return epoch; }
