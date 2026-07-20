/** getTime unit tests — returns Time singleton from world. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorld, trait } from 'koota';

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

describe('getTime', () => {
  it('returns null when no Time entity exists', async () => {
    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { getTime } = await import('../../src/runtime/systems/getTime');

    const world = createWorld();
    expect(getTime(world)).toBeNull();
  });

  it('returns the Time data when a Time entity exists', async () => {
    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { getTime } = await import('../../src/runtime/systems/getTime');

    const world = createWorld();
    world.spawn(Time);

    // Mutate via query (koota spawn doesn't support initial values on all builds)
    world.query(Time).updateEach(([t]) => {
      t.delta = 0.016; t.elapsed = 1.5; t.frame = 90;
      t.smoothedDelta = 0.016; t.smoothedElapsed = 1.5;
    });

    const t = getTime(world);
    expect(t).not.toBeNull();
    expect(t!.delta).toBe(0.016);
    expect(t!.elapsed).toBe(1.5);
    expect(t!.frame).toBe(90);
    expect(t!.smoothedDelta).toBe(0.016);
    expect(t!.smoothedElapsed).toBe(1.5);
  });

  it('returns mutable reference that reflects ECS updates', async () => {
    vi.doMock('../../src/runtime/traits', () => ({ Time }));
    const { getTime } = await import('../../src/runtime/systems/getTime');

    const world = createWorld();
    world.spawn(Time);

    const t = getTime(world);
    expect(t).not.toBeNull();
    expect(t!.frame).toBe(0);

    // Mutate via ECS query (simulating what timeSystem does)
    world.query(Time).updateEach(([time]) => { time.frame = 42; });

    // getTime returns a fresh query, should see updated value
    const t2 = getTime(world);
    expect(t2!.frame).toBe(42);
  });
});
