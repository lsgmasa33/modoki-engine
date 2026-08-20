/** "When did a human last touch this device?" — a plain global signal, same shape as
 *  `core/uiDirty.ts` and `core/playState.ts`.
 *
 *  It exists for ONE consumer so far, and the reason is worth stating where the signal lives
 *  rather than only where it is read. Quality-tier calibration judges the device by measuring
 *  frame times, and a phone that nobody is touching is not the phone the player plays on.
 *  Measured on a Galaxy S22 — the most powerful Android handset in the lab — sitting idle on
 *  Court's tutorial (bug `lvROp0yDYPSzS0VZM6LH`): ~41.6 ms medians against a 20 ms budget walked
 *  it `high → mid → low` inside ~66 ticks, while the GPU identity table had resolved `high`
 *  deterministically at boot on the same phone.
 *
 *  ⚠️ **This docblock used to explain that as "mobile CPU governors drop clocks when there is no
 *  input". Measured on 2026-08-20, that is the minor term.** The S22's LTPO panel idles from
 *  120 Hz to 24 Hz after ~20 s of static content, and 1000/24 is 41.67 ms — the reading, to three
 *  digits; the governor moved `cpuMs` only 5.6 → 8.4 ms. The distinction matters because a
 *  governor story implies the sample recovers once clocks ramp, and it does not: the interval
 *  belongs to the display. Full measurement, and the second half of the fix this signal is only
 *  one half of, in `docs/rendering.md` § "an idle window is not evidence".
 *
 *  The owner's rule (2026-08-20): **an idle window is not evidence, in either direction** — the
 *  same rule already applied to scene-load frames (`armTierCalibration`), rather than a
 *  demotion-only guard whose meaning would depend on which way the sample happened to point.
 *
 *  ⚠️ Stamped by the INPUT SOURCES, not by `inputSystem`. A game with no `Input` resource never
 *  runs that system, and gating calibration on a signal such a project can never emit would
 *  suppress it forever for a whole class of game. The sources see the DOM events regardless.
 *  A game that registers its OWN `InputSource` should call {@link noteUserInput} from it for the
 *  same reason — it is exported for that.
 *
 *  No wall-clock of its own: the caller passes `now` (the sanctioned `rawNow()` wrapper), so the
 *  determinism guard has nothing to catch and a test can drive it without faking a clock. */

/** Negative means "no input has EVER been seen", which is distinct from "input was seen a long
 *  time ago" only in what it is honest to say about it — both count as idle. */
let lastInputAt = -1;

/** Record that a human just did something. Cheap enough for `pointermove` (one assignment). */
export function noteUserInput(now: number): void {
  lastInputAt = now;
}

/** Milliseconds since the last input, or `Infinity` if there has never been any. */
export function msSinceUserInput(now: number): number {
  return lastInputAt < 0 ? Infinity : now - lastInputAt;
}

/** Has a human touched this device within `windowMs`? `false` before the first input ever. */
export function hasRecentUserInput(now: number, windowMs: number): boolean {
  return msSinceUserInput(now) < windowMs;
}

/** Test-only: forget the last input. */
export function __resetUserActivityForTest(): void {
  lastInputAt = -1;
}
