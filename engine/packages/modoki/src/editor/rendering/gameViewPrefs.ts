/** Persistence for GameView's toolbar toggles (Mute Audio, Show Colliders) — split out of
 *  GameView.tsx for the same reason `sceneViewPrefs.ts` sits beside SceneView.tsx: a plain .ts
 *  module is what's unit-testable, and it keeps runtime/audio + runtime/rendering (which ship
 *  in every game) free of any editor-only localStorage concern — GameView (editor-only) reads
 *  these on mount and applies them through the existing runtime setters. */

const MUTE_KEY = 'editor:gameViewMuted';
const COLLIDERS_KEY = 'editor:gameViewShowColliders';

export function loadGameViewMuted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(MUTE_KEY) === '1';
}
export function saveGameViewMuted(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* storage full/blocked */ }
}

export function loadGameViewShowColliders(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(COLLIDERS_KEY) === '1';
}
export function saveGameViewShowColliders(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(COLLIDERS_KEY, on ? '1' : '0'); } catch { /* storage full/blocked */ }
}

// Module-scoped: survives GameView remounting within the same page load (Load Layout, Reset
// Layout, dragging the Game tab into another tabset, a Fast Refresh), and resets on a real
// reload since the module re-evaluates then.
let appliedPersistedMuteThisPageLoad = false;
/** Test-only: model a fresh PAGE LOAD (in production this is a fresh module instance). */
export function _resetMutePageLoadGuardForTests(): void { appliedPersistedMuteThisPageLoad = false; }

/** Resolve GameView's initial `muted` React state, and — ONLY on the first call of a page
 *  load — apply the persisted value to the runtime so a reload actually restores mute (#399).
 *
 *  Every LATER call (a same-session remount) instead reads the CURRENT live value and does
 *  NOT write. `setAudioMuted` has a second writer outside the editor — a game's own runtime
 *  applies the player's in-game sound setting through this same global flag (e.g.
 *  `games/court/runtime/systems.ts`'s `applyCourtSettings`) — so re-pushing a stale persisted
 *  snapshot on every remount would silently stomp whatever the game just set: reopening the
 *  Game tab after the player turned sound off in-game would turn it back on (close-out review
 *  finding #3). Injected `isAudioMuted`/`setAudioMuted` (rather than importing the runtime
 *  module here) keep this function testable without the Web Audio graph. */
export function resolveInitialGameViewMute(isAudioMuted: () => boolean, setAudioMuted: (m: boolean) => void): boolean {
  if (appliedPersistedMuteThisPageLoad) return isAudioMuted();
  appliedPersistedMuteThisPageLoad = true;
  const persisted = loadGameViewMuted();
  setAudioMuted(persisted);
  return persisted;
}
