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
