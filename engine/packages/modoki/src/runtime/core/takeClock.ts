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
 *    boot overlay's loading hold (the game is not on screen yet — the take has not started).
 *  - **Zero for a frame that STARTED with a scene load in flight (#1486).** The two halves cannot
 *    agree on what a load costs any other way: the editor keeps ticking the old world through the
 *    async load at display rate — however long THIS machine took — while the replay's settle gate
 *    waits it out without stepping. So a load costs nothing on either clock.
 *    ⚠️ Sampled at the frame's START, not after it. The frame that starts a load (a game system
 *    calling `loadScene`, which marks it in flight before its first await) must count one dt on
 *    BOTH halves — the replay's step for it is a real timed frame, and the CLI renders a fixed
 *    `frameCountFor` frames that assume every timed step adds exactly one dt. Sampled after the
 *    frame, that step added zero and every take with a load lost its last dt of input — the
 *    closing `up` among it. With the start sample — and the settle gate looking again after its
 *    last macrotask, so a load a continuation starts is waited out too — a timed replay step adds
 *    zero only when the gate went ahead past a load it gave up on (`captureDriver.ts` § settle).
 *    The price is deliberate: the video cuts from the old scene to the new one, and taps made in
 *    the editor DURING a load all replay together, at the take time the load began at. */

import { isSimRunning } from './playState';
import { isTimeHeldForLoading } from './loadingTimeHold';
import { getUnscaledFrameDelta } from './timeSystem';
import { createProviderSlot } from './providerSlot';

/** Whether a scene load is in flight — `SceneManager` installs it (L3, which L0 may not import),
 *  answering from the same `getNext()` the replay's settle gate waits on, so the two halves read
 *  one piece of state. Unprovided (a headless test that deep-imports this file) reads as "no". */
export const sceneLoadInFlight = createProviderSlot<{ inFlight(): boolean }>('sceneLoadInFlight');

/** Sample at the START of a frame, and hand the answer to `takeClockDelta` after it. */
export function isNextSceneLoading(): boolean {
  return sceneLoadInFlight.get()?.inFlight() ?? false;
}

/** Real seconds the frame that just ran adds to a take's clock. `loadInFlightAtStart` is
 *  `isNextSceneLoading()` as sampled before the frame ran — see the docblock above for why not now. */
export function takeClockDelta(loadInFlightAtStart: boolean): number {
  if (!isSimRunning() || isTimeHeldForLoading() || loadInFlightAtStart) return 0;
  return getUnscaledFrameDelta();
}
