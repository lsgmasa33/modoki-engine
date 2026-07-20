/** getTime utility — returns Time resource from an ECS world. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { getTime } from '@modoki/engine/runtime';
import { timeSystem } from '@modoki/engine/runtime';
import { Time } from '@modoki/engine/runtime';

let w: ReturnType<typeof createWorld>;

afterEach(() => {
  w?.destroy();
});

describe('getTime', () => {
  it('returns null when no Time entity exists', () => {
    w = createWorld();
    expect(getTime(w)).toBeNull();
  });

  it('returns Time data after spawning Time entity and running timeSystem', () => {
    w = createWorld();
    w.spawn(Time());

    timeSystem(w);

    const time = getTime(w);
    expect(time).not.toBeNull();
    expect(time!.frame).toBe(1);
    expect(time!.delta).toBeGreaterThan(0);
    expect(time!.elapsed).toBeGreaterThan(0);
    expect(typeof time!.smoothedDelta).toBe('number');
    expect(typeof time!.smoothedElapsed).toBe('number');
  });

  it('returns Time data even before timeSystem runs (all zeros)', () => {
    w = createWorld();
    w.spawn(Time());

    const time = getTime(w);
    expect(time).not.toBeNull();
    expect(time!.frame).toBe(0);
    expect(time!.delta).toBe(0);
    expect(time!.elapsed).toBe(0);
    expect(time!.smoothedDelta).toBe(0);
    expect(time!.smoothedElapsed).toBe(0);
  });

  it('reflects accumulated state after multiple ticks', () => {
    w = createWorld();
    w.spawn(Time());

    timeSystem(w);
    timeSystem(w);
    timeSystem(w);

    const time = getTime(w);
    expect(time).not.toBeNull();
    expect(time!.frame).toBe(3);
    expect(time!.elapsed).toBeGreaterThan(0);
  });
});
