/** timeSystem unit tests — delta, elapsed, frame count, smoothing, clamping. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

// Create a local Time trait matching the real one
const Time = trait({
  delta: 0,
  elapsed: 0,
  frame: 0,
  smoothedDelta: 0,
  smoothedElapsed: 0,
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('timeSystem', () => {
  it('updates delta, elapsed, and frame on each call', async () => {
    // Mock performance.now to control timestamps
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    // Mock traits import to use our local Time trait
    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');

    const world = createWorld();
    world.spawn(Time);

    // First call initializes lastTime
    now = 1000;
    timeSystem(world);

    // Second call: advance by 16ms (~60fps)
    now = 1016;
    timeSystem(world);

    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });

    expect(time.delta).toBeCloseTo(0.016, 3);
    expect(time.elapsed).toBeCloseTo(0.016, 3);
    expect(time.frame).toBe(2);

    // Third call: advance by another 16ms
    now = 1032;
    timeSystem(world);

    world.query(Time).updateEach(([t]) => { time = t; });
    expect(time.delta).toBeCloseTo(0.016, 3);
    expect(time.elapsed).toBeCloseTo(0.032, 3);
    expect(time.frame).toBe(3);
  });

  it('clamps delta to MAX_DELTA (1/30s) on large gaps', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');

    const world = createWorld();
    world.spawn(Time);

    // Init
    now = 1000;
    timeSystem(world);

    // Simulate a 500ms pause (tab was in background)
    now = 1500;
    timeSystem(world);

    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });

    // Delta should be clamped to 1/30 ≈ 0.0333
    expect(time.delta).toBeCloseTo(1 / 30, 3);
    // Elapsed accumulates the clamped value, not the raw value
    expect(time.elapsed).toBeCloseTo(1 / 30, 3);
  });

  it('computes smoothedDelta as exponential moving average', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');

    const world = createWorld();
    world.spawn(Time);

    // Frame 0 (now=1000): lastTime was set at module load (also 1000),
    // so rawDelta=0, delta=0. Seeds smoothedDelta=0 (frame===0 && smoothedDelta===0).
    now = 1000;
    timeSystem(world);

    // Frame 1 (now=1016): rawDelta=0.016, delta=0.016.
    // EMA: 0.016 * 0.15 + 0 * 0.85 = 0.0024
    now = 1016;
    timeSystem(world);

    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });
    const expectedFrame1 = 0.016 * 0.15 + 0 * 0.85;
    expect(time.smoothedDelta).toBeCloseTo(expectedFrame1, 4);

    // Frame 2 (now=1036): rawDelta=0.020.
    // EMA: 0.020 * 0.15 + 0.0024 * 0.85
    now = 1036;
    timeSystem(world);

    world.query(Time).updateEach(([t]) => { time = t; });
    const expectedFrame2 = 0.020 * 0.15 + expectedFrame1 * 0.85;
    expect(time.smoothedDelta).toBeCloseTo(expectedFrame2, 4);
  });

  it('F6: smoothedDelta EASES from the capped delta after a stall (no MAX_DELTA pin)', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');

    const world = createWorld();
    world.spawn(Time);

    now = 1000; timeSystem(world);          // frame 0, seed 0
    now = 1016; timeSystem(world);          // frame 1, normal 16ms
    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });
    const prev = time.smoothedDelta;        // ~0.0024

    // A 500ms stall: rawDelta=0.5, delta clamps to 1/30. The EMA must feed the
    // CLAMPED delta — so smoothedDelta = (1/30)*0.15 + prev*0.85, which is well
    // BELOW MAX_DELTA. (The old code fed rawDelta then clamped → pinned at 1/30.)
    now = 1516; timeSystem(world);
    world.query(Time).updateEach(([t]) => { time = t; });
    const expected = (1 / 30) * 0.15 + prev * 0.85;
    expect(time.smoothedDelta).toBeCloseTo(expected, 5);
    expect(time.smoothedDelta).toBeLessThan(1 / 30); // eased, not pinned to the cap
  });

  it('accumulates smoothedElapsed over frames', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');

    const world = createWorld();
    world.spawn(Time);

    now = 1000;
    timeSystem(world);

    now = 1016;
    timeSystem(world);

    now = 1032;
    timeSystem(world);

    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });
    expect(time.smoothedElapsed).toBeGreaterThan(0);
    expect(time.frame).toBe(3);
  });

  it('does NOT honor the per-entity Paused tag (pause is a pipeline-tier gate, not timeSystem)', async () => {
    // Regression for ecs-core F1: the old `entity.has(Paused)` branch was dead/misleading
    // (zero producers; the pipeline skips the whole TIME tier when paused via playState, so
    // the branch could never run anyway). It was removed — timeSystem now ignores the tag.
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { timeSystem } = await import('../../src/runtime/systems/timeSystem');
    const { Paused } = await import('../../src/runtime/traits/Paused');

    const world = createWorld();
    const entity = world.spawn(Time);

    now = 1000; timeSystem(world);
    now = 1016; timeSystem(world);

    // Tagging the Time entity Paused must NOT freeze global time anymore.
    entity.add(Paused);
    now = 1032; timeSystem(world); // +16ms
    let time: any = null;
    world.query(Time).updateEach(([t]) => { time = t; });
    expect(time.delta).toBeCloseTo(0.016, 3); // still advances despite the tag
    expect(time.frame).toBe(3);               // frame keeps counting
  });
});
