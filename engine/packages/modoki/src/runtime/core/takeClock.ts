/** The gameplay recorder's TAKE clock (#1479) — one frame's worth of it.
 *
 *  A take's events are stamped on this clock while the owner plays in the editor, and the headless
 *  replay advances by it to decide when each event is due. Both halves call THIS function after
 *  every frame and sum the result, so they measure one quantity by construction.
 *
 *  What it deliberately is, and why:
 *  - **Summed, never read from `Time.elapsed`.** Every scene load spawns a fresh `Time` into the new
 *    world, so `elapsed` restarts at 0 on a level change mid-take and a clock read from it runs
 *    backwards there.
 *  - **Unscaled.** A video frame is 1/fps of REAL time. Summing the scaled delta would make a 0.5x
 *    slow-mo stretch shorten the take's timeline — so the replay would run out of frames before the
 *    end — and a time-stop would stamp every tap during it with one instant.
 *  - **Zero for a frame that did not advance**: paused (the sim tier did not run), or frozen by the
 *    boot overlay's loading hold (the game is not on screen yet — the take has not started). */

import { isSimRunning } from './playState';
import { isTimeHeldForLoading } from './loadingTimeHold';
import { getUnscaledFrameDelta } from './timeSystem';

/** Real seconds the frame that just ran adds to a take's clock. */
export function takeClockDelta(): number {
  if (!isSimRunning() || isTimeHeldForLoading()) return 0;
  return getUnscaledFrameDelta();
}
