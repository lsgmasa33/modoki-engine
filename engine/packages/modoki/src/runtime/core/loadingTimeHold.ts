/** Freeze GAME TIME while a loading screen is up — the scene starts when it is first on screen
 *  (#1246; the owner's call, 2026-09-15: "the whole game waits").
 *
 *  Why: under the loading overlay the world is live and ticking. A fresh install's shader compile
 *  keeps the overlay up for seconds (~10 s on an iPhone Air), so `demos/postfx-demo`'s tour had
 *  played its first look (0–15 s) invisibly when the overlay lifted — the first frame anyone saw
 *  was the second station.
 *
 *  A hold makes `timeSystem` apply a time scale of 0: `delta`, `smoothedDelta`, `elapsed` and every
 *  accessor built on them stand still, so physics, animation, particles, the timeline and shader
 *  time all wait together, and the first frame after release is t = 0 of the scene.
 *
 *  ⚠️ **It zeroes TIME; it does not stop the pipeline.** Pausing through `isSimRunning()` would skip
 *  every system below TRANSFORM — so animation would never sample its first pose (the #1097
 *  pre-pose flash, back) and `Scene3D`'s idle gate would stop drawing the frames that finish the
 *  load. Systems keep running at dt 0 instead.
 *
 *  ⚠️ **Not frozen:** media on its own clock (a playing `<video>`, WebAudio already started) and
 *  game code reading `setTimeout` — the same things `timeScale = 0` does not reach.
 *
 *  Counted, not a flag: a game-to-game swap can begin while the previous boot's hold is still
 *  releasing, and each release is idempotent so a cleanup path cannot free someone else's hold. */

let holds = 0;

/** Take a hold; call the returned function to release it (safe to call more than once). */
export function holdTimeForLoading(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
  };
}

/** True while any loading hold is active. */
export function isTimeHeldForLoading(): boolean {
  return holds > 0;
}

/** Test seam. */
export function resetLoadingTimeHold(): void {
  holds = 0;
}
