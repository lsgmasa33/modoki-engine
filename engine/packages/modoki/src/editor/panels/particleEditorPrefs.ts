/** Persistence for the Particle Editor's viewport toggles (currently just "ground plane") —
 *  same `editor:`-prefixed localStorage convention as `sceneViewPrefs.ts`/`gameViewPrefs.ts`
 *  (found as a sibling of #399's SceneView/GameView gap during that fix's close-out sweep: the
 *  ▦ ground-plane toggle in the transport bar is the exact same shape of bug — a preview-viewport
 *  display option that reset to its default on every mount). */

const SHOW_FLOOR_KEY = 'editor:particleEditorShowFloor';

export function loadParticleEditorShowFloor(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(SHOW_FLOOR_KEY) === '1';
}
export function saveParticleEditorShowFloor(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(SHOW_FLOOR_KEY, on ? '1' : '0'); } catch { /* storage full/blocked */ }
}
