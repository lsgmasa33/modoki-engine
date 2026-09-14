/** The editor's pointer ingestion scope (#1182): which presses belong to the RUNNING GAME.
 *
 *  The game's `pointerSource` and `gestureSource` listen on `window`, and inside the editor that
 *  window is mostly editor. Without a scope, a press on any panel or modal latched as the game's
 *  gesture and `setPointerCapture`d its target, overriding the panel's own capture. That made
 *  every outcome-only check of a panel's capture unfalsifiable. The mechanism is
 *  `setPointerIngestScope` in `runtime/core/pointerBlockers.ts`; this is the policy, installed by
 *  `EditorApp` beside the #264 input gate.
 *
 *  The policy is the Game panel's play area, `[data-game-view-area]` (set in `GameView.tsx`): the
 *  rectangle holding the game's canvases and its UI layer. It excludes the panel's toolbar. It is
 *  DOM containment, not panel focus, on purpose: focus is moved by `PanelFocusHost`, which cannot
 *  see a modal portalled out of the panel tree, so a focus rule would still hand a Sprite Editor
 *  press to the game whenever the Game panel was the last panel clicked. The same marker is what
 *  the debug tooling already treats as the Game panel's surface (`app/debug/uiSurface.ts`). */

export const GAME_VIEW_AREA_SELECTOR = '[data-game-view-area]';

/** True when a press on `target` belongs to the running game. A target with no `closest` (`window`,
 *  `document`, a text node) is outside. */
export function isGamePointerTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(GAME_VIEW_AREA_SELECTOR) != null;
}
