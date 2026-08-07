/** Scheduling policy for renderer rebuilds after GPU context loss (#121 P1).
 *
 *  These assert the three rules that keep a recoverable fault recoverable — see
 *  `runtime/rendering/rendererRecovery.ts` for why each exists. Timers are injected rather than
 *  slept through, so every test asserts the DECISION and none of them are timing-sensitive.
 *
 *  What is deliberately NOT tested here: whether recovery should be attempted at all. That
 *  budget lives in `core/activeRenderer.ts` and is covered by `activeRendererGpuFault.test.ts`;
 *  this module only ever hears about losses that are still worth acting on. */

import { describe, expect, it, vi } from 'vitest';
import { createRendererRecovery, DEFAULT_REBUILD_DELAY_MS } from '../../src/runtime/rendering/rendererRecovery';

/** A hand-driven clock: collects scheduled callbacks so a test fires them explicitly. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    delays: [] as number[],
    cleared: [] as unknown[],
    setTimer(fn: () => void, ms: number) {
      this.delays.push(ms);
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer(h: unknown) {
      this.cleared.push(h);
      pending.delete(h as number);
    },
    /** Fire every scheduled callback (and let its async body settle). */
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
      await Promise.resolve();
      await Promise.resolve();
    },
    get scheduled() { return pending.size; },
  };
}

function harness(over: Partial<Parameters<typeof createRendererRecovery>[0]> = {}) {
  const t = fakeTimers();
  const rebuild = vi.fn(async () => {});
  const recovery = createRendererRecovery({
    rebuild,
    isDisposed: () => false,
    setTimer: (fn, ms) => t.setTimer(fn, ms),
    clearTimer: (h) => t.clearTimer(h),
    ...over,
  });
  return { t, rebuild, recovery };
}

describe('rendererRecovery', () => {
  it('never rebuilds synchronously inside the loss event', () => {
    const { t, rebuild, recovery } = harness();

    recovery.request();

    // Rule 1: the loss handler returns before any GPU work starts.
    expect(rebuild).not.toHaveBeenCalled();
    expect(t.scheduled).toBe(1);
    expect(t.delays).toEqual([DEFAULT_REBUILD_DELAY_MS]);
  });

  it('rebuilds once the delay elapses', async () => {
    const { t, rebuild, recovery } = harness();

    recovery.request();
    await t.fire();

    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of losses into ONE rebuild', async () => {
    const { t, rebuild, recovery } = harness();

    recovery.request();
    recovery.request();
    recovery.request();
    await t.fire();

    // A canvas can report loss repeatedly; three rebuilds would race three renderers into
    // one container.
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('runs exactly one follow-up when a loss lands DURING a rebuild', async () => {
    const t = fakeTimers();
    let release!: () => void;
    const rebuild = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const recovery = createRendererRecovery({
      rebuild, isDisposed: () => false,
      setTimer: (fn, ms) => t.setTimer(fn, ms), clearTimer: (h) => t.clearTimer(h),
    });

    recovery.request();
    await t.fire();
    expect(recovery.isRebuilding()).toBe(true);

    // The freshly-built renderer dies on arrival — twice.
    recovery.request();
    recovery.request();
    expect(rebuild).toHaveBeenCalledTimes(1); // rule 2: not while one is in flight

    release();
    await Promise.resolve(); await Promise.resolve();
    await t.fire();

    // Rule 3: the signal is kept, but two losses during one rebuild mean the same as one.
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('keeps accepting losses after a rebuild REJECTS', async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () => { throw new Error('renderer creation failed'); });
    const { t, recovery: rec } = harness({ rebuild: failing, onError });

    rec.request();
    await t.fire();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(rec.isRebuilding()).toBe(false);

    // The regression this guards: an in-flight latch that never resets swallows every later
    // loss, restoring the permanent black screen the phase exists to remove.
    rec.request();
    await t.fire();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild into a viewport that unmounted during the delay', async () => {
    let disposed = false;
    const { t, rebuild, recovery } = harness({ isDisposed: () => disposed });

    recovery.request();
    disposed = true;   // React unmount lands between the request and the timer
    await t.fire();

    expect(rebuild).not.toHaveBeenCalled();
  });

  it('ignores a request that arrives after disposal', () => {
    const { t, rebuild, recovery } = harness();

    recovery.dispose();
    recovery.request();

    expect(t.scheduled).toBe(0);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('dispose cancels a scheduled rebuild', async () => {
    const { t, rebuild, recovery } = harness();

    recovery.request();
    expect(t.scheduled).toBe(1);
    recovery.dispose();

    expect(t.cleared).toHaveLength(1);
    await t.fire();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('honours an overridden delay', () => {
    const { t, recovery } = harness({ delayMs: 1000 });
    recovery.request();
    expect(t.delays).toEqual([1000]);
  });
});
