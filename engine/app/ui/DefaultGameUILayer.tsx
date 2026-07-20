/** Default UI layer: renders ECS-driven UIRenderer with game store bindings.
 *  Used when a game does not provide a custom UIComponent. */
import { useMemo, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '@modoki/engine/runtime';
import { UIRenderer, getStoreHooks, subscribeHooksVersion, getHooksVersion } from '@modoki/engine/runtime';

const storeSelector = (s: ReturnType<typeof useGameStore.getState>) => ({
  screen: s.screen,
  entityCount: s.entityCount,
  gamePhase: s.gamePhase,
  fps: s.fps,
  threeBackend: s.threeBackend,
  pixiBackend: s.pixiBackend,
  fontStatus: s.fontStatus,
});

/** Extra store hooks live in the engine registry (`@modoki/engine/runtime`):
 *  games register via `addStoreHook()` so their bindings resolve in UIRenderer.
 *  Each hook MUST be shallow-stable (e.g. return useShallow(selector)) so
 *  storeState retains referential equality between renders when no bound field
 *  changed.
 *
 *  IMPORTANT: the number of hooks called per render must stay constant
 *  (Rules of Hooks). When the registry mutates, its version bumps; we read it
 *  via useSyncExternalStore and use it as a `key` on the inner component so it
 *  remounts with the new fixed hook count. The editor adds all its hooks at
 *  module load before first render so this remount never fires there; the
 *  runtime app's `GameShell` registers per-game and DOES rely on this. */

/** Inner: holds the fixed-shape hook calls for one snapshot of the registry.
 *  Remounted (via parent key) whenever the hooks array shape changes. */
function DefaultGameUILayerInner({ onSelectEntity }: { onSelectEntity?: (entityId: number) => void }) {
  const gameState = useGameStore(useShallow(storeSelector));
  // Each extra hook must return a shallow-stable object (useShallow) so its
  // reference only changes when a bound field actually changes. The
  // assembled `storeState` is memoized on those references, so a frame in
  // which nothing changed produces the SAME object reference — UIRenderer
  // can short-circuit on === if it ever needs to (and we avoid one object +
  // array spread per render).
  const extras = getStoreHooks().map((h) => h());
  // Spread `extras` into the memo dep array so every individual hook result
  // becomes a discrete dep — useMemo correctly invalidates on any change.
  // (extras itself is a fresh array per render and would invalidate
  // unconditionally if used as a single dep.)
  const storeState = useMemo<Record<string, unknown>>(() => {
    // Engine fixed fields (gameState: entityCount/gamePhase/fps/…) are authoritative and win on a
    // key collision — spread the game-registered extras (e.g. setUIValues, audio mix) FIRST so a
    // game can't silently shadow a reserved engine field.
    return Object.assign({}, ...extras, gameState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState, ...extras]);
  return <UIRenderer storeState={storeState} onSelectEntity={onSelectEntity} />;
}

export function DefaultGameUILayer({ onSelectEntity }: { onSelectEntity?: (entityId: number) => void }) {
  const version = useSyncExternalStore(subscribeHooksVersion, getHooksVersion, getHooksVersion);
  return <DefaultGameUILayerInner key={version} onSelectEntity={onSelectEntity} />;
}
