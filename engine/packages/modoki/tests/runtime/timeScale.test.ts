/** timeScale + visual/sim delta accessors (Phase 1 — verification harness).
 *
 *  Covers the three concerns the time-system redesign separates: timeScale=1 is
 *  byte-identical to the old behavior; pause/time-stop (scale 0) is INSTANT (no
 *  EMA coast); slow-mo scales linearly; and the accessors freeze to 0 when the
 *  sim isn't running. Uses the REAL Time trait + manual clock (no mocks). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/traits/Time';
import { timeSystem, resetTimeBaseline } from '../../src/runtime/systems/timeSystem';
import { getTime, getSimDelta, getVisualDelta, getTimeScale, setTimeScale } from '../../src/runtime/systems/getTime';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/systems/clock';
import { setPlayState } from '../../src/runtime/systems/playState';

function tick(world: ReturnType<typeof createWorld>, dtMs = 16) {
  advanceManual(dtMs);
  timeSystem(world);
}

beforeEach(() => {
  setManualNow(0);
  resetTimeBaseline();
  setPlayState('playing'); // accessors gate on isSimRunning()
});
afterEach(() => {
  restoreRealClock();
  resetTimeBaseline();
  setPlayState('playing');
});

describe('timeScale', () => {
  it('is byte-identical to the legacy behavior at scale 1', () => {
    const world = createWorld();
    world.spawn(Time);
    tick(world); // frame 0 — seeds
    tick(world, 16);
    tick(world, 16);

    const t = getTime(world)!;
    expect(t.timeScale).toBe(1);
    expect(t.delta).toBeCloseTo(0.016, 3);
    expect(getSimDelta(world)).toBeCloseTo(t.delta, 6);
    expect(getVisualDelta(world)).toBeCloseTo(t.smoothedDelta, 6);
  });

  it('freezes both deltas INSTANTLY at scale 0 (no EMA coast)', () => {
    const world = createWorld();
    world.spawn(Time);
    // Warm up the smoothing EMA so smoothedDelta is clearly non-zero at 1×.
    for (let i = 0; i < 10; i++) tick(world, 16);
    expect(getTime(world)!.smoothedDelta).toBeGreaterThan(0.005);

    // Engage time-stop and step once.
    setTimeScale(world, 0);
    tick(world, 16);

    const t = getTime(world)!;
    expect(t.delta).toBe(0);
    // INSTANT: smoothedDelta drops to exactly 0 the same frame. If it coasted on
    // the EMA it would still be ~0.005+ here. (The internal cadence keeps tracking
    // hardware so un-pausing is smooth, but that's not surfaced as a field.)
    expect(t.smoothedDelta).toBe(0);
    expect(getVisualDelta(world)).toBe(0);
    expect(getSimDelta(world)).toBe(0);
  });

  it('scales linearly for slow-mo', () => {
    const world = createWorld();
    world.spawn(Time);
    tick(world); tick(world, 16); // warm
    const before = getTime(world)!;
    const rawDelta = before.delta; // scale 1 → delta is raw

    setTimeScale(world, 0.5);
    tick(world, 16);
    const t = getTime(world)!;
    expect(t.delta).toBeCloseTo(rawDelta * 0.5, 3);
    expect(getTimeScale(world)).toBe(0.5);
  });

  it('elapsed accumulates SCALED time (slow-mo runs the game clock slower)', () => {
    const world = createWorld();
    world.spawn(Time);
    tick(world, 16); // establish a frame at scale 1
    const elapsedBefore = getTime(world)!.elapsed;

    setTimeScale(world, 0.25);
    tick(world, 16);
    tick(world, 16);
    const t = getTime(world)!;
    // two 16ms frames at 0.25× advance the game clock by ~0.008s, not 0.032s
    expect(t.elapsed - elapsedBefore).toBeCloseTo(0.016 * 2 * 0.25, 3);
  });
});

describe('getSimDelta / getVisualDelta', () => {
  it('return 0 when the sim is not running (editor Stopped/Paused)', () => {
    const world = createWorld();
    world.spawn(Time({ delta: 0.05, smoothedDelta: 0.05, timeScale: 1 }));
    expect(getSimDelta(world)).toBeCloseTo(0.05, 6);

    setPlayState('stopped');
    expect(getSimDelta(world)).toBe(0);
    expect(getVisualDelta(world)).toBe(0);

    setPlayState('paused');
    expect(getSimDelta(world)).toBe(0);
    expect(getVisualDelta(world)).toBe(0);
  });

  it('default to 0 when there is no Time singleton', () => {
    const world = createWorld();
    expect(getSimDelta(world)).toBe(0);
    expect(getVisualDelta(world)).toBe(0);
    expect(getTimeScale(world)).toBe(1);
  });
});
