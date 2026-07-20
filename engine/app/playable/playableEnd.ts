/** Latches the game-dispatched `window 'playable:end'` event so it survives the off-screen
 *  ready/viewable hold. bootPlayable arms the latch immediately at boot, but PlayableOverlay only
 *  mounts once the ad is viewable — so a game that reaches win/lose WHILE the ad is still off-screen
 *  would otherwise fire 'playable:end' with no listener yet, and the end-card wouldn't show until
 *  the 30s time-cap. With the latch, the overlay reads `isPlayableEnded()` on mount and shows the
 *  end-card immediately. */

let ended = false;
let armed = false;

/** Install the window listener once (idempotent). Called by bootPlayable before the viewable gate. */
export function armPlayableEndLatch(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  window.addEventListener('playable:end', () => { ended = true; });
}

/** True if the game has dispatched `playable:end` since the latch was armed. */
export function isPlayableEnded(): boolean {
  return ended;
}

/** Clear the latch (on Replay — the game restarts and may end again). */
export function resetPlayableEnd(): void {
  ended = false;
}
