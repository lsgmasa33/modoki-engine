/** OTA Phase 4 — the runtime game registry: the project's build-time-baked game(s)
 *  (`virtual:modoki-games`) plus any sub-game bundles dynamically loaded over OTA this
 *  session (see subgameLoader.ts). `App.tsx`'s `findGame` reads through this instead of
 *  the raw `GAMES` array, so a sub-game becomes selectable once loaded without touching
 *  the per-game boot effect (that effect resolves `findGame(gameId)` synchronously at the
 *  TOP of its work — see docs/ota-subgame-modules.md for why this stays a
 *  background/additive registration rather than something the boot effect awaits). */

import { GAMES } from 'virtual:modoki-games';
import type { GameDefinition } from '@modoki/engine/runtime';

const dynamicGames: GameDefinition[] = [];
type Listener = () => void;
const listeners = new Set<Listener>();

/** All games currently known: the project's baked game(s) first, then any sub-games
 *  loaded so far this session, in load order. */
export function getGames(): readonly GameDefinition[] {
  return dynamicGames.length === 0 ? GAMES : [...GAMES, ...dynamicGames];
}

export function findGame(gameId: string): GameDefinition | undefined {
  if (GAMES.length) {
    const baked = GAMES.find((g) => g.id === gameId);
    if (baked) return baked;
  }
  return dynamicGames.find((g) => g.id === gameId);
}

/** Registers a successfully loaded + engine-API-verified sub-game. Refuses (returns
 *  `false`, does NOT throw) a `gameId` collision with a baked game or an already-loaded
 *  sub-game — silently overwriting one game with another under the same id is exactly
 *  the kind of silent failure this registry exists to avoid (docs/plans/
 *  ota-subgame-modules.md §5). The caller (subgameLoader.ts) is expected to surface a
 *  `false` return as a visible load error, not swallow it. */
export function registerDynamicGame(def: GameDefinition): boolean {
  if (GAMES.some((g) => g.id === def.id) || dynamicGames.some((g) => g.id === def.id)) {
    return false;
  }
  dynamicGames.push(def);
  listeners.forEach((l) => l());
  return true;
}

/** Subscribes to registry changes (a sub-game finished loading). Returns an unsubscribe
 *  function. Not invoked with the current state immediately — callers that need the
 *  current list call `getGames()` directly. */
export function subscribeGameRegistry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset — dynamicGames/listeners are module-level singletons like the rest of
 *  the app shell's boot state (ota.ts's gate, etc.), so a test that registers a dynamic
 *  game must clean up after itself. */
export function __resetGameRegistryForTest(): void {
  dynamicGames.length = 0;
  listeners.clear();
}
