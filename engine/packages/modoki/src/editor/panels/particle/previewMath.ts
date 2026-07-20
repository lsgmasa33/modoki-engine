/** Pure helpers for the particle editor preview timeline. */

/** The elapsed value to SHOW on the scrub slider/readout.
 *  The preview's `elapsedRef` grows unbounded, but the backend loops internally every
 *  `duration` seconds. For a looping effect, wrap the displayed value into [0, duration)
 *  so the readout reflects the loop phase instead of pinning at max forever. For a
 *  one-shot effect, just clamp at the end. */
export function displayElapsed(elapsed: number, duration: number, looping: boolean | undefined): number {
  if (!(duration > 0)) return 0;
  if (looping) {
    const r = elapsed % duration;
    return r < 0 ? r + duration : r;
  }
  return Math.min(elapsed, duration);
}
