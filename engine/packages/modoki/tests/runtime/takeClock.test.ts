/** The gameplay recorder's take clock (#1479): one frame's worth, summed by both the editor recorder
 *  and the replay — unscaled, and zero for a frame that did not advance. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/core/traits/Time';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/core/timeSystem';
import { advanceManual, setManualNow, restoreRealClock } from '../../src/runtime/core/clock';
import { setPlayState } from '../../src/runtime/core/playState';
import { holdTimeForLoading } from '../../src/runtime/core/loadingTimeHold';
import { setTimeScale } from '../../src/runtime/core/getTime';
import { takeClockDelta } from '../../src/runtime/core/takeClock';

function frame(world: ReturnType<typeof createWorld>, ms: number): number {
  advanceManual(ms);
  timeSystem(world);
  return takeClockDelta();
}

function setup() {
  const w = createWorld();
  w.spawn(Time());
  setManualNow(1000);
  resetTimeBaseline();
  setPlayState('playing');
  return w;
}

afterEach(() => { restoreRealClock(); setPlayState('stopped'); });

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
    expect(takeClockDelta()).toBe(0);
    setPlayState('playing');
    const release = holdTimeForLoading();
    expect(frame(w, 20)).toBe(0);
    release();
    expect(frame(w, 20)).toBeCloseTo(0.02, 9);
    w.destroy();
  });
});
