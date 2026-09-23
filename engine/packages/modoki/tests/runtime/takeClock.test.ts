/** The gameplay recorder's take clock (#1479): one frame's worth, summed by both the editor recorder
 *  and the replay — unscaled, and zero for a frame that did not advance. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/core/traits/Time';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/core/timeSystem';
import { advanceManual, setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { setPlayState } from '../../src/runtime/core/playState';
import { holdTimeForLoading } from '../../src/runtime/core/loadingTimeHold';
import { setTimeScale } from '../../src/runtime/core/getTime';
import { takeClockDelta, sceneLoadInFlight, isNextSceneLoading } from '../../src/runtime/core/takeClock';

/** One frame as both halves run it: sample the load state at the START, run the frame (`during`
 *  stands in for a system starting a load mid-frame), then read the clock. */
function frame(world: ReturnType<typeof createWorld>, ms: number, during?: () => void): number {
  const loadInFlightAtStart = isNextSceneLoading();
  advanceManual(ms);
  timeSystem(world);
  during?.();
  return takeClockDelta(loadInFlightAtStart);
}

function setup() {
  const w = createWorld();
  w.spawn(Time());
  setManualNow(1000);
  resetTimeBaseline();
  setPlayState('playing');
  return w;
}

let loading = false;
// Provided for every test, so the unprovided-slot warning does not print for the ones that do not care.
beforeEach(() => { loading = false; sceneLoadInFlight.provide({ inFlight: () => loading }); });
afterEach(() => { restoreRealClock(); setPlayState('stopped'); sceneLoadInFlight.reset(); });

describe('takeClockDelta', () => {
  it('is the frame\'s real (clamped) delta', () => {
    const w = setup();
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    // Clamped like the sim: a 200 ms hitch is one 1/30 s frame, as the sim saw it.
    expect(frame(w, 200)).toBeCloseTo(1 / 30, 9);
    w.destroy();
  });

  it('ignores timeScale — slow-mo and time-stop still advance the take in real time', () => {
    const w = setup();
    setTimeScale(w, 0.5);
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    setTimeScale(w, 0);
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    w.destroy();
  });

  it('is zero while paused and while the loading hold is up', () => {
    const w = setup();
    frame(w, 20);
    setPlayState('paused');
    expect(takeClockDelta(false)).toBe(0);
    setPlayState('playing');
    const release = holdTimeForLoading();
    expect(frame(w, 20)).toBe(0);
    release();
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    w.destroy();
  });

  it('is zero for a frame that STARTED with a load in flight — but the frame that starts one counts (#1486)', () => {
    const w = setup();
    // The frame that starts the load is a timed frame on both halves: it counts its dt.
    expect(frame(w, 20, () => { loading = true; })).toBeCloseTo(0.02, 9);
    // Frames that begin with the load in flight count nothing — the replay never steps them.
    expect(frame(w, 20)).toBe(0);
    // The swap lands between frames; the first frame after it counts again.
    loading = false;
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    w.destroy();
  });
});
