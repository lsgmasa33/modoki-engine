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
import {
  createRendererRecovery, describeRebuildFailure,
  DEFAULT_REBUILD_DELAY_MS, DEFAULT_MAX_REBUILD_ATTEMPTS,
} from '../../src/runtime/rendering/rendererRecovery';

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


/** #156 — rule 4. A failed rebuild used to be reported and dropped, which was TERMINAL BY
 *  CONSTRUCTION: only a further `onRendererLost` could ask for another attempt, and after a
 *  failed rebuild there is no live renderer left to lose. Reproduced on a Y6 2019 as a
 *  boot-time loss that left the surface blank for the process lifetime. */
describe('rendererRecovery — a failed rebuild is retried (#156)', () => {
  it('retries after a rejection instead of leaving the viewport black forever', async () => {
    const rebuild = vi.fn()
      .mockRejectedValueOnce(new Error('init failed'))
      .mockResolvedValueOnce(undefined);
    const { t, recovery } = harness({ rebuild });

    recovery.request();
    await t.fire();                       // attempt 1 — rejects
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(t.scheduled).toBe(1);          // the retry the old code never armed

    await t.fire();                       // attempt 2 — succeeds
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(t.scheduled).toBe(0);          // success stops the chain
  });

  it('backs off — a retry at the interval that just failed mostly fails again', async () => {
    const rebuild = vi.fn().mockRejectedValue(new Error('still resetting'));
    const { t, recovery } = harness({ rebuild });

    recovery.request();
    for (let i = 0; i < DEFAULT_MAX_REBUILD_ATTEMPTS; i++) await t.fire();

    expect(t.delays).toEqual([
      DEFAULT_REBUILD_DELAY_MS,
      DEFAULT_REBUILD_DELAY_MS * 2,
      DEFAULT_REBUILD_DELAY_MS * 4,
    ]);
  });

  it('gives up after maxAttempts — a hot loop is worse than a black screen', async () => {
    const rebuild = vi.fn().mockRejectedValue(new Error('dead'));
    const { t, recovery } = harness({ rebuild, maxAttempts: 2 });

    recovery.request();
    await t.fire();
    await t.fire();
    await t.fire();   // nothing left scheduled — this is a no-op

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(t.scheduled).toBe(0);
  });

  it('tells the viewport whether a retry is coming, so it cannot cry permanent too early', async () => {
    const onError = vi.fn();
    const rebuild = vi.fn().mockRejectedValue(new Error('dead'));
    const { t, recovery } = harness({ rebuild, onError, maxAttempts: 2 });

    recovery.request();
    await t.fire();
    await t.fire();

    expect(onError.mock.calls[0][1]).toMatchObject({ attempt: 1, willRetry: true });
    expect(onError.mock.calls[1][1]).toMatchObject({ attempt: 2, willRetry: false });
  });

  it('gives a FRESH loss the full budget rather than an exhausted one', async () => {
    const rebuild = vi.fn().mockRejectedValue(new Error('dead'));
    const { t, recovery } = harness({ rebuild, maxAttempts: 1 });

    recovery.request();
    await t.fire();
    expect(t.scheduled).toBe(0);   // budget spent

    recovery.request();            // a NEW fault
    expect(t.scheduled).toBe(1);
  });

  it('does not retry into a viewport that unmounted during the backoff', async () => {
    let disposed = false;
    const rebuild = vi.fn().mockRejectedValue(new Error('dead'));
    const { t, recovery } = harness({ rebuild, isDisposed: () => disposed });

    recovery.request();
    await t.fire();
    expect(t.scheduled).toBe(1);

    disposed = true;
    recovery.dispose();
    await t.fire();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});

/** The reporting half of #156. The symptom was `… FAILED — …: {}`; blaming Error serialization
 *  is WRONG (the device console capture special-cases Error and would have sent a stack), so an
 *  empty `{}` proves a NON-Error rejection with no enumerable properties. */
describe('describeRebuildFailure', () => {
  it('keeps an Error stack — the case that already worked', () => {
    const e = new Error('boom');
    expect(describeRebuildFailure(e)).toContain('boom');
  });

  it('salvages something from the {} that started this — an object with no enumerable props', () => {
    const opaque = Object.create({}, { name: { value: 'GPUError', enumerable: false } });
    const out = describeRebuildFailure(opaque);
    expect(out).not.toBe('{}');
    expect(out).toContain('GPUError');
  });

  it('names the shape when there is genuinely nothing to read', () => {
    expect(describeRebuildFailure({})).toContain('no readable properties');
  });

  it('reports undefined and null distinctly — "rejected with nothing" is itself a clue', () => {
    expect(describeRebuildFailure(undefined)).toBe('rejected with undefined');
    expect(describeRebuildFailure(null)).toBe('rejected with null');
  });

  it('never throws while describing why something else failed', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeRebuildFailure(circular)).not.toThrow();
    expect(() => describeRebuildFailure(Symbol('x'))).not.toThrow();
  });
});
