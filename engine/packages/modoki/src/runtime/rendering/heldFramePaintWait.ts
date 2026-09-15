/** Keep the loading overlay up for as long as a compile holds `Scene3D`'s frames — within a bound (#1246).
 *
 *  `liveCompileGate` promises its hold to the overlay when it kicks (`onKick` →
 *  `extendScenePaintWait`), and that promise is its own 5 s ceiling. A scene-pass compile's BORROW
 *  (`isRendererTargetBorrowed`) makes no such promise and holds with no ceiling at all: on an iPad
 *  mini 5 a fresh install's scene-pass compile runs 9.3 s, so the overlay timed out 5 s after the
 *  kick, the loading time hold released, and the game ran for ~4 s under a canvas that had not drawn.
 *  (A stage precompile session needs none of this — its ceiling counts from the gate's kick, which
 *  already promised it.)
 *
 *  So each frame the borrow holds renews the promise: the overlay's deadline stays `stepMs` ahead
 *  of now. It stays BOUNDED, because the overlay's ceiling exists for a renderer that never draws
 *  again: after `maxMs` of continuous holding this stops renewing, warns once, and the overlay times
 *  out `stepMs` later. The 3D surface itself stays held until the compile settles — drawing into a
 *  borrowed target is the GPU-process crash the borrow exists to prevent.
 *
 *  A hold is "continuous" while each held frame comes within `stepMs` of the previous one. A longer
 *  gap means the last renewal has already expired (an idle-gated editor, a long task), so the next
 *  held frame starts a new hold rather than inheriting an old one's elapsed time. */

/** How long ONE continuous hold may keep renewing the loading overlay's wait.
 *
 *  A CEILING for a compile that never settles, not a budget — and per hold, not a total: the stage
 *  compile that follows a scene-pass compile is a separate hold, promised by its own gate's kick. Sized
 *  against the slowest scene-pass compile measured, 9.3 s on an iPad mini 5 fresh install of
 *  `demos/postfx-demo`. */
export const HELD_FRAME_PAINT_WAIT_MAX_MS = 20_000;

export interface HeldFramePaintWaitOptions {
  now: () => number;
  /** Promise the overlay `ms` more from now — `extendScenePaintWait`. */
  extend: (ms: number) => void;
  /** How far ahead each renewal reaches, and the gap that ends a hold. */
  stepMs: number;
  /** Total renewal budget for one continuous hold. */
  maxMs: number;
  /** Called once per hold when the budget runs out, with how long it has held. */
  onBudgetExhausted: (heldMs: number) => void;
}

export interface HeldFramePaintWait {
  /** This frame was held by a compile. */
  held(): void;
  /** This frame was not held. */
  released(): void;
}

export function createHeldFramePaintWait(opts: HeldFramePaintWaitOptions): HeldFramePaintWait {
  let since: number | null = null;
  let lastHeldAt = 0;
  let exhausted = false;
  return {
    held() {
      const t = opts.now();
      if (since === null || t - lastHeldAt > opts.stepMs) {
        since = t;
        exhausted = false;
      }
      lastHeldAt = t;
      const elapsed = t - since;
      if (elapsed < opts.maxMs) {
        opts.extend(Math.min(opts.stepMs, opts.maxMs - elapsed));
      } else if (!exhausted) {
        exhausted = true;
        opts.onBudgetExhausted(elapsed);
      }
    },
    released() {
      since = null;
    },
  };
}
